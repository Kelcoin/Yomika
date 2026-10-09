//! DLSSNR（NVIDIA 的 `nvngx_dlssnr.dll`）的**引擎**：NGX 核心、D3D12 设备与工作区缓存、
//! 滤镜本体、动画路径、参数与适配器枚举，以及设置页要的那几个便宜结论。
//!
//! 为什么在核心而不在宿主：`docs/71` Task 8 的出口写着「宿主无 ORT/NGX 资源」，而 NGX
//! 只能在**计算进程**里初始化（同文 §11 Task 8 第 2 条）——worker 又不许依赖 Tauri
//! （§5.2），所以这套引擎必须落在这一层，两边才共用同一份实现。宿主那边现在只剩壳：
//! 命令在 `src-tauri/src/dlssnr/commands.rs`，DLL 的下载与安装策略在它的 `release.rs`。
//!
//! 垫片（`src-tauri/vendor/ngx/ngx_shim.c` + `nvsdk_ngx_s.lib`）由**这个 crate 的**
//! `build.rs` 编成 `yomika_ngx.dll`，再由 `ngx.rs` 用 `include_bytes!` 嵌进来——
//! 它在哪一份二进制里，NGX 就在哪一份里。
//!
//! 日志口是注入的（`set_skip_logger`）：动图跳过要写一行「为什么跳过」的诊断，而这一
//! 层不认识宿主的错误日志目录策略，所以由宿主在启动时把口子装上来；没人装就退回 stderr。
//!
//! # 这个模块住着两半，门的只有一半
//!
//! 同一份 `dlssnr` 里并排住着**纯元数据**与**引擎**，`#[cfg(feature = "dlssnr")]` 只门
//! 后者：设置（`settings`）、变体身份与导入（`variant_of` / `install_dll` / `dll_identity`）、
//! 产物身份（`output_revision`）、探针的记账（`last_probe_for` / `probe_is_valid` /
//! `forget_probe`）、合成图与像素差、图这个数据结构本身、显卡枚举（`gpu`，它只调 DXGI）、
//! 「这台机器跑不跑得起来」的二次校验（`runtime_gate_with`，卡由调用方递进来），以及日志口
//! ——这些答案不建 D3D12 设备、不碰 NGX，**宿主摘掉 `dlssnr` feature 之后照样要回答**
//! （8-g④-b 的全部难点就在这）。门在后面的是：`ngx`（垫片）、`device`（D3D12）、
//! `filter`（滤镜）、`workspace`（工作区缓存）、`animation`（动图逐帧），以及
//! `apply_rgba` 这个**要引擎才能给答案**的门面函数。`status_with` 与 `probe_cached_with`
//! 也是门面，但它们把「引擎那一半怎么答」交给调用方递进来的那一份事实（`EngineFacts`）
//! 与那一次运行（`run`）——所以它们自己不门。
//!
//! 早先把整个模块门在 feature 上，后果是宿主想摘 feature 就得连「这份 DLL 是不是原来
//! 那份」一起摘掉——所以切在这里，而不是在宿主里再抄一份。

pub mod settings;

#[cfg(feature = "dlssnr")]
pub mod animation;
#[cfg(feature = "dlssnr")]
pub mod device;
#[cfg(feature = "dlssnr")]
pub mod filter;
/// 「这台机器有什么卡」不属于引擎那一半：`detect_gpu` 只调 DXGI 枚举适配器，
/// 不建 D3D12 设备、不碰 NGX（见 `docs/71` §11-6 允许留下的按需纯元数据 helper）。
/// 摘掉 `dlssnr` feature 的宿主仍然要答这一问——它是 `DlssnrStatus` 的一半。
pub mod gpu;
#[cfg(feature = "dlssnr")]
pub mod ngx;
#[cfg(feature = "dlssnr")]
pub mod workspace;

/// 一张待处理的图：紧凑的 RGBA8。
///
/// 它住在元数据这一半（而不是 `filter` 里）：探针要「合成一张图 → 比像素差」，摘掉引擎
/// 之后宿主仍然要走这一段，所以这个数据结构本身不能跟着滤镜一起被门掉。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DlssnrImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl DlssnrImage {
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("图片尺寸为空".to_string());
        }
        let expected = width as usize * height as usize * 4;
        if rgba.len() != expected {
            return Err(format!(
                "图片字节数与尺寸对不上：{}x{} 需要 {} 字节，给了 {}",
                width,
                height,
                expected,
                rgba.len()
            ));
        }
        Ok(Self {
            width,
            height,
            rgba,
        })
    }
}

/// NGX 的尺寸下限：太小的图它自己会拒绝，先挡下来并给出人话。
pub const MIN_EDGE: u32 = 32;

// 跨模块的名字在这里收一次口：下面那些门面函数（`apply_rgba` / `status_with` /
// `probe_cached_with`）按裸名字用它们，而搬过来之前这正是宿主 `mod.rs` 的再导出——保持
// 同一套名字，宿主里那些 `crate::dlssnr::DlssnrSettings` 之类的调用点一行都不用改。
//
// 门在 feature 上的三条只对引擎那一半有意义：摘掉 feature 之后它们不存在，元数据那一半
// （设置、`DlssnrImage`、`Variant`、`dll_path`…）照旧。
#[cfg(feature = "dlssnr")]
pub use animation::apply_dlssnr;
#[cfg(feature = "dlssnr")]
pub use device::release_cached_workspaces;
#[cfg(feature = "dlssnr")]
pub use filter::apply;
pub use settings::{DlssnrSettings, PassSettings, DEFAULT_PASS_COUNT, MAX_PASS_COUNT};

/// 动图跳过时的那一行诊断要写到哪去：`(data_dir, message, detail)`。
///
/// 用函数指针而不是 trait 对象：只有宿主会装，装一次，装不上就算了（`OnceLock::set`
/// 失败意味着已经有人装过，后装的丢掉）。
pub type SkipLogger = fn(&std::path::Path, &str, Option<&str>) -> Result<(), String>;

static SKIP_LOGGER: std::sync::OnceLock<SkipLogger> = std::sync::OnceLock::new();

/// 装上写诊断的口子。宿主在启动时调一次（见 `src-tauri/src/dlssnr/mod.rs` 的
/// `install_skip_logger`，它在 `lib.rs` 的 setup 里）。
pub fn set_skip_logger(logger: SkipLogger) {
    let _ = SKIP_LOGGER.set(logger);
}

/// 这一层自己的日志口：`level`/`source` 只给回退路径用（宿主那边自带
/// `warn` / `dlssnr/animation`）。
///
/// 门在 feature 上：会写这行诊断的只有动图那条路（`animation.rs`），它也在引擎那一半。
/// 不门就会让「摘掉 feature 的核心」多出唯一一条自己的 `log_skip is never used`。
#[cfg(feature = "dlssnr")]
fn log_skip(
    data_dir: &std::path::Path,
    level: &str,
    source: &str,
    message: &str,
    detail: Option<&str>,
) -> Result<(), String> {
    match SKIP_LOGGER.get() {
        Some(logger) => logger(data_dir, message, detail),
        // 没有宿主（worker、纯核心测试）时原因照样要说出来，只是没有结构化落盘。
        None => {
            eprintln!("yomika: [{level}] {source}: {message}");
            Ok(())
        }
    }
}

/// 一块适配器的信息（DXGI 枚举出来的那几条）。
///
/// 它住在元数据这一半（`gpu.rs` 只借路径）：`DlssnrStatus` 里有它、`status_with` 要拿
/// 它算「该用哪一种变体」，而摘掉引擎的宿主仍然要拼出同一张 `DlssnrStatus`。枚举适配器
/// 那一步（`gpu::detect_gpu`，真的调 DXGI）才属于引擎那一半。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub is_nvidia: bool,
    /// 20 / 30 / 40 / 50 —— 只从卡名里读出来给提示用；NGX 的判定才是准的。
    pub series: Option<u32>,
    /// UMD 版本（例如 `32.0.16.1714`），DXGI 的 `CheckInterfaceSupport` 给的。
    pub driver: Option<String>,
    /// 显存（字节）。
    pub memory_bytes: u64,
}

impl GpuInfo {
    /// 这一代卡用社区包里哪一种 DLL（README 的对应关系）：
    /// 50 系官方原版即可，40 系要社区兼容版，20/30 系要 FP16 兼容版。
    pub fn recommended_variant(&self) -> Option<Variant> {
        match self.series {
            Some(50) => Some(Variant::Official),
            Some(40) => Some(Variant::Community40),
            Some(20) | Some(30) => Some(Variant::SfV2),
            _ => None,
        }
    }
}

/// 只有引擎那一半答得出来的事实：`status_with` 与 `runtime_gate_with` 的输入从「自己去问」
/// 改成「谁有引擎谁填」。
///
/// 摘掉 `dlssnr` feature 之后这一层问不出来——DXGI 枚举在 `gpu` 那一半（那一半**不**门，
/// 见模块抬头）、NGX 垫片在 `ngx` 那一半。但宿主仍然要拼出同一张 [`DlssnrStatus`]，
/// 所以答案当参数传进来；默认值就是「没有引擎」，那正是摘掉 feature 的宿主如实的样子。
///
/// 今天能填出 `core_available` 的只有 worker 那一侧（垫片在它的二进制里、NGX 在它进程里
/// 初始化），而它把这件事写在握手的 `BuildInfo.engines` 里；宿主照着填（`8-g④-b2`）。
#[derive(Debug, Clone, Default)]
pub struct EngineFacts {
    /// 这份二进制里有没有链上 NGX 核心（垫片）。
    pub core_available: bool,
    /// 枚举到的显卡（没卡是 `None`，不是错误）。
    pub gpu: Option<GpuInfo>,
}

/// 这台机器上 DLSSNR 的现状：设置页据此决定显示什么、能不能开。
///
/// 这里全是**便宜**的事实（枚举显卡、看文件在不在、认 DLL 哈希），不建 D3D12 设备、
/// 不碰 NGX：设置页打开就能读。真跑一遍的结论在 [`probe`]。
#[cfg(windows)]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DlssnrStatus {
    /// 数据目录里有没有那份 DLL。
    pub dll_present: bool,
    /// 是三种变体里的哪一种（认不出来就是 `None`，照样可以试）。
    pub variant: Option<String>,
    pub variant_label: Option<String>,
    pub dll_bytes: Option<u64>,
    /// 这份 DLL 自己报的版本号（`310.8.0.0`；读不出来就是 `None`）。
    ///
    /// 与 `variant` 分开：变体是**我们认得出**的那三种，版本号是**文件自己说**的——
    /// 用户导入一份社区新发的 DLL 时，变体可能认不出，版本号照样报得出来。
    pub dll_version: Option<String>,
    /// 盘上那份 DLL 的 SHA-256（小写十六进制；认不出变体也照样报）。
    ///
    /// 这是给「有没有更新」用的：目录里那条同名资产带着自己的 `sha256`/`size`，
    /// 两边一比才知道这一条社区版是不是换过一版。三种变体里有两条**字节数完全相同**
    /// （官方原版与社区兼容版都是 165,840,496 字节），只有哈希分得开——所以这里报的
    /// 必须是真哈希，不能退成字节数。
    pub dll_sha256: Option<String>,
    /// 显卡（第一块 NVIDIA 卡；没有就是 `None`，此时 `gpu_name` 会是别的厂商的卡）。
    pub gpu: Option<GpuInfo>,
    pub gpu_name: String,
    /// 这一代卡按 README 该用哪一种。
    pub recommended_variant: Option<String>,
    pub recommended_label: Option<String>,
    /// 这个构建里有没有链上 NGX 核心（DLSS SDK 的静态库）。
    pub core_available: bool,
    /// 设置页该不该显示这一组：支持系列的 N 卡 + 找到核心。
    ///
    /// 不要求已经装了片段——还没装的机器正是来这一组里挑一种下载的。
    /// 「支持系列」按三条变体汇总（RTX 20/30/40/50）。
    pub installable: bool,
    /// 这台机器现在就能跑：在上面的基础上还装了片段。
    ///
    /// 可用性由显卡、核心与组件决定；手动检测仅用于诊断。
    pub available: bool,
    /// 真机跑过一遍的结论（这一份报告里没有——`probe` 才给）。
    pub probe: Option<ProbeReport>,
    /// 上面那份结论是不是对**现在这一份 DLL** 跑的。
    ///
    /// 换过片段（导入另一种变体、从目录里换一份）之后旧结论就不算数了：开关不能
    /// 再据此解锁，阅读器也不该照旧排队。为假而 DLL 又在时，正确的动作是重新检测
    /// （换过 DLL 的进程还必须重启，见 `device.rs`）。
    pub probe_valid: bool,
    /// 出错时说清楚卡在哪一步（不是 N 卡、没装片段、没有核心、……）。
    pub error: Option<String>,
}

/// 真机跑一遍的结论：一张合成图过完整条链路（核心 → 片段 → 评估 → 回读）。
///
/// 这是唯一权威的「这台机器能不能跑 DLSSNR」：显卡型号只决定「该装哪一种变体」，
/// 驱动与 NGX 自己还有话说。
#[cfg(windows)]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub supported: bool,
    /// 跑通（或失败）用的尺寸。
    pub width: u32,
    pub height: u32,
    pub elapsed_ms: u64,
    /// 输出与输入的平均逐通道差：网络真的参与了才会明显大于 0。
    pub difference: f64,
    pub error: Option<String>,
}

/// 探一次现状。**不报错**：这份报告本身就是「能用/不能用的理由」。
///
/// 引擎那两条事实（垫片在不在、是哪块卡）由调用方给：见 [`EngineFacts`]。
#[cfg(windows)]
pub fn status_with(data_dir: &std::path::Path, engine: EngineFacts) -> DlssnrStatus {
    let EngineFacts {
        core_available: core,
        gpu,
    } = engine;
    let dll = dll_path(data_dir);
    let dll_bytes = std::fs::metadata(&dll).ok().map(|metadata| metadata.len());
    // 只在文件真在的时候读版本：一条 165 MB 的 PE，读不出来（被截断、不是 PE）就是
    // 「不知道」，不猜。
    let version = dll_bytes.is_some().then(|| dll_version(&dll)).flatten();
    // 认变体与报指纹走的是**同一遍**读：`cached_fingerprint` 已经把那份 165 MB 读完了，
    // 一次运行里最多付一次（见 `cached_fingerprint` 的注释）。
    let fingerprint = dll_bytes.is_some().then(|| cached_fingerprint(&dll)).flatten();
    let variant = fingerprint
        .as_ref()
        .and_then(|(bytes, digest)| variant_of(*bytes as usize, digest));
    let recommended = gpu.as_ref().and_then(|value| value.recommended_variant());
    let mut report = DlssnrStatus {
        dll_present: dll_bytes.is_some(),
        variant: variant.map(|value| value.id().to_string()),
        variant_label: variant.map(|value| value.label().to_string()),
        dll_bytes,
        dll_version: version,
        dll_sha256: fingerprint.map(|(_, digest)| digest),
        gpu_name: gpu.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
        recommended_variant: recommended.map(|value| value.id().to_string()),
        recommended_label: recommended.map(|value| value.label().to_string()),
        core_available: core,
        gpu,
        installable: false,
        available: false,
        probe: None,
        probe_valid: false,
        error: None,
    };

    // 一条条说清楚「差什么」——设置页就是拿这几句话告诉用户该做什么的。
    if report.gpu.is_none() {
        report.error = Some("没有找到 NVIDIA 显卡".to_string());
        return report;
    }
    if report.recommended_variant.is_none() {
        report.error = Some(format!(
            "{} 这一代不在 DLSSNR 的支持范围（支持的是 RTX 20/30/40/50 系）",
            report.gpu_name
        ));
        return report;
    }
    if !report.core_available {
        report.error = Some(
            "这个构建没有链上 NGX 核心（src-tauri/vendor/ngx/nvsdk_ngx_s.lib）".to_string(),
        );
        return report;
    }
    report.installable = true;
    if !report.dll_present {
        report.error = Some(format!(
            "还没有片段：从下面选一种下载，或者导入本地的 nvngx_dlssnr.dll（放在 {}）",
            dll.display()
        ));
        return report;
    }
    report.available = true;
    report
}

// 这里原来还有一个 `status(data_dir)`：它自己问「**这份二进制**有没有嵌着垫片」。8-g④-b2
// 把它删了——宿主问这个问题永远得到「没有」（那不是这台机器的事实，是宿主这份二进制的
// 样子），而真有引擎的 worker 不需要这层包装（它把答案写在握手的 `BuildInfo.engines` 里）。
// 留一个没人调用的入口，下一个人迟早会把它当成「宿主也能自己答」的证据。

// 这里原来还有一个 `probe(data_dir)`：它合成一张图、在本进程里调 `apply`、比像素差。
// 8-g④-b2b 把它删了——宿主没有 NGX 垫片，它在本进程里跑这一遍要么失败、要么（从前的
// 宿主）用的是自己那份引擎，而 `docs/71` Task 8 的出口是「宿主无 NGX 资源」。合成图与
// 像素差这两件**纯的**留在下面，怎么跑这一次改由调用方递进来（[`probe_cached_with`]）：
// 有引擎的那一侧（worker）在那边跑，宿主只负责编一张 PNG、比两个像素数组。
// 留一个没人调用的入口，下一个人迟早会把它当成「宿主也能自己跑引擎」的证据。

/// 一张有结构、有噪声的合成图：纯色与平缓渐变让网络无从下手，也看不出它到底跑
/// 没跑（「检测」与测试都用它）。
#[cfg(windows)]
pub fn synthetic_image(width: u32, height: u32) -> DlssnrImage {
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            // 斜向渐变 + 棋盘 + 一点确定性噪声。
            let base = ((x * 255 / width) as u8).wrapping_add((y * 255 / height) as u8);
            let checker = if (x / 8 + y / 8) % 2 == 0 { 24 } else { 0 };
            let noise = ((x * 31 + y * 17) % 23) as u8;
            rgba.extend_from_slice(&[base.wrapping_add(checker), base, base.wrapping_sub(noise), 255]);
        }
    }
    DlssnrImage::new(width, height, rgba).expect("尺寸与字节数一致")
}

/// 两张图差多少（平均逐通道绝对差，0–255）。
#[cfg(windows)]
pub fn mean_absolute_difference(left: &[u8], right: &[u8]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return f64::INFINITY;
    }
    let total: u64 = left
        .iter()
        .zip(right.iter())
        .map(|(left, right)| left.abs_diff(*right) as u64)
        .sum();
    total as f64 / left.len() as f64
}

/// 这一台设备上是否可能存在 DLSSNR 路径（编译期）。
pub const fn is_supported_platform() -> bool {
    cfg!(windows)
}

/// DLL 在数据目录里的位置：与模型同样的规矩——一份按名字固定的文件，用户导入
/// 哪一种变体由它自己决定（见 [`variant_of`]）。
#[cfg(windows)]
pub fn dll_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("dlssnr").join("nvngx_dlssnr.dll")
}

/// DLSSNR 产物该记在哪一版：这一份 DLL（按**内容**认）+ 这一套参数 + 起点那一版的
/// revision。
///
/// 前端说不出这件事——`nativeImageCache.read()` 对派生版本一律当作「本次会话的产物」，
/// 所以「磁盘上这一页是哪一份 DLL 用哪一套参数跑出来的」只能由知道这两件事的这里回答。
/// 任何一项变了就是另一版，旧产物不许顶上来。
///
/// 版本前缀是 `v3`：v2 的产物里混着「评估把输入原样交回、却被当成产物存下来」的行
/// （真机缓存里抓到三例：内容与起点页逐像素相同，并且已经被阅读器读走显示过，见
/// `filter::PASSTHROUGH`）。产物行本身不带代码版本，事后分不出哪一行是这种，所以 v2
/// 的产物一律不再认，让它们按新前缀重算——按需，翻到哪页算哪页。v1 认的是「字节数 +
/// 修改时间」，复制、解包、同步、恢复备份都能让一份完全不同的 DLL 在这两项上与原来
/// 那份一样（审计报告 P1-2），所以 v1 的产物也不认。内容哈希不放在热路径上，见
/// [`cached_fingerprint`]。
#[cfg(windows)]
pub fn output_revision(
    data_dir: &std::path::Path,
    source_revision: Option<&str>,
    settings: &DlssnrSettings,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"dlssnr-out:v3\0");
    hasher.update(dll_identity(data_dir).as_bytes());
    hasher.update(b"\0");
    hasher.update(source_revision.unwrap_or("reader-page").as_bytes());
    hasher.update(b"\0");
    // `settings` 传进来之前已经 `normalized()` 过（层数与数值都收过范围），所以
    // 「默认」与「显式写出默认值」在这里是同一串。
    hasher.update(serde_json::to_string(settings).unwrap_or_default().as_bytes());
    format!("dlssnr:v3:{}", hasher.finalize().to_hex())
}

/// 「这一份 DLL 是哪一份」——按**内容**认（SHA-256 + 字节数）。
///
/// 只认字节数与修改时间是不够的：把另一份 DLL 复制过来、解包出来、从云端同步下来、
/// 或还原一份旧备份，这两项都可能与原来那份分毫不差，于是换汤不换药的产物缓存把旧图
/// 端上来（审计报告 P1-2）。哈希本身在 [`cached_fingerprint`] 里进程内只算一遍，
/// 所以这不是热路径上的 165 MB。没装就是 `missing`——没装时产物缓存自然全部失效
/// （换回同一份 DLL 时也会重建，所以宁可多算一次）。
///
/// `pub` 是因为它原先只靠「宿主是这一层的子模块」才可见（`commands.rs` 的测试用它核
/// `install_dll` 装下去的到底是哪一份）：搬进核心之后那层关系没了，同一个调用点要编得
/// 过就得显式 `pub`。
#[cfg(windows)]
pub fn dll_identity(data_dir: &std::path::Path) -> String {
    match cached_fingerprint(&dll_path(data_dir)) {
        Some((bytes, digest)) => format!("sha256:{digest}:{bytes}"),
        None => "missing".into(),
    }
}

/// 片段自报的版本号：Windows 属性页里显示的那一串（本机三份是 `310.8.0.0` /
/// `310.8.SF.0`）。
///
/// 为什么去问系统的版本资源而不是从文件名或清单里编一个：名字叫 `nvngx_dlssnr.dll`
/// 的字节有几十种来源（官方原版、社区兼容版、用户自己导入的），清单顶多知道**下载**
/// 那一份是谁；用户问「我装的是哪一版」时唯一可信的答案是文件自己身上的版本资源。
/// 这也是一句纯元数据（读 PE 资源、不建设备、不碰 NGX），所以设置页打开就能读。
///
/// 返回值统一成点分（`310.8.0.0`）：资源里两种写法都有（见下面替换那一处的实测），
/// 数字一个不动，只把分隔符统一。
#[cfg(windows)]
pub fn dll_version(path: &std::path::Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };

    if !path.is_file() {
        return None;
    }
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // 先问要多大（这一步只读文件头与资源目录，不把 165 MB 读进来）。
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
    if size == 0 {
        return None;
    }
    let mut block = vec![0u8; size as usize];
    unsafe {
        GetFileVersionInfoW(
            PCWSTR(wide.as_ptr()),
            None,
            size,
            block.as_mut_ptr().cast(),
        )
        .ok()?;
    }

    // 资源块的每一问都是同一个形状：给一条子块路径，拿回指针与长度。
    let query = |key: &str| -> Option<(*mut core::ffi::c_void, u32)> {
        let key: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
        let mut buffer: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut length: u32 = 0;
        let found =
            unsafe { VerQueryValueW(block.as_ptr().cast(), PCWSTR(key.as_ptr()), &mut buffer, &mut length) };
        (found.as_bool() && !buffer.is_null()).then_some((buffer, length))
    };

    // 首选属性页里显示的那一句：翻译表告诉我们资源用的是哪套语言/代码页，再去取
    // `FileVersion` 字符串。SF-v2 那份的 `310.8.SF.0` 只在这里，固定版本号里没有。
    if let Some((codes, length)) = query("\\VarFileInfo\\Translation") {
        if length >= 4 {
            let codes = unsafe { std::slice::from_raw_parts(codes as *const u16, 2) };
            let key = format!(
                "\\StringFileInfo\\{:04x}{:04x}\\FileVersion",
                codes[0], codes[1]
            );
            if let Some((text, length)) = query(&key) {
                if length > 1 {
                    let utf16 = unsafe { std::slice::from_raw_parts(text as *const u16, length as usize) };
                    let text = String::from_utf16_lossy(utf16);
                    let text = text.trim_end_matches('\0').trim();
                    if !text.is_empty() {
                        // NVIDIA 那份官方原版的资源里写的是 `310,8,0,0`（逗号是它构建脚本
                        // 的脾性，属性页也照抄），社区版的 `310.8.SF.0` 是点分。同一个东西
                        // 两种写法摆在一列里像两个格式，所以这里统一成点分——只换分隔符，
                        // 不改任何数字（实测：官方原版 `310,8,0,0`、SF-v2 `310.8.SF.0`）。
                        return Some(text.replace(',', "."));
                    }
                }
            }
        }
    }

    // 退一步用固定版本号（没有字符串表时 Windows 也这么答）。
    let (buffer, length) = query("\\")?;
    if (length as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>() {
        return None;
    }
    let fixed = unsafe { &*(buffer as *const VS_FIXEDFILEINFO) };
    if fixed.dwSignature != 0xFEEF04BD {
        return None;
    }
    Some(format_fixed_version(
        fixed.dwFileVersionMS,
        fixed.dwFileVersionLS,
    ))
}

/// `VS_FIXEDFILEINFO` 里那四个 16 位字段的拼法：Windows 自己也这么拼
/// （`major.minor.build.revision`）。
#[cfg(windows)]
fn format_fixed_version(ms: u32, ls: u32) -> String {
    format!("{}.{}.{}.{}", ms >> 16, ms & 0xffff, ls >> 16, ls & 0xffff)
}

/// 社区包里的三种变体（docs/DLSSNR-DLL-Options-310.8.0.0/README.txt）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// NVIDIA 官方原版：50 系原生支持。
    Official,
    /// 社区兼容版：40/50 系。
    Community40,
    /// FP16 兼容版：20/30 系可运行，性能较低（主要适合图片与视频）。
    SfV2,
}

impl Variant {
    pub fn id(self) -> &'static str {
        match self {
            Variant::Official => "official",
            Variant::Community40 => "community",
            Variant::SfV2 => "sf-v2",
        }
    }

    /// 给设置页看的一句话：这一种是谁用的。
    pub fn label(self) -> &'static str {
        match self {
            Variant::Official => "NVIDIA 官方原版（RTX 50 系原生）",
            Variant::Community40 => "社区兼容版（RTX 40 / 50 系）",
            Variant::SfV2 => "FP16 兼容版（RTX 20 / 30 系，性能较低）",
        }
    }
}

/// 认一认这份 DLL 是三种里的哪一种：按 README 给出的字节数与 SHA-256。
/// 认不出来就是 `None`（照样能试，只是设置页不说它是哪一种）。
#[cfg(windows)]
pub fn variant_of(bytes: usize, sha256_hex: &str) -> Option<Variant> {
    let hash = sha256_hex.to_ascii_lowercase();
    match (bytes, hash.as_str()) {
        (165_840_496, "e16bcf15e16e13f527491cdf7845b2fe6521a738d8f7c9c721866a8496e1fc8e") => {
            Some(Variant::Official)
        }
        (165_840_496, "984bee0f775c277d5829b8fd6775d53a7b0f75396c852b3aaf06a18375f81014") => {
            Some(Variant::Community40)
        }
        (165_830_144, "6eb209e764f39872625debd6abaf45e2bb6322f6f270f781f70c059ae30b3927") => {
            Some(Variant::SfV2)
        }
        _ => None,
    }
}

/// 进程内记住「这个路径上那份 DLL 的内容」：`(路径, 字节数, 修改时间, 指纹)`。
///
/// 只留最近问过的那一条路径——应用只有一个数据目录，测试里那些临时目录里的片段都是
/// 几百字节，重算也不心疼。
#[cfg(windows)]
type FingerprintCache = std::sync::Mutex<
    Option<(
        std::path::PathBuf,
        u64,
        Option<std::time::SystemTime>,
        Option<(u64, String)>,
    )>,
>;

#[cfg(windows)]
static DLL_FINGERPRINT: std::sync::OnceLock<FingerprintCache> = std::sync::OnceLock::new();

#[cfg(windows)]
fn fingerprint_cache() -> &'static FingerprintCache {
    DLL_FINGERPRINT.get_or_init(|| std::sync::Mutex::new(None))
}

/// 这一份 DLL 的**内容**指纹：`(字节数, SHA-256)`，进程内只读一遍。
///
/// 165 MB 读一遍只在**第一次**要身份时付——真机上设置页认变体本来就要读一遍，产物
/// 身份（[`dll_identity`]）与探针结论（[`probe_key`]）复用同一份结果，所以一次运行里
/// 最多一次。之后按 `(路径, 字节数, 修改时间)` 命中；真的往这个路径写过新文件的
/// 地方（导入 / 下载）会显式作废，见 [`forget_fingerprint`]。
#[cfg(windows)]
fn cached_fingerprint(path: &std::path::Path) -> Option<(u64, String)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok();
    if let Ok(guard) = fingerprint_cache().lock() {
        if let Some((cached_path, bytes, cached_modified, value)) = guard.as_ref() {
            if cached_path == path && *bytes == metadata.len() && *cached_modified == modified {
                return value.clone();
            }
        }
    }
    let value = file_sha256(path).map(|digest| (metadata.len(), digest));
    if let Ok(mut guard) = fingerprint_cache().lock() {
        *guard = Some((path.to_path_buf(), metadata.len(), modified, value.clone()));
    }
    value
}

/// 刚往这个路径写过一份 DLL（导入 / 下载）之后作废进程内的指纹：文件名没变、内容变了。
#[cfg(windows)]
pub fn forget_fingerprint() {
    if let Ok(mut guard) = fingerprint_cache().lock() {
        *guard = None;
    }
}

/// 装进数据目录的那份 DLL 是三种里的哪一种（顺带把字节数与哈希记下来给设置页）。
#[cfg(windows)]
pub fn installed_variant(data_dir: &std::path::Path) -> Option<(Variant, u64)> {
    let path = dll_path(data_dir);
    let bytes = std::fs::metadata(&path).ok()?;
    let variant = cached_variant(&path)?;
    Some((variant, bytes.len()))
}

#[cfg(windows)]
fn cached_variant(path: &std::path::Path) -> Option<Variant> {
    let (bytes, digest) = cached_fingerprint(path)?;
    variant_of(bytes as usize, &digest)
}

/// 「驱动认不认这份片段」的三个答案。
///
/// NGX 核心在 `CreateFeature` 之前会调 `nvLoadSignedLibraryW()` 验签，**改过一个字节的
/// 片段一律加载不起来**；它报出来的码是 `0xBAD0000B`（描述表里写作「初始化功能失败，
/// 很可能找不到它需要的库」），看上去跟签名毫无关系，社区那几版就是这样（`docs/144`）。
/// 所以「装之前先拦一道」得自己问一次，不能等驱动在用户面前拒。
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureVerdict {
    /// 签名有效（`WinVerifyTrust` 返回 0）：驱动会认它。
    Trusted,
    /// 签过名，但内容与签名对不上（Authenticode 的 HashMismatch）：社区兼容版在这里。
    Modified,
    /// 没签名、读不到、或者根本不是 PE：都不该进产品目录。
    ///
    /// 社区那版 SF-v2 也在这一格里——它不是「签过名再改」，是**根本没签名**（本机实测
    /// 两种拒法各不相同，所以这句话给用户看的时侯也说得出差别）。
    Untrusted,
}

/// 「装片段之前要不要先问一次签名」。
///
/// 产品路径（用户导入、目录里下载）一律 [`SnippetTrust::Required`]：装进去的那一份必须是
/// 驱动肯加载的，否则用户看到的是「DLSSNR 开了，画面什么都没变」。仓库里的用例拿 1 MB
/// 的假 PE 当夹具，它们问的是**元数据那一半**（认不认得出变体、身份怎么算），不是签名，
/// 所以显式传 [`SnippetTrust::Skipped`]——名字里带着这件事，免得哪天产品路径顺手抄过去。
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnippetTrust {
    Required,
    Skipped,
}

/// `WinVerifyTrust` 说「内容与签名对不上」时返回的那个 `HRESULT`（`TRUST_E_BAD_DIGEST`）。
///
/// 用字面量而不是引 `windows` crate 的常量：`WinVerifyTrust` 返回的是裸 `LONG`，对照的
/// 也是这个数，引一个 `HRESULT` 再 `.0 as i32` 只是多一层包装。
#[cfg(windows)]
const TRUST_E_BAD_DIGEST: i32 = 0x8009_6010u32 as i32;

/// 问 Windows 一次「这份文件的 Authenticode 签名站不站得住」。
///
/// 只看文件和本地缓存（`WTD_REVOKE_NONE` + `WTD_CACHE_ONLY_URL_RETRIEVAL`）：这条路径可能
/// 在离线机器上跑（用户导入一份自己带的 DLL），而「吊销名单查不到」不该被读成「这份文件
/// 有问题」，更不该让装片段这件事等一次网络往返。
#[cfg(windows)]
pub fn signature_verdict(path: &std::path::Path) -> SignatureVerdict {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };

    if !path.is_file() {
        return SignatureVerdict::Untrusted;
    }
    let wide: Vec<u16> = std::os::windows::ffi::OsStrExt::encode_wide(path.as_os_str())
        .chain(std::iter::once(0))
        .collect();
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wide.as_ptr()),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        dwStateAction: WTD_STATEACTION_VERIFY,
        ..Default::default()
    };
    data.Anonymous.pFile = &mut file_info;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe {
        WinVerifyTrust(
            HWND(std::ptr::null_mut()),
            &mut action,
            &mut data as *mut _ as *mut std::ffi::c_void,
        )
    };
    // Close 是**必须**的：不关的话 `WinVerifyTrust` 攥着这份文件的句柄与一份状态，
    // 后面换片段时改名会因此失败（Windows 上正被映射的镜像删得掉、改不了名）。
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        let _ = WinVerifyTrust(
            HWND(std::ptr::null_mut()),
            &mut action,
            &mut data as *mut _ as *mut std::ffi::c_void,
        );
    }
    match status {
        0 => SignatureVerdict::Trusted,
        TRUST_E_BAD_DIGEST => SignatureVerdict::Modified,
        // 剩下的（`TRUST_E_NOSIGNATURE`、不是 PE、读不到……）是同一句人话：这份不算数。
        _ => SignatureVerdict::Untrusted,
    }
}

/// 「装之前拦一道」的那一道：签名不过的片段不进产品目录，而且要说清楚是哪一种不过
/// ——用户拿到的那句话得能解释「为什么我下的这一份装不上」。
#[cfg(windows)]
pub fn require_trusted_snippet(path: &std::path::Path) -> Result<(), String> {
    match signature_verdict(path) {
        SignatureVerdict::Trusted => Ok(()),
        SignatureVerdict::Modified => Err(format!(
            "{} 被 NVIDIA 签过名，但内容与签名对不上（社区改过的版本就是这样）。\
             驱动只加载签名对得上的片段，装进去也用不了，所以这里不换。",
            path.display()
        )),
        SignatureVerdict::Untrusted => Err(format!(
            "{} 没有 NVIDIA 的签名。驱动只加载签过名的片段，装进去也用不了，所以这里不换。",
            path.display()
        )),
    }
}

/// 导入一份用户给的 `nvngx_dlssnr.dll`：查它是 PE、查签名、拷到数据目录、认清是哪一种变体。
///
/// 认不出变体不算错——README 里那三种之外还能有别的（社区还在放新的），只是设置
/// 页说不出它是哪一代卡用的。
#[cfg(windows)]
pub fn install_dll(source: &std::path::Path, data_dir: &std::path::Path) -> Result<InstalledDll, String> {
    install_dll_with(source, data_dir, SnippetTrust::Required)
}

/// 带策略的那一支：产品的两处入口都用 [`SnippetTrust::Required`]，只有仓库里那些
/// 「假 PE 当夹具」的用例显式跳过（见 [`SnippetTrust`]）。
#[cfg(windows)]
pub fn install_dll_with(
    source: &std::path::Path,
    data_dir: &std::path::Path,
    trust: SnippetTrust,
) -> Result<InstalledDll, String> {
    let metadata = std::fs::metadata(source)
        .map_err(|error| format!("读不到这个文件：{error}"))?;
    if !metadata.is_file() {
        return Err("选中的不是一个文件".to_string());
    }
    if metadata.len() < 1_000_000 {
        return Err(format!("这个文件只有 {} 字节，不像是 DLSSNR 的 DLL", metadata.len()));
    }
    // 只认 PE：`MZ` 头 + PE 签名。用户很容易误选到别的文件（说明文档、压缩包），
    // 这时候要当场说清楚，别等 NGX 加载失败。
    {
        use std::io::Read;
        let mut header = [0u8; 0x40];
        let mut file = std::fs::File::open(source).map_err(|error| format!("打开失败：{error}"))?;
        file.read_exact(&mut header).map_err(|error| format!("读文件头失败：{error}"))?;
        if &header[0..2] != b"MZ" {
            return Err("这个文件不是 Windows 的 DLL（没有 MZ 头）".to_string());
        }
        let offset = u32::from_le_bytes([header[0x3c], header[0x3d], header[0x3e], header[0x3f]]) as u64;
        if offset + 4 > metadata.len() {
            return Err("这个文件的 PE 头越界了，文件可能不完整".to_string());
        }
    }

    // 尺寸与 PE 都像了，还要问一次签名。这一句排在前面那几句**之后**：用户最容易犯的
    // 错是选错文件（说明文档、压缩包），那两句才是对那种错的回答。
    if trust == SnippetTrust::Required {
        require_trusted_snippet(source)?;
    }

    let target = dll_path(data_dir);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("建目录失败：{error}"))?;
    }
    // 先拷到临时文件再改名：拷一半失败时不会把原来那份能用的盖坏。
    let staging = target.with_extension("dll.incoming");
    std::fs::copy(source, &staging).map_err(|error| format!("拷贝失败：{error}"))?;
    std::fs::rename(&staging, &target).map_err(|error| {
        let _ = std::fs::remove_file(&staging);
        format!("落盘失败：{error}")
    })?;

    // 刚写过这个路径：进程里记住的那份指纹不作数了，重新读一遍（也顺手把变体认出来）。
    forget_fingerprint();
    let bytes = std::fs::metadata(&target).map(|value| value.len()).unwrap_or(0);
    let variant = cached_variant(&target);
    Ok(InstalledDll {
        bytes,
        variant: variant.map(|value| value.id().to_string()),
        variant_label: variant.map(|value| value.label().to_string()),
        version: dll_version(&target),
    })
}

/// 导入结果：设置页拿它回一句话。
#[cfg(windows)]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledDll {
    pub bytes: u64,
    pub variant: Option<String>,
    pub variant_label: Option<String>,
    /// 这份文件自己身上的版本号（读不出来就是 `None`，不编）。
    pub version: Option<String>,
}

/// 一段 RGBA 走一遍 DLSSNR（阅读器与算力中心都从这里进）。
///
/// 尺寸小于 [`filter::MIN_EDGE`] 会直接报错——那是 DLL 自己的要求，不是我们加的。
#[cfg(feature = "dlssnr")]
pub fn apply_rgba(
    data_dir: &std::path::Path,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    settings: &DlssnrSettings,
) -> Result<DlssnrImage, String> {
    let image = DlssnrImage::new(width, height, rgba)?;
    apply(data_dir, &image, settings)
}

/// 已经跑过的那一次探针：设置页显示它、算力中心的能力清单也看它（探针本身要一秒
/// 多，不能每次开设置页都跑）。
///
/// 结论与**跑它的那一份 DLL** 绑在一起：换过片段之后旧结论必须作废，否则界面会
/// 显示「上次检测通过」而显存里跑的是换之前的片段。
#[cfg(windows)]
static LAST_PROBE: std::sync::Mutex<Option<(ProbeKey, ProbeReport)>> = std::sync::Mutex::new(None);

/// 认一份 DLL：数据目录 + **内容**指纹（字节数 + SHA-256）。
///
/// 只认「字节数 + 修改时间」时，一份复制/解包/同步过来的 DLL 可以在这两项上与原来那份
/// 一模一样，于是这里显示的还是换之前那份的结论（审计报告 P1-2）。指纹在
/// [`cached_fingerprint`] 里进程内只算一遍，所以不算热路径；带上目录是因为这张表是
/// 进程级的，而测试与应用会指向不同的数据目录。
#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeKey {
    data_dir: std::path::PathBuf,
    /// 没装（或读不出来）就是 `None`。
    fingerprint: Option<(u64, String)>,
}

#[cfg(windows)]
fn probe_key(data_dir: &std::path::Path) -> ProbeKey {
    ProbeKey {
        data_dir: data_dir.to_path_buf(),
        fingerprint: cached_fingerprint(&dll_path(data_dir)),
    }
}

#[cfg(windows)]
pub fn last_probe() -> Option<ProbeReport> {
    LAST_PROBE
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|(_, report)| report.clone()))
}

/// 上次的结论，但只在它是对现在这一份 DLL 跑的时候才算。
#[cfg(windows)]
pub fn last_probe_for(data_dir: &std::path::Path) -> Option<ProbeReport> {
    LAST_PROBE.lock().ok().and_then(|guard| {
        guard.as_ref().and_then(|(key, report)| {
            (*key == probe_key(data_dir)).then(|| report.clone())
        })
    })
}

/// 上次那份结论还算不算数（没跑过、或换过 DLL 都不算）。
#[cfg(windows)]
pub fn probe_is_valid(data_dir: &std::path::Path) -> bool {
    LAST_PROBE
        .lock()
        .map(|guard| {
            guard
                .as_ref()
                .is_some_and(|(key, _)| *key == probe_key(data_dir))
        })
        .unwrap_or(false)
}

/// 跑一遍探针并记住结论。`force` 为假且已经跑过时直接给上次的——设置页每次打开
/// 都调，不能每次都真跑。换过 DLL 之后旧结论不算数，会真跑一遍（那本来就是用户
/// 换完片段要看的东西）。
///
/// 「怎么跑这一次」由调用方递进来（`run`）：这一层不认识计算进程，也不该在本进程里
/// 建 D3D12 设备——宿主走的是「合成图 → 编 PNG → 交给 worker → 解码产物 → 比像素差」，
/// 有引擎的那一侧是什么形状由它自己决定。这里留下的只有**记账**：结论与跑它的那一份
/// DLL 绑在一起（[`probe_key`]），所以 `run` 只会在该跑的时候被调一次。
#[cfg(windows)]
pub fn probe_cached_with(
    data_dir: &std::path::Path,
    force: bool,
    run: impl FnOnce() -> ProbeReport,
) -> ProbeReport {
    let key = probe_key(data_dir);
    if !force {
        if let Some(report) = LAST_PROBE.lock().ok().and_then(|guard| {
            guard
                .as_ref()
                .and_then(|(stored, report)| (*stored == key).then(|| report.clone()))
        }) {
            return report;
        }
    }
    let report = run();
    if let Ok(mut guard) = LAST_PROBE.lock() {
        *guard = Some((key, report.clone()));
    }
    report
}

/// 换过 DLL 之后旧的结论作废（用户可能刚换成另一种变体）。
#[cfg(windows)]
pub fn forget_probe() {
    if let Ok(mut guard) = LAST_PROBE.lock() {
        *guard = None;
    }
}

/// 阅读器／算力中心在**真跑图之前**的二次校验。
///
/// 每次跑图前检查这台机器当前是否具备显卡与组件。**核心那一条不在这里**：宿主自己
/// 没有 NGX 垫片，「问自己有没有核心」得到的永远是「没有」——那不是这台机器的事实，
/// 那是宿主这份二进制的样子。有引擎的那一侧（worker）真缺核心时会在真跑图时响亮地
/// 失败，比宿主提前猜一句更准。卡的现状由调用方递进来（见 [`EngineFacts`]）。
pub fn runtime_gate_with(
    data_dir: &std::path::Path,
    gpu: Option<GpuInfo>,
) -> Result<(), String> {
    if !dll_path(data_dir).is_file() {
        return Err("还没有导入 nvngx_dlssnr.dll".to_string());
    }
    let gpu = gpu.ok_or_else(|| "这台机器没有可用的 NVIDIA 显卡".to_string())?;
    if gpu.recommended_variant().is_none() {
        return Err(format!("{} 这一代不在 DLSSNR 的支持范围", gpu.name));
    }
    Ok(())
}

#[cfg(windows)]
pub fn file_sha256(path: &std::path::Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 把一张图写成 PNG（肉眼核对用）。
    #[cfg(feature = "dlssnr")]
    fn dump_png(path: &std::path::Path, image: &DlssnrImage) {
        let Some(buffer) = image::RgbaImage::from_raw(image.width, image.height, image.rgba.clone())
        else {
            println!("落盘失败：尺寸与字节数不一致");
            return;
        };
        if let Err(error) = buffer.save(path) {
            println!("落盘失败：{error}");
        }
    }

    /// 测试用的那一份 DLL：先看环境变量，再看仓库里的社区包（docs 里那三份 165MB
    /// 的 DLL 不拷贝，直接指着用），都没有就跳过。
    /// 仓库里那三份社区 DLL 的目录。宿主时代 `CARGO_MANIFEST_DIR` 就是仓库根，搬进
    /// crate 之后它变成 `src-tauri/crates/compute-core`，所以往上找到第一个真的放着
    /// `docs/DLSSNR-DLL-Options-310.8.0.0` 的目录为止（找不到就跳过这组测试）。
    #[cfg(feature = "dlssnr")]
    fn docs_dlssnr_dlls() -> Option<std::path::PathBuf> {
        let mut directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        loop {
            let candidate = directory.join("docs").join("DLSSNR-DLL-Options-310.8.0.0");
            if candidate.is_dir() {
                return Some(candidate);
            }
            if !directory.pop() {
                return None;
            }
        }
    }
    #[cfg(feature = "dlssnr")]
    pub(super) fn test_dll() -> Option<std::path::PathBuf> {
        if let Ok(path) = std::env::var("YOMIKA_DLSSNR_DLL") {
            let path = std::path::PathBuf::from(path);
            return path.is_file().then_some(path);
        }
        let root = docs_dlssnr_dlls()?;
        for variant in ["NVIDIA-Original", "Community-RTX40-RTX50", "SF-v2"] {
            let candidate = root.join(variant).join("nvngx_dlssnr.dll");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    /// 这一组测试共用**一台设备**和**一个进程级的工作区缓存**（见 `device.rs` 的
    /// `OnceLock`），并行跑起来会互相挤掉对方的工作区：计时不可复现，工作区计数也
    /// 不再等于「这个测试自己建了几个」。所以凡是碰 `with_context*` 的测试都在开头
    /// 排队。锁中毒不是错（上一个测试 panic 过也要放行）。
    #[cfg(feature = "dlssnr")]
    pub(crate) fn gpu_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 仓库里那三份社区 DLL 的目录（`docs/` 里，不进仓库）。
    #[cfg(windows)]
    fn docs_dir() -> Option<std::path::PathBuf> {
        let mut directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        loop {
            let candidate = directory.join("docs").join("DLSSNR-DLL-Options-310.8.0.0");
            if candidate.is_dir() {
                return Some(candidate);
            }
            if !directory.pop() {
                return None;
            }
        }
    }

    /// 片段报的版本号得是 Windows 属性页里那一串：这三份真片段的版本资源各不相同
    /// （官方原版 `310,8,0,0`、SF-v2 `310.8.SF.0`），所以它同时钉住了「读的是文件
    /// 自己的版本资源」而不是某条我们自己编的规则。
    ///
    /// 一份都没找到时**不是通过**：打印跳过之后 assert 掉，免得干净检出把这条读成绿的。
    #[cfg(windows)]
    #[test]
    fn the_shipped_dlls_report_the_version_windows_shows() {
        let Some(root) = docs_dir() else {
            panic!("跳过：docs/DLSSNR-DLL-Options-310.8.0.0 不在（这条测试要真片段当夹具）");
        };
        let mut checked = 0;
        for (folder, expected) in [("NVIDIA-Original", "310.8.0.0"), ("SF-v2", "310.8.SF.0")] {
            let path = root.join(folder).join("nvngx_dlssnr.dll");
            if !path.is_file() {
                println!("跳过 {folder}：那份 DLL 不在");
                continue;
            }
            checked += 1;
            assert_eq!(
                super::dll_version(&path).as_deref(),
                Some(expected),
                "{folder} 的版本号该是 Windows 说的那一串"
            );
        }
        assert!(checked > 0, "一份片段都没量到，这条测试什么也没证明");
    }

    /// 读不出来就是「不知道」，不许编：文件不在、或者根本不是 PE，都返回 `None`。
    #[cfg(windows)]
    #[test]
    fn a_file_without_a_version_resource_has_no_version() {
        assert_eq!(super::dll_version(std::path::Path::new("这个文件不存在.dll")), None);
        let temp = std::env::temp_dir().join(format!("yomika-version-{}.bin", std::process::id()));
        std::fs::write(&temp, b"not a portable executable at all").expect("写临时文件");
        assert_eq!(super::dll_version(&temp), None, "不是 PE 的文件不该报出版本号");
        let _ = std::fs::remove_file(&temp);
    }

    /// 固定版本号那一支（翻译表缺失时 Windows 也这么答）的拼法。
    #[cfg(windows)]
    #[test]
    fn the_fixed_version_is_spelled_like_windows_spells_it() {
        assert_eq!(super::format_fixed_version(0x0136_0008, 0), "310.8.0.0");
        assert_eq!(super::format_fixed_version(0x0001_0002, 0x0003_0004), "1.2.3.4");
    }

    /// 一份够大、`MZ` 头自洽的假 PE：**没有签名**。产品路径要签名，这个文件是给
    /// 「只问元数据那一半」的用例当夹具的（`tests/dlssnr_metadata.rs` 里那张同名的表）。
    #[cfg(windows)]
    fn unsigned_pe(path: &std::path::Path, bytes: usize) {
        let mut content = vec![0u8; bytes];
        content[0..2].copy_from_slice(b"MZ");
        content[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        std::fs::write(path, &content).expect("写假 PE");
    }

    /// 驱动认不认这份片段：官方原版有效；社区那两版签过名但被改过；随手写的假 PE 与
    /// 不存在的路径一律不算数——**一个字节的改动也算改过**（`docs/144` 量到的就是这一条）。
    #[cfg(windows)]
    #[test]
    fn a_snippet_the_driver_would_refuse_is_not_trusted() {
        let dir = tempfile::tempdir().expect("临时目录");
        let unsigned = dir.path().join("unsigned.dll");
        unsigned_pe(&unsigned, 1_000_001);
        assert_eq!(
            super::signature_verdict(&unsigned),
            super::SignatureVerdict::Untrusted,
            "没签名的假 PE 不算数"
        );
        assert_eq!(
            super::signature_verdict(std::path::Path::new("这个文件不存在.dll")),
            super::SignatureVerdict::Untrusted,
            "读不到就是不算数，不是「没问题」"
        );

        let Some(root) = docs_dir() else {
            panic!("跳过：docs/DLSSNR-DLL-Options-310.8.0.0 不在（这条测试要真片段当夹具）");
        };
        let official = root.join("NVIDIA-Original").join("nvngx_dlssnr.dll");
        if !official.is_file() {
            panic!("跳过：{} 不在", official.display());
        }
        assert_eq!(
            super::signature_verdict(&official),
            super::SignatureVerdict::Trusted,
            "官方原版是签名有效的那一份：驱动会认它"
        );

        // 一个字节的对照：拷一份官方原版，把 DOS stub 里那个填充字节翻掉（不动任何区段）。
        let flipped = dir.path().join("flipped.dll");
        std::fs::copy(&official, &flipped).expect("拷一份");
        {
            use std::io::{Seek, SeekFrom, Write};
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .open(&flipped)
                .expect("打开副本");
            file.seek(SeekFrom::Start(0x80)).expect("定位");
            file.write_all(&[0xFD]).expect("翻一个字节");
        }
        assert_eq!(
            super::signature_verdict(&flipped),
            super::SignatureVerdict::Modified,
            "翻一个填充字节就不再是同一份文件：签名说的就是这件事"
        );

        // 社区那两版：**两种不同的过不了**——兼容版是 NVIDIA 签过名再被改过（内容与签名
        // 对不上），SF-v2 连签名都没有。这正是「自己问一次」比「按名单猜」强的地方：
        // 拒的理由不一样，说给用户的话也就不一样。
        let mut measured = 0;
        for (folder, expected) in [
            ("Community-RTX40-RTX50", super::SignatureVerdict::Modified),
            ("SF-v2", super::SignatureVerdict::Untrusted),
        ] {
            let path = root.join(folder).join("nvngx_dlssnr.dll");
            if !path.is_file() {
                println!("跳过 {folder}：那份 DLL 不在");
                continue;
            }
            measured += 1;
            assert_eq!(
                super::signature_verdict(&path),
                expected,
                "{folder} 过不了驱动那一关，理由与量到的不一样"
            );
        }
        assert!(measured > 0, "一份社区片段都没量到，这条测试只证了一半");
    }

    /// 装之前拦一道：签名不过的片段**不许顶掉**盘上那份能用的，而且要说清楚为什么。
    #[cfg(windows)]
    #[test]
    fn a_snippet_the_driver_would_refuse_never_replaces_the_one_on_disk() {
        let Some(root) = docs_dir() else {
            panic!("跳过：docs/DLSSNR-DLL-Options-310.8.0.0 不在（这条测试要真片段当夹具）");
        };
        let official = root.join("NVIDIA-Original").join("nvngx_dlssnr.dll");
        let community = root.join("Community-RTX40-RTX50").join("nvngx_dlssnr.dll");
        if !official.is_file() || !community.is_file() {
            panic!("跳过：官方原版或社区兼容版不在（这条路要两份真片段）");
        }
        let dir = tempfile::tempdir().expect("临时目录");
        let installed = super::install_dll(&official, dir.path()).expect("官方原版该装得进去");
        assert_eq!(installed.variant.as_deref(), Some("official"));
        let before = super::file_sha256(&dll_path(dir.path())).expect("哈希");

        // 签了名再被改过的那一份：驱动拒它，所以这里也不许换。
        let refused = super::install_dll(&community, dir.path()).expect_err("改过的片段不该装进去");
        assert!(refused.contains("签名"), "{refused}");
        assert_eq!(
            super::file_sha256(&dll_path(dir.path())).as_deref(),
            Some(before.as_str()),
            "拒了之后盘上还是原来那份能用的"
        );

        // 没签名的假 PE：同样拒，同样不许留下东西。
        let fake_dir = tempfile::tempdir().expect("临时目录");
        let fake = fake_dir.path().join("unsigned.dll");
        unsigned_pe(&fake, 1_000_001);
        let refused = super::install_dll(&fake, dir.path()).expect_err("没签名的片段不该装进去");
        assert!(refused.contains("签名"), "{refused}");
        assert_eq!(
            super::file_sha256(&dll_path(dir.path())).as_deref(),
            Some(before.as_str()),
            "两次拒绝都没换掉能用的那一份"
        );

        // 显式跳过验签的那一支照样装得进去：元数据那一半的用例走的就是它。
        super::install_dll_with(&fake, dir.path(), super::SnippetTrust::Skipped)
            .expect("显式跳过时该装得进去");
        assert_ne!(
            super::file_sha256(&dll_path(dir.path())).as_deref(),
            Some(before.as_str()),
            "跳过时就真的换掉了"
        );
    }

    #[test]
    fn variant_hashes_match_the_shipped_readme() {
        // 三种变体的哈希来自 docs 里的 README；认变体靠它，错一个字符就等于把
        // 「装的哪一种」判错。
        assert_eq!(
            variant_of(165_840_496, "E16BCF15E16E13F527491CDF7845B2FE6521A738D8F7C9C721866A8496E1FC8E"),
            Some(Variant::Official)
        );
        assert_eq!(
            variant_of(165_840_496, "984bee0f775c277d5829b8fd6775d53a7b0f75396c852b3aaf06a18375f81014"),
            Some(Variant::Community40)
        );
        assert_eq!(
            variant_of(165_830_144, "6EB209E764F39872625DEBD6ABAF45E2BB6322F6F270F781F70C059AE30B3927"),
            Some(Variant::SfV2)
        );
        assert_eq!(variant_of(165_840_496, "00"), None);
    }

    // 这里原来有两条 `status()` 的用例（都是「自己问自己有没有嵌着垫片」）。`status` 删掉
    // 之后同一套口径由仓库外那一半接住：`tests/dlssnr_metadata.rs` 里 `status_with` 的四段
    // （默认值、卡+核心、装上片段、没卡）**不带任何 feature** 就能跑——那正是宿主要走的路，
    // 也是这两条用例当年留在 feature 后面所掩盖的事。

    /// 换过 DLL 之后，旧的那份「检测通过」不能再算数：开关会解锁、阅读器会排队，
    /// 而显存里跑的是换之前那一份片段。
    #[test]
    fn a_probe_stops_counting_once_its_dll_changes() {
        let dir = tempfile::tempdir().expect("临时目录");
        let dll = dll_path(dir.path());
        std::fs::create_dir_all(dll.parent().expect("dlssnr 目录")).expect("建目录");
        std::fs::write(&dll, vec![0_u8; 4096]).expect("写片段");

        // 没有跑过探针：不算数，阅读器也没有结论可用。
        assert!(!probe_is_valid(dir.path()));
        assert!(last_probe_for(dir.path()).is_none());

        // 假装此刻跑通了一遍。
        let report = ProbeReport {
            supported: true,
            width: 96,
            height: 96,
            elapsed_ms: 5,
            difference: 3.2,
            error: None,
        };
        *LAST_PROBE.lock().expect("探针表") = Some((probe_key(dir.path()), report));
        assert!(probe_is_valid(dir.path()));
        assert!(last_probe_for(dir.path()).is_some());

        // 换成另一份片段：大小变了，旧结论作废。
        std::fs::write(&dll, vec![0_u8; 8192]).expect("换片段");
        assert!(!probe_is_valid(dir.path()), "换过 DLL 之后旧结论不能继续算数");
        assert!(last_probe_for(dir.path()).is_none());

        // 另一个数据目录里那份结论也不是这一份的。
        let elsewhere = tempfile::tempdir().expect("另一个临时目录");
        assert!(!probe_is_valid(elsewhere.path()));
        forget_probe();
    }

    /// 真机跑一遍：没有 NVIDIA 卡、没有 DLL、没有核心就打印原因并跳过；能跑就断言
    /// 它真的改了图。这条同时是「核心 → 片段 → 参数对象 → 评估 → 回读」的端到端。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn applies_dlssnr_on_this_machine_when_available() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll（设 YOMIKA_DLSSNR_DLL 或放好 docs 里的社区包）");
            return;
        };
        // 固定目录：NGX 会在这里写日志（YOMIKA_NGX_LOG=1 时），排查时能回头翻。
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let image = synthetic_image(160, 128);
        let settings = DlssnrSettings::default();
        let started = std::time::Instant::now();
        let output = match filter::apply_with_dll(&dir, &dll, &image, &settings) {
            Ok(output) => output,
            Err(error) => {
                // 初始化失败是 DLL/驱动/卡三方之一的事，测试只报告，不当失败：
                // 这台机器上真能用的时候才会走到断言。
                println!("跳过：DLSSNR 没跑起来 —— {error}");
                return;
            }
        };
        let elapsed = started.elapsed();
        assert_eq!(output.width, image.width);
        assert_eq!(output.height, image.height);
        assert_eq!(output.rgba.len(), image.rgba.len());
        let difference = mean_absolute_difference(&image.rgba, &output.rgba);
        println!("一次 pass：{}ms，平均逐通道差 {difference:.2}", elapsed.as_millis());
        if std::env::var_os("YOMIKA_DLSSNR_DUMP").is_some() {
            dump_png(&dir.join("probe-input.png"), &image);
            dump_png(&dir.join("probe-output.png"), &output);
            println!("已落盘：{} / {}", dir.join("probe-input.png").display(), dir.join("probe-output.png").display());
        }
        assert!(difference > 0.05, "输出与输入一模一样，网络没有参与");
        assert!(difference < 40.0, "输出与输入差太多，像是花屏");

        // 两层：再跑一遍应当仍是一张正常尺寸的图。
        let two = DlssnrSettings {
            passes: vec![PassSettings::default(), PassSettings { intensity: 1.2, ..PassSettings::default() }],
        };
        let stacked = filter::apply_with_dll(&dir, &dll, &image, &two).expect("两层叠加");
        assert_eq!(stacked.rgba.len(), image.rgba.len());
        let stacked_difference = mean_absolute_difference(&image.rgba, &stacked.rgba);
        println!("两层：平均逐通道差 {stacked_difference:.2}");
        assert!(stacked_difference > 0.05);
    }

    /// 「一个 bucket 工作区吃同一本档案里各种尺寸的页」成不成立。
    ///
    /// 判据只有一条：**输出要和按页尺寸建 feature 时几乎一样**（同一张图、同一层
    /// 参数）。不成立就不能用——跑出来是花屏等于把功能做坏。差值的参照是「同一模式
    /// 再跑一遍」的噪声底。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn a_bucket_workspace_matches_a_per_page_feature() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let settings = DlssnrSettings::default();
        let none = crate::cancel::CancelToken::none();
        let page = synthetic_image(1478, 2100);

        let run = |label: &str, forced: Option<(u32, u32)>| {
            let started = std::time::Instant::now();
            let output = filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &none, forced);
            let elapsed = started.elapsed().as_millis();
            match output {
                Ok(output) => {
                    println!("{label:<38} {elapsed:>6} ms");
                    Some(output)
                }
                Err(error) => {
                    println!("{label:<38} 失败：{error}");
                    None
                }
            }
        };

        println!("--- bucket 工作区 vs 按页尺寸建 feature（页 1478x2100）---");
        // 生产路径：量化成 1536×2112 的 bucket（1478、1500 这一类的页共用它）。
        let bucket = run("bucket（生产路径）", None);
        // 老路：feature 建在这一页的尺寸上。`forced` 点名的尺寸和上面那个不同，
        // 两边各自量的都是要量的东西。
        let per_page = run("按页尺寸（1478x2100）", Some((1478, 2100)));
        // 噪声底：同一模式再跑一遍（NGX 同一张图本来就跑不出逐字节一致的结果）。
        let per_page_again = run("按页尺寸（噪声底）", Some((1478, 2100)));

        let (Some(bucket), Some(per_page), Some(per_page_again)) = (bucket, per_page, per_page_again) else {
            println!("有的一版没跑出来（原因见上面那几行），不比较");
            return;
        };
        let noise = mean_absolute_difference(&per_page.rgba, &per_page_again.rgba);
        let gap = mean_absolute_difference(&per_page.rgba, &bucket.rgba);
        println!("噪声底（按页 vs 按页）: {noise:.3}");
        println!("bucket vs 按页: 平均逐通道差 {gap:.3}（{:.4}%）", gap / 255.0 * 100.0);
        assert!(
            gap <= noise.max(0.5),
            "bucket 与按页尺寸的输出差太多：{gap:.3}（噪声底 {noise:.3}）"
        );
    }

    /// 同一本档案里连着翻、页页尺寸都差十几像素时，它们应该落进**同一个工作区**：
    /// 换页不重建 feature。这是这轮优化要证明的核心，用 `GpuContext` 上的计数器判
    /// ——时间在 CI 上不稳，计数是确定的机制。
    ///
    /// 计数器是**进程级**的（同一个测试进程里所有 GPU 测试共用一个上下文），所以差值
    /// 只能当上界：`<= 1`。按页重建那一支会是 3。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn similar_pages_share_one_workspace() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let settings = DlssnrSettings::default();
        let none = crate::cancel::CancelToken::none();
        // 一本档案里最常见的差异就是十几像素（扫描/裁边）。
        let pages = [
            synthetic_image(1300, 1900),
            synthetic_image(1310, 1900),
            synthetic_image(1290, 1890),
        ];

        let before = filter::context_counts(&dir, &dll).expect("读计数");
        for (index, page) in pages.iter().enumerate() {
            let started = std::time::Instant::now();
            filter::apply_with_dll_bucket(&dir, &dll, page, &settings, &none, None)
                .unwrap_or_else(|error| panic!("第 {} 页失败：{error}", index + 1));
            println!(
                "第 {} 页（{}x{}）{:>6} ms",
                index + 1,
                page.width,
                page.height,
                started.elapsed().as_millis()
            );
        }
        let after = filter::context_counts(&dir, &dll).expect("读计数");
        let builds = after.0 - before.0;
        let feature_builds = after.1 - before.1;
        println!("三页之后：新建工作区 {builds} 次、重建 feature {feature_builds} 次");
        assert!(builds <= 1, "三页尺寸只差十几像素，却建了 {builds} 个工作区");
        assert!(
            feature_builds <= 1,
            "三页尺寸只差十几像素，却重建了 {feature_builds} 次 feature"
        );
    }

    /// 层数从 1 涨到 2 时，同一个工作区要能**原地长大**（补一张中间图），而不是拿
    /// 一张只有 0 张中间图的工作区去跑两层（那会越界）。
    ///
    /// 判据用输出：两层的输出必须和一层的不一样——不一样才说明第二层真的拿前一层
    /// 的输出当输入跑了。计数不参与判断（进程级计数器会被并行的 GPU 测试搅浑）。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn growing_the_layer_count_reuses_the_same_workspace() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let none = crate::cancel::CancelToken::none();
        let page = synthetic_image(600, 800);
        let one = DlssnrSettings::default();
        let two = DlssnrSettings {
            passes: vec![
                PassSettings::default(),
                PassSettings {
                    intensity: 1.2,
                    ..PassSettings::default()
                },
            ],
        };

        // 先用一层把工作区建出来（只有 0 张中间图），再用两层要它。
        let first = filter::apply_with_dll_bucket(&dir, &dll, &page, &one, &none, None)
            .expect("一层跑不动");
        let second = filter::apply_with_dll_bucket(&dir, &dll, &page, &two, &none, None)
            .expect("两层要在同一个工作区里原地长大");
        assert_eq!(second.rgba.len(), 600 * 800 * 4, "输出尺寸得和这一页一致");
        let gap = mean_absolute_difference(&first.rgba, &second.rgba);
        println!("一层 vs 两层：平均逐通道差 {gap:.3}");
        assert!(gap > 0.5, "两层输出和一层一样（{gap:.3}），第二层没真跑");
        let again = filter::apply_with_dll_bucket(&dir, &dll, &page, &one, &none, None)
            .expect("减少层数后要恢复同样的一层输出");
        assert_eq!(first.rgba, again.rgba, "1->2->1 must not preserve the second layer's settings/output");
    }

    /// 提交期失败（`Signal` 失败、栅栏超时…）之后，那份上下文**不能**留在缓存里：
    /// 报错的那一次就要把坏上下文摘掉，下一次请求重建一份，再往后回到复用。
    ///
    /// 这是审计报告 P1-1 的场景：`GpuContext` 是进程级缓存，一次 GPU/驱动错误在改之前
    /// 会被后续每个请求反复用到，故障就放大成「连着一串页都失败」。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn a_failed_submit_drops_the_context_instead_of_poisoning_every_page() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let none = crate::cancel::CancelToken::none();
        let settings = DlssnrSettings::default();
        let page = synthetic_image(240, 320);

        // 先把上下文建起来；这台机器跑不起来就跳过（与别的 GPU 测试同一条规矩）。
        if let Err(error) = filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &none, None) {
            println!("跳过：DLSSNR 没跑起来 —— {error}");
            return;
        }
        let builds = super::device::context_builds();

        // 注入一次提交失败：报错必须带稳定错误码，说清是提交期失败。
        super::device::fail_next_submit(true);
        let error = filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &none, None)
            .expect_err("注入的提交失败必须报错");
        assert!(
            error.contains(super::device::DEVICE_RESET_REQUIRED),
            "提交期失败要给稳定错误码：{error}"
        );
        assert!(error.contains("注入的提交失败"), "要说清是哪一步失败：{error}");
        assert_eq!(
            super::device::context_builds(),
            builds,
            "报错的那一刻还不该重建：坏上下文先摘掉，等下一次请求再建"
        );

        // 下一次请求必须**重建**一份上下文（坏的那份已经不在缓存里了）。
        filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &none, None)
            .expect("作废之后要能自己恢复");
        assert_eq!(
            super::device::context_builds(),
            builds + 1,
            "作废的上下文之后必须重建，而且只重建一份"
        );
        // 新上下文里的计数是它自己的：这一页的工作区与 feature 都得是新建的（旧上下文
        // 那份计数随它一起作废，跨上下文比大小没有意义）。
        let (workspaces_after, features_after) = filter::context_counts(&dir, &dll).expect("读计数");
        assert_eq!(workspaces_after, 1, "新上下文里要重新建一个工作区");
        assert!(features_after > 0, "新上下文里要重新建 feature");

        // 恢复之后回到复用：再跑一页不该再建上下文，也不该再建工作区与 feature。
        filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &none, None)
            .expect("重建之后继续复用");
        assert_eq!(
            super::device::context_builds(),
            builds + 1,
            "恢复之后不该再建上下文"
        );
        let (workspaces_reused, features_reused) =
            filter::context_counts(&dir, &dll).expect("读计数");
        assert_eq!(
            (workspaces_reused, features_reused),
            (workspaces_after, features_after),
            "恢复之后同样的页要接着用那个工作区"
        );
    }

    /// 网络偶尔把输入原样交回（真机产物缓存里抓到过三例：产物与起点页逐像素相同）。
    ///
    /// 一次原样交回就当成那一页没被评估：重试一次。连着两次就必须如实报
    /// [`filter::PASSTHROUGH`]，宁可报错也不能再交出一个「看起来像产物」的输入——
    /// `commands` 那一层就是靠这个信号决定「原图交回、不写产物缓存」的（写进去，用户
    /// 那一页会一直停在未处理的样子，只有再动一次参数才会重算）。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn a_passthrough_is_retried_before_it_is_believed() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let settings = DlssnrSettings::default().normalized();
        let page = synthetic_image(600, 800);

        // 一次原样交回：重试应当把它救回来，交出来的必须是被改过的图。
        filter::force_passthrough(1);
        let recovered =
            filter::apply_with_dll(&dir, &dll, &page, &settings).expect("重试之后应当给出真的产物");
        let gap = mean_absolute_difference(&page.rgba, &recovered.rgba);
        assert!(
            gap > 0.05,
            "重试之后仍然与输入逐像素同源（差 {gap:.3}）：这一次评估没被重试"
        );

        // 连着两次原样交回：如实报出去，不能拿输入当产物。
        filter::force_passthrough(2);
        match filter::apply_with_dll(&dir, &dll, &page, &settings) {
            Err(error) => assert_eq!(
                error,
                filter::PASSTHROUGH,
                "两次原样交回之后该报「原样交回」"
            ),
            Ok(output) => panic!(
                "两次原样交回之后还是给了一个结果（与输入差 {:.3}）",
                mean_absolute_difference(&page.rgba, &output.rgba)
            ),
        }
        filter::force_passthrough(0);
    }

    /// 每一层都真的拿自己那份参数评估过。
    ///
    /// 「加一层画面会变」不足以证明每层都在算（加层本来就会让结果变），所以判据是**同一套
    /// 层数下只改第 k 层的参数**：改哪一层，输出都必须跟着变。反之，任何一层被 DLL 悄悄
    /// 跳过（评估了但没参与），这一条就会红。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn every_layer_evaluates_with_its_own_parameters() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let page = synthetic_image(600, 800);
        let tone = |tone: f32| PassSettings {
            local_tone_strength: tone,
            ..PassSettings::default()
        };
        let run = |passes: Vec<PassSettings>| {
            let settings = DlssnrSettings { passes }.normalized();
            filter::apply_with_dll(&dir, &dll, &page, &settings)
                .expect("评估")
                .rgba
        };
        let gap = |left: &[u8], right: &[u8]| mean_absolute_difference(left, right);

        let one = run(vec![tone(1.0)]);
        let two = run(vec![tone(1.0), tone(1.0)]);
        let three = run(vec![tone(1.0), tone(1.0), tone(1.0)]);

        // 加层真的要多跑一趟。
        assert!(
            gap(&one, &two) > 0.05,
            "第 2 层没有真的跑：2 层的结果与 1 层相同"
        );
        assert!(
            gap(&two, &three) > 0.05,
            "第 3 层没有真的跑：3 层的结果与 2 层相同"
        );

        // 只改某一层的参数，只有那一层变了才解释得通。
        let single_moved = run(vec![tone(0.2)]);
        assert!(
            gap(&one, &single_moved) > 0.05,
            "层参数没进网络：只改这一层的色调，结果没变"
        );
        let second_moved = run(vec![tone(1.0), tone(2.0)]);
        assert!(
            gap(&two, &second_moved) > 0.05,
            "第 2 层的参数没进网络：只改第 2 层，结果没变"
        );
        let third_moved = run(vec![tone(1.0), tone(1.0), tone(2.0)]);
        assert!(
            gap(&three, &third_moved) > 0.05,
            "第 3 层的参数没进网络：只改第 3 层，结果没变"
        );
        let first_moved = run(vec![tone(2.0), tone(1.0), tone(1.0)]);
        assert!(
            gap(&three, &first_moved) > 0.05,
            "第 1 层的参数没进网络：只改第 1 层，结果没变"
        );
    }

    /// 强度 0 就是「完全保留原图」，DLL 真的会把输入原样交回。
    ///
    /// 实测（合成图与四张真页）：`DLSSNR.Intensity` 是「DLSSNR 结果与原图之间的混合权重」，
    /// 0 → 逐字节等于输入，1 → 完全采用，1.5 / 2.0 与 1.0 逐字节相同（1 以上没有额外效果）。
    /// 所以这里不再当产物交出去，而是如实报 [`filter::PASSTHROUGH`]，由 `commands` 决定
    /// 「原图交回、不写缓存、记一条日志」。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn a_zero_intensity_layer_is_reported_instead_of_cached() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let page = synthetic_image(600, 800);
        let settings = DlssnrSettings {
            passes: vec![PassSettings {
                intensity: 0.0,
                ..PassSettings::default()
            }],
        }
        .normalized();

        match filter::apply_with_dll(&dir, &dll, &page, &settings) {
            Err(error) => assert_eq!(
                error,
                filter::PASSTHROUGH,
                "强度 0 这一页该报「原样交回」，而不是别的错"
            ),
            Ok(output) => panic!(
                "强度 0 被当成产物交出来了（与输入差 {:.3}）",
                mean_absolute_difference(&page.rgba, &output.rgba)
            ),
        }
    }

    /// 取消（记录期出错）**不该**动上下文，也不该把工作区销毁掉。
    ///
    /// 取消是常态：后台整本预扫被前台当前页抢断时就掐掉正在跑的那一页，所以每取消一次
    /// 就重建一遍 feature（120ms 级）是纯浪费。这里注入一次记录期失败，判据是紧接着的
    /// 一次正常请求**不新建工作区、不重建 feature**。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn a_cancelled_page_keeps_the_context_and_its_workspace() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let none = crate::cancel::CancelToken::none();
        let settings = DlssnrSettings::default();
        let page = synthetic_image(700, 900);

        // 先正常跑一次，把工作区与 feature 都建出来。
        let first = filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &none, None)
            .expect("先跑一页都跑不动");
        let builds = super::device::context_builds();
        let (workspaces_before, features_before) = filter::context_counts(&dir, &dll).expect("读计数");

        // 注入一次「记到一半被取消」：错误串就是取消那份，上下文不该作废。
        filter::fail_next_record(true);
        let error = filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &none, None)
            .expect_err("注入的记录期失败要报错");
        assert_eq!(error, filter::CANCELLED, "层间取消失败要报成取消：{error}");

        // 同一个工作区接着用：不重建上下文、不新建工作区、不重建 feature。
        let second = filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &none, None)
            .expect("取消之后要能继续跑");
        assert_eq!(
            super::device::context_builds(),
            builds,
            "取消不该把上下文也作废掉"
        );
        let (workspaces_after, features_after) = filter::context_counts(&dir, &dll).expect("读计数");
        assert_eq!(
            (workspaces_after, features_after),
            (workspaces_before, features_before),
            "取消不该把工作区丢掉：被取消的那一页没有提交过任何命令，纹理还在开场状态"
        );
        assert_eq!(
            mean_absolute_difference(&first.rgba, &second.rgba),
            0.0,
            "取消之后再跑同一页，结果该一模一样"
        );
    }

    /// 「没人看的时候把工作区交回去」必须真的收回那些纹理。
    ///
    /// 这条是内存回归的守卫：工作区缓存与进程同寿，而它按「层数 × 页面积」占的是
    /// **提交内存**——真机实测一页 2731×4096 跑五层留下几个 GB（台账见 `docs/69`），
    /// 上限还是两份。判据四条：跑完一页缓存里确实有一份、交回之后**当下**的数量归零
    /// （不是只改了计数器）、NGX 那边确实收到了那些 feature（`released_features` 得涨）、
    /// 紧接着同一页还能跑出逐像素相同的结果（纹理放掉再建回来，语义没变）。
    ///
    /// 第三条是后补的：前三条里「条数归零」与「逐像素相同」**都分不出**「还回去」与
    /// 「把 `Workspace` 丢掉」——把 `workspace.release(core)` 换成 `context.workspaces.clear()`
    /// 实测照样绿（`debug_outputs/task8h5/blind-release.log`），而 NGX feature 里那份显存
    /// 就这么烂在进程里。把整段回收换成空实现，第一条 `dropped >= 1` 就红。
    #[cfg(feature = "dlssnr")]
    #[test]
    fn releasing_the_cached_workspaces_gives_the_textures_back() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let page = synthetic_image(700, 900);
        let settings = DlssnrSettings::default();
        let first = match filter::apply_with_dll(&dir, &dll, &page, &settings) {
            Ok(output) => output,
            Err(error) => {
                println!("跳过：DLSSNR 没跑起来 —— {error}");
                return;
            }
        };
        assert!(
            super::device::cached_workspace_count() >= 1,
            "跑完一页之后缓存里该留着一份工作区，不然「翻页不重建 feature」就没有着落"
        );
        let released_before = super::ngx::released_features();
        let dropped = super::device::release_cached_workspaces();
        assert!(dropped >= 1, "缓存里明明有工作区，却一个都没放掉");
        assert!(
            super::ngx::released_features() > released_before,
            "工作区是「丢掉」的，不是「还回 NGX」的：条数归零与逐像素相同都拦不住这种假回收"
        );
        assert_eq!(
            super::device::cached_workspace_count(),
            0,
            "交回之后缓存里不该还挂着工作区"
        );
        let second = filter::apply_with_dll(&dir, &dll, &page, &settings)
            .expect("交回工作区之后同一页要还能跑");
        assert_eq!(
            mean_absolute_difference(&first.rgba, &second.rgba),
            0.0,
            "交回工作区只该多花一次重建，结果必须逐像素相同"
        );
    }

    #[cfg(feature = "dlssnr")]
    #[test]
    #[ignore = "real GPU private-commit soak; run separately to avoid other models affecting the measurement"]
    fn repeated_pages_keep_private_commit_bounded_and_release_workspaces() {
        let _gpu = gpu_test_lock();
        let dll = test_dll().expect("memory probe requires the real DLL");
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).unwrap();
        fn private_bytes() -> usize {
            use windows::Win32::System::{ProcessStatus::*, Threading::GetCurrentProcess};
            let mut memory = PROCESS_MEMORY_COUNTERS_EX::default();
            unsafe { GetProcessMemoryInfo(GetCurrentProcess(), (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast(), std::mem::size_of_val(&memory) as u32) }.unwrap();
            memory.PrivateUsage
        }
        device::release_cached_workspaces();
        let passes = dlssnr_passes();
        let mut page = synthetic_image(512, 768);
        let settings = DlssnrSettings { passes: vec![PassSettings { intensity: 1.25, ..Default::default() }; passes] };
        assert_eq!(
            settings.passes.len(),
            passes,
            "层数被 normalized() 改过就不是这一跑问的那个数了"
        );
        let cancel = crate::cancel::CancelToken::none();
        for _ in 0..4 { filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &cancel, None).unwrap(); }
        let before = private_bytes();
        for index in 0..32 {
            page.rgba[0] = index;
            drop(filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &cancel, None).unwrap());
        }
        let after = private_bytes();
        assert!(device::release_cached_workspaces() >= 1);
        std::thread::sleep(std::time::Duration::from_millis(500));
        let released = private_bytes();
        eprintln!("DLSSNR private commit: passes={passes} warm={} MiB, after32={} MiB, released={} MiB", before/1048576, after/1048576, released/1048576);
        assert!(after.saturating_sub(before) < 32 * 1048576, "private commit kept growing per page");
        assert_eq!(device::cached_workspace_count(), 0);
    }

    /// 同一张图、同一套参数，**一次只量一份片段**：它要多久、交出来的东西是不是同一份。
    ///
    /// 一个进程里只认第一份片段（上下文按指纹记着），所以对照不能在一条用例里做完：
    /// `debug_outputs/lecram/ab-dlssnr.ps1` 用 `YOMIKA_DLSSNR_DLL` 各指一次，再把两行
    /// `DLSSNR_AB_JSON` 拼起来比。计时只包住 NR 本身——解码/编码不在这条路上，否则
    /// 2% 量级的差异会被首尾两头（一张 3 MP 的 PNG 编解码就几百毫秒）淹掉。
    ///
    /// 每轮的产出一并报出来：两份片段的输出**逐字节相同**才是「纯内核优化」的证据，
    /// 不相同就说明它动的不只是内核。
    #[cfg(feature = "dlssnr")]
    #[test]
    #[ignore = "real GPU A/B; run once per fragment via debug_outputs/lecram/ab-dlssnr.ps1"]
    fn a_fragment_reports_what_its_kernels_cost_and_what_they_hand_back() {
        let _gpu = gpu_test_lock();
        let dll = test_dll().expect("A/B requires the real DLL");
        fn number(name: &str, fallback: u32) -> u32 {
            match std::env::var(name) {
                Ok(value) => value
                    .parse()
                    .unwrap_or_else(|_| panic!("{name} 不是个数：{value}")),
                Err(_) => fallback,
            }
        }
        let width = number("YOMIKA_DLSSNR_AB_WIDTH", 2048);
        let height = number("YOMIKA_DLSSNR_AB_HEIGHT", 3072);
        let rounds = number("YOMIKA_DLSSNR_AB_ROUNDS", 40) as usize;
        let passes = dlssnr_passes();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data-ab");
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = std::fs::metadata(&dll).map(|meta| meta.len()).unwrap_or(0);
        let sha = file_sha256(&dll).unwrap_or_default();
        let version = dll_version(&dll).unwrap_or_default();
        let variant = variant_of(bytes as usize, &sha)
            .map(|value| value.id())
            .unwrap_or("unknown");
        let mut page = synthetic_image(width, height);
        let settings = DlssnrSettings {
            passes: vec![PassSettings { intensity: 1.25, ..Default::default() }; passes],
        };
        assert_eq!(
            settings.passes.len(),
            passes,
            "层数被 normalized() 改过就不是这一跑问的那个数了"
        );
        let cancel = crate::cancel::CancelToken::none();
        // 前三跑含建上下文与编译管线，那一笔不算。
        for index in 0..3 {
            page.rgba[0] = index as u8;
            drop(
                filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &cancel, None)
                    .expect("预热"),
            );
        }
        let mut micros: Vec<u128> = Vec::with_capacity(rounds);
        let mut digests: Vec<String> = Vec::with_capacity(rounds);
        for index in 0..rounds {
            page.rgba[0] = index as u8;
            let started = std::time::Instant::now();
            let output = filter::apply_with_dll_bucket(&dir, &dll, &page, &settings, &cancel, None)
                .expect("这一页要能跑");
            micros.push(started.elapsed().as_micros());
            digests.push(blake3::hash(&output.rgba).to_hex().to_string());
        }
        let mut sorted = micros.clone();
        sorted.sort_unstable();
        let ms = |value: u128| value as f64 / 1000.0;
        let digest = digests.first().cloned().unwrap_or_default();
        let stable = digests.iter().all(|value| *value == digest);
        let report = serde_json::json!({
            "variant": variant,
            "version": version,
            "bytes": bytes,
            "sha256": sha,
            "width": width,
            "height": height,
            "passes": passes,
            "rounds": rounds,
            "warmup": 3,
            "ms": micros.iter().map(|value| ms(*value)).collect::<Vec<f64>>(),
            "meanMs": ms(micros.iter().sum::<u128>() / micros.len() as u128),
            "medianMs": ms(sorted[sorted.len() / 2]),
            "p95Ms": ms(sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)]),
            "minMs": ms(*sorted.first().unwrap_or(&0)),
            "digest": digest,
            "digestStable": stable,
        });
        eprintln!("DLSSNR_AB_JSON {report}");
    }

    /// 这一跑要几层（§12.4 ②/③ 的「3 层 / 1/3/5 层」）。
    ///
    /// 协议里那个 `layers` 字段**没有一处代码读它**（全仓库的构造点都写 `None`），产品里
    /// 「层」就是这个 DLSSNR 的 `passes`。缺省 3 是这条 soak 原来的写照；能改只是为了把
    /// 「层数与内存/时间的关系」量出来，不碰任何产品行为。
    #[cfg(feature = "dlssnr")]
    fn dlssnr_passes() -> usize {
        match std::env::var("YOMIKA_DLSSNR_PASSES") {
            Ok(value) => value
                .parse::<usize>()
                .unwrap_or_else(|_| panic!("YOMIKA_DLSSNR_PASSES 不是个数：{value}")),
            Err(_) => 3,
        }
    }

}