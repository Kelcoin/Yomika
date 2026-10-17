//! D3D12 侧的一次性上下文：设备、队列、命令表、栅栏，以及 NGX 的初始化。
//!
//! 一页图只跑一次，所以这里不追帧率：设备与命令对象进程内建一次（NGX 的
//! `Init_Ext` 只认一块设备）。纹理与 feature 按**量化尺寸**缓存成
//! [`Workspace`]（见 `workspace` 模块：换尺寸重建 feature 是这条链路上最大的
//! 单项开销），一页的整套命令（上传 → 各层 → 回读）合成一次提交。
//!
//! 全局一把锁：GPU 侧一次只跑一个请求（阅读器本来也有单并发闸，算力中心同理）。
//!
//! 这里把失败分两类。**记录期**出错（还没提交，比如上传失败、层间取消）丢掉重记就是，
//! 上下文留着；**提交期**出错（关闭命令表、`Signal`、栅栏超时、重置分配器/命令表）
//! 说明 GPU 状态未知、命令表也未必能再记，于是整份上下文作废并从缓存里摘掉，下一次
//! 请求重建——返回的稳定错误码是 [`DEVICE_RESET_REQUIRED`]。上下文建不起来时失败会按
//! DLL 指纹记住，不会每个请求都去重新初始化一次 NGX。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIAdapter1;

use super::ngx::{NgxCore, Parameters};
use super::workspace::{self, Workspace};

/// Auto-reset event owned by this queue, never shared with other contexts.
struct FenceEvent(HANDLE);
impl FenceEvent {
    fn new() -> Result<Self, String> {
        unsafe { CreateEventW(None, false, false, None) }
            .map(Self).map_err(|error| format!("创建 GPU 栅栏事件失败：{error}"))
    }
}
impl Drop for FenceEvent {
    fn drop(&mut self) { let _ = unsafe { CloseHandle(self.0) }; }
}

/// 进程内的一块设备 + 一个 NGX 会话（核心 + 片段）。
pub struct GpuContext {
    /// NGX 核心（DLSS SDK 的静态库，经垫片 DLL）：初始化、参数对象、特性模块都由它管。
    pub core: NgxCore,

    /// 片段自己（`nvngx_dlssnr.dll` 的导出）：feature 的建 / 跑 / 还全走它。
    ///
    /// 为什么不走核心那三个同名调用：核心在 `CreateFeature` 之前调
    /// `nvLoadSignedLibraryW()` 验签，改过一个字节的片段一律 0xBAD0000B（见 `mod.rs`
    /// 的 [`SignatureVerdict`](super::SignatureVerdict) 与 `docs/144`）。片段自己的导出
    /// 没有这道校验——Magpie / Veyra 就是靠这条跑社区兼容版与 FP16 版的。
    pub runtime: super::ngx::DlssnrRuntime,

    pub device: ID3D12Device,
    pub queue: ID3D12CommandQueue,
    pub allocator: ID3D12CommandAllocator,
    pub list: ID3D12GraphicsCommandList,
    pub fence: ID3D12Fence,
    fence_event: FenceEvent,
    pub fence_value: u64,
    /// NGX 的应用数据目录（它在那里写日志）。
    pub data_dir: PathBuf,
    /// 按量化尺寸缓存的工作区（近期用过的排在前面）。
    pub workspaces: Vec<Workspace>,
    /// 诊断用计数：建过几个工作区、建过几次 feature。测试拿它证明「换页不重建」。
    pub workspace_builds: u64,
    pub feature_builds: u64,
    /// Conservative initial estimate, corrected upwards by actual allocations.
    workspace_gpu_bytes_per_pixel: u64,
    workspace_commit_bytes_per_pixel: u64,
    /// `Some(原因)` ＝ 这一份上下文已经作废，不能再记录、不能再复用。
    ///
    /// 提交失败/栅栏超时/命令表重置失败都走这里：GPU 有没有停下不知道，命令表也未必
    /// 还能 Reset，于是整份上下文交给 `with_context_at` 从缓存里摘掉（报告 P1-1）。
    pub poisoned: Option<String>,
}

// D3D12 的对象是 agile 的（windows crate 已经给它们 Send/Sync），指针都由这把锁串起来。
unsafe impl Send for GpuContext {}

/// GPU 侧出错之后这一份上下文已经作废时给出的稳定错误码。
///
/// 看到它就说明：这一次的结果不可用，而且设备/队列/命令表/工作区整份已经报废，
/// 下一次请求会重新建。调用方不该把它当成参数错误（报告 P1-1）。
pub const DEVICE_RESET_REQUIRED: &str = "DLSSNR_DEVICE_RESET_REQUIRED";

/// 把原因包成带稳定错误码的一行。
fn reset_required(reason: &str) -> String {
    format!("{DEVICE_RESET_REQUIRED}：{reason}")
}

/// 进程级上下文槽的三态。
///
/// `Failed` 是「试过一次、没建起来」：不记住它，每个请求都会重新去初始化 NGX——
/// 而 NGX 一旦失败，进程内就不该再反复试（且报告要求这种错误「一次性、不会无限
/// 重试」）。记住的是**按 DLL 指纹**失败的：换一份片段（大小/修改时间变了）会重新试。
///
/// 但「记住」不等于「记到进程结束」。真机日志里那 11 条 `0xBAD00001` 是同一秒里同一个
/// 失败被记住了 11 次，而用户随后换回官方片段、也重启过应用之外什么都没做——失败当时
/// 可能是**当时**的状态（驱动刚被 NVIDIA App 换掉、另一份进程占着设备、文件刚落地）。
/// 所以记失败时同时记下**试过几次**与**什么时候**：过了 `INIT_RETRY_COOLDOWN` 且还没试满
/// `MAX_INIT_ATTEMPTS` 次，下一次请求会真的再建一遍；试满了才彻底记住，等换 DLL 或重启。
enum ContextState {
    Empty,
    Ready {
        key: ContextKey,
        context: GpuContext,
    },
    Failed {
        key: ContextKey,
        message: String,
        attempts: u32,
        failed_at: std::time::Instant,
    },
}

/// 建不起来之后隔多久允许再试一次。60 秒：比一次阅读会话里翻页的间隔长得多（否则等于
/// 每页都重试），又短到用户换完 DLL 或驱动更新完回来时通常已经过了。
const INIT_RETRY_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(60);

/// 同一份 DLL 最多真去建几次上下文。第三次之后彻底记住：那时候它多半是真的不兼容，
/// 继续重试只会把每一页都拖成一次几秒的初始化失败。
const MAX_INIT_ATTEMPTS: u32 = 3;

static CONTEXT: OnceLock<Mutex<ContextState>> = OnceLock::new();

/// 建过几份上下文（每次重建 +1）。测试拿它断言「作废之后确实重新建了一份」。
static CONTEXT_BUILDS: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
static POISONED_CONTEXT_DROPS: AtomicU64 = AtomicU64::new(0);

/// 测试用：建过几份上下文。
#[cfg(test)]
pub fn context_builds() -> u64 {
    CONTEXT_BUILDS.load(Ordering::Relaxed)
}

/// 测试用：缓存里现在挂着几份工作区。
///
/// 与 [`context_builds`] 不同，这是**当下**的数量——`release_cached_workspaces` 之后
/// 它必须归零，这条断言才说明纹理真的被放掉了而不是只改了计数器。
#[cfg(test)]
pub fn cached_workspace_count() -> usize {
    let cell = CONTEXT.get_or_init(|| Mutex::new(ContextState::Empty));
    let Ok(guard) = cell.lock() else {
        return 0;
    };
    match &*guard {
        ContextState::Ready { context, .. } => context.workspaces.len(),
        _ => 0,
    }
}

/// 测试用：下一次提交直接按「栅栏信号失败」处理。
///
/// 真的等一次 30 秒的栅栏超时没法进测试，但它与 `Signal` 失败、命令表重置失败走的
/// 是**同一条**中毒路径，所以在这里注入就够（报告 P1-1 的故障注入）。
#[cfg(test)]
static FAIL_SUBMIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
pub fn fail_next_submit(fail: bool) {
    FAIL_SUBMIT.store(fail, Ordering::SeqCst);
}

/// 这份上下文是按哪一份 DLL / 哪个数据目录建出来的。
///
/// NGX 的 `Init_Ext` 只认一块设备，进程内只初始化一次；而 DLL 是可以被换掉的
/// （用户导入另一种变体、或者从目录里换一份）。换过之后不能继续用旧上下文——那会
/// 让界面显示「已换成 community 版」而显存里跑的还是刚才那一份。大小与修改时间
/// 足以认出来（165MB 的哈希每次算一遍太贵，而换文件必然两者都变）。
#[derive(Clone, PartialEq, Eq)]
struct ContextKey {
    data_dir: PathBuf,
    dll: PathBuf,
    dll_bytes: u64,
    dll_modified: Option<std::time::SystemTime>,
}

impl ContextKey {
    fn of(data_dir: &std::path::Path, dll: &std::path::Path) -> Self {
        let metadata = std::fs::metadata(dll).ok();
        Self {
            data_dir: data_dir.to_path_buf(),
            dll: dll.to_path_buf(),
            dll_bytes: metadata.as_ref().map(|value| value.len()).unwrap_or(0),
            dll_modified: metadata.and_then(|value| value.modified().ok()),
        }
    }
}

/// 拿到全局上下文（第一次调用时建）。失败会被记住，但**不是永远**：同一份片段过了冷却窗
/// （`INIT_RETRY_COOLDOWN`）会再试一次，试满 `MAX_INIT_ATTEMPTS` 才彻底记住——一次瞬时
/// 失败（显卡刚唤醒、驱动/NVIDIA 应用刚更新完）不该让用户只能重启应用。
pub fn with_context<T>(
    data_dir: &std::path::Path,
    use_context: impl FnOnce(&mut GpuContext) -> Result<T, String>,
) -> Result<T, String> {
    let dll = super::dll_path(data_dir);
    with_context_at(data_dir, &dll, use_context)
}

/// 缓存槽里那份状态，对这一次 `(data_dir, dll)` 意味着什么。
///
/// 抽成纯决策是为了能单测这张表：真去走 `Rebuild` 那一格就要真的初始化一遍 NGX，
/// 而「初始化失败」正是进程内不该再试的那件事（`Failed` 状态存在的理由），测试里
/// 不能去踩；反过来 `AlreadyInitialized` 那一格也不能靠真建两份上下文来制造。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotStep {
    /// 就是它：直接跑。
    Run,
    /// 缓存里是另一份 DLL（或另一个数据目录）的上下文：NGX 换不掉，明确报错。
    AlreadyInitialized,
    /// 这一份已经失败过：报同一个错，不再初始化一遍。
    Remembered,
    /// 空槽、只是另一份 DLL 的失败记录、或者冷却窗已经过去且还没试满次数：去建一份。
    Rebuild,
}

/// 这一次 `(data_dir, dll)` 该怎么走。`now` 与失败记录的 `failed_at` 一起决定冷却窗；
/// 抽成参数是为了能单测「同一份 DLL 在冷却窗内记住、过了窗再试、试满次数又记住」。
fn slot_step(
    cached: Option<&ContextKey>,
    failed: Option<(&ContextKey, u32, std::time::Instant)>,
    key: &ContextKey,
    now: std::time::Instant,
) -> SlotStep {
    if cached.is_some_and(|existing| existing == key) {
        return SlotStep::Run;
    }
    if cached.is_some() {
        return SlotStep::AlreadyInitialized;
    }
    if let Some((remembered, attempts, failed_at)) = failed {
        if remembered == key {
            let cooled = now.saturating_duration_since(failed_at) >= INIT_RETRY_COOLDOWN;
            if cooled && attempts < MAX_INIT_ATTEMPTS {
                return SlotStep::Rebuild;
            }
            return SlotStep::Remembered;
        }
    }
    SlotStep::Rebuild
}

/// 同上，但 DLL 由调用方点名（测试指着 docs 里的那一份；应用指着用户导入的那一份）。
///
/// 上下文的三种去向都在这里决定：跑完没出事就放回缓存；**中毒**（GPU 提交/栅栏/重置
/// 失败）就整份丢掉，下一次请求重建；建不起来就按 DLL 指纹把失败记住，不再反复初始化
/// 那个进程内注定失败的 NGX。
pub fn with_context_at<T>(
    data_dir: &std::path::Path,
    dll: &std::path::Path,
    use_context: impl FnOnce(&mut GpuContext) -> Result<T, String>,
) -> Result<T, String> {
    let key = ContextKey::of(data_dir, dll);
    let cell = CONTEXT.get_or_init(|| Mutex::new(ContextState::Empty));
    let mut guard = cell.lock().map_err(|_| "DLSSNR 上下文锁失败".to_string())?;
    // 把上下文暂时取出来跑（锁还在手上）：跑完按它有没有中毒决定放回去还是丢掉。
    let state = std::mem::replace(&mut *guard, ContextState::Empty);
    let (cached, failed) = match &state {
        ContextState::Ready { key, .. } => (Some(key), None),
        ContextState::Failed {
            key,
            attempts,
            failed_at,
            ..
        } => (None, Some((key, *attempts, *failed_at))),
        ContextState::Empty => (None, None),
    };
    // 这一次失败已经试过几次：同一份 DLL 的失败记录会把它带下去，另一份从 0 起。
    let attempts = match &state {
        ContextState::Failed {
            key: failed_key,
            attempts,
            ..
        } if failed_key == &key => *attempts,
        _ => 0,
    };
    match slot_step(cached, failed, &key, std::time::Instant::now()) {
        SlotStep::Run => {
            let ContextState::Ready {
                key: existing,
                mut context,
            } = state
            else {
                unreachable!("Run 只可能来自 Ready")
            };
            let result = use_context(&mut context);
            match context.poisoned.clone() {
                // 提交/信号/栅栏/重置失败过：整份丢弃（`Drop` 里也不会再去碰 NGX），
                // 下一次请求重建。**这就是「一次 GPU 错误不能放大成后续请求连续失败」**。
                Some(reason) => Err(reset_required(&reason)),
                None => {
                    *guard = ContextState::Ready { key: existing, context };
                    result
                }
            }
        }
        SlotStep::AlreadyInitialized => {
            let ContextState::Ready {
                key: existing,
                context,
            } = state
            else {
                unreachable!("AlreadyInitialized 只可能来自 Ready")
            };
            // 旧上下文还活着，NGX 也已经在进程里初始化过了：这时候换一份 DLL 是
            // 换不掉的。宁可明确报错，也不要让用户以为自己在跑新导入的那一份。
            let message = format!(
                "DLSSNR 已经为另一份片段初始化过（{} 字节，数据目录 {}）：换过 DLL 之后要重启应用才会用新的那一份",
                existing.dll_bytes,
                existing.data_dir.display()
            );
            *guard = ContextState::Ready { key: existing, context };
            Err(message)
        }
        SlotStep::Remembered => {
            let ContextState::Failed {
                key: failed_key,
                message,
                attempts,
                failed_at,
            } = state
            else {
                unreachable!("Remembered 只可能来自 Failed")
            };
            // 同一份 DLL 已经失败过（且在冷却窗内、或者已经试满次数）：给同一个错，
            // 不再去初始化一遍 NGX。记录原样放回，冷却时间到了下一次自然会走 Rebuild。
            *guard = ContextState::Failed {
                key: failed_key,
                message: message.clone(),
                attempts,
                failed_at,
            };
            Err(message)
        }
        SlotStep::Rebuild => create_and_run(&mut guard, key, data_dir, dll, attempts, use_context),
    }
}

/// 初始化失败时给用户看的那句话：错误码 + **哪一份片段** + 怎么办 + 第几次。
///
/// 抽成纯函数是为了能不碰 GPU / NGX 就钉住这句话的每一段：真让 `GpuContext::create` 失败
/// 需要一台有显卡的机器，而且失败形态取决于当时车上的是哪一份 DLL。
fn init_failure_message(error: &str, dll: &std::path::Path, bytes: u64, tried: u32) -> String {
    // 试满次数之后就把「换一份 DLL 或重启」说死；还没试满则说明冷却窗过后会自动再试一次
    // ——用户看到的这句话决定了他是去换 DLL 还是干等。
    let hint = if tried >= MAX_INIT_ATTEMPTS {
        "这一份片段没能建起 GPU 上下文：换一份 DLL 或重启应用会重新尝试"
    } else {
        "这一份片段没能建起 GPU 上下文：过一会儿这一份会自己再试一次，也可以换一份 DLL 或重启应用"
    };
    // 文件名 + 字节数足以对上目录里那一份，又不必把 165MB 的哈希算一遍。
    let snippet = dll
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| dll.display().to_string());
    format!("{error}（片段 {snippet} · {bytes} 字节；{hint}；第 {tried} 次）")
}

/// 建一份新上下文并立刻跑这次请求（失败记住、中毒丢掉）。
fn create_and_run<T>(
    guard: &mut ContextState,
    key: ContextKey,
    data_dir: &std::path::Path,
    dll: &std::path::Path,
    attempts: u32,
    use_context: impl FnOnce(&mut GpuContext) -> Result<T, String>,
) -> Result<T, String> {
    match GpuContext::create(data_dir, dll) {
        Ok(mut context) => {
            CONTEXT_BUILDS.fetch_add(1, Ordering::Relaxed);
            let result = use_context(&mut context);
            match context.poisoned.clone() {
                Some(reason) => Err(reset_required(&reason)),
                None => {
                    *guard = ContextState::Ready { key, context };
                    result
                }
            }
        }
        Err(error) => {
            let tried = attempts.saturating_add(1);
            let message = init_failure_message(&error, dll, key.dll_bytes, tried);
            *guard = ContextState::Failed {
                key,
                message: message.clone(),
                attempts: tried,
                failed_at: std::time::Instant::now(),
            };
            Err(message)
        }
    }
}

/// 把缓存里的工作区全部放掉，返回放掉了几个。
///
/// 工作区缓存是为了「翻下一页不用重建 feature」而存在的，可它和进程同寿：阅读器早就
/// 停在某一页、甚至已经退回书架，那几份按 bucket 量化出来的纹理还留在缓存里。真机
/// 实测这些纹理的主体不在我们自己分配的那几张图上，而在每个 NGX feature 内部：
/// 一页 2731×4096 跑一层，进程**提交内存**（`PrivateMemorySize64`）从 45MB 涨到
/// 2.2GB；同尺寸跑五层涨到 9.5GB；把两份缓存档全部放掉，立刻回到 1.0GB 上下。
/// 也就是说「一页五层」这一档每趟会留下几个 GB 的提交内存，而缓存上限是两份。
///
/// 空闲时它们一个字节都没在干活，所以**离开阅读器**（或整本预处理停下来一会儿，
/// 见 `src/components/ReaderRoute.tsx`）时就交回：代价只是下一页第一趟重建 feature，
/// 实测几十到几百毫秒（见 `src-tauri/src/dlssnr/workspace.rs` 顶部那组数字），换来
/// 的是空闲占用落回基线。
///
/// 只放工作区，不动上下文本身：device / queue / NGX 的初始化比建 feature 贵得多，
/// 而且**同一份片段**在冷却窗内失败过就该记住（换一份 DLL 是另一份 key，会重新初始化，
/// 见 `slot_step`）。
pub fn release_cached_workspaces() -> usize {
    let cell = CONTEXT.get_or_init(|| Mutex::new(ContextState::Empty));
    let Ok(mut guard) = cell.lock() else {
        return 0;
    };
    let ContextState::Ready { context, .. } = &mut *guard else {
        return 0;
    };
    let dropped = context.workspaces.len();
    let runtime = &context.runtime;
    for mut workspace in context.workspaces.drain(..) {
        workspace.release(runtime);
    }
    dropped
}

fn fence_reached(completed: u64, target: u64) -> Result<bool, &'static str> {
    if completed == u64::MAX {
        Err("GPU 设备已移除（栅栏返回 UINT64_MAX）")
    } else {
        Ok(completed >= target)
    }
}

fn dlssnr_adapter_supported(vendor: u32, flags: u32) -> bool {
    vendor == 0x10de
        && flags & windows::Win32::Graphics::Dxgi::DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 == 0
}

impl GpuContext {
    fn create(data_dir: &std::path::Path, dll: &std::path::Path) -> Result<Self, String> {
        // 顺序不能换：核心 → 设备 → 片段。片段的 `Init_Ext` 一条也不能少（少了核心
        // 它不是报错，是崩）。
        let core = NgxCore::new();

        let device = create_device()?;
        // 片段交给核心加载一次：核心初始化时按搜索路径找到 `nvngx_dlssnr.dll` 并把它
        // 载进进程——片段的 `Init_Ext` **依赖这个会话**（没有它不是报错，是崩）。
        let feature_dir = dll.parent().unwrap_or(data_dir).to_path_buf();
        core.initialize(&device, data_dir, &feature_dir)?;
        // 再按我们自己的路把它加载一遍：`LoadLibraryExW` 命中同一个模块（引用计数 +1），
        // 拿到可以直接调的那五个导出，并装上「调用者叫 nvngx.dll」的兼容层。建 / 跑 / 还
        // feature 之后全走这一份——见 `GpuContext::runtime` 的注释。
        let runtime = super::ngx::DlssnrRuntime::load(dll)?;
        runtime.ensure_initialized(&device, data_dir)?;
        let queue: ID3D12CommandQueue = unsafe {
            device.CreateCommandQueue(&D3D12_COMMAND_QUEUE_DESC {
                Type: D3D12_COMMAND_LIST_TYPE_COMPUTE,
                ..Default::default()
            })
        }
        .map_err(|error| format!("创建 D3D12 命令队列失败：{error}"))?;
        let allocator: ID3D12CommandAllocator =
            unsafe { device.CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_COMPUTE) }
                .map_err(|error| format!("创建命令分配器失败：{error}"))?;
        let list: ID3D12GraphicsCommandList =
            unsafe { device.CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_COMPUTE, &allocator, None) }
                .map_err(|error| format!("创建命令表失败：{error}"))?;
        // 命令表建出来就处在「录制中」：直接开始记，不用先关一次（先关再记会被
        // D3D12 拒绝，Close 也只认一次）。提交时 `execute_and_wait` 会关它，之后再
        // Reset 打开。
        let fence: ID3D12Fence =
            unsafe { device.CreateFence(0, D3D12_FENCE_FLAG_NONE) }.map_err(|error| format!("创建栅栏失败：{error}"))?;

        // NGX 只认一块设备：初始化跟着设备走，一次。
        std::fs::create_dir_all(data_dir).map_err(|error| format!("创建 DLSSNR 数据目录失败：{error}"))?;

        Ok(Self {
            core,
            runtime,
            device,
            queue,
            allocator,
            list,
            fence,
            fence_event: FenceEvent::new()?,
            fence_value: 0,
            data_dir: data_dir.to_path_buf(),
            workspaces: Vec::new(),
            workspace_builds: 0,
            feature_builds: 0,
            workspace_gpu_bytes_per_pixel: 192,
            workspace_commit_bytes_per_pixel: 192,
            poisoned: None,
        })
    }

    /// 标记这一份上下文已经作废，并给出带稳定错误码的错误。
    ///
    /// 拿不准 GPU 有没有停下时用它——它意味着整份设备上下文作废：`with_context_at`
    /// 会把这一份丢掉，下一次请求重新建 device/queue/allocator/list/workspace。
    fn poison(&mut self, reason: String) -> String {
        self.poisoned = Some(reason.clone());
        reset_required(&reason)
    }

    /// 分配一个参数对象（NGX 核心分配，析构也还给它）。
    pub fn allocate_parameters(&self) -> Result<Parameters, String> {
        self.core.allocate_parameters()
    }

    /// 把当前记录好的命令提交掉，并等 GPU 跑完。
    ///
    /// 这里的**每一条失败路径都会让整份上下文作废**（`poison`）：关闭失败时命令表处在
    /// 未知状态；`Signal` 失败或栅栏超时时命令已经发出去了、GPU 有没有停下不知道；
    /// 重置失败则这张命令表再也记不了下一页。作废之后调用方不能再拿工作区去 `release`
    /// （见 `filter::run`），`with_context_at` 会把上下文从缓存里摘掉。
    pub fn execute_and_wait(&mut self) -> Result<(), String> {
        // 测试注入：按「提交/栅栏信号失败」处理。真的等一次 30 秒超时没法进测试，
        // 但它走的是同一条中毒路径。
        #[cfg(test)]
        if FAIL_SUBMIT.swap(false, Ordering::SeqCst) {
            return Err(self.poison("注入的提交失败（测试）".to_string()));
        }
        if let Err(error) = unsafe { self.list.Close() } {
            for message in info_queue_messages(&self.device) {
                eprintln!("[dlssnr] 调试层：{message}");
            }
            // 命令还没提交过，理论上 reset 一下就能重来；但连关闭都失败，说明命令表
            // 已经不是记录时的样子了——试着收回去，然后整份作废。
            let _ = self.discard_recorded();
            return Err(self.poison(format!("关闭命令表失败：{error}")));
        }
        let lists = [Some(self.list.cast::<ID3D12CommandList>().map_err(|error| error.to_string())?)];
        unsafe { self.queue.ExecuteCommandLists(&lists) };

        self.fence_value += 1;
        if let Err(error) = unsafe { self.queue.Signal(&self.fence, self.fence_value) } {
            return Err(self.poison(format!("信号栅栏失败：{error}")));
        }
        // Match the reference pipelines' fence-event wait: no one-millisecond
        // polling or extra CPU wakeups. Check removal both before and after wait.
        let completed = unsafe { self.fence.GetCompletedValue() };
        if !fence_reached(completed, self.fence_value).map_err(|reason| self.poison(reason.to_string()))? {
            if let Err(error) = unsafe { self.fence.SetEventOnCompletion(self.fence_value, self.fence_event.0) } {
                return Err(self.poison(format!("设置 GPU 栅栏事件失败：{error}")));
            }
            let waited = unsafe { WaitForSingleObject(self.fence_event.0, 30_000) };
            if waited == WAIT_TIMEOUT {
                return Err(self.poison("等待 GPU 超过 30 秒".to_string()));
            }
            if waited != WAIT_OBJECT_0 {
                return Err(self.poison(format!("等待 GPU 栅栏事件失败：{}", waited.0)));
            }
            let completed = unsafe { self.fence.GetCompletedValue() };
            if !fence_reached(completed, self.fence_value).map_err(|reason| self.poison(reason.to_string()))? {
                return Err(self.poison("GPU 栅栏事件触发但任务尚未完成".to_string()));
            }
        }
        if let Err(error) = unsafe { self.allocator.Reset() } {
            return Err(self.poison(format!("重置分配器失败：{error}")));
        }
        if let Err(error) = unsafe { self.list.Reset(&self.allocator, None) } {
            return Err(self.poison(format!("重置命令表失败：{error}")));
        }
        Ok(())
    }

    /// 丢掉这张命令表上已记录、但决定不提交的命令（取消时用）。
    ///
    /// **不执行**：命令没提交过，纹理的实际状态也就没变过——下次重新记录时那些
    /// 「开场状态」的假设依然成立（见 `workspace` 模块头的状态机）。
    ///
    /// 收不回去就说明这份上下文也不能再用了（命令表停在不可记录的状态）：标中毒。
    pub fn discard_recorded(&mut self) -> Result<(), String> {
        let _ = unsafe { self.list.Close() };
        if let Err(error) = unsafe { self.allocator.Reset() } {
            return Err(self.poison(format!("重置分配器失败：{error}")));
        }
        if let Err(error) = unsafe { self.list.Reset(&self.allocator, None) } {
            return Err(self.poison(format!("重置命令表失败：{error}")));
        }
        Ok(())
    }

    /// 取一个装得下这一页的工作区：装得下就复用（同一 bucket 不会重建 feature），
    /// 否则按量化尺寸新建一个。用完交回 [`GpuContext::release_workspace`]。
    ///
    /// `forced` 是试验用的：点名一个创建尺寸（要装得下这一页），好让「按页尺寸建
    /// feature」那条老路还能跑，与 bucket 那一路对比输出。
    pub fn acquire_workspace(
        &mut self,
        width: u32,
        height: u32,
        passes: usize,
        forced: Option<(u32, u32)>,
    ) -> Result<Workspace, String> {
        let choice = match forced {
            Some(size) => {
                if size.0 < width || size.1 < height {
                    return Err(format!(
                        "bucket {}×{} 装不下这一页 {width}×{height}",
                        size.0, size.1
                    ));
                }
                match self.workspaces.iter().position(|item| item.size == size) {
                    Some(index) => workspace::Choice::Reuse(index),
                    None => workspace::Choice::Create(size),
                }
            }
            None => workspace::choose(&self.workspace_sizes(), (width, height)),
        };
        match choice {
            workspace::Choice::Reuse(index) => {
                let mut existing = self.workspaces.remove(index);
                if let Err(error) = existing.ensure_features(self, passes) {
                    if self.poisoned.is_none() {
                        self.discard_recorded()?;
                        existing.release(&self.runtime);
                    }
                    return Err(error);
                }
                Ok(existing)
            }
            workspace::Choice::Create(size) => {
                let pixels = u64::from(size.0) * u64::from(size.1);
                // Internal NGX allocations dominate textures. Spare buckets
                // survive only if BOTH live budgets can cover the new bucket.
                // Unknown readings revert to releasing before creating.
                let predicted_gpu = pixels.saturating_mul(self.workspace_gpu_bytes_per_pixel).saturating_add(256 << 20);
                let predicted_commit = pixels.saturating_mul(self.workspace_commit_bytes_per_pixel).saturating_add(256 << 20);
                while !self.workspaces.is_empty() && (!workspace::spare_allocation_fits(
                    self.video_memory(), crate::resources::system_memory(), predicted_gpu, predicted_commit,
                ) || self.workspaces.len() >= workspace::MAX_WORKSPACES) {
                    if let Some(mut old) = self.workspaces.pop() { old.release(&self.runtime); }
                }
                let gpu_before = self.video_memory();
                let commit_before = crate::resources::system_memory();
                let mut result = self.create_clean_workspace(size, passes);
                if !self.workspaces.is_empty() && self.poisoned.is_none() && result.as_ref().err().is_some_and(|error| {
                    crate::resources::is_allocation_error(&crate::error::ComputeError::InvalidInput(error.clone()))
                }) {
                    // A model may exceed the learned estimate. Release all
                    // spares and make exactly one clean allocation attempt.
                    for mut old in self.workspaces.drain(..) { old.release(&self.runtime); }
                    result = self.create_clean_workspace(size, passes);
                }
                if result.is_ok() {
                    if let (Some(before), Some(after)) = (gpu_before, self.video_memory()) {
                        self.workspace_gpu_bytes_per_pixel = self.workspace_gpu_bytes_per_pixel.max(after.used_bytes.saturating_sub(before.used_bytes).saturating_sub(256 << 20).div_ceil(pixels.max(1)));
                    }
                    if let (Some(before), Some(after)) = (commit_before, crate::resources::system_memory()) {
                        self.workspace_commit_bytes_per_pixel = self.workspace_commit_bytes_per_pixel.max(after.private_commit_bytes.saturating_sub(before.private_commit_bytes).saturating_sub(256 << 20).div_ceil(pixels.max(1)));
                    }
                }
                result
            }
        }
    }

    /// 把工作区交回缓存：最近用过的排前面，超出条数或显存预算就从最久没用的开始扔。
    ///
    /// 至少留一个（刚用过的这个）——否则一张长条页会把普通页那一档挤掉，紧接着的
    /// 下一页又要重建 feature，正好抵消这层想省的东西。
    pub fn release_workspace(&mut self, workspace: Workspace) {
        if let Some(index) = self.workspaces.iter().position(|item| item.size == workspace.size) {
            // 同尺寸不该有两份（取的时候是移出去的，这条只是兜底）。
            let mut stale = self.workspaces.remove(index);
            stale.release(&self.runtime);
        }
        self.workspaces.insert(0, workspace);
        let gpu = self.video_memory();
        let system = crate::resources::system_memory();
        let keep_spares = keep_spare_workspaces(gpu, system);
        let limit = if keep_spares { workspace::MAX_WORKSPACES } else if gpu.is_some() && system.is_some() { 0 } else { 1 };
        while self.workspaces.len() > limit {
            if let Some(mut dropped) = self.workspaces.pop() {
                dropped.release(&self.runtime);
            }
        }
    }

    fn video_memory(&self) -> Option<super::gpu::VideoMemory> {
        let id = unsafe { self.device.GetAdapterLuid() };
        let luid = ((id.HighPart as i64) << 32) | id.LowPart as i64;
        super::gpu::video_memory_for_luid(luid)
    }

    fn create_clean_workspace(&mut self, size: (u32, u32), passes: usize) -> Result<Workspace, String> {
        let result = Workspace::create(self, size, passes);
        // Even early texture allocation failures may leave guide upload
        // commands recorded against resources that are now gone. Never let
        // the next attempt submit those dangling commands.
        if result.is_err() && self.poisoned.is_none() { self.discard_recorded()?; }
        result
    }

    /// 现有工作区的尺寸，按「最近用过」排（给 `workspace::choose` 挑）。
    fn workspace_sizes(&self) -> Vec<(u32, u32)> {
        self.workspaces.iter().map(|item| item.size).collect()
    }

    /// 建一张默认堆纹理。
    pub fn create_texture(
        &self,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
        flags: D3D12_RESOURCE_FLAGS,
    ) -> Result<ID3D12Resource, String> {
        let heap = D3D12_HEAP_PROPERTIES {
            Type: D3D12_HEAP_TYPE_DEFAULT,
            ..Default::default()
        };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
            Alignment: 0,
            Width: width as u64,
            Height: height,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
            Flags: flags,
        };
        committed_resource(&self.device, &heap, &desc, D3D12_RESOURCE_STATE_COMMON)
            .map_err(|error| format!("创建纹理失败（{width}x{height}）：{error}"))
    }

    /// 记录一次 RGBA8 上传（**不提交**）：`from` 是这张纹理当前的状态。
    ///
    /// 返回上传缓冲：它还被这一批命令引用，**要活到提交之后**——提前 drop 就是让
    /// GPU 去拷一个已经析构的资源。
    pub fn record_upload_rgba(
        &self,
        texture: &ID3D12Resource,
        from: D3D12_RESOURCE_STATES,
        width: u32,
        height: u32,
        bytes: &[u8],
    ) -> Result<ID3D12Resource, String> {
        self.record_upload_like(texture, from, DXGI_FORMAT_R8G8B8A8_UNORM, width, height, bytes, 4)
    }

    /// `record_upload_rgba` 的通用版：任意像素宽度与格式（引导图用得上）。
    ///
    /// 拷贝按 `width`×`height` **有界**：纹理是 bucket（可能比这一页大），无界拷贝会
    /// 连纹理上多出来的那片一起算，而缓冲没有那么大。footprint 那一侧的格式必须写
    /// 纹理的格式——调试层对缓冲那侧的 footprint 会按「Height/Depth 推出的纹理维度」
    /// 检查格式，写 UNKNOWN 会被挡下来（这里踩过一次）。
    pub fn record_upload_like(
        &self,
        texture: &ID3D12Resource,
        from: D3D12_RESOURCE_STATES,
        format: DXGI_FORMAT,
        width: u32,
        height: u32,
        bytes: &[u8],
        bytes_per_pixel: u32,
    ) -> Result<ID3D12Resource, String> {
        let row_pitch = width * bytes_per_pixel;
        let aligned_pitch = (row_pitch + 255) & !255;
        let buffer = self.create_buffer(D3D12_HEAP_TYPE_UPLOAD, aligned_pitch as u64 * height as u64)?;
        unsafe {
            let mut mapped: *mut std::ffi::c_void = std::ptr::null_mut();
            buffer
                .Map(0, None, Some(&mut mapped))
                .map_err(|error| format!("映射上传缓冲失败：{error}"))?;
            for row in 0..height as usize {
                let source = &bytes[row * row_pitch as usize..(row + 1) * row_pitch as usize];
                std::ptr::copy_nonoverlapping(
                    source.as_ptr(),
                    (mapped as *mut u8).add(row * aligned_pitch as usize),
                    row_pitch as usize,
                );
            }
            buffer.Unmap(0, None);
        }

        self.transition(texture, from, D3D12_RESOURCE_STATE_COPY_DEST);
        let footprint = D3D12_PLACED_SUBRESOURCE_FOOTPRINT {
            Offset: 0,
            Footprint: D3D12_SUBRESOURCE_FOOTPRINT {
                Format: format,
                Width: width,
                Height: height,
                Depth: 1,
                RowPitch: aligned_pitch,
            },
        };
        self.copy_buffer_to_texture(texture, &buffer, footprint, width, height);
        self.transition(texture, D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        Ok(buffer)
    }

    /// 记录一张全零的引导图（建纹理 + 上传零，**不提交**）。
    ///
    /// 运动与深度都按零给：静态图片没有运动，深度也按契约给零。返回（纹理, 上传
    /// 缓冲）：缓冲要活到提交之后。
    pub fn record_zero_guide(
        &self,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
        bytes_per_pixel: u32,
    ) -> Result<(ID3D12Resource, ID3D12Resource), String> {
        let texture = self.create_texture(width, height, format, D3D12_RESOURCE_FLAGS(0))?;
        let zeros = vec![0u8; width as usize * height as usize * bytes_per_pixel as usize];
        let buffer = self.record_upload_like(
            &texture,
            D3D12_RESOURCE_STATE_COMMON,
            format,
            width,
            height,
            &zeros,
            bytes_per_pixel,
        )?;
        Ok((texture, buffer))
    }

    /// 记录一次回读（**不提交**）：把纹理左上角 `width`×`height` 那一块拷进回读缓冲。
    ///
    /// 大纹理里跑小页（bucket）全靠这一圈源 box：不给 box，`CopyTextureRegion` 会把
    /// 整个 subresource 拷进按小页开的缓冲里（这里踩过一次）。
    pub fn record_read_back(
        &self,
        texture: &ID3D12Resource,
        width: u32,
        height: u32,
        texture_width: u32,
        texture_height: u32,
    ) -> Result<ID3D12Resource, String> {
        let row_pitch = width * 4;
        let aligned_pitch = (row_pitch + 255) & !255;
        let buffer = self.create_buffer(D3D12_HEAP_TYPE_READBACK, aligned_pitch as u64 * height as u64)?;
        self.transition(texture, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_COPY_SOURCE);
        let footprint = D3D12_PLACED_SUBRESOURCE_FOOTPRINT {
            Offset: 0,
            Footprint: D3D12_SUBRESOURCE_FOOTPRINT {
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                Width: width,
                Height: height,
                Depth: 1,
                RowPitch: aligned_pitch,
            },
        };
        let mut destination = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(buffer.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { PlacedFootprint: footprint },
        };
        let mut source = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(texture.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { SubresourceIndex: 0 },
        };
        let region = D3D12_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: width.min(texture_width),
            bottom: height.min(texture_height),
            back: 1,
        };
        unsafe {
            self.list.CopyTextureRegion(&destination, 0, 0, 0, &source, Some(&region));
            // These CPU descriptors do not own GPU work. The returned buffer and
            // workspace keep the resources alive until the fence completes.
            std::mem::ManuallyDrop::drop(&mut destination.pResource);
            std::mem::ManuallyDrop::drop(&mut source.pResource);
        }
        Ok(buffer)
    }

    /// 提交并等 GPU 跑完之后，把回读缓冲映成紧凑的 RGBA8。
    pub fn map_read_back(&self, buffer: &ID3D12Resource, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let row_pitch = width * 4;
        let aligned_pitch = (row_pitch + 255) & !255;
        let mut rgba = vec![0u8; row_pitch as usize * height as usize];
        unsafe {
            let mut mapped: *mut std::ffi::c_void = std::ptr::null_mut();
            let range = D3D12_RANGE {
                Begin: 0,
                End: rgba.len(),
            };
            buffer
                .Map(0, Some(&range), Some(&mut mapped))
                .map_err(|error| format!("映射回读缓冲失败：{error}"))?;
            for row in 0..height as usize {
                let target = &mut rgba[row * row_pitch as usize..(row + 1) * row_pitch as usize];
                std::ptr::copy_nonoverlapping(
                    (mapped as *const u8).add(row * aligned_pitch as usize),
                    target.as_mut_ptr(),
                    row_pitch as usize,
                );
            }
            buffer.Unmap(0, None);
        }
        Ok(rgba)
    }

    /// 缓冲 → 纹理的一次拷贝，按 `width`×`height` 有界（纹理可能比这一块大）。
    /// 两侧的 `Type` 不能搞反：**纹理那侧是 `SUBRESOURCE_INDEX`，缓冲那侧才是
    /// `PLACED_FOOTPRINT`**——反了调试层会直接说「PLACED_FOOTPRINT 只能配
    /// DIMENSION_BUFFER 的资源」（这里踩过一次）。
    fn copy_buffer_to_texture(
        &self,
        texture: &ID3D12Resource,
        buffer: &ID3D12Resource,
        footprint: D3D12_PLACED_SUBRESOURCE_FOOTPRINT,
        width: u32,
        height: u32,
    ) {
        let mut texture_location = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(texture.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { SubresourceIndex: 0 },
        };
        let mut buffer_location = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(buffer.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { PlacedFootprint: footprint },
        };
        let region = D3D12_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: width,
            bottom: height,
            back: 1,
        };
        unsafe {
            self.list
                .CopyTextureRegion(&texture_location, 0, 0, 0, &buffer_location, Some(&region));
            std::mem::ManuallyDrop::drop(&mut texture_location.pResource);
            std::mem::ManuallyDrop::drop(&mut buffer_location.pResource);
        };
    }

    fn create_buffer(&self, heap_type: D3D12_HEAP_TYPE, size: u64) -> Result<ID3D12Resource, String> {
        let heap = D3D12_HEAP_PROPERTIES {
            Type: heap_type,
            ..Default::default()
        };
        // 每种堆只认自己的初始状态：上传堆是 GENERIC_READ，回读堆是 COPY_DEST——
        // 给错了 CreateCommittedResource 直接 E_INVALIDARG。
        let initial = if heap_type == D3D12_HEAP_TYPE_READBACK {
            D3D12_RESOURCE_STATE_COPY_DEST
        } else {
            D3D12_RESOURCE_STATE_GENERIC_READ
        };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_BUFFER,
            Alignment: 0,
            Width: size,
            Height: 1,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: DXGI_FORMAT_UNKNOWN,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Layout: D3D12_TEXTURE_LAYOUT_ROW_MAJOR,
            Flags: D3D12_RESOURCE_FLAGS(0),
        };
        committed_resource(&self.device, &heap, &desc, initial)
            .map_err(|error| format!("创建缓冲失败（{size} 字节）：{error}"))
    }

    /// 一次状态转换（不提交，跟着同一张命令表走）。
    pub fn transition(
        &self,
        resource: &ID3D12Resource,
        from: D3D12_RESOURCE_STATES,
        to: D3D12_RESOURCE_STATES,
    ) {
        let barrier = D3D12_RESOURCE_BARRIER {
            Type: D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
            Flags: D3D12_RESOURCE_BARRIER_FLAG_NONE,
            Anonymous: D3D12_RESOURCE_BARRIER_0 {
                Transition: std::mem::ManuallyDrop::new(D3D12_RESOURCE_TRANSITION_BARRIER {
                    pResource: std::mem::ManuallyDrop::new(Some(resource.clone())),
                    Subresource: D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
                    StateBefore: from,
                    StateAfter: to,
                }),
            },
        };
        let mut barriers = [barrier];
        unsafe {
            self.list.ResourceBarrier(&barriers);
            // The union's ManuallyDrop suppresses Release; recording alone does
            // not balance the clone's AddRef. Release exactly the active member.
            std::mem::ManuallyDrop::drop(&mut (*barriers[0].Anonymous.Transition).pResource);
        }
    }
}

impl Drop for GpuContext {
    fn drop(&mut self) {
        if self.poisoned.is_some() {
            #[cfg(test)]
            POISONED_CONTEXT_DROPS.fetch_add(1, Ordering::Relaxed);
            // 已经作废的上下文（提交失败 / 栅栏超时 / 设备丢了）：GPU 是否停下未知，
            // 这时候再去调 NGX 释放 feature 只是拿一个状态未知的设备开玩笑——整份
            // 交给进程/驱动回收（报告 P1-1：不要在没有确认 GPU 停下时去动资源）。
            return;
        }
        // feature 句柄要还给 NGX；纹理靠 D3D12 自己的引用计数。
        for workspace in self.workspaces.iter_mut() {
            workspace.release(&self.runtime);
        }
    }
}

/// `CreateCommittedResource` 在 windows 0.62 里的形状是「写进一个 out 参数」，
/// 包一层让它读起来还是「返回一张资源」。
fn committed_resource(
    device: &ID3D12Device,
    heap: &D3D12_HEAP_PROPERTIES,
    desc: &D3D12_RESOURCE_DESC,
    initial: D3D12_RESOURCE_STATES,
) -> Result<ID3D12Resource, String> {
    let mut resource: Option<ID3D12Resource> = None;
    unsafe {
        device
            .CreateCommittedResource(heap, D3D12_HEAP_FLAG_NONE, desc, initial, None, &mut resource)
            .map_err(|error| error.message().to_string())?;
    }
    resource.ok_or_else(|| "D3D12 没有返回资源".to_string())
}

/// 在指定适配器上建一块 D3D12 设备；`None` 是默认适配器。
/// 打开 D3D12 调试层（机器上装了「图形工具」才有）：失败时它会在信息队列里写下
/// 原因，比一个 `0x80070057` 有用得多。
fn enable_debug_layer() {
    use windows::Win32::Graphics::Direct3D12::{D3D12GetDebugInterface, ID3D12Debug};
    let mut debug: Option<ID3D12Debug> = None;
    if unsafe { D3D12GetDebugInterface(&mut debug) }.is_ok() {
        if let Some(debug) = debug {
            unsafe { debug.EnableDebugLayer() };
        }
    }
}

fn create_device_on(adapter: Option<&IDXGIAdapter1>) -> Result<ID3D12Device, String> {
    enable_debug_layer();
    let mut device: Option<ID3D12Device> = None;
    let result = unsafe {
        match adapter {
            Some(adapter) => D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, &mut device),
            None => D3D12CreateDevice(None, D3D_FEATURE_LEVEL_11_0, &mut device),
        }
    };
    result.map_err(|error| error.message().to_string())?;
    device.ok_or_else(|| "D3D12 没有返回设备".to_string())
}

/// 建一块支持 compute 队列的设备（优先独显）。
pub(super) fn create_device() -> Result<ID3D12Device, String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|error| format!("创建 DXGI 工厂失败：{error}"))?;
    let mut index = 0u32;
    let mut last_error = String::from("没有可用的 D3D12 适配器");
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(_) => break,
        };
        index += 1;
        let desc = match unsafe { adapter.GetDesc1() } {
            Ok(desc) => desc,
            Err(error) => { last_error = error.to_string(); continue; }
        };
        // Capability detection already names an NVIDIA device. Selecting the
        // first D3D12-capable iGPU here contradicts that gate on hybrid systems.
        if !dlssnr_adapter_supported(desc.VendorId, desc.Flags) { continue; }
        match create_device_on(Some(&adapter)) {
            Ok(device) => return Ok(device),
            Err(error) => last_error = error,
        }
    }
    Err(format!("没有可用的 NVIDIA D3D12 设备：{last_error}"))
}


/// 调试层攒下的消息（没装调试层就是空）。
fn info_queue_messages(device: &ID3D12Device) -> Vec<String> {
    use windows::Win32::Graphics::Direct3D12::ID3D12InfoQueue;
    use windows::core::Interface;

    let Ok(queue) = device.cast::<ID3D12InfoQueue>() else {
        return Vec::new();
    };
    let count = unsafe { queue.GetNumStoredMessages() };
    let mut messages = Vec::new();
    for index in 0..count.min(16) {
        let mut size = 0usize;
        if unsafe { queue.GetMessage(index, None, &mut size) }.is_err() || size == 0 {
            continue;
        }
        let mut buffer = vec![0u8; size];
        let message = buffer.as_mut_ptr() as *mut windows::Win32::Graphics::Direct3D12::D3D12_MESSAGE;
        if unsafe { queue.GetMessage(index, Some(message), &mut size) }.is_err() {
            continue;
        }
        let message = unsafe { &*message };
        let text = unsafe {
            std::slice::from_raw_parts(message.pDescription as *const u8, message.DescriptionByteLength)
        };
        messages.push(String::from_utf8_lossy(&text[..text.len().saturating_sub(1)]).to_string());
    }
    messages
}

/// 这台机器愿不愿意留备用工作区（`GpuContext::release_workspace` 的那条判据）。
///
/// 产品路径就是内存策略：提交量超过物理内存四分之一时，刚交回的那一份会被立刻丢掉，
/// 于是每页各建一次工作区。那是策略按自己的规矩办事，不是回归——但测试里量「同尺寸
/// 复用」的那几条判据会因此忽绿忽红（跑测试时提交量本来就高）。测试可以用
/// [`force_spare_workspaces`] 把这条钉成确定值，判据就只量复用本身。
fn keep_spare_workspaces(
    gpu: Option<super::gpu::VideoMemory>,
    system: Option<crate::resources::SystemMemory>,
) -> bool {
    #[cfg(test)]
    match SPARE_WORKSPACES_OVERRIDE.load(std::sync::atomic::Ordering::Relaxed) {
        1 => return true,
        0 => return false,
        _ => {}
    }
    workspace::spare_allocation_fits(gpu, system, 0, 0)
}

/// 测试用：把「留不留备用工作区」钉死（`None` 恢复按内存策略），返回之前的值。
#[cfg(test)]
pub(crate) fn force_spare_workspaces(force: Option<bool>) -> Option<bool> {
    let next = match force {
        None => -1i8,
        Some(false) => 0,
        Some(true) => 1,
    };
    let previous = SPARE_WORKSPACES_OVERRIDE.swap(next, std::sync::atomic::Ordering::Relaxed);
    match previous {
        -1 => None,
        0 => Some(false),
        _ => Some(true),
    }
}

#[cfg(test)]
static SPARE_WORKSPACES_OVERRIDE: std::sync::atomic::AtomicI8 =
    std::sync::atomic::AtomicI8::new(-1);

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 一个上下文、一份失败记录各自的去向（审计报告 P1-1 的第三、四条）。
    ///
    /// 只测决策表，不碰全局槽，也不去真的初始化 NGX：走 `Rebuild` 那一格就要真的建一份
    /// 上下文，而「初始化失败」是进程内不该再试的那件事（`Failed` 状态存在的理由），
    /// 测试里踩一次会把整组 GPU 测试弄坏；`AlreadyInitialized` 那一格也不能靠真建两份
    /// 上下文来制造（NGX 只认一块设备）。
    #[test]
    fn the_slot_keeps_one_context_and_remembers_a_failure_per_dll() {
        let dir = std::env::temp_dir().join("yomika-dlssnr-slot-step");
        std::fs::create_dir_all(&dir).expect("临时目录");
        let first = dir.join("first.dll");
        let second = dir.join("second.dll");
        std::fs::write(&first, vec![0u8; 8]).expect("写第一份片段");
        std::fs::write(&second, vec![0u8; 16]).expect("写第二份片段");
        let other_dir = dir.join("other-data");
        std::fs::create_dir_all(&other_dir).expect("另一个数据目录");

        let first_key = ContextKey::of(&dir, &first);
        let second_key = ContextKey::of(&dir, &second);
        let other_key = ContextKey::of(&other_dir, &first);
        let now = std::time::Instant::now();

        // 空槽：去建。
        assert_eq!(slot_step(None, None, &first_key, now), SlotStep::Rebuild);
        // 缓存里是第一份：同一份直接跑。
        assert_eq!(
            slot_step(Some(&first_key), None, &first_key, now),
            SlotStep::Run
        );
        // 换一份 DLL、或换一个数据目录：都换不掉（NGX 只认一块设备，只能报错让用户重启）。
        assert_eq!(
            slot_step(Some(&first_key), None, &second_key, now),
            SlotStep::AlreadyInitialized
        );
        assert_eq!(
            slot_step(Some(&first_key), None, &other_key, now),
            SlotStep::AlreadyInitialized
        );
        // 第一份**刚**失败过：同一份报回记住的那个错，不再初始化一遍（冷却窗还没到）。
        assert_eq!(
            slot_step(None, Some((&first_key, 1, now)), &first_key, now),
            SlotStep::Remembered
        );
        // 而另一份（或另一个数据目录）不该被那份记录挡着：重新试。
        assert_eq!(
            slot_step(None, Some((&first_key, 1, now)), &second_key, now),
            SlotStep::Rebuild
        );
        assert_eq!(
            slot_step(None, Some((&first_key, 1, now)), &other_key, now),
            SlotStep::Rebuild
        );
    }

    /// 冷却窗与重试次数：同一份 DLL 的失败**不该**记到进程结束。
    ///
    /// 真机日志里那 11 条 `0xBAD00001` 是同一秒里同一个失败被记住了 11 次，而用户随后
    /// 换回了官方片段——旧行为下他除了重启应用没有任何办法让它再试一次。这条判据钉住的
    /// 是「过了冷却窗就真的再建一遍」，同时钉住「试满次数之后不再反复试」。
    /// 失败那句话必须说清「哪一份片段」：真机上用户换过变体，三份都叫同一个文件名，
    /// 日志里只留一个错误码时谁也说不清当时车上的是哪一份（2026-10-13 的 0xBAD00001）。
    #[test]
    fn the_init_failure_message_names_the_snippet_that_was_in_use() {
        let dll = std::path::Path::new("C:\\data\\dlssnr\\nvngx_dlssnr.dll");
        let failure = "NGX 核心初始化失败：这个功能在当前系统/硬件/图形 API 上不支持（0xBAD00001）";
        let first = init_failure_message(failure, dll, 165_840_496, 1);
        assert!(first.contains("nvngx_dlssnr.dll"), "{first}");
        assert!(first.contains("165840496 字节"), "{first}");
        assert!(first.contains("第 1 次"), "{first}");
        // 还没试满：这句话得让用户知道「可以等」。
        assert!(first.contains("过一会儿这一份会自己再试一次"), "{first}");
        // 试满之后不能再承诺重试：只能让他换 DLL 或重启。
        let last = init_failure_message(failure, dll, 165_840_496, MAX_INIT_ATTEMPTS);
        assert!(last.contains("换一份 DLL 或重启应用会重新尝试"), "{last}");
        assert!(!last.contains("过一会儿这一份会自己再试一次"), "{last}");
    }

    #[test]
    fn a_remembered_failure_is_retried_after_the_cooldown_until_the_attempts_run_out() {
        let dir = std::env::temp_dir().join("yomika-dlssnr-slot-cooldown");
        std::fs::create_dir_all(&dir).expect("临时目录");
        let dll = dir.join("snippet.dll");
        std::fs::write(&dll, vec![0u8; 8]).expect("写片段");
        let other = dir.join("other.dll");
        std::fs::write(&other, vec![1u8; 8]).expect("写另一份片段");
        let key = ContextKey::of(&dir, &dll);
        let other_key = ContextKey::of(&dir, &other);
        let now = std::time::Instant::now();
        let almost = INIT_RETRY_COOLDOWN - std::time::Duration::from_secs(1);

        assert_eq!(
            slot_step(None, Some((&key, 1, now)), &key, now),
            SlotStep::Remembered,
            "刚失败过的同一份 DLL 不该立刻重试"
        );
        assert_eq!(
            slot_step(None, Some((&key, 1, now)), &key, now + almost),
            SlotStep::Remembered,
            "冷却窗没到就不该重试"
        );
        assert_eq!(
            slot_step(None, Some((&key, 1, now)), &key, now + INIT_RETRY_COOLDOWN),
            SlotStep::Rebuild,
            "过了冷却窗、还没试满次数，就该真的再建一遍"
        );
        assert_eq!(
            slot_step(
                None,
                Some((&key, MAX_INIT_ATTEMPTS, now)),
                &key,
                now + INIT_RETRY_COOLDOWN * 10
            ),
            SlotStep::Remembered,
            "试满次数之后不该再试"
        );
        assert_eq!(
            slot_step(None, Some((&other_key, MAX_INIT_ATTEMPTS, now)), &key, now),
            SlotStep::Rebuild,
            "另一份 DLL 的失败记录不该挡着这一份"
        );
    }

    /// D3D12 descriptors contain ManuallyDrop COM fields. Each clone must release
    /// its AddRef after recording, not pin every page/upload/readback until exit.
    #[test]
    fn recording_page_commands_does_not_leak_com_references() {
        let _gpu = crate::dlssnr::tests::gpu_test_lock();
        let Some(dll) = crate::dlssnr::tests::test_dll() else {
            eprintln!("SKIP: no DLSSNR DLL for COM lifetime test");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).unwrap();
        with_context_at(&dir, &dll, |context| {
            fn refs(resource: &ID3D12Resource) -> u32 {
                let unknown = resource.cast::<windows::core::IUnknown>().unwrap();
                unsafe {
                    (unknown.vtable().AddRef)(unknown.as_raw());
                    // Release returns the count with the temporary cast still alive.
                    (unknown.vtable().Release)(unknown.as_raw()) - 1
                }
            }
            let texture = context.create_texture(64, 64, DXGI_FORMAT_R8G8B8A8_UNORM, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS)?;
            let before = refs(&texture);
            for _ in 0..16 {
                let upload = context.record_upload_rgba(&texture, D3D12_RESOURCE_STATE_COMMON, 64, 64, &vec![0; 64 * 64 * 4])?;
                context.transition(&texture, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
                let readback = context.record_read_back(&texture, 64, 64, 64, 64)?;
                context.discard_recorded()?;
                assert_eq!(refs(&upload), 1, "upload descriptor leaked a COM reference");
                assert_eq!(refs(&readback), 1, "readback descriptor leaked a COM reference");
                assert_eq!(refs(&texture), before, "copy/barrier descriptors leaked texture references");
            }
            Ok(())
        }).expect("record commands and release descriptor references");
    }


    #[test]
    fn a_removed_device_fence_never_counts_as_completed() {
        assert_eq!(fence_reached(4, 5), Ok(false));
        assert_eq!(fence_reached(5, 5), Ok(true));
        assert!(fence_reached(u64::MAX, 5).is_err(), "device-removed sentinel is not successful completion");
    }

    #[test]
    fn dlssnr_does_not_select_an_integrated_or_software_adapter() {
        use windows::Win32::Graphics::Dxgi::DXGI_ADAPTER_FLAG_SOFTWARE;
        assert!(dlssnr_adapter_supported(0x10de, 0));
        assert!(!dlssnr_adapter_supported(0x8086, 0));
        assert!(!dlssnr_adapter_supported(0x1002, 0));
        assert!(!dlssnr_adapter_supported(0x10de, DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32));
    }

    #[test]
    fn a_poisoned_context_stays_poisoned_until_its_destructor() {
        let _gpu = crate::dlssnr::tests::gpu_test_lock();
        let Some(dll) = crate::dlssnr::tests::test_dll() else { return; };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).unwrap();
        let before = POISONED_CONTEXT_DROPS.load(Ordering::Relaxed);
        let result: Result<(), String> = with_context_at(&dir, &dll, |context| {
            Err(context.poison("test-only poison; no GPU submission".into()))
        });
        assert!(result.unwrap_err().contains(DEVICE_RESET_REQUIRED));
        assert_eq!(POISONED_CONTEXT_DROPS.load(Ordering::Relaxed), before + 1,
            "taking the reason clears poison and incorrectly runs NGX cleanup");
    }

}
