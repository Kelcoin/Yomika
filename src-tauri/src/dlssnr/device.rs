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
use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIAdapter1;

use super::ngx::{NgxCore, Parameters};
use super::workspace::{self, Workspace};

/// 进程内的一块设备 + 一个 NGX 会话（核心 + 片段）。
pub struct GpuContext {
    /// NGX 核心（DLSS SDK 的静态库，经垫片 DLL）：初始化、参数对象、特性模块都由它管。
    pub core: NgxCore,

    pub device: ID3D12Device,
    pub queue: ID3D12CommandQueue,
    pub allocator: ID3D12CommandAllocator,
    pub list: ID3D12GraphicsCommandList,
    pub fence: ID3D12Fence,
    pub fence_value: u64,
    /// NGX 的应用数据目录（它在那里写日志）。
    pub data_dir: PathBuf,
    /// 按量化尺寸缓存的工作区（近期用过的排在前面）。
    pub workspaces: Vec<Workspace>,
    /// 诊断用计数：建过几个工作区、建过几次 feature。测试拿它证明「换页不重建」。
    pub workspace_builds: u64,
    pub feature_builds: u64,
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
enum ContextState {
    Empty,
    Ready {
        key: ContextKey,
        context: GpuContext,
    },
    Failed {
        key: ContextKey,
        message: String,
    },
}

static CONTEXT: OnceLock<Mutex<ContextState>> = OnceLock::new();

/// 建过几份上下文（每次重建 +1）。测试拿它断言「作废之后确实重新建了一份」。
static CONTEXT_BUILDS: AtomicU64 = AtomicU64::new(0);

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

/// 拿到全局上下文（第一次调用时建）。失败会被记住：第二次调用直接报同一个错，
/// 不会反复去初始化 NGX（它出错之后进程内就不该再试）。
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
    /// 空槽，或只是另一份 DLL 的失败记录：去建一份。
    Rebuild,
}

fn slot_step(cached: Option<&ContextKey>, failed: Option<&ContextKey>, key: &ContextKey) -> SlotStep {
    if cached.is_some_and(|existing| existing == key) {
        return SlotStep::Run;
    }
    if cached.is_some() {
        return SlotStep::AlreadyInitialized;
    }
    if failed.is_some_and(|remembered| remembered == key) {
        return SlotStep::Remembered;
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
        ContextState::Failed { key, .. } => (None, Some(key)),
        ContextState::Empty => (None, None),
    };
    match slot_step(cached, failed, &key) {
        SlotStep::Run => {
            let ContextState::Ready {
                key: existing,
                mut context,
            } = state
            else {
                unreachable!("Run 只可能来自 Ready")
            };
            let result = use_context(&mut context);
            match context.poisoned.take() {
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
            } = state
            else {
                unreachable!("Remembered 只可能来自 Failed")
            };
            // 同一份 DLL 已经失败过：给同一个错，不再去初始化一遍 NGX。
            *guard = ContextState::Failed {
                key: failed_key,
                message: message.clone(),
            };
            Err(message)
        }
        SlotStep::Rebuild => create_and_run(&mut guard, key, data_dir, dll, use_context),
    }
}

/// 建一份新上下文并立刻跑这次请求（失败记住、中毒丢掉）。
fn create_and_run<T>(
    guard: &mut ContextState,
    key: ContextKey,
    data_dir: &std::path::Path,
    dll: &std::path::Path,
    use_context: impl FnOnce(&mut GpuContext) -> Result<T, String>,
) -> Result<T, String> {
    match GpuContext::create(data_dir, dll) {
        Ok(mut context) => {
            CONTEXT_BUILDS.fetch_add(1, Ordering::Relaxed);
            let result = use_context(&mut context);
            match context.poisoned.take() {
                Some(reason) => Err(reset_required(&reason)),
                None => {
                    *guard = ContextState::Ready { key, context };
                    result
                }
            }
        }
        Err(error) => {
            let message = format!(
                "{error}（这一份片段没能建起 GPU 上下文：换一份 DLL 或重启应用会重新尝试）"
            );
            *guard = ContextState::Failed {
                key,
                message: message.clone(),
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
/// 而且换一份 DLL 之后进程内不该再初始化 NGX（`ContextState::Failed` 就是为它留的）。
pub fn release_cached_workspaces() -> usize {
    let cell = CONTEXT.get_or_init(|| Mutex::new(ContextState::Empty));
    let Ok(mut guard) = cell.lock() else {
        return 0;
    };
    let ContextState::Ready { context, .. } = &mut *guard else {
        return 0;
    };
    let dropped = context.workspaces.len();
    let core = &context.core;
    for mut workspace in context.workspaces.drain(..) {
        workspace.release(core);
    }
    dropped
}

impl GpuContext {
    fn create(data_dir: &std::path::Path, dll: &std::path::Path) -> Result<Self, String> {
        // 顺序不能换：核心 → 设备 → 片段。片段的 `Init_Ext` 一条也不能少（少了核心
        // 它不是报错，是崩）。
        let core = NgxCore::new();

        let device = create_device()?;
        // 片段交给核心：它按搜索路径找到 `nvngx_dlssnr.dll`、自己加载并在每次调用前
        // 把客户端设的参数喂给特性（`PopulateParameters_Impl`）——直接调片段的评估
        // 读不到任何参数（实测）。
        let feature_dir = dll.parent().unwrap_or(data_dir).to_path_buf();
        core.initialize(&device, data_dir, &feature_dir)?;
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
            device,
            queue,
            allocator,
            list,
            fence,
            fence_value: 0,
            data_dir: data_dir.to_path_buf(),
            workspaces: Vec::new(),
            workspace_builds: 0,
            feature_builds: 0,
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
        // 轮询而不是等事件：这里一次只有一张图，1ms 的粒度足够，也少一个内核对象。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while unsafe { self.fence.GetCompletedValue() } < self.fence_value {
            if std::time::Instant::now() > deadline {
                return Err(self.poison("等待 GPU 超过 30 秒".to_string()));
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
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
                existing.ensure_features(self, passes)?;
                Ok(existing)
            }
            workspace::Choice::Create(size) => Workspace::create(self, size, passes),
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
            stale.release(&self.core);
        }
        self.workspaces.insert(0, workspace);
        let mut total: u64 = self.workspaces.iter().map(Workspace::bytes).sum();
        while self.workspaces.len() > 1
            && (self.workspaces.len() > workspace::MAX_WORKSPACES || total > workspace::WORKSPACE_BUDGET_BYTES)
        {
            if let Some(mut dropped) = self.workspaces.pop() {
                total = total.saturating_sub(dropped.bytes());
                dropped.release(&self.core);
            }
        }
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
        let destination = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(buffer.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { PlacedFootprint: footprint },
        };
        let source = D3D12_TEXTURE_COPY_LOCATION {
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
        unsafe { self.list.CopyTextureRegion(&destination, 0, 0, 0, &source, Some(&region)) };
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
        let texture_location = D3D12_TEXTURE_COPY_LOCATION {
            pResource: std::mem::ManuallyDrop::new(Some(texture.clone())),
            Type: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
            Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { SubresourceIndex: 0 },
        };
        let buffer_location = D3D12_TEXTURE_COPY_LOCATION {
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
                .CopyTextureRegion(&texture_location, 0, 0, 0, &buffer_location, Some(&region))
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
        unsafe { self.list.ResourceBarrier(&[barrier]) };
    }
}

impl Drop for GpuContext {
    fn drop(&mut self) {
        if self.poisoned.is_some() {
            // 已经作废的上下文（提交失败 / 栅栏超时 / 设备丢了）：GPU 是否停下未知，
            // 这时候再去调 NGX 释放 feature 只是拿一个状态未知的设备开玩笑——整份
            // 交给进程/驱动回收（报告 P1-1：不要在没有确认 GPU 停下时去动资源）。
            return;
        }
        // feature 句柄要还给 NGX；纹理靠 D3D12 自己的引用计数。
        for workspace in self.workspaces.iter_mut() {
            workspace.release(&self.core);
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
        match create_device_on(Some(&adapter)) {
            Ok(device) => return Ok(device),
            Err(error) => last_error = error,
        }
    }
    // 没有独立适配器时退回默认设备（WARP 也能建，NGX 会在初始化时明确拒绝）。
    create_device_on(None)
        .map_err(|error| format!("创建 D3D12 设备失败：{error}（枚举适配器时最后一个是：{last_error}）"))
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

        // 空槽：去建。
        assert_eq!(slot_step(None, None, &first_key), SlotStep::Rebuild);
        // 缓存里是第一份：同一份直接跑。
        assert_eq!(
            slot_step(Some(&first_key), None, &first_key),
            SlotStep::Run
        );
        // 换一份 DLL、或换一个数据目录：都换不掉（NGX 只认一块设备，只能报错让用户重启）。
        assert_eq!(
            slot_step(Some(&first_key), None, &second_key),
            SlotStep::AlreadyInitialized
        );
        assert_eq!(
            slot_step(Some(&first_key), None, &other_key),
            SlotStep::AlreadyInitialized
        );
        // 第一份失败过之后：同一份报回记住的那个错，不再初始化一遍。
        assert_eq!(
            slot_step(None, Some(&first_key), &first_key),
            SlotStep::Remembered
        );
        // 而另一份（或另一个数据目录）不该被那份记录挡着：重新试。
        assert_eq!(
            slot_step(None, Some(&first_key), &second_key),
            SlotStep::Rebuild
        );
        assert_eq!(
            slot_step(None, Some(&first_key), &other_key),
            SlotStep::Rebuild
        );
    }
}
