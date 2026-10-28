//! 宿主这一侧的推理编排：选哪一档超分、模型怎么装、产物怎么缓存。
//!
//! 真正的计算不在这个进程里——ONNX 与内置的 Anime4K 着色器链都跑在 worker（见
//! `compute/`、docs/71 §11）。这里管的是「宿主知道什么」：模型目录与清单、可用档位的
//! 解析（`resolve_upscaler`）、装机与校验，以及把一页交给计算进程、按身份缓存产物。
//! 所以这里的错误几乎都是「这一档现在能不能用」，不是像素对不对。

/// 计算错误的宿主别名。
///
/// 定义搬去了 [`yomika_compute_core::error`]（docs/71 §11 Task 2）：算法层要能在
/// 没有 Tauri、没有数据库的进程里独立报错，而宿主这边保留同一个名字，于是几百处
/// `InferenceError::…` 的构造与 match 一行都不用改。
pub use yomika_compute_core::error::ComputeError as InferenceError;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelManifest {
    pub id: String,
    pub version: String,
    pub format: String,
    pub scale: u32,
    pub max_pixels: usize,
    pub sha256: String,
    pub supported_backends: Vec<String>,
    /// Smallest tile edge the graph will accept, in source pixels. Real-CUGAN
    /// reflects 18 px inside the graph and rejects anything under 20, while the
    /// tiler can hand it a 9 px strip at a page's right edge; the engine grows
    /// such a tile and crops the answer. 1 — the default, and what every model
    /// without an opinion gets — leaves the tile exactly as the pipeline planned
    /// it.
    #[serde(default = "default_min_input_edge")]
    pub min_input_edge: u32,
}

fn default_min_input_edge() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelArchiveEntryKind {
    Regular,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelArchiveEntry {
    pub name: String,
    pub kind: ModelArchiveEntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInstallPlan {
    pub staging_root: std::path::PathBuf,
    pub install_root: std::path::PathBuf,
    pub entries: Vec<std::path::PathBuf>,
}

impl ModelArchiveEntry {
    pub fn regular(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind: ModelArchiveEntryKind::Regular,
        }
    }
}

pub fn plan_model_archive_entries(
    staging_root: &std::path::Path,
    entries: &[ModelArchiveEntry],
) -> Result<Vec<std::path::PathBuf>, InferenceError> {
    let mut targets = std::collections::HashSet::new();
    let mut planned = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.kind != ModelArchiveEntryKind::Regular {
            return Err(InferenceError::InvalidManifest(
                "model archive contains a non-regular entry".into(),
            ));
        }
        if entry.name.is_empty() || entry.name.starts_with(['/', '\\']) || entry.name.contains('\0')
        {
            return Err(InferenceError::InvalidManifest(
                "model archive path is not relative".into(),
            ));
        }
        let components: Vec<&str> = entry.name.split(['/', '\\']).collect();
        if components.iter().any(|component| {
            component.is_empty()
                || *component == "."
                || *component == ".."
                || component.contains(':')
        }) {
            return Err(InferenceError::InvalidManifest(
                "model archive path is unsafe".into(),
            ));
        }
        let duplicate_key = components.join("/").to_lowercase();
        if !targets.insert(duplicate_key) {
            return Err(InferenceError::InvalidManifest(
                "model archive target is duplicated".into(),
            ));
        }
        let mut target = staging_root.to_path_buf();
        for component in components {
            target.push(component);
        }
        if !target.starts_with(staging_root) {
            return Err(InferenceError::InvalidManifest(
                "model archive target escapes staging".into(),
            ));
        }
        planned.push(target);
    }
    Ok(planned)
}

/// Build the filesystem boundary for an atomic model-directory publish.
/// Both roots must be sibling absolute paths so a final rename stays on one
/// filesystem and cannot place the install directory inside its staging tree.
pub fn plan_model_install(
    staging_root: &std::path::Path,
    install_root: &std::path::Path,
    entries: &[ModelArchiveEntry],
) -> Result<ModelInstallPlan, InferenceError> {
    if !staging_root.is_absolute() || !install_root.is_absolute() {
        return Err(InferenceError::InvalidManifest(
            "model install roots must be absolute".into(),
        ));
    }
    if staging_root == install_root
        || staging_root.starts_with(install_root)
        || install_root.starts_with(staging_root)
        || staging_root.parent() != install_root.parent()
    {
        return Err(InferenceError::InvalidManifest(
            "model install roots must be sibling paths".into(),
        ));
    }
    let planned = plan_model_archive_entries(staging_root, entries)?;
    Ok(ModelInstallPlan {
        staging_root: staging_root.to_path_buf(),
        install_root: install_root.to_path_buf(),
        entries: planned,
    })
}

fn safe_model_identity_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

pub fn model_install_roots(
    app_data_dir: &std::path::Path,
    model_id: &str,
    model_version: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), InferenceError> {
    if !app_data_dir.is_absolute()
        || !safe_model_identity_segment(model_id)
        || !safe_model_identity_segment(model_version)
    {
        return Err(InferenceError::InvalidManifest(
            "model identity is not a safe path segment".into(),
        ));
    }
    let parent = app_data_dir.join("models").join(model_id);
    Ok((
        parent.join(format!(".{model_version}.installing")),
        parent.join(model_version),
    ))
}

const MAX_MODEL_ARCHIVE_UNCOMPRESSED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Where the validated manifest is kept inside an installed model directory.
///
/// Nothing else records the model's scale, and without it a model cannot be
/// used: an ONNX output shape is usually dynamic, so the file itself cannot say
/// how much bigger it makes an image. The name is deliberately ours rather than
/// `manifest.json`, which an upstream model archive might well contain.
pub const MODEL_MANIFEST_FILE: &str = "yomika-model.json";

/// The `.onnx` file inside an installed model directory, if there is exactly one.
pub fn model_file_in(install_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut found = None;
    for entry in std::fs::read_dir(install_root).ok()?.flatten() {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("onnx"))
            && found.replace(path).is_some()
        {
            return None;
        }
    }
    found
}

pub fn read_model_manifest(install_root: &std::path::Path) -> Option<ModelManifest> {
    let bytes = std::fs::read(install_root.join(MODEL_MANIFEST_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn install_model_archive(
    archive_bytes: &[u8],
    manifest: &ModelManifest,
    staging_root: &std::path::Path,
    install_root: &std::path::Path,
) -> Result<std::path::PathBuf, InferenceError> {
    validate_manifest(manifest)?;
    if staging_root.exists() || install_root.exists() {
        return Err(InferenceError::InvalidInput(
            "model staging or install path already exists".into(),
        ));
    }

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(archive_bytes))
        .map_err(|error| InferenceError::InvalidManifest(format!("invalid model ZIP: {error}")))?;
    let mut entries = Vec::with_capacity(archive.len());
    let mut model_index = None;
    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| {
            InferenceError::InvalidManifest(format!("invalid model ZIP entry: {error}"))
        })?;
        total_size = total_size
            .checked_add(file.size())
            .ok_or_else(|| InferenceError::InvalidManifest("model ZIP size overflow".into()))?;
        if total_size > MAX_MODEL_ARCHIVE_UNCOMPRESSED_BYTES {
            return Err(InferenceError::InvalidManifest(
                "model ZIP is too large".into(),
            ));
        }
        let name = std::str::from_utf8(file.name_raw())
            .map_err(|_| InferenceError::InvalidManifest("model ZIP path is not UTF-8".into()))?
            .to_string();
        let kind = if file.is_dir() {
            ModelArchiveEntryKind::Directory
        } else {
            match file.unix_mode().map(|mode| mode & 0o170000) {
                Some(0o120000) => ModelArchiveEntryKind::Symlink,
                Some(0o040000) => ModelArchiveEntryKind::Directory,
                Some(0o100000) | Some(0) | None => ModelArchiveEntryKind::Regular,
                Some(_) => ModelArchiveEntryKind::Other,
            }
        };
        if kind == ModelArchiveEntryKind::Regular
            && std::path::Path::new(&name)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("onnx"))
        {
            if model_index.replace(index).is_some() {
                return Err(InferenceError::InvalidManifest(
                    "model ZIP must contain one ONNX file".into(),
                ));
            }
        }
        entries.push(ModelArchiveEntry { name, kind });
    }
    let model_index = model_index.ok_or_else(|| {
        InferenceError::InvalidManifest("model ZIP does not contain an ONNX file".into())
    })?;
    let plan = plan_model_install(staging_root, install_root, &entries)?;

    let result = (|| {
        std::fs::create_dir_all(staging_root.parent().ok_or_else(|| {
            InferenceError::InvalidInput("model staging path has no parent".into())
        })?)
        .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
        std::fs::create_dir(staging_root)
            .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;

        for (index, target) in plan.entries.iter().enumerate() {
            let mut source = archive.by_index(index).map_err(|error| {
                InferenceError::InvalidManifest(format!("invalid model ZIP entry: {error}"))
            })?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
            }
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
            std::io::copy(&mut source, &mut output)
                .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
            output
                .sync_all()
                .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
        }

        let model_path = &plan.entries[model_index];
        let model_bytes = std::fs::read(model_path)
            .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
        validate_model_bytes(manifest, &model_bytes)?;
        // Written into staging so it lands with the rename: a model directory
        // without its manifest has no recorded scale and cannot be used. Scoped
        // so the handle is closed first — Windows refuses to rename a directory
        // that still has an open file inside it.
        {
            let manifest_json = serde_json::to_vec_pretty(manifest)
                .map_err(|error| InferenceError::InvalidManifest(error.to_string()))?;
            let mut manifest_file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging_root.join(MODEL_MANIFEST_FILE))
                .map_err(|_| {
                    InferenceError::InvalidManifest(format!(
                        "model ZIP must not contain {MODEL_MANIFEST_FILE}"
                    ))
                })?;
            std::io::Write::write_all(&mut manifest_file, &manifest_json)
                .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
            manifest_file
                .sync_all()
                .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
        }
        if install_root.exists() {
            return Err(InferenceError::InvalidInput(
                "model install path already exists".into(),
            ));
        }
        std::fs::rename(staging_root, install_root)
            .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
        Ok(install_root.to_path_buf())
    })();

    if result.is_err() && staging_root.exists() {
        let _ = std::fs::remove_dir_all(staging_root);
    }
    result
}

// Anime4K 的解析器与 CPU 解释器搬进了计算核心（docs/71 §11 Task 2）：worker 也要
// 编进这一档，两边必须解同一份 GLSL。宿主的 `inference::anime4k::*` 路径原样保留，
// 调用点（`inference.rs` 与阅读器那几条规划）一行都不用改。
pub use yomika_compute_core::anime4k;
pub mod cancel;
// 下面这个模块（以及它背后的核心层）只有测试用得上：`onnx` 是真模型用例要开的引擎。产品构建里宿主一条 ONNX 会话都不开
// （8-g③-iv），所以它连编译都不该进来——`#[cfg(test)]` 就是这条边界，谁哪天在产品
// 代码里用上它们，会以「找不到模块」当场红掉，而不是悄悄把运行库链回主进程。
#[cfg(test)]
pub mod onnx;
pub mod session;
mod scheduling;
pub mod upscale;

/// The pixel budget a model is handed when nothing on disk says otherwise.
/// Tiles are far smaller than this; the budget exists so a pathological page
/// cannot ask for an allocation that takes the process down.
pub const DEFAULT_MAX_PIXELS: usize = 64_000_000;

/// Execution providers we know how to ask for, most preferred first per
/// platform. The ONNX Runtime session picks one of these; CPU always works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendId {
    DirectMl,
    CoreMl,
    Nnapi,
    Cpu,
}

impl BackendId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectMl => "directml",
            Self::CoreMl => "coreml",
            Self::Nnapi => "nnapi",
            Self::Cpu => "cpu",
        }
    }

    pub fn is_hardware_accelerated(self) -> bool {
        !matches!(self, Self::Cpu)
    }
}

/// Preference order for the current platform. Windows gets DirectML, Apple
/// platforms CoreML, Android NNAPI — the same split the mihon fork makes when it
/// chooses a Vulkan/NNAPI device — and CPU is the universal fallback.
///
/// 顺序本体在 `yomika_compute_core::runtime::platform_preference`：宿主与 worker 必须
/// 给出同一个顺序，留两份就会漂移。
pub fn platform_backend_preference() -> Vec<BackendId> {
    yomika_compute_core::runtime::platform_preference()
        .into_iter()
        .map(session::backend_of)
        .collect()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceCapabilities {
    pub backends: Vec<String>,
    pub max_pixels: usize,
    pub hardware_acceleration: bool,
}

/// 这份构建**声明**要用哪几条运行库（平台偏好顺序，末位永远是 CPU）。
///
/// 8-g③-iv 之前这里是**实测**：宿主自己开一次会话来问哪条能跑。现在宿主一条会话都
/// 开不了（模型计算全在 worker 里），能实测的只剩 worker——它启动时拿
/// `WORKER_RUNTIME_LABEL` 自证，每次交回的 `EngineReport` 里带着真的
/// `device_id`/`fallback`。所以这条命令答的是「这份构建打算怎么走」，不是「这台机器
/// 能不能走」；要后者请看产物里那份报告，别把这一条当保证用。
#[tauri::command(async)]
pub fn inference_probe() -> crate::domain::result::CommandResult<InferenceCapabilities> {
    let backends = platform_backend_preference();
    crate::domain::result::CommandResult::success(InferenceCapabilities {
        hardware_acceleration: backends
            .iter()
            .any(|backend| backend.is_hardware_accelerated()),
        backends: backends
            .into_iter()
            .map(|backend| backend.as_str().to_string())
            .collect(),
        max_pixels: 64_000_000,
    })
}

pub fn validate_manifest(manifest: &ModelManifest) -> Result<(), InferenceError> {
    if manifest.id.trim().is_empty()
        || manifest.version.trim().is_empty()
        || manifest.format != "onnx"
    {
        return Err(InferenceError::InvalidManifest(
            "model identity or format invalid".to_string(),
        ));
    }
    if manifest.scale == 0
        || manifest.max_pixels == 0
        || !manifest.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || manifest.sha256.len() != 64
    {
        return Err(InferenceError::InvalidManifest(
            "model scale, pixel budget or hash invalid".to_string(),
        ));
    }
    if !manifest
        .supported_backends
        .iter()
        .any(|backend| backend == "cpu")
    {
        return Err(InferenceError::InvalidManifest(
            "CPU backend is required".to_string(),
        ));
    }
    // A zero floor would mean "grow every tile to nothing"; an enormous one would
    // ask for an allocation far past any model's needs.
    if manifest.min_input_edge == 0 || manifest.min_input_edge > 4096 {
        return Err(InferenceError::InvalidManifest(
            "model minimum input edge is out of range".to_string(),
        ));
    }
    Ok(())
}

pub fn validate_model_bytes(manifest: &ModelManifest, model: &[u8]) -> Result<(), InferenceError> {
    validate_manifest(manifest)?;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(model);
    let actual = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual != manifest.sha256.to_ascii_lowercase() {
        return Err(InferenceError::InvalidManifest(
            "model hash mismatch".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelValidationInput {
    pub manifest: ModelManifest,
    pub model: Vec<u8>,
}

#[tauri::command(async)]
pub fn inference_validate_model(
    input: ModelValidationInput,
) -> crate::domain::result::CommandResult<()> {
    match validate_model_bytes(&input.manifest, &input.model) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(InferenceError::InvalidManifest(message)) => {
            crate::domain::result::CommandResult::failure("INVALID_RESPONSE", message, false)
        }
        Err(error) => crate::domain::result::CommandResult::failure(
            "INVALID_RESPONSE",
            format!("{error:?}"),
            false,
        ),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInstallInput {
    pub manifest: ModelManifest,
    pub archive: Vec<u8>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub id: String,
    pub version: String,
    /// From the installed manifest. `None` means the directory has no manifest,
    /// so the model can be listed but not run.
    pub scale: Option<u32>,
    /// Supported model kind. Cached entries from removed features are never
    /// returned to the frontend's strictly validated model list.
    pub kind: String,
    /// Reserved component metadata; current upscalers use a single graph.
    #[serde(default)]
    pub components: Vec<InstalledModelComponent>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModelComponent {
    pub id: String,
    pub name: String,
    pub role: String,
    pub path: String,
}

/// How much larger than the page an enhanced rendition is served.
///
/// The models available are x4, and x4 is not what a reader needs: it is sixteen
/// times the pixels, which has to be encoded, cached, decoded and then drawn into
/// a slot at most a couple of times the page's size. Downsampling the model's
/// output to x2 keeps the detail the model recovered and drops three quarters of
/// the bytes — which is also most of the reason enhanced pages felt slow.
pub const ENHANCED_OUTPUT_SCALE: u32 = 2;

/// Resamples a model's output down to `ENHANCED_OUTPUT_SCALE` times the source.
/// Anything already at or below that is returned untouched.
///
/// 缩放本身在 `yomika_compute_core::fit` 里：worker 也要在编码之前做同一件事，
/// 抄一份「交出去多大」的规则迟早会两边不一致（MEMORY 三十二）。这里留下的是**产品
/// 常数与名字**——「阅读器要几倍」是策略，不是算法。
///
/// 取 `Vec` 而不是 `&[u8]` 是有意的，理由在核心那边：`to_vec()` 会让 25 MP 的模型
/// 输出在内存里躺两份（256 MB），而这条路径上没人还需要模型的原样输出。
pub fn fit_enhanced_output(
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    source_width: u32,
    source_height: u32,
) -> (Vec<u8>, u32, u32) {
    yomika_compute_core::fit::fit_rgba_scale(
        rgba,
        width,
        height,
        source_width,
        source_height,
        ENHANCED_OUTPUT_SCALE,
    )
}

/// 空操作：宿主一条 ONNX 会话都没有了。
///
/// 从前它清的是宿主的进程级会话缓存，那台缓存随「模型计算全在 worker」一起消失
/// （8-g③-iv，最后一个占用者是页面那条来路）。命令**留着**是因为渲染层在离开阅读器
/// 时还在叫它——让一个常用的调用变成「没有这个命令」是前端要单独处理的错误，而这里
/// 该表达的只是「本来就没事可做」。返回值从此恒为 0。
#[tauri::command]
pub async fn inference_release_sessions() -> crate::domain::result::CommandResult<u32> {
    crate::domain::result::CommandResult::success(0)
}

pub const MODEL_KIND_UPSCALE: &str = "upscale";

// Inspect metadata only: never read ONNX weights to populate the settings list.
fn model_fingerprint(root: &std::path::Path) -> std::io::Result<String> {
    use std::hash::{Hash, Hasher};
    fn visit(
        root: &std::path::Path,
        hash: &mut std::collections::hash_map::DefaultHasher,
    ) -> std::io::Result<()> {
        let mut entries = std::fs::read_dir(root)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            let meta = entry.metadata()?;
            entry.file_name().hash(hash);
            if kind.is_dir() {
                visit(&entry.path(), hash)?;
            } else {
                meta.len().hash(hash);
                meta.modified()?.hash(hash);
            }
        }
        Ok(())
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    visit(root, &mut hash)?;
    Ok(format!("v3-{:016x}", hash.finish()))
}

/// 指纹按根目录缓存：模型装好后内容不变，而逐页超分会让每个页面都走一遍
/// 目录遍历。失效信号用根目录自身的 mtime——安装、换版本必然动到它；
/// 只在既有版本目录里原地替换权重文件的场景才会漏，而那不是任何入口的做法。
/// 指纹缓存也必须是有界容器：键是模型根目录，正常只有几个，但路径来自安装与
/// 导入入口，一个只插不删的表就是无界的。插满之后按插入顺序淘汰最旧的一条，
/// 与 inference/cancel.rs 的 pending 表是同一套做法。
const MAX_FINGERPRINT_CACHE_ENTRIES: usize = 64;

#[derive(Default)]
struct FingerprintCache {
    entries: std::collections::HashMap<std::path::PathBuf, (Option<std::time::SystemTime>, String)>,
    order: std::collections::VecDeque<std::path::PathBuf>,
}

impl FingerprintCache {
    fn get(&self, root: &std::path::Path) -> Option<&(Option<std::time::SystemTime>, String)> {
        self.entries.get(root)
    }

    fn insert(
        &mut self,
        root: std::path::PathBuf,
        stamp: Option<std::time::SystemTime>,
        fingerprint: String,
    ) {
        if self.entries.insert(root.clone(), (stamp, fingerprint)).is_none() {
            self.order.push_back(root);
        }
        while self.order.len() > MAX_FINGERPRINT_CACHE_ENTRIES {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

static FINGERPRINT_CACHE: std::sync::Mutex<Option<FingerprintCache>> =
    std::sync::Mutex::new(None);

fn cached_model_fingerprint(root: &std::path::Path) -> std::io::Result<String> {
    let stamp = root.metadata()?.modified().ok();
    let mut guard = FINGERPRINT_CACHE
        .lock()
        .map_err(|_| std::io::Error::other("fingerprint cache poisoned"))?;
    let cache = guard.get_or_insert_with(FingerprintCache::default);
    if let Some((cached_stamp, cached)) = cache.get(root) {
        if *cached_stamp == stamp {
            return Ok(cached.clone());
        }
    }
    let fingerprint = model_fingerprint(root)?;
    cache.insert(root.to_path_buf(), stamp, fingerprint.clone());
    Ok(fingerprint)
}

pub fn model_data_dir(_app: &tauri::AppHandle) -> std::io::Result<std::path::PathBuf> {
    crate::data_paths::data_dir(_app)
}

/// Models on disk, as `models/<id>/<version>/`, newest version of each id first.
///
/// A partially-extracted install is a `.<version>.installing` sibling, and those
/// are skipped: offering one as a choice would name a model that cannot load.
pub fn installed_models_in(app_data_dir: &std::path::Path) -> Vec<InstalledModel> {
    let models_dir = app_data_dir.join("models");
    let cache_file = app_data_dir.join("model-index.json");
    let fingerprint = model_fingerprint(&models_dir).ok();
    if let (Some(fp), Ok(bytes)) = (&fingerprint, std::fs::read(&cache_file)) {
        if let Ok((cached_fp, models)) =
            serde_json::from_slice::<(String, Vec<InstalledModel>)>(&bytes)
        {
            if &cached_fp == fp && models.iter().all(|model| model.kind == MODEL_KIND_UPSCALE) {
                return models;
            }
        }
    }
    let mut found = Vec::new();
    let Ok(model_dirs) = std::fs::read_dir(&models_dir) else {
        return found;
    };
    for model_dir in model_dirs.flatten() {
        if !model_dir
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let id = model_dir.file_name().to_string_lossy().to_string();
        if !safe_model_identity_segment(&id) || id.starts_with('.') {
            continue;
        }
        let Ok(versions) = std::fs::read_dir(model_dir.path()) else {
            continue;
        };
        let mut ids: Vec<String> = versions
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            // `model_install_roots` stages an extraction as `.<version>.installing`,
            // and that leading dot is the only thing separating a finished install
            // from a half-written one.
            .filter(|version| safe_model_identity_segment(version) && !version.starts_with('.'))
            .collect();
        ids.sort_by(|left, right| right.cmp(left));
        for version in ids {
            let root = model_dir.path().join(&version);
            let scale = read_model_manifest(&root).map(|manifest| manifest.scale);
            // Old multi-directory bundles are not single-graph upscalers.
            // Rebuilding their cache must not relabel them as supported models.
            if scale.is_none() && model_file_in(&root).is_none()
                && std::fs::read_dir(&root).ok().is_some_and(|entries| {
                    entries.flatten().any(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                }) {
                continue;
            }
            found.push(InstalledModel {
                id: id.clone(),
                version,
                scale,
                kind: MODEL_KIND_UPSCALE.into(),
                components: Vec::new(),
            });
        }
    }
    found.sort_by(|left, right| left.id.cmp(&right.id));
    if let Some(fp) = fingerprint {
        if let Ok(bytes) = serde_json::to_vec(&(fp, found.clone())) {
            let _ = std::fs::write(cache_file, bytes);
        }
    }
    found
}

/// Newest installed version of `model_id` that is actually runnable: it has a
/// manifest (so a scale) and exactly one ONNX file.
///
/// `pub(crate)`：计算编排层（`compute::models`）要在派发前把这份模型摆进只读输入根，
/// 交给 worker 去算。解析规则只该有一份，命令层与编排层不许各自实现一遍。
pub(crate) fn resolve_installed_model(
    app_data_dir: &std::path::Path,
    model_id: &str,
) -> Option<(std::path::PathBuf, ModelManifest)> {
    installed_models_in(app_data_dir)
        .into_iter()
        .filter(|model| model.id == model_id && model.kind == MODEL_KIND_UPSCALE)
        .find_map(|model| {
            let root = app_data_dir
                .join("models")
                .join(&model.id)
                .join(&model.version);
            let manifest = read_model_manifest(&root)?;
            model_file_in(&root).map(|path| (path, manifest))
        })
}

/// Upscalers that ship inside the binary. Anime4K is a shader chain rather than
/// an ONNX file, so there is nothing to download and no directory to find: it is
/// listed alongside the installed models and resolved by id.
pub fn builtin_upscale_models() -> Vec<InstalledModel> {
    anime4k::ANIME4K_PRESETS
        .iter()
        // Anime4K exposes one curated chain in settings. The legacy presets
        // remain addressable by the renderer so existing cached pages work.
        .filter(|preset| preset.id == "anime4k-hq")
        .map(|preset| InstalledModel {
            id: preset.id.to_string(),
            version: preset.version.to_string(),
            scale: Some(preset.scale),
            kind: MODEL_KIND_UPSCALE.to_string(),
            components: Vec::new(),
        })
        .collect()
}

/// The built-in upscaling chain `model_id` names, if it names one.
///
/// Anime4K is a shader chain compiled into the binary rather than an ONNX file.
/// It used to be **host only** — the worker's build carried no copy, so a pipeline
/// stage naming one could never run there, and the caller had to tell that apart
/// from "not downloaded". Since the parser and both executors moved into
/// `yomika-compute-core` (which the worker also links) the chain is no longer a
/// host privilege: the worker compiles the same shaders and runs the same tier.
/// The distinction that remains is *what kind of thing* an id names, which is what
/// this function answers — and `compute::models` turns it into a `StagedModel`.
pub(crate) fn builtin_upscaler(model_id: &str) -> Option<&'static anime4k::Anime4kPreset> {
    anime4k::preset_by_id(model_id)
}

/// What a `upscaleModel` id names: a built-in chain, a model on disk, or nothing
/// at all, which leaves the pipeline on the nearest-neighbour scaler.
///
/// `pub(crate)`：`compute::reader`（阅读器那道门）要按同一把尺子判「这个 id 到底是
/// 什么」——是能在 worker 里跑的模型，还是只活在宿主里的 shader 链。两边各判一遍就会
/// 出现「一边当它是模型、另一边当它是预设」。
pub(crate) enum ResolvedUpscaler {
    Onnx(std::path::PathBuf, ModelManifest),
    Anime4k(&'static anime4k::Anime4kPreset),
}

pub(crate) fn resolve_upscaler(
    app_data_dir: &std::path::Path,
    model_id: &str,
) -> Option<ResolvedUpscaler> {
    if let Some(preset) = anime4k::preset_by_id(model_id) {
        return Some(ResolvedUpscaler::Anime4k(preset));
    }
    resolve_installed_model(app_data_dir, model_id)
        .map(|(path, manifest)| ResolvedUpscaler::Onnx(path, manifest))
}

/// An installed model and a built-in one are the same kind of choice in the
/// settings list; the built-ins come first so a fresh install can turn upscaling
/// on without downloading anything.
pub fn listed_upscale_models_in(app_data_dir: &std::path::Path) -> Vec<InstalledModel> {
    let mut models = builtin_upscale_models();
    models.extend(installed_models_in(app_data_dir));
    models
}

/// Removes all downloaded versions of selected models; bundled models are protected.
pub fn remove_downloaded_models(
    app_data_dir: &std::path::Path,
    model_ids: &[String],
) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    // Validate the entire request before touching disk, including bundled IDs.
    if model_ids.is_empty() || model_ids.iter().any(|id| {
        !safe_model_identity_segment(id) || id.starts_with('.')
            || id == "waifu2x-upconv7" || builtin_upscaler(id).is_some()
    }) {
        return Err(Error::new(ErrorKind::InvalidInput, "不能删除随包模型或无效模型"));
    }
    let data = app_data_dir.canonicalize()?;
    let models = data.join("models");
    if !models.exists() { return Ok(()); }
    if models.canonicalize()? != models {
        return Err(Error::new(ErrorKind::InvalidInput, "模型目录不能是外部链接"));
    }
    let mut roots = Vec::new();
    for id in model_ids {
        let root = models.join(id);
        match std::fs::symlink_metadata(&root) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() || root.canonicalize()? != root {
                    return Err(Error::new(ErrorKind::InvalidInput, "模型路径无效"));
                }
                if !roots.contains(&root) { roots.push(root); }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {},
            Err(error) => return Err(error),
        }
    }
    for root in roots { std::fs::remove_dir_all(root)?; }
    // Discovery must not revive an old model-index snapshot after deletion.
    let _ = std::fs::remove_file(data.join("model-index.json"));
    Ok(())
}

#[tauri::command(async)]
pub fn inference_remove_models(
    app: tauri::AppHandle,
    model_ids: Vec<String>,
) -> crate::domain::result::CommandResult<Vec<InstalledModel>> {
    let result = model_data_dir(&app).and_then(|data| {
        remove_downloaded_models(&data, &model_ids)?;
        Ok(listed_upscale_models_in(&data))
    });
    match result {
        Ok(models) => crate::domain::result::CommandResult::success(models),
        Err(error) => crate::domain::result::CommandResult::failure(
            "MODEL_REMOVE_FAILED", format!("删除模型失败：{error}"), true,
        ),
    }
}

#[tauri::command(async)]
pub fn inference_list_models(
    app: tauri::AppHandle,
) -> crate::domain::result::CommandResult<Vec<InstalledModel>> {
    match model_data_dir(&app) {
        Ok(app_data_dir) => {
            crate::domain::result::CommandResult::success(listed_upscale_models_in(&app_data_dir))
        }
        Err(error) => crate::domain::result::CommandResult::failure(
            "PLATFORM_UNAVAILABLE",
            error.to_string(),
            false,
        ),
    }
}

#[tauri::command(async)]
pub fn inference_install_model(
    app: tauri::AppHandle,
    input: ModelInstallInput,
) -> crate::domain::result::CommandResult<InstalledModel> {
    let result = model_data_dir(&app)
        .map_err(|error| InferenceError::InvalidInput(error.to_string()))
        .and_then(|app_data_dir| {
            let (staging, install) =
                model_install_roots(&app_data_dir, &input.manifest.id, &input.manifest.version)?;
            install_model_archive(&input.archive, &input.manifest, &staging, &install)
        });

    match result {
        Ok(_) => crate::domain::result::CommandResult::success(InstalledModel {
            id: input.manifest.id,
            version: input.manifest.version,
            scale: Some(input.manifest.scale),
            kind: MODEL_KIND_UPSCALE.to_string(),
            components: Vec::new(),
        }),
        Err(InferenceError::InvalidInput(message)) => {
            crate::domain::result::CommandResult::failure("INVALID_RESPONSE", message, false)
        }
        Err(InferenceError::InvalidManifest(message)) => {
            crate::domain::result::CommandResult::failure("INVALID_RESPONSE", message, false)
        }
        Err(InferenceError::PixelBudgetExceeded { pixels, max_pixels }) => {
            crate::domain::result::CommandResult::failure(
                "INFERENCE_UNAVAILABLE",
                format!("Image pixel budget exceeded: {pixels} > {max_pixels}"),
                false,
            )
        }
        Err(InferenceError::CacheBusy) => crate::domain::result::CommandResult::failure(
            "INFERENCE_UNAVAILABLE",
            "Inference cache is in use",
            true,
        ),
        // 安装模型这条路上没有取消点，但错误枚举多了一格，这里必须有个说法。
        Err(InferenceError::Cancelled) => crate::domain::result::CommandResult::failure(
            "INFERENCE_CANCELLED",
            "任务已取消",
            false,
        ),
    }
}

/// The model id a raw `.onnx` import lands under: the file's stem when it is a
/// safe path segment (so `realesr-general-x4v3.onnx` is selectable under the
/// name the settings menu already knows), otherwise the legacy catch-all.
fn imported_model_id(filename: &str) -> String {
    let stem = filename.trim();
    let stem = stem.strip_suffix(".onnx").or_else(|| stem.strip_suffix(".ONNX")).unwrap_or(stem);
    let sanitized: String = stem
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        .map(|byte| byte as char)
        .collect();
    if safe_model_identity_segment(&sanitized) {
        sanitized
    } else {
        "imported-model".into()
    }
}

/// Imports either a zip containing `manifest.json` and model assets, or a raw
/// ONNX file, from a path on disk. Raw files receive a conservative CPU
/// manifest and use the fixed application data model directory through the
/// normal installer.
///
/// 几百 MB 的包不再被前端拆成 number[] 过 JSON 桥（一进一出要占十几倍内存，
/// 还会冻结主线程）：由 Rust 直接读路径。(async)：整文件读 + 安装是重活。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImportPathInput {
    pub path: String,
}

#[tauri::command(async)]
pub fn inference_import_model_path(
    app: tauri::AppHandle,
    input: ModelImportPathInput,
) -> crate::domain::result::CommandResult<InstalledModel> {
    let trimmed = input.path.trim();
    if trimmed.is_empty() {
        return crate::domain::result::CommandResult::failure(
            "INVALID_MODEL_IMPORT",
            String::from("model path is empty"),
            false,
        );
    }
    let path = std::path::Path::new(trimmed);
    let outcome = (|| -> Result<InstalledModel, String> {
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err(String::from("not a file"));
        }
        let filename = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or_else(|| String::from("model path has no filename"))?;
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        // InferenceError 的 Debug 形状与旧入口一致地透出。
        import_model_bytes(&app, filename, bytes).map_err(|e| format!("{e:?}"))
    })();
    match outcome {
        Ok(model) => crate::domain::result::CommandResult::success(model),
        Err(message) => crate::domain::result::CommandResult::failure(
            "INVALID_MODEL_IMPORT",
            message,
            false,
        ),
    }
}

fn import_model_bytes(
    app: &tauri::AppHandle,
    filename: String,
    file: Vec<u8>,
) -> Result<InstalledModel, InferenceError> {
    model_data_dir(app)
        .map_err(|e| InferenceError::InvalidInput(e.to_string()))
        .and_then(|data| {
            let (manifest, archive) = if filename.to_ascii_lowercase().ends_with(".onnx") {
                use sha2::{Digest, Sha256};
                let hash = Sha256::digest(&file)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();
                let manifest = ModelManifest {
                    id: imported_model_id(&filename),
                    version: "1".into(),
                    format: "onnx".into(),
                    scale: 2,
                    max_pixels: 64_000_000,
                    sha256: hash,
                    supported_backends: vec!["cpu".into()],
                    min_input_edge: default_min_input_edge(),
                };
                let mut archive = std::io::Cursor::new(Vec::new());
                {
                    let mut writer = zip::ZipWriter::new(&mut archive);
                    writer
                        .start_file("model.onnx", zip::write::SimpleFileOptions::default())
                        .map_err(|e| InferenceError::InvalidInput(e.to_string()))?;
                    std::io::Write::write_all(&mut writer, &file)
                        .map_err(|e| InferenceError::InvalidInput(e.to_string()))?;
                    writer
                        .finish()
                        .map_err(|e| InferenceError::InvalidInput(e.to_string()))?;
                }
                (manifest, archive.into_inner())
            } else {
                let manifest = {
                    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&file))
                        .map_err(|e| InferenceError::InvalidInput(e.to_string()))?;
                    let mut manifest_file = zip.by_name("manifest.json").map_err(|e| {
                        InferenceError::InvalidManifest(format!("manifest.json missing: {e}"))
                    })?;
                    let mut manifest_bytes = Vec::new();
                    std::io::Read::read_to_end(&mut manifest_file, &mut manifest_bytes)
                        .map_err(|e| InferenceError::InvalidInput(e.to_string()))?;
                    serde_json::from_slice::<ModelManifest>(&manifest_bytes)
                        .map_err(|e| InferenceError::InvalidManifest(e.to_string()))?
                };
                (manifest, file)
            };
            let (staging, install) = model_install_roots(&data, &manifest.id, &manifest.version)?;
            install_model_archive(&archive, &manifest, &staging, &install).map(|_| InstalledModel {
                id: manifest.id,
                version: manifest.version,
                scale: Some(manifest.scale),
                kind: MODEL_KIND_UPSCALE.to_string(),
                components: Vec::new(),
            })
        })
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceCacheClearResult {
    pub entries_cleared: usize,
}

pub fn clear_inference_cache(
    connection: &rusqlite::Connection,
    cache_root: &std::path::Path,
) -> Result<InferenceCacheClearResult, InferenceError> {
    let is_controlled_root = cache_root.is_absolute()
        && cache_root.file_name() == Some(std::ffi::OsStr::new("inference"))
        && cache_root.parent().and_then(std::path::Path::file_name)
            == Some(std::ffi::OsStr::new("cache"));
    if !is_controlled_root {
        return Err(InferenceError::InvalidInput(
            "invalid inference cache root".into(),
        ));
    }
    let active_jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM inference_jobs WHERE status IN ('queued','running','paused')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
    if active_jobs > 0 {
        return Err(InferenceError::CacheBusy);
    }

    let clearing_root = cache_root.with_file_name(".inference-clearing");
    if clearing_root.exists() {
        return Err(InferenceError::InvalidInput(
            "inference cache cleanup is already pending".into(),
        ));
    }
    let moved = cache_root.exists();
    if moved {
        std::fs::rename(cache_root, &clearing_root)
            .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
    }
    let deleted = match connection.execute("DELETE FROM cache_entries WHERE kind='inference'", []) {
        Ok(value) => value,
        Err(error) => {
            if moved {
                let _ = std::fs::rename(&clearing_root, cache_root);
            }
            return Err(InferenceError::InvalidInput(error.to_string()));
        }
    };
    if moved {
        std::fs::remove_dir_all(&clearing_root)
            .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
    }
    Ok(InferenceCacheClearResult {
        entries_cleared: deleted,
    })
}

#[tauri::command(async)]
pub fn inference_clear_cache(
    app: tauri::AppHandle,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<InferenceCacheClearResult> {
    let app_data_dir = match model_data_dir(&app) {
        Ok(value) => value,
        Err(error) => {
            return crate::domain::result::CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                error.to_string(),
                true,
            )
        }
    };
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => {
            return crate::domain::result::CommandResult::failure(
                "UNKNOWN",
                crate::cache::LOCK_FAILED,
                true,
            )
        }
    };
    match clear_inference_cache(&connection, &app_data_dir.join("cache").join("inference")) {
        Ok(value) => crate::domain::result::CommandResult::success(value),
        Err(InferenceError::CacheBusy) => crate::domain::result::CommandResult::failure(
            "INFERENCE_UNAVAILABLE",
            "Inference cache is in use",
            true,
        ),
        Err(_) => crate::domain::result::CommandResult::failure(
            "UNKNOWN",
            "Inference cache cleanup failed",
            true,
        ),
    }
}

/// Picks the most preferred backend that the model supports and the device has
/// not blacklisted. Falls back to CPU, which every build can run.
pub fn select_backend(supported: &[String], blacklist: &[String]) -> BackendId {
    let allowed = |backend: BackendId| {
        let name = backend.as_str();
        supported
            .iter()
            .any(|value| value.eq_ignore_ascii_case(name))
            && !blacklist
                .iter()
                .any(|value| value.eq_ignore_ascii_case(name))
    };
    platform_backend_preference()
        .into_iter()
        .find(|backend| allowed(*backend))
        .unwrap_or(BackendId::Cpu)
}

/// 最近邻缩放的输出，定义在 [`yomika_compute_core::cpu_scale`]。宿主现在不点
/// 这个名字（`cpu_scale_rgba` 的调用方直接读字段），保留是为了路径不变。
#[allow(unused_imports)]
pub use yomika_compute_core::cpu_scale::CpuRgbaOutput;

/// 派生版本（超分产物）的缓存 revision。
///
/// 模型换了就不能再服务旧产物：revision 是模型指纹，两条链（写的那一步与读的那
/// 一步）各自算出同一个串——前端只知道模型 id，指纹要在这里查。
fn upscaler_fingerprint(resolved: &Option<ResolvedUpscaler>) -> String {
    match resolved {
        Some(ResolvedUpscaler::Onnx(_path, manifest)) => {
            format!("onnx:{}:{}:{}", manifest.id, manifest.version, manifest.sha256)
        }
        Some(ResolvedUpscaler::Anime4k(preset)) => {
            format!("anime4k:{}:{}", preset.id, preset.version)
        }
        None => "nearest".to_string(),
    }
}

/// 这一档**实际内容**的版本，给远端处理计划的身份用（docs/175 R11）。
///
/// Hash the actual file even when its manifest declares a digest: an in-place
/// replacement must not keep the previous remote plan identity. The streaming
/// hash avoids allocating a second complete model in the host.
pub(crate) fn upscaler_content_revision(resolved: &Option<ResolvedUpscaler>) -> String {
    match resolved {
        Some(ResolvedUpscaler::Onnx(path, manifest)) => {
            match crate::compute::artifacts::hash_file(path) {
                Ok((_, hash)) => format!("onnx:{}:{}:blake3:{}", manifest.id, manifest.version, hash),
                Err(_) => format!("onnx:{}:{}:unreadable", manifest.id, manifest.version),
            }
        }
        other => upscaler_fingerprint(other),
    }
}

/// `enhanced` 的 revision：超分模型指纹。
///
/// 从 docs/71 §11 Task 5 第 6 条起，这个串不再只是「模型 + 起点」：它还要说出
/// **谁算的**（后端、运行库版本、精度）与**哪条流水线**算的，否则「同一份模型、
/// 同一份起点」在两个后端之间会被当成同一件事，或者流水线改了口径却继续吃旧产物。
/// 这些字段由 [`derived_cache_revision`] 统一拼（`cache_revision` 带长度前缀，
/// 免得 `("ab","c")` 与 `("a","bc")` 折成一个串）。
///
/// `pub(crate)`：`compute::reader` 铸任务身份时用的就是这一个函数——阅读器走 URL 那条路
/// 与旧命令那条路必须算出**同一个** `settings_id`，否则同一页、同一份设置会被当成两件
/// 任务各算一遍，缓存也永远命中不了。
pub(crate) fn enhanced_revision(resolved: &Option<ResolvedUpscaler>) -> String {
    derived_cache_revision(
        &upscaler_fingerprint(resolved),
        "reader-page",
        UPSCALE_PIPELINE_REVISION,
        declared_backend_label(),
    )
}

/// Final output dimensions are part of the artifact identity, not the engine's
/// native scale. Keep the existing default identity for older callers.
pub(crate) fn enhanced_revision_with_scale(resolved: &Option<ResolvedUpscaler>, output_scale: u32) -> String {
    if output_scale == ENHANCED_OUTPUT_SCALE { return enhanced_revision(resolved); }
    derived_cache_revision(&upscaler_fingerprint(resolved), "reader-page",
        &format!("{UPSCALE_PIPELINE_REVISION}:output:{output_scale}"), declared_backend_label())
}

/// 缓存修订里的「运行库」那一栏。
///
/// 它**不再问宿主自己链着什么**：`ort` 一升级，底下的内核与算子实现就换了，同一份模型
/// 可能给出不同的数（ORT 并不承诺跨版本的位级一致），旧产物因此必须作废——所以这一栏
/// 必须是真的算它的那条运行库的版本号，不能是手写常量。
///
/// 但宿主正在把 ONNX Runtime 摘出去（docs/71 §11 Task 8），摘完它这一侧
/// `runtime::runtime_label()` 只会答 `"no-runtime"`——那个答案一旦被写进缓存身份，
/// 就成了「一切照常、只是账上的号不再跟着运行库走」。所以答案只有一个来源：协议里的
/// `WORKER_RUNTIME_LABEL`，由 worker 在启动时用自己链着的运行库**证明**过
/// （`runtime::runtime_label_mismatch`，对不上就拒跑）。名字里的 `ort` 说的是这一栏的
/// **内容**（`ort-api27`），不是宿主链着谁。
fn ort_runtime_label() -> &'static str {
    yomika_compute_protocol::WORKER_RUNTIME_LABEL
}

/// 缓存修订里的「后端」那一栏：这份构建**声明**的首选执行提供者。
///
/// 为什么声明而不是实测：命中路径根本不会开模型（那正是缓存的意义），所以「这一次
/// 实际跑在谁身上」在命中时不可知；而真正会误命中的那种情况（模型换了）由
/// `model_spec_id` 里的 sha256 管住。这一栏管的是别的：同一台机器上后端策略变了
/// （驱动升级后 DML 没了、探针拒了这个模型）时，旧产物不会被当成新策略的产物接着用。
///
/// 8-g③-iv 之后连「问一句」都做不到了：宿主没有会话可开，`runtime::available_runtimes`
/// 不在产品依赖里。这一栏于是与 [`inference_probe`] 同一个来源（平台偏好），差别只在
/// 于它进的是缓存身份——两者必须同源，否则「探测说 directml、身份写 cpu」这种错位会
/// 让产物按一套策略算、按另一套策略命中。
fn declared_backend_label() -> &'static str {
    static LABEL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LABEL.get_or_init(|| {
        platform_backend_preference()
            .first()
            .copied()
            .unwrap_or(BackendId::Cpu)
            .as_str()
            .to_string()
    })
}

/// 流水线口径的版本。修订号里没有别的字段能表达「同一份模型、同一份起点，但中间
/// 多了一道处理」——阶段顺序、参数、后处理改了就把对应的这个 +1，旧产物当场作废。
const UPSCALE_PIPELINE_REVISION: &str = "upscale:6-processing-scale-display2";

/// 派生图（超分产物）的缓存修订号。
///
/// `backend` 是一格**参数**，不在这里读 [`declared_backend_label`]：这一栏必须随声明的
/// 后端变，而「它真的在变」只有从外面喂两个不同的值才断得出来（见
/// `a_derived_revision_names_its_source_and_its_engine`；产品调用点传的都是
/// [`declared_backend_label`]，也就是这台机器声明要用的那一条）。
fn derived_cache_revision(
    model_spec_id: &str,
    source_revision: &str,
    pipeline_revision: &str,
    backend: &str,
) -> String {
    crate::compute::artifacts::cache_revision(&crate::compute::artifacts::CacheRevisionParts {
        model_spec_id,
        source_revision,
        backend,
        runtime_id: ort_runtime_label(),
        // 两条链都只跑 fp32：ONNX 图里的权重是 fp32，没人替我们降到 fp16。
        precision: "fp32",
        pipeline_revision,
    })
}

/// 起点那一版的身份。
///
/// 传三个标量而不是整份命令输入：`compute::reader` 也要按同一把尺子算出「这一页的起点
/// 是哪一行」。两边共用一个函数，才不会一边按别的 rendition 去查、另一边按这一版去写。
pub(crate) fn source_identity(
    scope_id: &str,
    archive_id: &str,
    page_index: i64,
    source_rendition: &str,
) -> crate::cache::CacheImageIdentity {
    crate::cache::CacheImageIdentity::new(scope_id, archive_id, source_rendition, page_index)
}

/// 读某一步的输入时，那一版是按什么 revision 存的。
///
/// 链上每一步的输入都是说得出名字的一版，而一版是按**产出它的模型**存的：
/// `enhanced` 属于某个超分模型。调用方手上只有模型 id，指纹要在这里查；
/// 拿一个空的 revision 去读一份不知道是谁写的图是不可接受的。
#[derive(Debug)]
pub(crate) struct SourceRevisionError {
    pub code: &'static str,
    pub message: String,
}

pub(crate) fn source_revision(
    models_data: &std::path::Path,
    rendition: &str,
    upscale_model: Option<&str>,
    output_scale: Option<u32>,
) -> Result<Option<String>, SourceRevisionError> {
    match rendition {
        "reader-page" => Ok(None),
        "enhanced" => {
            let upscale = upscale_model
                .filter(|value| !value.is_empty())
                .and_then(|id| resolve_upscaler(models_data, id));
            Ok(Some(enhanced_revision_with_scale(&upscale, output_scale.unwrap_or(ENHANCED_OUTPUT_SCALE))))
        }
        other => Err(SourceRevisionError {
            code: "INVALID_RESPONSE",
            message: format!("Unsupported source rendition: {other}"),
        }),
    }
}

/// 从缓存里取一版派生结果；没有就是 `None`（不是错误——第一次跑本来就没有）。
///
/// 走 `read_cached_image`：一页图 1.5MB 起，超分产物更大，读文件与算 blake3 都在
/// DB 锁外做（全局锁是偏好、书架、搜索的必经之路，不能让它等一次整页读）。
pub(crate) fn cached_derived(
    database: &crate::db::Database,
    app_data: &std::path::Path,
    identity: &crate::cache::CacheImageIdentity,
) -> Option<Vec<u8>> {
    crate::cache::read_cached_image(database, app_data, identity)
        .ok()
        .flatten()
        .map(|image| image.bytes)
}

/// 派生结果没能落盘的原因。
///
/// 「这一页算出来了」与「这一页存下来了」是两件事：缓存写不进去不是这一页的错（GPU 与
/// 编码都已经成功，用户手上已经有图），但下次翻回这一页还得再算一遍，所以要能把它和
/// 「成功且已缓存」分开，让上层说得出发生了什么。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CacheWriteError {
    /// 统一错误日志里的稳定分类（见 `CACHE_WRITE_FAILED`）。界面按它归档，不用猜措辞。
    pub(crate) code: &'static str,
    /// 给人看的一句话（中文），含底层原因。
    pub(crate) message: String,
    /// 再试一次还有没有意义：数据库锁拿不到是「这一下拿不到」，磁盘满、权限不对不是
    /// 重试能解决的。
    pub(crate) retryable: bool,
}

/// 派生产物落盘失败的稳定分类：日志里那句警告以它开头，界面按它归档。
pub(crate) const CACHE_WRITE_FAILED: &str = "CACHE_WRITE_FAILED";

/// 统一错误日志里 `source` 那一栏：哪一条命令的产物没落盘。
pub(crate) const UPSCALE_CACHE_SOURCE: &str = "inference.upscale.cache";

/// 把派生结果写回缓存。
///
/// `mime` 必须说真话：`cache::sniff_image_mime` 见到 `image/*` 就原样收下，不核对
/// magic bytes，所以这里报错了容器类型，取回来的一页就会带着错的 content-type 发给
/// 前端。
pub(crate) fn store_derived(
    database: &crate::db::Database,
    app_data: &std::path::Path,
    identity: &crate::cache::CacheImageIdentity,
    mime: &str,
    bytes: &[u8],
) -> Result<(), CacheWriteError> {
    // 走 `write_cached_image`：落盘（建目录 + 写临时文件 + rename）在 DB 锁外，
    // 锁只覆盖挂行与配额检查。
    crate::cache::write_cached_image(database, app_data, identity, mime, bytes).map_err(|error| {
        let retryable = error == crate::cache::LOCK_FAILED;
        CacheWriteError {
            code: CACHE_WRITE_FAILED,
            message: if retryable {
                "数据库正被占用，这一页的产物没能落盘".to_string()
            } else {
                format!("这一页的产物没能落盘：{error}")
            },
            retryable,
        }
    })
}

/// 落盘失败记一笔结构化警告。
///
/// **不记图片内容、不记凭据**：`detail` 里只有缓存键（scope / archive / page /
/// rendition / revision），够下次翻回同一页时对照。写进统一错误日志
/// `<data>/logs/error.log`，界面那个「错误日志」面板读的就是这一份文件。
pub(crate) fn note_cache_write_failure(
    app_data: &std::path::Path,
    source: &str,
    identity: &crate::cache::CacheImageIdentity,
    error: &CacheWriteError,
) {
    let detail = format!(
        "scope={} archive={} page={} rendition={} revision={}",
        identity.scope_id,
        identity.archive_id,
        identity.page_index,
        identity.rendition,
        identity.revision.as_deref().unwrap_or("-"),
    );
    if let Err(log_error) = crate::error_log::record_at_data_dir(
        app_data,
        "warn",
        source,
        &format!("{}：{}", error.code, error.message),
        Some(&detail),
    ) {
        eprintln!(
            "yomika: derived cache write failed: {} (log: {log_error})",
            error.message
        );
    }
}

/// 派生结果的统一收尾：交给缓存，然后**无论成没成**都把这一页交出去。
///
/// 超分 / DLSSNR 几条命令的结尾都是这一句。成功体是**裸字节**
/// （`domain::result::into_binary_response` 直接把 PNG 当 IPC 体发出去，没有可以挂字段
/// 的信封），所以「这一次没缓存上」的结构化出口就是统一错误日志里那条
/// `CACHE_WRITE_FAILED`：带完整缓存键，用户能在界面里看到，下次翻回同一页也能对账。
///
/// 为什么不直接返回可重试错误：用户正看着的这张图**已经算出来了**，磁盘满不该把它从
/// 眼前拿走——缓存是可再生的（重启后再算一遍），这一页不是。
pub(crate) fn finish_derived(
    database: &crate::db::Database,
    app_data: &std::path::Path,
    source: &str,
    identity: &crate::cache::CacheImageIdentity,
    mime: &str,
    encoded: Vec<u8>,
) -> Vec<u8> {
    if let Err(error) = store_derived(database, app_data, identity, mime, &encoded) {
        note_cache_write_failure(app_data, source, identity, &error);
    }
    encoded
}


/// 重活的优先级。前台＝用户正在看的那一页（超分/DLSSNR 都算重活），后台＝
/// 阅读器为了「翻到就能看」而提前预扫的那一批。
///
/// 计算编排那一侧另有一个 `compute::scheduler::Priority`，两处说的是**同一个
/// 判断**（用户正看着的那一页就是前台），却故意不合并成一个类型：宿主的重活闸与
/// worker 的任务队是两层不同的东西——前者管「本机只准一件」，后者管「那一件在
/// worker 里的先后」。原先那座把两者对译过来的桥（`HeavyPriority::compute_priority`）
/// 随着「宿主自己开模型算这一页」的那两条命令一起没了（第 24 轮，8-g③-ii）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HeavyPriority {
    Foreground,
    Background,
}

impl HeavyPriority {
    /// 只有前端明说 `"foreground"` 才是前台。**默认是后台**：将来哪个调用点忘了
    /// 带这一栏，它排在整本预扫后面，而不是把正在跑的那件活掐掉。
    pub(crate) fn parse(value: Option<&str>) -> Self {
        match value {
            Some("foreground") => Self::Foreground,
            _ => Self::Background,
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::Foreground => 1,
            Self::Background => 0,
        }
    }
}

/// 两条碰**全局**重活队列的测试要互相排队：它是进程级的，并行跑会看到对方的许可。
///
/// 放在模块作用域（而不是某一个测试模块里），是因为**别的模块**的测试也会走这条队列。
/// **这条锁还要留着**：本模块自己的五条重活队列测试之间就要串起来。
#[cfg(test)]
pub(crate) fn heavy_queue_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 现在拿着许可的那一件。
struct HeavyRunning {
    priority: HeavyPriority,
    task_id: Option<String>,
}

/// 在等许可的队伍里的一个。`sender` 是叫醒它的那一头；`sequence` 只用来在同一
/// 档里排先来后到。
struct HeavyWaiter {
    priority: HeavyPriority,
    sequence: u64,
    task_id: Option<String>,
    sender: tokio::sync::oneshot::Sender<()>,
}

/// 排队与抢占的**纯决策**部分：不放 tokio、不发信号，为的是能用同步单测把
/// 「谁先跑」「该掐谁」这两件事钉住。
struct HeavyQueueState {
    running: Option<HeavyRunning>,
    waiters: Vec<HeavyWaiter>,
    sequence: u64,
}

impl HeavyQueueState {
    /// 轮到自己了没有。有更高级别的人排着就不算——新来的后台不许插到已经排队的
    /// 前台前面。
    fn can_start(&self, priority: HeavyPriority) -> bool {
        self.running.is_none()
            && !self
                .waiters
                .iter()
                .any(|waiter| waiter.priority.rank() > priority.rank())
    }

    fn start(&mut self, priority: HeavyPriority, task_id: Option<String>) {
        self.running = Some(HeavyRunning { priority, task_id });
    }

    /// 排队，回**要掐的任务号**（如果有）：只有「自己前台、正在跑的是后台、而且
    /// 它报了号」才给。前台不抢前台——同一页可能有两步，后一步要等前一步
    /// 的产物，掐掉就是自己把自己饿死。
    fn enqueue(
        &mut self,
        priority: HeavyPriority,
        task_id: Option<String>,
        sender: tokio::sync::oneshot::Sender<()>,
    ) -> Option<String> {
        self.sequence += 1;
        let preempt = match (&self.running, priority) {
            (Some(running), HeavyPriority::Foreground)
                if running.priority == HeavyPriority::Background =>
            {
                running.task_id.clone()
            }
            _ => None,
        };
        self.waiters.push(HeavyWaiter {
            priority,
            sequence: self.sequence,
            task_id,
            sender,
        });
        preempt
    }

    /// 下一个该跑的：前台优先，同档先来先到。
    fn next(&mut self) -> Option<HeavyWaiter> {
        let index = self
            .waiters
            .iter()
            .enumerate()
            .max_by_key(|(_, waiter)| (waiter.priority.rank(), std::cmp::Reverse(waiter.sequence)))
            .map(|(index, _)| index)?;
        Some(self.waiters.swap_remove(index))
    }
}

/// 一件重活一次，是为了跨阅读器重挂载收住内存。但**谁先来**不该是 FIFO：整本预扫
/// 排在前台当前页前面，用户就得盯着正在看的那一页等预扫。所以这里自带一个两档优先
/// 级队列——前台插到后台前面，并且把正在跑的后台那件掐掉（只置旗，它会在自己的检
/// 查点退出来）。
///
/// 有两份实例：`HEAVY_QUEUE`（本机 GPU / 模型的重活）与 `REMOTE_QUEUE`（发给远端
/// 那一步的重活）。分开的理由见 `run_remote`。
struct HeavyQueue {
    state: std::sync::Mutex<HeavyQueueState>,
}

impl HeavyQueue {
    const fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(HeavyQueueState {
                running: None,
                waiters: Vec::new(),
                sequence: 0,
            }),
        }
    }

    async fn acquire(
        self: &'static Self,
        priority: HeavyPriority,
        task_id: Option<String>,
    ) -> HeavyPermit {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let preempt = {
            let mut state = self.lock();
            if state.can_start(priority) {
                state.start(priority, task_id);
                return HeavyPermit { queue: self };
            }
            state.enqueue(priority, task_id, sender)
        };
        if let Some(target) = preempt {
            cancel::cancel(&target);
        }
        // 叫醒的那一头没了（这个命令 future 已经被丢掉）不算错：许可会经 release
        // 的循环交给下一位，这里当作拿到再立刻还回去。
        let _ = receiver.await;
        HeavyPermit { queue: self }
    }

    /// 还许可：交给下一位，没有等待者才算空。
    ///
    /// 循环是必须的：`send` 失败说明那一位的 future 已经没了（用户翻页 / 关了开
    /// 关），许可不能就这么丢在地板上，否则整条链子从此卡死。
    fn release(&self) {
        loop {
            let mut state = self.lock();
            let Some(waiter) = state.next() else {
                state.running = None;
                return;
            };
            let HeavyWaiter {
                priority,
                task_id,
                sender,
                ..
            } = waiter;
            if sender.send(()).is_ok() {
                state.start(priority, task_id);
                return;
            }
            // 这一位已经不在了：继续找下一位。running 仍然算占着——不能让新来的
            // 在 next() 走到之前抢跑进来。
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HeavyQueueState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

static HEAVY_QUEUE: HeavyQueue = HeavyQueue::new();

/// 发给远端那一步的重活自己的闸。远端请求在等的过程中**不占**本机 GPU 那一件，
/// 理由见 `run_remote`。
static REMOTE_QUEUE: HeavyQueue = HeavyQueue::new();

/// 拿着一张代表「现在只有这一件重活在跑」的牌。丢掉就还回去。
///
/// 牌上记着是哪一条队列给的：本机那一件与远端那一件是两条独立的链子。
pub(crate) struct HeavyPermit {
    queue: &'static HeavyQueue,
}

impl Drop for HeavyPermit {
    fn drop(&mut self) {
        self.queue.release();
    }
}

/// 全局只允许一件重活：阅读器的超分、DLSSNR、远端处理收到的请求都走这里。
/// 不这么收，两张图同时进来就会各开一份模型，内存直接翻倍。
///
/// **本机**那一件。发给远端的请求走 `run_remote`（另一条队列）。
pub(crate) async fn run_heavy<T: Send + 'static>(
    priority: HeavyPriority,
    task_id: Option<String>,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    run_on(&HEAVY_QUEUE, priority, task_id, work).await
}

/// 远端任务的闸：**不占本机那一件重活**。
///
/// 远端那一步的等待时间由局域网决定（最长 180 秒），而它占的资源在**对面**那台机器上。
/// 以前它占的就是本机 GPU 的独占闸，于是一份卡住或慢的远端请求会让用户当前页的 DLSSNR /
/// 超分一直排队——而这两件事根本不抢同一份资源（审计 P2-2）。所以给它自己的一条队列，
/// 两档优先级在这里同样有用：前台那一页的远端请求插到整本预扫的前面。
///
/// 本机这一侧仍然一次一件（`HEAVY_QUEUE`），所以「两张图同时进来把内存顶爆」那条保护
/// 没有松开。
///
/// **闸门横跨的是一段异步工作**（docs/175 R04）：远端那一件要能在途取消，读盘之后的
/// HTTP 等待必须跑在异步线程上（阻塞式 HTTP 的 future 不归任何执行器管，丢不掉）。所以
/// 这里只负责「拿闸门 + 等这件活」，工作由调用方以 future 的形式交进来；取消了 = 那个
/// future 被丢掉 = 闸门当场还回来。`scheduling::WorkerPriority::enter()` 因此不再适用于
/// 这条来路（它的线程优先级是给本机那件重活用的）。
pub(crate) async fn run_remote<T, F>(
    priority: HeavyPriority,
    task_id: Option<String>,
    work: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = T>,
{
    let permit = REMOTE_QUEUE.acquire(priority, task_id).await;
    let output = work.await;
    drop(permit);
    Ok(output)
}

async fn run_on<T: Send + 'static>(
    queue: &'static HeavyQueue,
    priority: HeavyPriority,
    task_id: Option<String>,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let permit = queue.acquire(priority, task_id).await;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let _priority = scheduling::WorkerPriority::enter();
        work()
    })
    .await
    .map_err(|e| e.to_string())
}

/// 算力中心的能力清单用：本机上「模型包齐全、能直接跑」的模型。
///
/// 只列齐全的——半份模型跑一半会留半张处理过的图，比直接说「没有」更糟。
pub(crate) fn runnable_models(models_data: &std::path::Path) -> Vec<RunnableModel> {
    let mut runnable = Vec::new();
    for model in installed_models_in(models_data) {
        match resolve_upscaler(models_data, &model.id) {
            Some(ResolvedUpscaler::Onnx(_, manifest)) => runnable.push(RunnableModel {
                id: model.id.clone(),
                kind: "upscale".to_string(),
                label: format!("超分：{}（{}x）", model.id, manifest.scale),
                scale: Some(manifest.scale),
            }),
            Some(ResolvedUpscaler::Anime4k(preset)) => runnable.push(RunnableModel {
                id: model.id.clone(),
                kind: "upscale".to_string(),
                label: format!("超分：{}（{}x）", model.id, preset.scale),
                scale: Some(preset.scale),
            }),
            None => {}
        }
    }
    runnable
}

/// 一台机器上「能直接用的模型」：算力中心把它报给移动端。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnableModel {
    pub id: String,
    /// `upscale`。
    pub kind: String,
    pub label: String,
    pub scale: Option<u32>,
}

/// 宿主自己算的那一档：一段图片字节跑一遍超分，回 PNG 字节（不碰本地缓存页面）。
///
/// **只有两档走这里**：宿主内置的 shader 链（Anime4K）与「没有模型」的最近邻。
/// ONNX 那一档不在其中——它由算力中心分流给计算进程（worker），因为 Task 8 的出口是
/// 「宿主进程里没有 ONNX Runtime」。真走到这里说明分流断了：明说，别拿别的引擎顶替。
pub(crate) fn run_host_upscale_bytes(
    models_data: &std::path::Path,
    model_id: &str,
    source: &[u8],
    requested_scale: Option<u32>,
) -> Result<Vec<u8>, String> {
    let resolved = (!model_id.is_empty())
        .then(|| resolve_upscaler(models_data, model_id))
        .flatten();
    let preset = match &resolved {
        Some(ResolvedUpscaler::Anime4k(preset)) => Some(preset),
        Some(ResolvedUpscaler::Onnx(_, _)) => {
            return Err(format!("{model_id} 这一档要交给计算进程算，宿主这里没有它"));
        }
        // 点了名却找不到，说明调用方以为在跑模型——这时候悄悄换成最近邻会让人以为
        // 「模型效果就这样」。与阅读器那条路一样：报错。
        None if !model_id.is_empty() => return Err(format!("没有装这个超分模型：{model_id}")),
        None => None,
    };
    let scale = match preset {
        Some(preset) => preset.scale,
        None => requested_scale.unwrap_or(2).clamp(1, 4),
    };
    let max_pixels = match preset {
        Some(_) => anime4k::ANIME4K_MAX_PIXELS,
        None => 64_000_000,
    };
    let decoded = image::load_from_memory(source)
        .map_err(|error| error.to_string())?
        .to_rgba8();
    let (width, height) = (decoded.width(), decoded.height());
    let chosen: Option<Box<dyn upscale::UpscaleEngine>> = match preset {
        Some(preset) => Some(Box::new(
            anime4k::Anime4kEngine::open(preset).map_err(|error| format!("{error:?}"))?,
        )),
        None => None,
    };
    let fallback = upscale::NearestNeighbourEngine { scale, max_pixels };
    let engine: &dyn upscale::UpscaleEngine = match &chosen {
        Some(engine) => engine.as_ref(),
        None => &fallback,
    };
    let options = upscale::UpscaleOptions {
        max_pixels,
        ..upscale::UpscaleOptions::default()
    };
    let upscaled = upscale::upscale_rgba(engine, decoded.as_raw(), width, height, options)
        .map_err(|error| format!("{error:?}"))?;
    let (final_rgba, final_width, final_height) =
        fit_enhanced_output(upscaled.rgba, upscaled.width, upscaled.height, width, height);
    let mut encoded = Vec::new();
    use image::ImageEncoder;
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(&final_rgba, final_width, final_height, image::ExtendedColorType::Rgba8)
        .map_err(|error| error.to_string())?;
    Ok(encoded)
}

// 这一档只剩超分：ONNX 那条路整条搬进了计算进程（worker），宿主只剩「用哪个包」这一步
// （`resolve_installed_model` / `resolve_upscaler`）。搬运的理由很硬——超分要开的是宿主
// 进程里最后一台 ONNX 会话，它留在这儿，宿主就永远摘不掉 ORT。

/// 取消一个阅读器推理任务（切页、关开关、离开阅读器）。
///
/// 前端的 `AbortSignal` 只丢结果：原生那一侧照旧跑完，而全局只允许一件重活，于是
/// 用户要看的那一页排在旧任务后面。这个命令让取消真的传到循环里（见
/// `inference::cancel` 与各 pipeline 的检查点）。
#[tauri::command]
pub fn inference_cancel_page(task_id: String) -> crate::domain::result::CommandResult<bool> {
    crate::domain::result::CommandResult::success(cancel::cancel(&task_id))
}

/// CPU 最近邻缩放是**内部**兜底：`upscale.rs` / `onnx.rs` / `anime4k.rs` 在模型不可用时
/// 都直接调 `cpu_scale_rgba`，产物由 `inference_upscale_page` 以二进制体交出去。
/// 这里曾经另有一条把整页 RGBA 摊成 JSON 数字数组来回的 `inference_cpu_scale` 命令
/// （一百多万个数字进出，前端一个调用方都没有），已随 `cache_store_image` 一起删除：
/// 能力留在 Rust 内部，不再留一个只能以错误方式使用的入口。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceStartInput {
    pub id: String,
    pub source_scope: String,
    pub source_id: String,
    pub model_id: String,
    pub model_version: String,
    pub input_hashes: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceJob {
    pub id: String,
    pub status: String,
    pub item_count: usize,
    pub completed_count: usize,
}

fn load_job(connection: &rusqlite::Connection, id: &str) -> Result<InferenceJob, String> {
    connection.query_row("SELECT j.id,j.status,COUNT(i.item_index),COALESCE(SUM(CASE WHEN i.status='completed' THEN 1 ELSE 0 END),0) FROM inference_jobs j LEFT JOIN inference_items i ON i.job_id=j.id WHERE j.id=?1 GROUP BY j.id,j.status", rusqlite::params![id], |row| Ok(InferenceJob { id: row.get(0)?, status: row.get(1)?, item_count: row.get::<_, i64>(2)? as usize, completed_count: row.get::<_, i64>(3)? as usize })).map_err(|e| e.to_string())
}

fn start_job(
    connection: &mut rusqlite::Connection,
    input: InferenceStartInput,
) -> Result<InferenceJob, String> {
    if input.id.trim().is_empty()
        || input.source_scope.trim().is_empty()
        || input.input_hashes.is_empty()
        || input.input_hashes.iter().any(|hash| hash.trim().is_empty())
    {
        return Err("Invalid inference job".to_string());
    }
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction.execute("INSERT INTO inference_jobs (id,source_scope,source_id,model_id,model_version,status) VALUES (?1,?2,?3,?4,?5,'queued') ON CONFLICT(id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP", rusqlite::params![input.id,input.source_scope,input.source_id,input.model_id,input.model_version]).map_err(|e| e.to_string())?;
    for (index, hash) in input.input_hashes.iter().enumerate() {
        transaction.execute("INSERT OR IGNORE INTO inference_items (job_id,item_index,input_hash,status) VALUES (?1,?2,?3,'pending')", rusqlite::params![input.id,index as i64,hash]).map_err(|e| e.to_string())?;
    }
    let job = load_job(&transaction, &input.id)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(job)
}

fn checkpoint_item(
    connection: &rusqlite::Connection,
    job_id: &str,
    item_index: i64,
    completed_tile: i64,
    status: &str,
    output_path: Option<&str>,
) -> Result<(), String> {
    if completed_tile < 0
        || !matches!(
            status,
            "pending" | "running" | "completed" | "failed" | "cancelled"
        )
    {
        return Err("Invalid inference checkpoint".to_string());
    }
    if status == "completed" && output_path.is_none() {
        return Err("Completed inference item requires output".to_string());
    }
    let changed = connection.execute("UPDATE inference_items SET completed_tile=MAX(completed_tile,?1),status=?2,output_path=COALESCE(?3,output_path),updated_at=CURRENT_TIMESTAMP WHERE job_id=?4 AND item_index=?5 AND status!='completed'", rusqlite::params![completed_tile,status,output_path,job_id,item_index]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Inference item not found or already completed".to_string());
    }
    if status == "completed" {
        connection.execute("UPDATE inference_jobs SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM inference_items WHERE job_id=?1 AND status!='completed') THEN 'completed' ELSE 'running' END,updated_at=CURRENT_TIMESTAMP WHERE id=?1", rusqlite::params![job_id]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

fn transition_job(
    connection: &rusqlite::Connection,
    job_id: &str,
    target: &str,
) -> Result<InferenceJob, String> {
    if !matches!(target, "paused" | "running" | "completed") {
        return Err("Invalid inference job transition".to_string());
    }
    let current: String = connection
        .query_row(
            "SELECT status FROM inference_jobs WHERE id=?1",
            rusqlite::params![job_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let allowed = match (current.as_str(), target) {
        ("queued", "running")
        | ("queued", "paused")
        | ("running", "paused")
        | ("paused", "running") => true,
        ("running", "completed") => {
            let pending: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM inference_items WHERE job_id=?1 AND status!='completed'",
                    rusqlite::params![job_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            pending == 0
        }
        _ => false,
    };
    if !allowed {
        return Err("Inference job transition not allowed".to_string());
    }
    connection
        .execute(
            "UPDATE inference_jobs SET status=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2",
            rusqlite::params![target, job_id],
        )
        .map_err(|e| e.to_string())?;
    if target == "running" {
        connection.execute("UPDATE inference_items SET status='pending',updated_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND status='running'", rusqlite::params![job_id]).map_err(|e| e.to_string())?;
    }
    load_job(connection, job_id)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceCheckpointInput {
    pub job_id: String,
    pub item_index: i64,
    pub completed_tile: i64,
    pub status: String,
    pub output_path: Option<String>,
}

#[tauri::command(async)]
pub fn inference_checkpoint(
    input: InferenceCheckpointInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => {
            return crate::domain::result::CommandResult::failure(
                "UNKNOWN",
                crate::cache::LOCK_FAILED,
                true,
            )
        }
    };
    match checkpoint_item(
        &connection,
        &input.job_id,
        input.item_index,
        input.completed_tile,
        &input.status,
        input.output_path.as_deref(),
    ) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => {
            crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false)
        }
    }
}

fn transition_command(
    job_id: String,
    target: &str,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<InferenceJob> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => {
            return crate::domain::result::CommandResult::failure(
                "UNKNOWN",
                crate::cache::LOCK_FAILED,
                true,
            )
        }
    };
    match transition_job(&connection, &job_id, target) {
        Ok(value) => crate::domain::result::CommandResult::success(value),
        Err(error) => {
            crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false)
        }
    }
}

#[tauri::command(async)]
pub fn inference_pause(
    id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<InferenceJob> {
    transition_command(id, "paused", database)
}

#[tauri::command(async)]
pub fn inference_resume(
    id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<InferenceJob> {
    transition_command(id, "running", database)
}

#[tauri::command(async)]
pub fn inference_start(
    input: InferenceStartInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<InferenceJob> {
    let mut connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => {
            return crate::domain::result::CommandResult::failure(
                "UNKNOWN",
                crate::cache::LOCK_FAILED,
                true,
            )
        }
    };
    match start_job(&mut connection, input) {
        Ok(value) => crate::domain::result::CommandResult::success(value),
        Err(error) => {
            crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false)
        }
    }
}

#[tauri::command(async)]
pub fn inference_get_job(
    id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<InferenceJob> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => {
            return crate::domain::result::CommandResult::failure(
                "UNKNOWN",
                crate::cache::LOCK_FAILED,
                true,
            )
        }
    };
    match load_job(&connection, &id) {
        Ok(value) => crate::domain::result::CommandResult::success(value),
        Err(error) => crate::domain::result::CommandResult::failure("LRR_NOT_FOUND", error, false),
    }
}

#[tauri::command(async)]
pub fn inference_cancel(
    id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<InferenceJob> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => {
            return crate::domain::result::CommandResult::failure(
                "UNKNOWN",
                crate::cache::LOCK_FAILED,
                true,
            )
        }
    };
    let result = (|| {
        connection.execute("UPDATE inference_jobs SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status NOT IN ('completed','cancelled')",rusqlite::params![id]).map_err(|e|e.to_string())?;
        connection.execute("UPDATE inference_items SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND status NOT IN ('completed','cancelled')",rusqlite::params![id]).map_err(|e|e.to_string())?;
        load_job(&connection, &id)
    })();
    match result {
        Ok(value) => crate::domain::result::CommandResult::success(value),
        Err(error) => crate::domain::result::CommandResult::failure("UNKNOWN", error, true),
    }
}

/// 最近邻放大，实现在 [`yomika_compute_core::cpu_scale`]；模型缺失时的兜底，
/// 也是分块管道测试里的参照实现。
// 只有测试用得上（`onnx.rs`、`anime4k.rs` 那几条拿真图量的曲线）：产品路径上「模型给
// 不出结果时退到最近邻」这一步已经不在宿主了。
#[cfg(test)]
pub use yomika_compute_core::cpu_scale::cpu_scale_rgba;

#[cfg(test)]
mod tests {
    #[test]
    fn downloaded_model_removal_preserves_bundles_and_other_models() {
        let data = tempfile::tempdir().unwrap();
        for id in ["waifu2x-upconv7", "realcugan-2x-conservative", "realcugan-2x-denoise3x", "keep"] {
            std::fs::create_dir_all(data.path().join("models").join(id).join("1")).unwrap();
            std::fs::create_dir_all(data.path().join("models").join(id).join("2")).unwrap();
        }
        std::fs::write(data.path().join("model-index.json"), b"stale").unwrap();
        let ids = vec!["realcugan-2x-conservative".into(), "realcugan-2x-denoise3x".into()];
        remove_downloaded_models(data.path(), &ids).unwrap();
        for id in ids { assert!(!data.path().join("models").join(id).exists()); }
        assert!(data.path().join("models/waifu2x-upconv7/1").exists());
        assert!(data.path().join("models/keep/2").exists());
        assert!(!data.path().join("model-index.json").exists());
        remove_downloaded_models(data.path(), &["missing".into()]).unwrap();
    }

    #[test]
    fn downloaded_model_removal_rejects_invalid_requests_before_deleting() {
        let data = tempfile::tempdir().unwrap();
        let keep = data.path().join("models/downloaded/1");
        std::fs::create_dir_all(&keep).unwrap();
        for invalid in ["../outside", ".", "..", "", ".hidden", "waifu2x-upconv7", "anime4k-hq", "anime4k-ultra"] {
            assert!(remove_downloaded_models(data.path(), &["downloaded".into(), invalid.into()]).is_err());
            assert!(keep.exists());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reader_inference_does_not_block_the_async_executor() {
        // 这条会真的走一遍全局 `HEAVY_QUEUE`（`run_heavy`）：与那几条直接摆弄队列的
        // 测试互相排队，不然并行跑时它们会看到对方的许可。
        let _serial = heavy_queue_test_lock();
        let caller = std::thread::current().id();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = tokio::spawn(run_heavy(
            HeavyPriority::Background,
            None,
            move || {
                started_tx.send(std::thread::current().id()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(3))
                    .unwrap();
                42
            },
        ));
        let worker_thread = started_rx.await.unwrap();
        assert_ne!(caller, worker_thread);
        // On a single-thread executor this can run only if inference yielded.
        let heartbeat = tokio::spawn(async { 7 });
        assert_eq!(heartbeat.await.unwrap(), 7);
        release_tx.send(()).unwrap();
        assert_eq!(worker.await.unwrap().unwrap(), 42);
    }
    #[test]
    fn model_index_reuses_cache_and_invalidates_nested_changes() {
        let base = std::env::temp_dir().join(format!(
            "yomika-index-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = base.join("models").join("realesr-general").join("2026.09.2");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(MODEL_MANIFEST_FILE),
            serde_json::to_vec(&model_manifest(b"x")).unwrap(),
        )
        .unwrap();
        std::fs::write(root.join("realesr-general-x4v3.onnx"), b"model").unwrap();

        let first = installed_models_in(&base);
        assert_eq!(first[0].kind, MODEL_KIND_UPSCALE);
        assert_eq!(first[0].id, "realesr-general");
        assert_eq!(first[0].scale, Some(2));
        let index = base.join("model-index.json");
        let timestamp = std::fs::metadata(&index).unwrap().modified().unwrap();
        assert_eq!(first, installed_models_in(&base));
        assert_eq!(
            timestamp,
            std::fs::metadata(&index).unwrap().modified().unwrap()
        );
        let before = model_fingerprint(&base.join("models")).unwrap();
        std::fs::write(root.join("realesr-general-x4v3.onnx"), b"changed-model").unwrap();
        assert_ne!(before, model_fingerprint(&base.join("models")).unwrap());
        std::fs::remove_file(root.join(MODEL_MANIFEST_FILE)).unwrap();
        assert_eq!(installed_models_in(&base)[0].scale, None);
        std::fs::write(index, b"broken cache").unwrap();
        assert!(!installed_models_in(&base).is_empty());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn model_index_rejects_cached_kinds_from_removed_features() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("models/current/1");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("current.onnx"), b"model").unwrap();
        let bundle = base.path().join("models/retired/1/nested");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("weights.onnx"), b"old graph").unwrap();
        let mut models = installed_models_in(base.path());
        models[0].kind = "retired-feature".into();
        let fingerprint = model_fingerprint(&base.path().join("models")).unwrap();
        std::fs::write(
            base.path().join("model-index.json"),
            serde_json::to_vec(&(fingerprint, models)).unwrap(),
        ).unwrap();
        let refreshed = listed_upscale_models_in(base.path());
        assert!(refreshed.iter().all(|model| model.kind == MODEL_KIND_UPSCALE));
        assert!(refreshed.iter().any(|model| model.id == "current"));
        assert!(!refreshed.iter().any(|model| model.id == "retired"));
    }

    #[test]
    fn an_enhanced_page_is_served_at_twice_the_source() {
        // The installed models are x4, which is sixteen times the pixels of the
        // page: a 1400x2000 scan would be encoded, cached and decoded at
        // 5600x8000 to be drawn into a slot a fraction of that. Two keeps the
        // detail and drops three quarters of the bytes.
        let source = (10_u32, 8_u32);
        let quadrupled = vec![0_u8; (source.0 * 4) as usize * (source.1 * 4) as usize * 4];
        let (rgba, width, height) =
            fit_enhanced_output(quadrupled, source.0 * 4, source.1 * 4, source.0, source.1);
        assert_eq!((width, height), (source.0 * 2, source.1 * 2));
        assert_eq!(rgba.len(), (width * height * 4) as usize);

        // Already at or below the target: handed back untouched rather than
        // resampled for nothing — the same allocation, not a copy of it.
        let doubled = vec![7_u8; (source.0 * 2) as usize * (source.1 * 2) as usize * 4];
        let allocation = doubled.as_ptr();
        let (same, w, h) =
            fit_enhanced_output(doubled, source.0 * 2, source.1 * 2, source.0, source.1);
        assert_eq!((w, h), (source.0 * 2, source.1 * 2));
        assert_eq!(same.as_ptr(), allocation);
        assert!(same.iter().all(|byte| *byte == 7));
    }

    #[test]
    fn fitting_an_enhanced_page_matches_the_buffer_copying_it_replaced() {
        // 4x4 的页，模型交回 16x16：目标是 8x8，走的正是重采样那条路。参考值按改动前
        // 的写法算（先 `to_vec()` 拷一份再 `from_raw`），改成移动整个缓冲区之后两边
        // 必须逐字节一致——省掉的那一份拷贝不该动到任何一个像素。
        let source = (4_u32, 4_u32);
        let (width, height) = (source.0 * 4, source.1 * 4);
        let buffer: Vec<u8> = (0..(width * height * 4) as usize).map(|index| (index % 251) as u8).collect();
        let reference = {
            let image = image::RgbaImage::from_raw(width, height, buffer.clone()).unwrap();
            image::imageops::resize(
                &image,
                source.0 * 2,
                source.1 * 2,
                image::imageops::FilterType::Lanczos3,
            )
            .into_raw()
        };

        let (fitted, fitted_width, fitted_height) =
            fit_enhanced_output(buffer, width, height, source.0, source.1);

        assert_eq!((fitted_width, fitted_height), (source.0 * 2, source.1 * 2));
        assert_eq!(fitted, reference);
    }

    #[test]
    fn a_buffer_that_does_not_fit_its_dimensions_is_handed_back_untouched() {
        // 尺寸与缓冲区对不上时旧写法也是原样退回（`from_raw` 给 None），不能因为改成
        // 移动就变成 panic 或者半张图。
        let short = vec![3_u8; 10];
        let (same, width, height) = fit_enhanced_output(short, 16, 16, 4, 4);
        assert_eq!((width, height), (16, 16));
        assert_eq!(same, vec![3_u8; 10]);
    }
    use super::*;

    #[test]
    fn backend_selection_prefers_the_platform_accelerator_then_falls_back() {
        let all = ["directml", "coreml", "nnapi", "cpu"].map(str::to_string);
        let expected = platform_backend_preference()[0];
        assert_eq!(select_backend(&all, &[]), expected);

        // A device blacklist pushes the choice down the preference order.
        assert_eq!(select_backend(&all, &[expected.as_str().to_string()]), {
            let mut rest = platform_backend_preference();
            rest.retain(|backend| *backend != expected);
            rest[0]
        });

        // A model that only ships CPU kernels never gets an accelerator.
        assert_eq!(select_backend(&["cpu".to_string()], &[]), BackendId::Cpu);
        // Nothing supported at all still yields a runnable backend.
        assert_eq!(select_backend(&[], &["cpu".to_string()]), BackendId::Cpu);
    }

    #[test]
    fn probe_reports_the_platform_backends_it_would_use() {
        let capabilities = match inference_probe() {
            crate::domain::result::CommandResult::Success { value, .. } => value,
            _ => panic!("probe must succeed"),
        };
        assert!(capabilities.backends.contains(&"cpu".to_string()));
        // 报的就是平台偏好那一份：8-g③-iv 之后宿主没有会话可开，能实测的只剩 worker
        // 交回的 `EngineReport`。这条同时挡住「探针说一套、缓存身份写另一套」。
        assert_eq!(
            capabilities.hardware_acceleration,
            platform_backend_preference()
                .iter()
                .any(|backend| backend.is_hardware_accelerated()),
        );
        assert_eq!(
            capabilities.backends.first().map(String::as_str),
            Some(declared_backend_label()),
        );
        if capabilities.hardware_acceleration {
            assert_eq!(
                capabilities.backends.first().map(String::as_str),
                Some("directml")
            );
        }
    }

    #[test]
    fn a_derived_revision_names_its_source_and_its_engine() {
        // 这一条钉的是两个调用点的**接缝**：写入路径与命中路径各自算一次身份，必须算出
        // 同一个串，否则链条永远读不中自己刚写下的那一版（不是错误，只是白算，所以它
        // 只会以「怎么每次都重跑」的样子出现——正是这种静默的失配最该有测试看着）。
        let reader_page = enhanced_revision(&None);
        assert!(reader_page.starts_with("rev:v1:"), "形状：{reader_page}");
        assert_eq!(reader_page, enhanced_revision(&None));
        assert_ne!(
            reader_page,
            derived_cache_revision(&upscaler_fingerprint(&None), "reader-page", "upscale:1", declared_backend_label()),
            "preprocessing changes must invalidate previously cached output"
        );

        // 起点那一步的身份：原图没有 revision；只有超分一条链了。
        let models_data = std::path::Path::new("no-such-models-root");
        assert_eq!(source_revision(models_data, "reader-page", None, None).unwrap(), None);
        // 不认识的 rendition 是明确的错误，不是一个静默的空 revision。
        assert!(source_revision(models_data, "nonsense", None, None).is_err());

        // 运行库那一栏现在是协议里的常量（宿主摘掉 ORT 之后就问不了自己的运行库了：
        // 那件事只有 worker 说得清，所以由它启动时证明），但内容仍必须是那条运行库的
        // 号；后端那一栏仍来自环境，且不能是空串。
        assert!(ort_runtime_label().starts_with("ort-api"));
        assert!(!declared_backend_label().is_empty());

        // 后端那一栏得是真的在起作用，而不只是「印了个非空串」：同一份模型、同一份起点、
        // 同一条流水线，只换「谁算的」，修订号就必须换一个——否则同一台机器上后端策略
        // 变了（驱动升级后 DML 没了、探针拒了这个模型），旧产物会被当成新策略的产物接着用。
        let model = upscaler_fingerprint(&None);
        assert_ne!(
            derived_cache_revision(&model, "reader-page", UPSCALE_PIPELINE_REVISION, "cpu"),
            derived_cache_revision(&model, "reader-page", UPSCALE_PIPELINE_REVISION, "directml"),
            "后端那一栏没有参与折算，换后端就等于换了个写法"
        );
        // 产品调用点真的传的是「这台机器声明的那一条」而不是某个常量：本机声明的是
        // directml（Windows 上有硬件候选），所以产品身份必须与「cpu 写死」的那一版不同。
        // 只在声明的后端不是 cpu 时才断——CPU-only 的机器上这两个值本来就该相同。
        let declared = declared_backend_label();
        eprintln!("这台机器声明的后端 = {declared}（首选运行库，末位永远是 CPU）");
        if declared != "cpu" {
            assert_ne!(
                reader_page,
                derived_cache_revision(&model, "reader-page", UPSCALE_PIPELINE_REVISION, "cpu"),
                "产品算出来的身份与 CPU 那一版相同：产品调用点把后端写成了常量，\
                 而这台机器声明的是「{declared}」"
            );
        }
    }

    /// 本机没有真模型素材时**明说跳过**——跳过不等于通过。
    ///
    /// 为什么不放进 `tests/`：产品函数 `upscale_cached_page_with_models` 是私有的
    /// （`inference` 不对外），集成测试够不着；为了让测试能调它而把它 `pub` 出去，等于
    /// 让测试的需要决定生产 API 的形状。真进程那一半（`compute::proxy` 本身）已经在
    /// `tests/legacy_upscale_proxy.rs` 里用回声引擎真跑过了。
    fn local_upscaler(name: &str) -> Option<Vec<u8>> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/models")
            .join(format!("{name}.onnx"));
        match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) => {
                eprintln!("跳过：本机没有 {}（{error}）", path.display());
                None
            }
        }
    }

    /// 集成测试不会自动编译同 workspace 里另一个包的 bin，所以这里自己编一次。
    /// 与 `tests/compute_model_chain.rs` 里那份同源：`#[cfg(test)]` 的东西集成测试看不见，
    /// 为此共用一个测试专用 crate 比多这十几行更贵。
    #[cfg(windows)]
    fn worker_under_test() -> std::path::PathBuf {
        let exe = std::env::current_exe().expect("测试自己的路径");
        let profile_dir = exe
            .parent()
            .and_then(std::path::Path::parent)
            .expect("target/<profile>")
            .to_path_buf();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let mut command = std::process::Command::new(env!("CARGO"));
        command
            .arg("build")
            .arg("--manifest-path")
            .arg(&manifest)
            .arg("-p")
            .arg("yomika-compute-worker");
        if profile_dir.file_name().is_some_and(|name| name == "release") {
            command.arg("--release");
        }
        let output = command.output().expect("跑 cargo build 起 worker");
        assert!(
            output.status.success(),
            "编 worker 失败：\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let worker = profile_dir.join("yomika-compute-worker.exe");
        assert!(
            worker.exists(),
            "编完之后还是找不到 worker：{}",
            worker.display()
        );
        worker
    }

    /// The whole chain the reader takes, on the real model when it is present:
    /// a ZIP goes through `install_model_archive`, the installed directory is
    /// resolved back by id, and the engine built from it upscales a tile.
    ///
    /// The temp directory keeps this independent of whatever is installed on
    /// this machine; `docs/` is gitignored, so a fresh clone skips it.
    #[test]
    fn the_downloaded_model_installs_and_resolves_into_a_working_engine() {
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/models/realcugan-2x-conservative.onnx");
        if !source.exists() {
            eprintln!("skipping: {} is not present", source.display());
            return;
        }
        let model_bytes = std::fs::read(&source).expect("read the downloaded model");

        let base = std::env::temp_dir().join("yomika-install-real-model");
        let _ = std::fs::remove_dir_all(&base);
        let (staging, install) =
            model_install_roots(&base, "realcugan-2x-conservative", "2022.02.27")
                .expect("install roots");

        let mut manifest = model_manifest(&model_bytes);
        manifest.id = "realcugan-2x-conservative".into();
        manifest.version = "2022.02.27".into();
        manifest.scale = 2;
        // As the published catalog declares it, so the tile below is grown the way
        // a page-edge strip is.
        manifest.min_input_edge = 20;
        install_model_archive(
            &model_zip(&[("model.onnx", &model_bytes)]),
            &manifest,
            &staging,
            &install,
        )
        .expect("install the downloaded model");

        let (path, resolved) = resolve_installed_model(&base, "realcugan-2x-conservative")
            .expect("resolve the installed model");
        assert_eq!(path, install.join("model.onnx"));
        assert_eq!(
            resolved, manifest,
            "the manifest must survive installation verbatim"
        );

        let engine = onnx::OnnxEngine::open(
            &path,
            resolved.scale,
            resolved.max_pixels,
            resolved.min_input_edge,
        )
        .expect("open the installed model");
        let rgba = vec![128_u8; 8 * 8 * 4];
        let output = upscale::UpscaleEngine::upscale_tile(&engine, &rgba, 8, 8)
            .expect("upscale a tile with the installed model");
        assert_eq!(
            output.len(),
            16 * 16 * 4,
            "a x2 model turns an 8x8 tile into 16x16, however far it had to grow it first"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn built_in_upscalers_are_listed_before_the_installed_models() {
        let base = std::env::temp_dir().join("yomika-builtin-models");
        let _ = std::fs::remove_dir_all(&base);

        // A fresh install has no models directory, but still has a usable choice.
        let fresh = listed_upscale_models_in(&base);
        assert_eq!(fresh.len(), 1, "settings expose one curated Anime4K chain");
        assert_eq!(fresh[0].id, "anime4k-hq");
        assert_eq!(fresh[0].kind, MODEL_KIND_UPSCALE);
        assert_eq!(fresh[0].scale, Some(2));
        assert!(fresh.iter().all(|model| !model.version.is_empty()));

        // An installed model is appended, not replaced by the built-ins.
        let root = base.join("models").join("realesr").join("1");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(MODEL_MANIFEST_FILE),
            serde_json::to_vec(&model_manifest(b"x")).unwrap(),
        )
        .unwrap();
        let listed = listed_upscale_models_in(&base);
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|model| model.id == "realesr"));
        assert_eq!(listed[0].id, "anime4k-hq", "built-ins come first");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_built_in_id_resolves_with_nothing_installed() {
        let base = std::env::temp_dir().join("yomika-builtin-resolve");
        let _ = std::fs::remove_dir_all(&base);
        match resolve_upscaler(&base, "anime4k-hq") {
            Some(ResolvedUpscaler::Anime4k(preset)) => assert_eq!(preset.id, "anime4k-hq"),
            _ => panic!("a built-in id has to resolve without a model directory"),
        }
        assert!(resolve_upscaler(&base, "not-installed").is_none());
    }

    fn model_manifest(bytes: &[u8]) -> ModelManifest {
        use sha2::{Digest, Sha256};
        let sha256 = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        ModelManifest {
            id: "waifu".into(),
            version: "1".into(),
            format: "onnx".into(),
            scale: 2,
            max_pixels: 64_000_000,
            sha256,
            supported_backends: vec!["cpu".into()],
            min_input_edge: default_min_input_edge(),
        }
    }

    fn model_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::{Cursor, Write};
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(0o600);
            for (name, bytes) in entries {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        output.into_inner()
    }

    fn install_test_roots(
        name: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("yomika-{name}-{}-{nonce}", std::process::id()));
        (base.join(".staging"), base.join("model"), base)
    }

    #[test]
    fn manifest_validation_requires_hash_scale_and_cpu_support() {
        let manifest = ModelManifest {
            id: "waifu".into(),
            version: "1".into(),
            format: "onnx".into(),
            scale: 2,
            max_pixels: 64_000_000,
            sha256: "a".repeat(64),
            supported_backends: vec!["directml".into(), "cpu".into()],
            min_input_edge: default_min_input_edge(),
        };
        assert!(validate_manifest(&manifest).is_ok());
        let mut invalid = manifest.clone();
        invalid.supported_backends.clear();
        assert!(matches!(
            validate_manifest(&invalid),
            Err(InferenceError::InvalidManifest(_))
        ));
    }

    #[test]
    fn model_bytes_must_match_manifest_sha256() {
        use sha2::{Digest, Sha256};
        let bytes = b"model";
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let manifest = ModelManifest {
            id: "waifu".into(),
            version: "1".into(),
            format: "onnx".into(),
            scale: 2,
            max_pixels: 64_000_000,
            sha256: hash,
            supported_backends: vec!["cpu".into()],
            min_input_edge: default_min_input_edge(),
        };
        assert!(validate_model_bytes(&manifest, bytes).is_ok());
        assert!(matches!(
            validate_model_bytes(&manifest, b"tampered"),
            Err(InferenceError::InvalidManifest(_))
        ));
    }

    #[test]
    fn model_archive_planner_accepts_regular_relative_entries_inside_staging() {
        let staging = std::path::Path::new("staging/model-a");
        let entries = vec![
            ModelArchiveEntry::regular("model.onnx"),
            ModelArchiveEntry::regular("assets/config.json"),
            ModelArchiveEntry::regular("tokenizer\\vocab.json"),
        ];
        let planned = plan_model_archive_entries(staging, &entries).expect("safe archive plan");
        assert_eq!(
            planned,
            vec![
                staging.join("model.onnx"),
                staging.join("assets").join("config.json"),
                staging.join("tokenizer").join("vocab.json"),
            ]
        );
        assert!(planned.iter().all(|path| path.starts_with(staging)));
    }

    #[test]
    fn model_archive_planner_rejects_unsafe_paths_and_non_regular_entries() {
        for name in [
            "/model.onnx",
            "\\model.onnx",
            "C:\\model.onnx",
            "C:model.onnx",
            "//server/share/model.onnx",
            "\\\\server\\share\\model.onnx",
            "../model.onnx",
            "assets/../model.onnx",
            "./model.onnx",
            "assets//model.onnx",
        ] {
            assert!(
                plan_model_archive_entries(
                    std::path::Path::new("staging"),
                    &[ModelArchiveEntry::regular(name)]
                )
                .is_err(),
                "accepted {name}"
            );
        }
        for kind in [
            ModelArchiveEntryKind::Directory,
            ModelArchiveEntryKind::Symlink,
            ModelArchiveEntryKind::Other,
        ] {
            assert!(plan_model_archive_entries(
                std::path::Path::new("staging"),
                &[ModelArchiveEntry {
                    name: "entry".into(),
                    kind
                }]
            )
            .is_err());
        }
    }

    #[test]
    fn model_archive_planner_rejects_duplicate_normalized_targets() {
        let entries = vec![
            ModelArchiveEntry::regular("assets/model.onnx"),
            ModelArchiveEntry::regular("ASSETS\\MODEL.ONNX"),
        ];
        assert!(plan_model_archive_entries(std::path::Path::new("staging"), &entries).is_err());
    }

    #[test]
    fn model_install_plan_requires_sibling_absolute_roots() {
        let base = std::env::temp_dir().join("yomika-model-install-test");
        let staging = base.join(".staging-model");
        let install = base.join("model");
        let entries = [ModelArchiveEntry::regular("model.onnx")];
        let plan = plan_model_install(&staging, &install, &entries).expect("install plan");
        assert_eq!(plan.staging_root, staging);
        assert_eq!(plan.install_root, install);
        assert_eq!(plan.entries, vec![staging.join("model.onnx")]);
    }

    #[test]
    fn model_install_plan_rejects_relative_nested_or_cross_parent_roots() {
        let base = std::env::temp_dir().join("yomika-model-install-test");
        let cases = [
            (std::path::PathBuf::from("staging"), base.join("model")),
            (base.join("model"), base.join("model").join("nested")),
            (base.join(".staging"), base.join("other").join("model")),
        ];
        for (staging, install) in cases {
            assert!(plan_model_install(&staging, &install, &[]).is_err());
        }
    }

    #[test]
    fn model_install_roots_are_derived_from_safe_identity_segments() {
        let app_data = std::env::temp_dir().join("yomika-app-data");
        let (staging, install) = model_install_roots(&app_data, "waifu2x-upconv7", "2026.08.1")
            .expect("safe model identity");
        let parent = app_data.join("models").join("waifu2x-upconv7");
        assert_eq!(staging, parent.join(".2026.08.1.installing"));
        assert_eq!(install, parent.join("2026.08.1"));

        for invalid in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "C:model",
            " spaced",
            "model@latest",
        ] {
            assert!(
                model_install_roots(&app_data, invalid, "1").is_err(),
                "accepted id {invalid:?}"
            );
            assert!(
                model_install_roots(&app_data, "model", invalid).is_err(),
                "accepted version {invalid:?}"
            );
        }
    }

    #[test]
    fn installed_models_skip_partial_installs_and_report_newest_version_first() {
        let base = std::env::temp_dir().join("yomika-installed-models");
        let _ = std::fs::remove_dir_all(&base);
        let models = base.join("models");
        for path in [
            models.join("realesr-general").join("2026.08.1"),
            models.join("realesr-general").join("2026.09.2"),
            // A half-finished extraction, and a name model_install_roots would
            // never produce: neither can be selected.
            models.join("realesr-general").join(".2026.10.0.installing"),
            models.join("waifu2x").join("1"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        // Only one of them records a manifest, so only one has a usable scale.
        std::fs::write(
            models
                .join("realesr-general")
                .join("2026.09.2")
                .join(MODEL_MANIFEST_FILE),
            serde_json::to_vec(&model_manifest(b"x")).unwrap(),
        )
        .unwrap();

        assert_eq!(
            installed_models_in(&base),
            vec![
                InstalledModel {
                    id: "realesr-general".into(),
                    version: "2026.09.2".into(),
                    scale: Some(2),
                    kind: MODEL_KIND_UPSCALE.into(),
                    components: Vec::new()
                },
                InstalledModel {
                    id: "realesr-general".into(),
                    version: "2026.08.1".into(),
                    scale: None,
                    kind: MODEL_KIND_UPSCALE.into(),
                    components: Vec::new()
                },
                InstalledModel {
                    id: "waifu2x".into(),
                    version: "1".into(),
                    scale: None,
                    kind: MODEL_KIND_UPSCALE.into(),
                    components: Vec::new()
                },
            ]
        );
        // No models directory at all is an empty list, not an error: a fresh
        // install has nowhere to look yet.
        assert!(installed_models_in(&base.join("elsewhere")).is_empty());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_raw_import_takes_its_identity_from_the_file_name() {
        assert_eq!(imported_model_id("realesr-general-x4v3.onnx"), "realesr-general-x4v3");
        assert_eq!(imported_model_id(" 4x-Fatal-Pixels.ONNX "), "4x-Fatal-Pixels");
        // A name that cannot be a path segment falls back to the legacy catch-all.
        assert_eq!(imported_model_id("模型.onnx"), "imported-model");
        assert_eq!(imported_model_id(".onnx"), "imported-model");
    }

    #[test]
    fn resolving_a_model_needs_both_a_manifest_and_exactly_one_onnx_file() {
        let base = std::env::temp_dir().join("yomika-resolve-model");
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("models").join("realesr").join("1");
        std::fs::create_dir_all(&root).unwrap();

        // Manifest but no model file.
        std::fs::write(
            root.join(MODEL_MANIFEST_FILE),
            serde_json::to_vec(&model_manifest(b"x")).unwrap(),
        )
        .unwrap();
        assert!(resolve_installed_model(&base, "realesr").is_none());

        std::fs::write(root.join("model.onnx"), b"onnx").unwrap();
        let (path, manifest) = resolve_installed_model(&base, "realesr").expect("resolved model");
        assert_eq!(path, root.join("model.onnx"));
        assert_eq!(manifest.scale, 2);

        // Two ONNX files is ambiguous: refusing beats picking one at random.
        std::fs::write(root.join("other.onnx"), b"onnx").unwrap();
        assert!(model_file_in(&root).is_none());
        assert!(resolve_installed_model(&base, "realesr").is_none());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn model_archive_install_extracts_validated_model_then_publishes_atomically() {
        let model = b"valid onnx model";
        let archive = model_zip(&[("model.onnx", model), ("assets/config.json", b"{}")]);
        let manifest = model_manifest(model);
        let (staging, install, base) = install_test_roots("model-install-ok");

        let installed = install_model_archive(&archive, &manifest, &staging, &install)
            .expect("installed model");

        assert_eq!(installed, install);
        assert_eq!(std::fs::read(install.join("model.onnx")).unwrap(), model);
        assert_eq!(
            std::fs::read(install.join("assets/config.json")).unwrap(),
            b"{}"
        );
        // The manifest travels with the model, because nothing else records the
        // scale the upscaler needs.
        assert_eq!(
            read_model_manifest(&install).expect("installed manifest"),
            manifest
        );
        assert!(!staging.exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn model_archive_install_rejects_traversal_and_cleans_staging() {
        let model = b"valid onnx model";
        let archive = model_zip(&[("../model.onnx", model)]);
        let manifest = model_manifest(model);
        let (staging, install, base) = install_test_roots("model-install-traversal");

        assert!(install_model_archive(&archive, &manifest, &staging, &install).is_err());
        assert!(!staging.exists());
        assert!(!install.exists());
        if base.exists() {
            std::fs::remove_dir_all(base).unwrap();
        }
    }

    #[test]
    fn model_archive_install_rejects_bad_hash_or_existing_install_without_overwrite() {
        let model = b"tampered model";
        let archive = model_zip(&[("model.onnx", model)]);
        let manifest = model_manifest(b"expected model");
        let (staging, install, base) = install_test_roots("model-install-existing");

        assert!(install_model_archive(&archive, &manifest, &staging, &install).is_err());
        assert!(!staging.exists());
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("keep.txt"), b"keep").unwrap();
        assert!(
            install_model_archive(&archive, &model_manifest(model), &staging, &install).is_err()
        );
        assert_eq!(std::fs::read(install.join("keep.txt")).unwrap(), b"keep");
        assert!(!staging.exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    fn cache_test_db() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../migrations/0001_initial.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0002_local_library.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0009_inference_jobs.sql"))
            .unwrap();
        connection
    }

    #[test]
    fn inference_cache_clear_removes_files_and_index_but_preserves_models() {
        let connection = cache_test_db();
        let (_, _, base) = install_test_roots("inference-cache-clear");
        let cache_root = base.join("cache").join("inference");
        let model_root = base.join("models").join("waifu").join("1");
        std::fs::create_dir_all(cache_root.join("waifu/input")).unwrap();
        std::fs::create_dir_all(&model_root).unwrap();
        std::fs::write(cache_root.join("waifu/input/output.bin"), b"result").unwrap();
        std::fs::write(model_root.join("model.onnx"), b"model").unwrap();
        connection.execute("INSERT INTO cache_entries (key,kind,path,size,source_scope,content_hash,model_id) VALUES ('inference-a','inference','cache/inference/waifu/input/output.bin',6,'scope','hash','waifu'),('image-a','image','cache/images/a.bin',1,'scope','image-hash',NULL)", []).unwrap();

        let result = clear_inference_cache(&connection, &cache_root).expect("cache cleared");

        assert_eq!(result.entries_cleared, 1);
        assert!(!cache_root.exists());
        assert!(model_root.join("model.onnx").exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn inference_cache_clear_refuses_while_job_is_active() {
        let connection = cache_test_db();
        let (_, _, base) = install_test_roots("inference-cache-active");
        let cache_root = base.join("cache").join("inference");
        std::fs::create_dir_all(&cache_root).unwrap();
        std::fs::write(cache_root.join("keep.bin"), b"keep").unwrap();
        connection.execute("INSERT INTO inference_jobs (id,source_scope,source_id,model_id,model_version,status) VALUES ('job','scope','source','waifu','1','running')", []).unwrap();

        assert!(clear_inference_cache(&connection, &cache_root).is_err());
        assert!(cache_root.join("keep.bin").exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn backend_selector_falls_back_to_cpu_when_nothing_else_is_usable() {
        // Accelerators the platform does not have are never chosen, and an
        // unsupported or fully blacklisted set still yields a runnable backend.
        assert_eq!(
            select_backend(&["nnapi".into(), "coreml".into()], &[]),
            BackendId::Cpu
        );
        assert_eq!(
            select_backend(&["cpu".into()], &["cpu".into()]),
            BackendId::Cpu
        );
    }

    #[test]
    fn inference_job_resumes_without_recreating_items_and_cancel_persists() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../migrations/0001_initial.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0009_inference_jobs.sql"))
            .unwrap();
        let make = || InferenceStartInput {
            id: "job-a".into(),
            source_scope: "scope-a".into(),
            source_id: "gallery-a".into(),
            model_id: "model-a".into(),
            model_version: "1".into(),
            input_hashes: vec!["h1".into(), "h2".into()],
        };
        assert_eq!(start_job(&mut connection, make()).unwrap().item_count, 2);
        assert_eq!(start_job(&mut connection, make()).unwrap().item_count, 2);
        connection.execute("UPDATE inference_items SET status='completed' WHERE job_id='job-a' AND item_index=0",[]).unwrap();
        connection
            .execute(
                "UPDATE inference_jobs SET status='cancelled' WHERE id='job-a'",
                [],
            )
            .unwrap();
        let job = load_job(&connection, "job-a").unwrap();
        assert_eq!(job.completed_count, 1);
        assert_eq!(job.status, "cancelled");
    }

    #[test]
    fn item_checkpoint_is_monotonic_and_completion_requires_output() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../migrations/0001_initial.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0009_inference_jobs.sql"))
            .unwrap();
        start_job(
            &mut connection,
            InferenceStartInput {
                id: "job-b".into(),
                source_scope: "scope-a".into(),
                source_id: "gallery-a".into(),
                model_id: "model-a".into(),
                model_version: "1".into(),
                input_hashes: vec!["h1".into()],
            },
        )
        .unwrap();
        checkpoint_item(&connection, "job-b", 0, 4, "running", None).unwrap();
        checkpoint_item(&connection, "job-b", 0, 2, "running", None).unwrap();
        assert!(checkpoint_item(&connection, "job-b", 0, 5, "completed", None).is_err());
        checkpoint_item(&connection, "job-b", 0, 5, "completed", Some("out.png")).unwrap();
        let stored: (i64, String, Option<String>) = connection.query_row("SELECT completed_tile,status,output_path FROM inference_items WHERE job_id='job-b'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(stored, (5, "completed".into(), Some("out.png".into())));
    }

    #[test]
    fn pause_and_resume_preserve_completed_items() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../migrations/0001_initial.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0009_inference_jobs.sql"))
            .unwrap();
        start_job(
            &mut connection,
            InferenceStartInput {
                id: "job-c".into(),
                source_scope: "scope".into(),
                source_id: "g".into(),
                model_id: "m".into(),
                model_version: "1".into(),
                input_hashes: vec!["a".into(), "b".into()],
            },
        )
        .unwrap();
        checkpoint_item(&connection, "job-c", 0, 3, "completed", Some("out.png")).unwrap();
        transition_job(&connection, "job-c", "paused").unwrap();
        transition_job(&connection, "job-c", "running").unwrap();
        let statuses: Vec<String> = connection
            .prepare("SELECT status FROM inference_items WHERE job_id='job-c' ORDER BY item_index")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(statuses, vec!["completed", "pending"]);
        assert!(transition_job(&connection, "job-c", "completed").is_err());
    }

    /// 空状态。测试自己造，不去碰那个进程级的全局队列。
    fn empty_heavy_queue() -> HeavyQueueState {
        HeavyQueueState {
            running: None,
            waiters: Vec::new(),
            sequence: 0,
        }
    }

    /// 前台（用户正看着的那一页）排到后台（整本预扫）前面，并且点名要掐正在跑的那
    /// 一件；同一档里仍然先来先到。
    #[test]
    fn the_heavy_queue_runs_the_current_page_first() {
        let mut state = empty_heavy_queue();
        assert!(state.can_start(HeavyPriority::Background));
        // 整本预扫先跑起来。
        state.start(HeavyPriority::Background, Some("sweep-1".into()));
        assert!(!state.can_start(HeavyPriority::Background), "同时只能有一件");

        let (sweep_2, _recv_2) = tokio::sync::oneshot::channel();
        let (sweep_3, _recv_3) = tokio::sync::oneshot::channel();
        assert_eq!(
            state.enqueue(
                HeavyPriority::Background,
                Some("sweep-2".into()),
                sweep_2
            ),
            None,
            "后台不抢后台"
        );
        assert_eq!(
            state.enqueue(
                HeavyPriority::Background,
                Some("sweep-3".into()),
                sweep_3
            ),
            None
        );

        let (page, _recv_page) = tokio::sync::oneshot::channel();
        assert_eq!(
            state.enqueue(
                HeavyPriority::Foreground,
                Some("page-9".into()),
                page
            ),
            Some("sweep-1".to_string()),
            "前台进来要掐掉正在跑的后台那一件"
        );
        let next = state.next().expect("有人排队");
        assert_eq!(next.priority, HeavyPriority::Foreground);
        assert_eq!(next.task_id.as_deref(), Some("page-9"));
        assert_eq!(state.next().unwrap().task_id.as_deref(), Some("sweep-2"));
        assert_eq!(state.next().unwrap().task_id.as_deref(), Some("sweep-3"));
        assert!(state.next().is_none());
    }

    /// 前台之间不互相抢：同一页可能有两步，后一步等前一步的产物。
    #[test]
    fn a_foreground_request_does_not_cancel_another_foreground_job() {
        let mut state = empty_heavy_queue();
        state.start(HeavyPriority::Foreground, Some("page-1:upscale".into()));
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        assert_eq!(
            state.enqueue(HeavyPriority::Foreground, Some("page-1:enhanced".into()), sender),
            None
        );
    }

    /// 新来的后台不许插到已经排队的前台前面：否则用户翻到的那一页又要等预扫。
    #[test]
    fn a_queued_foreground_is_not_overtaken_by_a_later_background() {
        let mut state = empty_heavy_queue();
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        state.enqueue(HeavyPriority::Foreground, Some("page".into()), sender);
        assert!(!state.can_start(HeavyPriority::Background));
        assert!(state.can_start(HeavyPriority::Foreground));
    }

    /// 排上队了没有。`acquire` 是「先拿锁、再 await」，所以要等那个任务真的走到
    /// await 上，不然测的就成了 release 时没人在等。
    async fn wait_for_waiters(count: usize) {
        for _ in 0..1000 {
            if HEAVY_QUEUE.lock().waiters.len() == count {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!(
            "排队人数没到 {count}：现在是 {}",
            HEAVY_QUEUE.lock().waiters.len()
        );
    }

    /// 还回去的许可要交给下一位，不能丢在地上（丢了整条链子从此卡死）。
    #[tokio::test(flavor = "current_thread")]
    async fn a_released_permit_reaches_the_next_one_in_line() {
        let _serial = heavy_queue_test_lock();
        let running = HEAVY_QUEUE.acquire(HeavyPriority::Background, None).await;
        assert!(
            HEAVY_QUEUE.lock().running.is_some(),
            "第一件该在跑"
        );

        let waiter = tokio::spawn(async move {
            let _permit = HEAVY_QUEUE.acquire(HeavyPriority::Foreground, None).await;
        });
        wait_for_waiters(1).await;
        drop(running);
        waiter.await.unwrap();
        assert!(
            HEAVY_QUEUE.lock().running.is_none(),
            "走到最后一件时就该空出来"
        );
    }

    /// 前台插队时，正在跑的那个后台任务会收到取消旗（它自己会在检查点退出来）。
    #[tokio::test(flavor = "current_thread")]
    async fn a_foreground_request_cancels_the_running_background_job() {
        let _serial = heavy_queue_test_lock();
        let running = HEAVY_QUEUE
            .acquire(HeavyPriority::Background, Some("sweep-1".into()))
            .await;
        let guard = cancel::begin(Some("sweep-1"));
        assert!(!guard.cancelled());

        let waiter = tokio::spawn(async {
            let _permit = HEAVY_QUEUE
                .acquire(HeavyPriority::Foreground, Some("page-1".into()))
                .await;
        });
        wait_for_waiters(1).await;
        assert!(guard.cancelled(), "正在跑的后台那件该被掐");

        drop(running);
        waiter.await.unwrap();
    }

    /// 审计 P2-2：远端那一步等的是**对面**那台机器，不该占住本机的重活槽。
    ///
    /// 以前两条路共用一个闸，一份卡住或慢的远端请求（阻塞式 HTTP，最长 180 秒）会让
    /// 用户当前页的 DLSSNR / 超分一直排队。
    #[tokio::test(flavor = "current_thread")]
    async fn a_remote_task_does_not_hold_the_local_heavy_slot() {
        let _serial = heavy_queue_test_lock();

        // 远端占着自己的那条 → 本机那一件仍然要立刻拿得到。
        let remote = REMOTE_QUEUE.acquire(HeavyPriority::Background, None).await;
        let local = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            HEAVY_QUEUE.acquire(HeavyPriority::Foreground, None),
        )
        .await
        .expect("远端占着的时候，本机那一件重活仍然要立刻能跑");
        drop(local);
        drop(remote);
        assert!(HEAVY_QUEUE.lock().running.is_none());
        assert!(REMOTE_QUEUE.lock().running.is_none());

        // 反过来：本机占着 → 远端也立刻能发出去。
        let local = HEAVY_QUEUE.acquire(HeavyPriority::Foreground, None).await;
        let remote = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            REMOTE_QUEUE.acquire(HeavyPriority::Background, None),
        )
        .await
        .expect("本机占着的时候，远端那一步仍然要立刻能发出去");
        drop(remote);
        drop(local);
        assert!(HEAVY_QUEUE.lock().running.is_none());
        assert!(REMOTE_QUEUE.lock().running.is_none());
    }

    /// 负控：分两条队列不是把闸拆了——各自仍然一次一件。
    #[tokio::test(flavor = "current_thread")]
    async fn each_heavy_queue_still_runs_one_thing_at_a_time() {
        let _serial = heavy_queue_test_lock();

        let local = HEAVY_QUEUE.acquire(HeavyPriority::Background, None).await;
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(120),
                HEAVY_QUEUE.acquire(HeavyPriority::Background, None)
            )
            .await
            .is_err(),
            "本机那一条仍然一次一件"
        );

        let remote = REMOTE_QUEUE.acquire(HeavyPriority::Background, None).await;
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(120),
                REMOTE_QUEUE.acquire(HeavyPriority::Foreground, None)
            )
            .await
            .is_err(),
            "远端那一条仍然一次一件"
        );

        drop(remote);
        drop(local);
        assert!(HEAVY_QUEUE.lock().running.is_none());
        assert!(REMOTE_QUEUE.lock().running.is_none());
    }

    /// 一张真的小 PNG（缓存层的 `sniff_image_mime` 与 blake3 校验都走真字节）。
    fn tiny_page_png() -> Vec<u8> {
        use image::ImageEncoder;
        let (width, height) = (8u32, 8u32);
        let rgba = vec![7u8; (width * height * 4) as usize];
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
            .expect("编码 PNG");
        bytes
    }

    /// 让缓存写必然失败：把 `cache` 这个位置先占成**文件**，`create_dir_all(<data>/cache/
    /// images/xx)` 就建不起来。（不靠权限位：Windows 上目录的只读位本来就不挡写入。）
    fn block_cache_writes(data_dir: &std::path::Path) {
        std::fs::write(data_dir.join("cache"), b"").expect("占位");
    }

    fn derived_identity() -> crate::cache::CacheImageIdentity {
        let mut identity =
            crate::cache::CacheImageIdentity::new("scope-a", "archive-7", "dlssnr", 42);
        identity.revision = Some("dlssnr:v2:0f1e".to_string());
        identity
    }

    /// P2-1：写不进去要能被调用方看见（不是一个被吞掉的 `()`），而且原因分得清「再试
    /// 一次有用」和「没用」。
    #[test]
    fn a_derived_result_that_cannot_be_written_reports_a_structured_error() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        let identity = derived_identity();
        block_cache_writes(dir.path());

        let error = store_derived(&database, dir.path(), &identity, "image/png", &tiny_page_png())
            .expect_err("写不进去必须是 Err");
        assert_eq!(error.code, CACHE_WRITE_FAILED);
        assert!(!error.message.trim().is_empty(), "要有一句人话");
        assert!(!error.retryable, "目录建不起来不是重试能解决的");
    }

    /// P2-1 的契约：缓存没写进去，这一页照样交出去——图已经算出来了，磁盘满不该把它从
    /// 用户眼前拿走；代价是统一错误日志里多一条带完整缓存键的警告。
    #[test]
    fn a_failed_cache_write_still_returns_the_page_and_says_so_in_the_log() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        let identity = derived_identity();
        let png = tiny_page_png();
        block_cache_writes(dir.path());

        let returned = finish_derived(
            &database,
            dir.path(),
            UPSCALE_CACHE_SOURCE,
            &identity,
            "image/png",
            png.clone(),
        );
        assert_eq!(returned, png, "写不进去也要把这一页原样交出去");

        let log = std::fs::read_to_string(dir.path().join("logs/error.log")).expect("错误日志");
        let line = log.lines().next().expect("一条记录");
        let fields: Vec<&str> = line.split('\t').collect();
        assert_eq!(fields.len(), 5, "统一错误日志是制表符分隔的五栏：{line}");
        assert_eq!(fields[1], "warn");
        assert_eq!(fields[2], UPSCALE_CACHE_SOURCE);
        assert!(
            fields[3].starts_with(CACHE_WRITE_FAILED),
            "分类要在最前面：{line}"
        );
        for key in [
            "scope=scope-a",
            "archive=archive-7",
            "page=42",
            "rendition=dlssnr",
            "revision=dlssnr:v2:0f1e",
        ] {
            assert!(
                fields[4].contains(key),
                "detail 里要能对账：{key} / {}",
                fields[4]
            );
        }
        // 一次失败一条：不要把同一件事写成两行（日志面板按 (时间,级别,来源,消息) 去重，
        // 但重复写本身就说明有人调了两遍）。
        assert_eq!(log.lines().count(), 1, "一次失败一条");
    }

    /// 成功落盘时不写日志：警告只在真出问题时出现，不然日志面板就全是噪音。
    #[test]
    fn a_derived_result_that_lands_returns_the_page_and_leaves_no_warning() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        let identity = derived_identity();
        let png = tiny_page_png();

        let returned = finish_derived(
            &database,
            dir.path(),
            UPSCALE_CACHE_SOURCE,
            &identity,
            "image/png",
            png.clone(),
        );

        assert_eq!(returned, png);
        assert_eq!(
            cached_derived(&database, dir.path(), &identity),
            Some(png),
            "落盘了就该能原样取回来"
        );
        assert!(
            !dir.path().join("logs/error.log").exists(),
            "成功不该留警告"
        );
    }

}

#[cfg(test)]
mod fingerprint_cache_bounds {
    use super::*;

    fn seed(root: &std::path::Path) -> String {
        std::fs::create_dir_all(root.join("v1")).expect("模型目录");
        std::fs::write(root.join("v1/weights.bin"), b"w").expect("权重");
        cached_model_fingerprint(root).expect("指纹")
    }

    #[test]
    fn a_repeated_fingerprint_lookup_reuses_the_cached_value() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path().join("models/demo");
        let first = seed(&root);
        assert!(first.starts_with("v3-"), "指纹前缀：{first}");
        assert_eq!(cached_model_fingerprint(&root).expect("第二次指纹"), first);
    }

    #[test]
    fn the_fingerprint_cache_evicts_the_oldest_root_instead_of_growing() {
        let dir = tempfile::tempdir().expect("临时目录");
        let total = MAX_FINGERPRINT_CACHE_ENTRIES + 16;
        for index in 0..total {
            seed(&dir.path().join(format!("models/m{index}")));
        }
        {
            let guard = FINGERPRINT_CACHE.lock().unwrap();
            let cache = guard.as_ref().expect("缓存已建立");
            assert!(
                cache.len() <= MAX_FINGERPRINT_CACHE_ENTRIES,
                "缓存条数 {} 超过上限 {MAX_FINGERPRINT_CACHE_ENTRIES}",
                cache.len()
            );
            assert!(
                cache.get(&dir.path().join("models/m0")).is_none(),
                "最旧的根目录应被淘汰"
            );
            assert!(
                cache.get(&dir.path().join(format!("models/m{}", total - 1))).is_some(),
                "最近的根目录应保留"
            );
        }
        // 别把测试用的临时路径留在进程级缓存里。
        *FINGERPRINT_CACHE.lock().unwrap() = None;
    }
}
