//! DLSSNR（NVIDIA 的 `nvngx_dlssnr.dll`）滤镜。
//!
//! 这是桌面端把一页图交给 NVIDIA 的神经渲染网络做一次同分辨率增强的路径：读入
//! RGBA、把图与运动/深度引导传进 NGX、取回增强后的 RGBA。参数、风格与多层叠加
//! 都走 NGX 自己的参数表（`DLSSNR.Style` / `DLSSNR.Intensity` / … ），多层就是同一
//! 张图串行跑 1–5 个 pass。
//!
//! 三个入口：
//! * [`status`]：这台机器能不能用（显卡、装的是哪一种 DLL、NGX 自己的判定）。
//! * [`apply`]：把一页图跑一遍（`PassSettings` 列表，1–5 层）。
//! * [`install`]：把用户手上的某个 `nvngx_dlssnr.dll` 装进数据目录。
//!
//! 只做 Windows：这条路径建立在 DXGI / D3D12 / NGX 上，其它平台编译时整个模块
//! 不存在（`#[cfg(windows)]`），调用点用 [`is_supported_platform`] 判断。

#[cfg(windows)]
pub mod commands;

/// 非 Windows 上的同名命令：设置页在这些平台上根本不显示 DLSSNR，但
///  要求命令在所有平台上都存在，所以留一组只会回「不可用」的
/// 壳。（命令名与参数要和 Windows 那份一致，前端只按名字调。）
#[cfg(not(windows))]
pub mod commands {
    use crate::domain::result::CommandResult;

    fn unavailable() -> CommandResult<serde_json::Value> {
        CommandResult::failure(
            "PLATFORM_UNAVAILABLE",
            "DLSSNR 只在 Windows 桌面端可用",
            false,
        )
    }

    #[tauri::command]
    pub fn dlssnr_status(_app: tauri::AppHandle) -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub async fn dlssnr_probe(
        _app: tauri::AppHandle,
        _force: Option<bool>,
    ) -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub fn dlssnr_import_dll(
        _app: tauri::AppHandle,
        _path: String,
    ) -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub fn dlssnr_catalog() -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub async fn dlssnr_download_variant(
        _app: tauri::AppHandle,
        _variant_id: String,
    ) -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub async fn dlssnr_apply_page(
        _input: serde_json::Value,
        _app: tauri::AppHandle,
    ) -> Result<tauri::ipc::Response, String> {
        Ok(crate::domain::result::into_binary_response(
            CommandResult::<Vec<u8>>::failure(
                "PLATFORM_UNAVAILABLE",
                "DLSSNR 只在 Windows 桌面端可用",
                false,
            ),
        ))
    }
}
#[cfg(windows)]
mod animation;
#[cfg(windows)]
mod device;
#[cfg(windows)]
mod filter;
#[cfg(windows)]
mod gpu;
#[cfg(windows)]
mod ngx;
#[cfg(windows)]
mod release;
#[cfg(windows)]
mod settings;
#[cfg(windows)]
mod workspace;

#[cfg(windows)]
pub use animation::apply_dlssnr;
#[cfg(windows)]
pub use filter::{apply, DlssnrImage};
#[cfg(windows)]
pub use gpu::GpuInfo;
#[cfg(windows)]
pub use settings::{DlssnrSettings, PassSettings, DEFAULT_PASS_COUNT, MAX_PASS_COUNT};

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
#[cfg(windows)]
pub fn status(data_dir: &std::path::Path) -> DlssnrStatus {
    let gpu = gpu::detect_gpu().ok().flatten();
    let dll = dll_path(data_dir);
    let dll_bytes = std::fs::metadata(&dll).ok().map(|metadata| metadata.len());
    let variant = cached_variant(&dll);
    let core = ngx::NgxCore::available(data_dir);
    let recommended = gpu.as_ref().and_then(|value| value.recommended_variant());
    let mut report = DlssnrStatus {
        dll_present: dll_bytes.is_some(),
        variant: variant.map(|value| value.id().to_string()),
        variant_label: variant.map(|value| value.label().to_string()),
        dll_bytes,
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

/// 真机跑一遍：合成图 → [`apply`] → 差多少。
///
/// 设置页的「检测」按钮走它，开关也看它——跑通一次才允许打开。
#[cfg(windows)]
pub fn probe(data_dir: &std::path::Path) -> ProbeReport {
    const EDGE: u32 = 96;
    let image = synthetic_image(EDGE, EDGE);
    let started = std::time::Instant::now();
    match apply(data_dir, &image, &DlssnrSettings::default()) {
        Ok(output) => {
            let difference = mean_absolute_difference(&image.rgba, &output.rgba);
            let supported = difference > 0.05;
            ProbeReport {
                supported,
                width: EDGE,
                height: EDGE,
                elapsed_ms: started.elapsed().as_millis() as u64,
                difference,
                error: (!supported).then(|| "输出与输入一模一样：网络没有参与".to_string()),
            }
        }
        Err(error) => ProbeReport {
            supported: false,
            width: EDGE,
            height: EDGE,
            elapsed_ms: started.elapsed().as_millis() as u64,
            difference: 0.0,
            error: Some(error),
        },
    }
}

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
#[cfg(windows)]
fn dll_identity(data_dir: &std::path::Path) -> String {
    match cached_fingerprint(&dll_path(data_dir)) {
        Some((bytes, digest)) => format!("sha256:{digest}:{bytes}"),
        None => "missing".into(),
    }
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
pub(super) fn forget_fingerprint() {
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

/// 导入一份用户给的 `nvngx_dlssnr.dll`：查它是 PE、拷到数据目录、认清是哪一种变体。
///
/// 认不出变体不算错——README 里那三种之外还能有别的（社区还在放新的），只是设置
/// 页说不出它是哪一代卡用的。
#[cfg(windows)]
pub fn install_dll(source: &std::path::Path, data_dir: &std::path::Path) -> Result<InstalledDll, String> {
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
}

/// 一段 RGBA 走一遍 DLSSNR（阅读器与算力中心都从这里进）。
///
/// 尺寸小于 [`filter::MIN_EDGE`] 会直接报错——那是 DLL 自己的要求，不是我们加的。
#[cfg(windows)]
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
#[cfg(windows)]
pub fn probe_cached(data_dir: &std::path::Path, force: bool) -> ProbeReport {
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
    let report = probe(data_dir);
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
/// 每次跑图前检查这台机器当前是否具备显卡、核心与组件。
#[cfg(windows)]
pub fn runtime_gate(data_dir: &std::path::Path) -> Result<(), String> {
    if !dll_path(data_dir).is_file() {
        return Err("还没有导入 nvngx_dlssnr.dll".to_string());
    }
    if !ngx::NgxCore::available(data_dir) {
        return Err("这个构建没有链上 NGX 核心".to_string());
    }
    let gpu = gpu::detect_gpu().map_err(|error| error.to_string())?
        .ok_or_else(|| "这台机器没有可用的 NVIDIA 显卡".to_string())?;
    if gpu.recommended_variant().is_none() {
        return Err(format!("{} 这一代不在 DLSSNR 的支持范围", gpu.name));
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn file_sha256(path: &std::path::Path) -> Option<String> {
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
    pub(super) fn test_dll() -> Option<std::path::PathBuf> {
        if let Ok(path) = std::env::var("YOMIKA_DLSSNR_DLL") {
            let path = std::path::PathBuf::from(path);
            return path.is_file().then_some(path);
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()?
            .join("docs")
            .join("DLSSNR-DLL-Options-310.8.0.0");
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
    pub(crate) fn gpu_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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

    #[test]
    fn status_reports_the_whole_story_without_erroring() {
        let dir = tempfile::tempdir().expect("temp dir");
        let report = status(dir.path());
        // 没导入 DLL 时：明说「还没有导入」，并且不恐慌、不开这一组。
        assert!(!report.dll_present);
        assert!(!report.available);
        assert!(report.error.is_some());
        println!("status: {}", serde_json::to_string(&report).expect("json"));
    }

    /// 「检测」走的那条路：数据目录里没有 DLL，于是给一份明确的失败报告
    /// （不是恐慌，也不是假装能跑）。
    #[test]
    fn status_reports_a_missing_dll_instead_of_panicking() {
        // 只看 status：NGX 的上下文是**进程级**的（`device.rs` 里那份 OnceLock），
        // 同一个测试进程里先跑过真 DLL 的话，probe 会重用那份上下文、照样成功——
        // 「缺 DLL」这件事只能在 status 这一层断言。
        let dir = tempfile::tempdir().expect("temp dir");
        let status = status(dir.path());
        assert!(!status.dll_present, "临时目录里没有 DLL");
        assert!(status.error.is_some(), "要说清楚差什么");
        // 「这一组显不显示」与「现在能不能跑」是两件事：没装片段的机器正是来挑一种
        // 下载的，所以只要卡与核心都在，它就该显示；开关仍然锁着。
        assert_eq!(
            status.installable,
            status.gpu.is_some() && status.recommended_variant.is_some() && status.core_available
        );
        assert!(!status.available, "没装片段就跑不起来");
        if status.installable {
            let hint = status.error.clone().unwrap_or_default();
            assert!(hint.contains("下载"), "该指路去下载：{hint}");
        }
        println!("status: {}", serde_json::to_string(&status).expect("json"));
    }

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

    /// 门控：这台机器上跑不起来时，命令层必须自己拒绝——偏好在另一台机器上打开过
    /// 也好、昨天打开过也好，都不是此刻的事实。
    ///
    /// 判据是**这台机器的事实**（有没有片段、有没有 NGX 核心、有没有那块卡），
    /// 手动检测只用于诊断，不参与门控：探针结论只活在进程内存里，要是拿它当门，
    /// 每次重开应用都得先去设置页点一遍「检测」，否则 DLSSNR 静悄悄地不再生效。
    /// 真跑失败由原生处理链报回来（一次失败 + 一条日志），比「什么都没发生」好。
    #[test]
    fn the_runtime_gate_refuses_a_machine_it_cannot_run_on() {
        let dir = tempfile::tempdir().expect("临时目录");
        forget_probe();
        // 什么都没有（没片段）：必须给一句人话，而且不是 Ok。
        let error = runtime_gate(dir.path()).expect_err("没有片段时不该放行");
        assert!(!error.is_empty());

        // 有片段时，答案由这台机器决定（有没有卡、有没有核心）——重点是**记不记探针
        // 结论都不变**：同一台机器上先记一份「跑不起来」的结论，门控的答案必须一样，
        // 否则就是又把探针当门了。
        let dll = dll_path(dir.path());
        std::fs::create_dir_all(dll.parent().expect("dlssnr 目录")).expect("建目录");
        std::fs::write(&dll, vec![0_u8; 4096]).expect("写片段");
        let before = runtime_gate(dir.path());
        *LAST_PROBE.lock().expect("探针表") = Some((
            probe_key(dir.path()),
            ProbeReport {
                supported: false,
                width: 0,
                height: 0,
                elapsed_ms: 0,
                difference: 0.0,
                error: Some("驱动不支持".to_string()),
            },
        ));
        let after = runtime_gate(dir.path());
        assert_eq!(
            before.is_ok(),
            after.is_ok(),
            "探针结论不该改变门控的答案：{before:?} / {after:?}"
        );
        forget_probe();
    }

    /// 真机跑一遍：没有 NVIDIA 卡、没有 DLL、没有核心就打印原因并跳过；能跑就断言
    /// 它真的改了图。这条同时是「核心 → 片段 → 参数对象 → 评估 → 回读」的端到端。
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
        let none = crate::inference::cancel::CancelToken::none();
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
        let none = crate::inference::cancel::CancelToken::none();
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
    #[test]
    fn growing_the_layer_count_reuses_the_same_workspace() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let none = crate::inference::cancel::CancelToken::none();
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
    }

    /// 提交期失败（`Signal` 失败、栅栏超时…）之后，那份上下文**不能**留在缓存里：
    /// 报错的那一次就要把坏上下文摘掉，下一次请求重建一份，再往后回到复用。
    ///
    /// 这是审计报告 P1-1 的场景：`GpuContext` 是进程级缓存，一次 GPU/驱动错误在改之前
    /// 会被后续每个请求反复用到，故障就放大成「连着一串页都失败」。
    #[test]
    fn a_failed_submit_drops_the_context_instead_of_poisoning_every_page() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let none = crate::inference::cancel::CancelToken::none();
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

    /// 取消（记录期出错）**不该**动上下文，也不该把工作区销毁掉。
    ///
    /// 取消是常态：后台整本预扫被前台当前页抢断时就掐掉正在跑的那一页，所以每取消一次
    /// 就重建一遍 feature（120ms 级）是纯浪费。这里注入一次记录期失败，判据是紧接着的
    /// 一次正常请求**不新建工作区、不重建 feature**。
    #[test]
    fn a_cancelled_page_keeps_the_context_and_its_workspace() {
        let _gpu = gpu_test_lock();
        let Some(dll) = test_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ngx-data");
        std::fs::create_dir_all(&dir).expect("数据目录");
        let none = crate::inference::cancel::CancelToken::none();
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
}
