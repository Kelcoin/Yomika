#[derive(Debug, PartialEq, Eq)]
pub enum InferenceError {
    InvalidInput(String),
    PixelBudgetExceeded { pixels: usize, max_pixels: usize },
    InvalidManifest(String),
    CacheBusy,
}

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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelArchiveEntryKind { Regular, Directory, Symlink, Other }

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
        Self { name: name.into(), kind: ModelArchiveEntryKind::Regular }
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
            return Err(InferenceError::InvalidManifest("model archive contains a non-regular entry".into()));
        }
        if entry.name.is_empty() || entry.name.starts_with(['/', '\\']) || entry.name.contains('\0') {
            return Err(InferenceError::InvalidManifest("model archive path is not relative".into()));
        }
        let components: Vec<&str> = entry.name.split(['/', '\\']).collect();
        if components.iter().any(|component| component.is_empty() || *component == "." || *component == ".." || component.contains(':')) {
            return Err(InferenceError::InvalidManifest("model archive path is unsafe".into()));
        }
        let duplicate_key = components.join("/").to_lowercase();
        if !targets.insert(duplicate_key) {
            return Err(InferenceError::InvalidManifest("model archive target is duplicated".into()));
        }
        let mut target = staging_root.to_path_buf();
        for component in components { target.push(component); }
        if !target.starts_with(staging_root) {
            return Err(InferenceError::InvalidManifest("model archive target escapes staging".into()));
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
        return Err(InferenceError::InvalidManifest("model install roots must be absolute".into()));
    }
    if staging_root == install_root
        || staging_root.starts_with(install_root)
        || install_root.starts_with(staging_root)
        || staging_root.parent() != install_root.parent()
    {
        return Err(InferenceError::InvalidManifest("model install roots must be sibling paths".into()));
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
        return Err(InferenceError::InvalidManifest("model identity is not a safe path segment".into()));
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
        if path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("onnx"))
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
        return Err(InferenceError::InvalidInput("model staging or install path already exists".into()));
    }

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(archive_bytes))
        .map_err(|error| InferenceError::InvalidManifest(format!("invalid model ZIP: {error}")))?;
    let mut entries = Vec::with_capacity(archive.len());
    let mut model_index = None;
    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index)
            .map_err(|error| InferenceError::InvalidManifest(format!("invalid model ZIP entry: {error}")))?;
        total_size = total_size.checked_add(file.size())
            .ok_or_else(|| InferenceError::InvalidManifest("model ZIP size overflow".into()))?;
        if total_size > MAX_MODEL_ARCHIVE_UNCOMPRESSED_BYTES {
            return Err(InferenceError::InvalidManifest("model ZIP is too large".into()));
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
            && std::path::Path::new(&name).extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("onnx"))
        {
            if model_index.replace(index).is_some() {
                return Err(InferenceError::InvalidManifest("model ZIP must contain one ONNX file".into()));
            }
        }
        entries.push(ModelArchiveEntry { name, kind });
    }
    let model_index = model_index
        .ok_or_else(|| InferenceError::InvalidManifest("model ZIP does not contain an ONNX file".into()))?;
    let plan = plan_model_install(staging_root, install_root, &entries)?;

    let result = (|| {
        std::fs::create_dir_all(staging_root.parent().ok_or_else(|| {
            InferenceError::InvalidInput("model staging path has no parent".into())
        })?).map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
        std::fs::create_dir(staging_root)
            .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;

        for (index, target) in plan.entries.iter().enumerate() {
            let mut source = archive.by_index(index)
                .map_err(|error| InferenceError::InvalidManifest(format!("invalid model ZIP entry: {error}")))?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
            }
            let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(target)
                .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
            std::io::copy(&mut source, &mut output)
                .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
            output.sync_all().map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
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
                .map_err(|_| InferenceError::InvalidManifest(format!("model ZIP must not contain {MODEL_MANIFEST_FILE}")))?;
            std::io::Write::write_all(&mut manifest_file, &manifest_json)
                .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
            manifest_file.sync_all().map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
        }
        if install_root.exists() {
            return Err(InferenceError::InvalidInput("model install path already exists".into()));
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

pub mod decensor;
pub mod detect;
pub mod inpaint;
pub mod onnx;
pub mod upscale;

/// Execution providers we know how to ask for, most preferred first per
/// platform. The ONNX Runtime session picks one of these; CPU always works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendId { DirectMl, CoreMl, Nnapi, Cpu }

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
pub fn platform_backend_preference() -> Vec<BackendId> {
    let mut order = Vec::new();
    if cfg!(target_os = "windows") {
        order.push(BackendId::DirectMl);
    }
    if cfg!(any(target_os = "macos", target_os = "ios")) {
        order.push(BackendId::CoreMl);
    }
    if cfg!(target_os = "android") {
        order.push(BackendId::Nnapi);
    }
    order.push(BackendId::Cpu);
    order
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceCapabilities {
    pub backends: Vec<String>,
    pub max_pixels: usize,
    pub hardware_acceleration: bool,
}

#[tauri::command]
pub fn inference_probe() -> crate::domain::result::CommandResult<InferenceCapabilities> {
    let backends = platform_backend_preference();
    crate::domain::result::CommandResult::success(InferenceCapabilities {
        hardware_acceleration: backends.iter().any(|backend| backend.is_hardware_accelerated()),
        backends: backends.into_iter().map(|backend| backend.as_str().to_string()).collect(),
        max_pixels: 64_000_000,
    })
}

pub fn validate_manifest(manifest: &ModelManifest) -> Result<(), InferenceError> {
    if manifest.id.trim().is_empty() || manifest.version.trim().is_empty() || manifest.format != "onnx" {
        return Err(InferenceError::InvalidManifest("model identity or format invalid".to_string()));
    }
    if manifest.scale == 0 || manifest.max_pixels == 0 || !manifest.sha256.bytes().all(|b| b.is_ascii_hexdigit()) || manifest.sha256.len() != 64 {
        return Err(InferenceError::InvalidManifest("model scale, pixel budget or hash invalid".to_string()));
    }
    if !manifest.supported_backends.iter().any(|backend| backend == "cpu") {
        return Err(InferenceError::InvalidManifest("CPU backend is required".to_string()));
    }
    Ok(())
}

pub fn validate_model_bytes(manifest: &ModelManifest, model: &[u8]) -> Result<(), InferenceError> {
    validate_manifest(manifest)?;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(model);
    let actual = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    if actual != manifest.sha256.to_ascii_lowercase() {
        return Err(InferenceError::InvalidManifest("model hash mismatch".to_string()));
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelValidationInput { pub manifest: ModelManifest, pub model: Vec<u8> }

#[tauri::command]
pub fn inference_validate_model(input: ModelValidationInput) -> crate::domain::result::CommandResult<()> {
    match validate_model_bytes(&input.manifest, &input.model) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(InferenceError::InvalidManifest(message)) => crate::domain::result::CommandResult::failure("INVALID_RESPONSE", message, false),
        Err(error) => crate::domain::result::CommandResult::failure("INVALID_RESPONSE", format!("{error:?}"), false),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInstallInput { pub manifest: ModelManifest, pub archive: Vec<u8> }

#[derive(Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub id: String,
    pub version: String,
    /// From the installed manifest. `None` means the directory has no manifest,
    /// so the model can be listed but not run.
    pub scale: Option<u32>,
    /// What the model does, read from the shape of the install rather than from
    /// the manifest: a directory holding the four de-censoring files is a
    /// de-censoring bundle whatever its manifest says. Keeps a bundle out of the
    /// upscaler's picker, where selecting it silently produced plain nearest
    /// neighbour output.
    pub kind: String,
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
pub fn fit_enhanced_output(
    rgba: &[u8],
    width: u32,
    height: u32,
    source_width: u32,
    source_height: u32,
) -> (std::borrow::Cow<'_, [u8]>, u32, u32) {
    let target_width = source_width.saturating_mul(ENHANCED_OUTPUT_SCALE);
    let target_height = source_height.saturating_mul(ENHANCED_OUTPUT_SCALE);
    if width <= target_width || height <= target_height || target_width == 0 || target_height == 0 {
        return (std::borrow::Cow::Borrowed(rgba), width, height);
    }
    let Some(image) = image::RgbaImage::from_raw(width, height, rgba.to_vec()) else {
        return (std::borrow::Cow::Borrowed(rgba), width, height);
    };
    // Lanczos3 on the way down: the model spent its time recovering edges, and a
    // box filter would give them straight back.
    let resized = image::imageops::resize(&image, target_width, target_height, image::imageops::FilterType::Lanczos3);
    (std::borrow::Cow::Owned(resized.into_raw()), target_width, target_height)
}

/// The de-censoring sessions, kept for the life of the process and keyed by the
/// bundle they were opened from.
///
/// The detector is a 240 MB graph. It was opened per page, so every page turn paid
/// to load and initialise it again — the model's size is the reason that mattered,
/// and nothing about the graph is per-page. Keyed by the detector's path so
/// switching bundles opens the new one instead of serving the old.
static DECENSOR_ENGINES: std::sync::OnceLock<
    std::sync::Mutex<Option<(std::path::PathBuf, std::sync::Arc<decensor::DecensorEngines>)>>,
> = std::sync::OnceLock::new();

pub(crate) fn decensor_engines_for(
    bundle: &decensor::DecensorBundle,
) -> Result<std::sync::Arc<decensor::DecensorEngines>, InferenceError> {
    let cell = DECENSOR_ENGINES.get_or_init(|| std::sync::Mutex::new(None));
    let mut held = cell
        .lock()
        .map_err(|_| InferenceError::InvalidInput("de-censoring session lock poisoned".into()))?;
    if let Some((path, engines)) = held.as_ref() {
        if path == &bundle.detector {
            return Ok(std::sync::Arc::clone(engines));
        }
    }
    // Drop the previous bundle's sessions before opening the next: two 240 MB
    // detectors resident at once is not a cost worth paying to switch models.
    *held = None;
    let engines = std::sync::Arc::new(decensor::DecensorEngines::open(bundle)?);
    *held = Some((bundle.detector.clone(), std::sync::Arc::clone(&engines)));
    Ok(engines)
}

pub const MODEL_KIND_UPSCALE: &str = "upscale";
pub const MODEL_KIND_DECENSOR: &str = "decensor";

/// Models on disk, as `models/<id>/<version>/`, newest version of each id first.
///
/// A partially-extracted install is a `.<version>.installing` sibling, and those
/// are skipped: offering one as a choice would name a model that cannot load.
pub fn installed_models_in(app_data_dir: &std::path::Path) -> Vec<InstalledModel> {
    let models_dir = app_data_dir.join("models");
    let mut found = Vec::new();
    let Ok(model_dirs) = std::fs::read_dir(&models_dir) else { return found };
    for model_dir in model_dirs.flatten() {
        if !model_dir.file_type().map(|kind| kind.is_dir()).unwrap_or(false) { continue }
        let id = model_dir.file_name().to_string_lossy().to_string();
        if !safe_model_identity_segment(&id) || id.starts_with('.') { continue }
        let Ok(versions) = std::fs::read_dir(model_dir.path()) else { continue };
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
            let kind = if decensor::bundle_in(&root).is_some() { MODEL_KIND_DECENSOR } else { MODEL_KIND_UPSCALE };
            found.push(InstalledModel { id: id.clone(), version, scale, kind: kind.to_string() });
        }
    }
    found.sort_by(|left, right| left.id.cmp(&right.id));
    found
}

/// Newest installed version of `model_id` that is actually runnable: it has a
/// manifest (so a scale) and exactly one ONNX file.
fn resolve_installed_model(
    app_data_dir: &std::path::Path,
    model_id: &str,
) -> Option<(std::path::PathBuf, ModelManifest)> {
    installed_models_in(app_data_dir)
        .into_iter()
        .filter(|model| model.id == model_id)
        .find_map(|model| {
            let root = app_data_dir.join("models").join(&model.id).join(&model.version);
            let manifest = read_model_manifest(&root)?;
            model_file_in(&root).map(|path| (path, manifest))
        })
}

/// Lets the settings page offer the models that are actually installed instead
/// of asking the user to type a model name and hope.
#[tauri::command]
pub fn inference_list_models(app: tauri::AppHandle) -> crate::domain::result::CommandResult<Vec<InstalledModel>> {
    use tauri::Manager;
    match app.path().app_data_dir() {
        Ok(app_data_dir) => crate::domain::result::CommandResult::success(installed_models_in(&app_data_dir)),
        Err(error) => crate::domain::result::CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), false),
    }
}

/// Installs a de-censoring bundle by copying one out of an existing Aletheia-Lens
/// directory, since it is far too large to hand over as bytes. See
/// `decensor::install_bundle_from` for why.
#[tauri::command]
pub fn inference_install_decensor_bundle(
    app: tauri::AppHandle,
    source_dir: String,
    version: Option<String>,
) -> crate::domain::result::CommandResult<InstalledModel> {
    use tauri::Manager;
    const BUNDLE_ID: &str = "aletheia-lens";
    let version = version.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "1".to_string());
    let result = app.path().app_data_dir()
        .map_err(|error| InferenceError::InvalidInput(error.to_string()))
        .and_then(|app_data_dir| {
            let (staging, install) = model_install_roots(&app_data_dir, BUNDLE_ID, &version)?;
            decensor::install_bundle_from(std::path::Path::new(&source_dir), &staging, &install)?;
            Ok(install)
        });
    match result {
        Ok(install) => crate::domain::result::CommandResult::success(InstalledModel {
            id: BUNDLE_ID.to_string(),
            version,
            // A bundle has four ONNX files and no single scale of its own.
            scale: None,
            kind: if decensor::bundle_in(&install).is_some() { MODEL_KIND_DECENSOR } else { MODEL_KIND_UPSCALE }.to_string(),
        }),
        Err(InferenceError::InvalidInput(message)) | Err(InferenceError::InvalidManifest(message)) => {
            crate::domain::result::CommandResult::failure("INVALID_RESPONSE", message, false)
        }
        Err(error) => crate::domain::result::CommandResult::failure("UNKNOWN", format!("{error:?}"), true),
    }
}

#[tauri::command]
pub fn inference_install_model(
    app: tauri::AppHandle,
    input: ModelInstallInput,
) -> crate::domain::result::CommandResult<InstalledModel> {
    use tauri::Manager;

    let result = app.path().app_data_dir()
        .map_err(|error| InferenceError::InvalidInput(error.to_string()))
        .and_then(|app_data_dir| {
            let (staging, install) = model_install_roots(
                &app_data_dir,
                &input.manifest.id,
                &input.manifest.version,
            )?;
            install_model_archive(&input.archive, &input.manifest, &staging, &install)
        });

    match result {
        Ok(install) => crate::domain::result::CommandResult::success(InstalledModel {
            id: input.manifest.id,
            version: input.manifest.version,
            scale: Some(input.manifest.scale),
            kind: if decensor::bundle_in(&install).is_some() { MODEL_KIND_DECENSOR } else { MODEL_KIND_UPSCALE }.to_string(),
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
    }
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceCacheClearResult { pub entries_cleared: usize }

pub fn clear_inference_cache(
    connection: &rusqlite::Connection,
    cache_root: &std::path::Path,
) -> Result<InferenceCacheClearResult, InferenceError> {
    let is_controlled_root = cache_root.is_absolute()
        && cache_root.file_name() == Some(std::ffi::OsStr::new("inference"))
        && cache_root.parent().and_then(std::path::Path::file_name)
            == Some(std::ffi::OsStr::new("cache"));
    if !is_controlled_root {
        return Err(InferenceError::InvalidInput("invalid inference cache root".into()));
    }
    let active_jobs: i64 = connection.query_row(
        "SELECT COUNT(*) FROM inference_jobs WHERE status IN ('queued','running','paused')",
        [],
        |row| row.get(0),
    ).map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
    if active_jobs > 0 {
        return Err(InferenceError::CacheBusy);
    }

    let clearing_root = cache_root.with_file_name(".inference-clearing");
    if clearing_root.exists() {
        return Err(InferenceError::InvalidInput("inference cache cleanup is already pending".into()));
    }
    let moved = cache_root.exists();
    if moved {
        std::fs::rename(cache_root, &clearing_root)
            .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
    }
    let deleted = match connection.execute("DELETE FROM cache_entries WHERE kind='inference'", []) {
        Ok(value) => value,
        Err(error) => {
            if moved { let _ = std::fs::rename(&clearing_root, cache_root); }
            return Err(InferenceError::InvalidInput(error.to_string()));
        }
    };
    if moved {
        std::fs::remove_dir_all(&clearing_root)
            .map_err(|error| InferenceError::InvalidInput(error.to_string()))?;
    }
    Ok(InferenceCacheClearResult { entries_cleared: deleted })
}

#[tauri::command]
pub fn inference_clear_cache(
    app: tauri::AppHandle,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<InferenceCacheClearResult> {
    use tauri::Manager;

    let app_data_dir = match app.path().app_data_dir() {
        Ok(value) => value,
        Err(error) => return crate::domain::result::CommandResult::failure(
            "PLATFORM_UNAVAILABLE", error.to_string(), true,
        ),
    };
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return crate::domain::result::CommandResult::failure(
            "UNKNOWN", "Database lock failed", true,
        ),
    };
    match clear_inference_cache(&connection, &app_data_dir.join("cache").join("inference")) {
        Ok(value) => crate::domain::result::CommandResult::success(value),
        Err(InferenceError::CacheBusy) => crate::domain::result::CommandResult::failure(
            "INFERENCE_UNAVAILABLE", "Inference cache is in use", true,
        ),
        Err(_) => crate::domain::result::CommandResult::failure(
            "UNKNOWN", "Inference cache cleanup failed", true,
        ),
    }
}

/// Picks the most preferred backend that the model supports and the device has
/// not blacklisted. Falls back to CPU, which every build can run.
pub fn select_backend(supported: &[String], blacklist: &[String]) -> BackendId {
    let allowed = |backend: BackendId| {
        let name = backend.as_str();
        supported.iter().any(|value| value.eq_ignore_ascii_case(name))
            && !blacklist.iter().any(|value| value.eq_ignore_ascii_case(name))
    };
    platform_backend_preference()
        .into_iter()
        .find(|backend| allowed(*backend))
        .unwrap_or(BackendId::Cpu)
}

#[derive(Debug, PartialEq, Eq)]
pub struct CpuRgbaOutput {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

impl serde::Serialize for CpuRgbaOutput {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: serde::Serializer {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("CpuRgbaOutput", 3)?;
        state.serialize_field("rgba", &self.rgba)?;
        state.serialize_field("width", &self.width)?;
        state.serialize_field("height", &self.height)?;
        state.end()
    }
}

/// Upscales one cached reader page and stores the result as the `enhanced`
/// rendition, keyed by the model version so a model change does not serve a
/// stale image.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscalePageInput {
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    #[serde(default)]
    pub scale: Option<u32>,
    /// Installed model to run, by id. Absent (or not installed) falls back to the
    /// nearest-neighbour scaler, which is honest about being model-free rather
    /// than failing the page.
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub tile_size: Option<u32>,
    #[serde(default)]
    pub tile_sleep_ms: Option<u64>,
    /// When set, the upscaler reads this page's de-censored rendition instead of
    /// the plain one, so the two pipelines chain in the order that matters: fill
    /// the censored regions at the original scale — which is what the detector and
    /// the inpainter were trained on — and enlarge the finished page afterwards.
    /// Upscaling first would hand the inpainter interpolated pixels and smeared
    /// mosaic blocks.
    #[serde(default)]
    pub decensor_model: Option<String>,
}

#[tauri::command]
pub fn inference_upscale_page(
    input: UpscalePageInput,
    database: tauri::State<'_, crate::db::Database>,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    use tauri::Manager;
    let app_data = match app.path().app_data_dir() {
        Ok(value) => value,
        Err(error) => return Ok(crate::domain::result::into_binary_response(
            crate::domain::result::CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), true),
        )),
    };
    let result = upscale_cached_page(&database, &app_data, &input);
    Ok(crate::domain::result::into_binary_response(result))
}

fn upscale_cached_page(
    database: &crate::db::Database,
    app_data: &std::path::Path,
    input: &UpscalePageInput,
) -> crate::domain::result::CommandResult<Vec<u8>> {
    use crate::cache::{CacheImageIdentity, load_image_cache, store_image_cache};
    use crate::domain::result::CommandResult;

    if input.page_index < 0 {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid page index", false);
    }
    // A model's scale is fixed by the model, so it wins over the requested one.
    // Only the model-free path is free to honour the request.
    let model = input
        .model_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| resolve_installed_model(app_data, id));
    let scale = match &model {
        Some((_, manifest)) => manifest.scale.clamp(1, 4),
        None => input.scale.unwrap_or(2).clamp(1, 4),
    };
    // The revision keys the cache: switching model, version or scale has to miss
    // rather than serve the previous model's output. So does chaining onto the
    // de-censored page, which is a different input entirely.
    let decensor = input
        .decensor_model
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| resolve_installed_bundle(app_data, id))
        .map(|(_, manifest)| format!("{}@{}", manifest.id, manifest.version));
    let revision = match &model {
        Some((_, manifest)) => format!("x{scale}:{}@{}", manifest.id, manifest.version),
        None => format!("x{scale}:nearest"),
    };
    let revision = match &decensor {
        Some(bundle) => format!("{revision}+dc:{bundle}"),
        None => revision,
    };
    let mut enhanced = CacheImageIdentity::new(&input.scope_id, &input.archive_id, "enhanced", input.page_index);
    enhanced.revision = Some(revision);
    // Chaining reads the de-censored rendition as the source. Its revision has to
    // match what the de-censoring command wrote, or this looks for an entry that
    // does not exist.
    let source = match &decensor {
        Some(bundle) => {
            let mut identity = CacheImageIdentity::new(&input.scope_id, &input.archive_id, "decensored", input.page_index);
            identity.revision = Some(bundle.clone());
            identity
        }
        None => CacheImageIdentity::new(&input.scope_id, &input.archive_id, "reader-page", input.page_index),
    };

    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match load_image_cache(&connection, app_data, &enhanced) {
        Ok(Some(image)) => return CommandResult::success(image.bytes),
        Ok(None) => {}
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    }
    let page = match load_image_cache(&connection, app_data, &source) {
        Ok(Some(image)) => image,
        // Retryable on purpose: when chaining, the de-censored page may still be
        // being produced, and the caller asks again once it lands.
        Ok(None) => return CommandResult::failure("LRR_NOT_FOUND", "Page is not cached yet", true),
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };

    let decoded = match image::load_from_memory(&page.bytes) {
        Ok(value) => value.to_rgba8(),
        Err(error) => return CommandResult::failure("INVALID_RESPONSE", error.to_string(), false),
    };
    let (width, height) = (decoded.width(), decoded.height());
    let max_pixels = model.as_ref().map_or(64_000_000, |(_, manifest)| manifest.max_pixels);
    // An installed model that will not load is reported, not silently swapped for
    // the nearest-neighbour scaler: the user chose a model and would otherwise
    // see a blurry page with no explanation.
    let onnx = match &model {
        Some((path, manifest)) => match onnx::OnnxEngine::open(path, manifest.scale, max_pixels) {
            Ok(engine) => Some(engine),
            Err(error) => return CommandResult::failure("INFERENCE_UNAVAILABLE", format!("{error:?}"), false),
        },
        None => None,
    };
    let fallback = upscale::NearestNeighbourEngine { scale, max_pixels };
    let engine: &dyn upscale::UpscaleEngine = match &onnx {
        Some(engine) => engine,
        None => &fallback,
    };
    let options = upscale::UpscaleOptions {
        tile_size: input.tile_size.unwrap_or(upscale::DEFAULT_TILE_SIZE).max(16),
        tile_sleep_ms: input.tile_sleep_ms.unwrap_or(0),
        max_pixels,
        ..upscale::UpscaleOptions::default()
    };
    let upscaled = match upscale::upscale_rgba(engine, decoded.as_raw(), width, height, options) {
        Ok(value) => value,
        Err(InferenceError::PixelBudgetExceeded { pixels, max_pixels }) => {
            return CommandResult::failure("INFERENCE_UNAVAILABLE", format!("Image pixel budget exceeded: {pixels} > {max_pixels}"), false)
        }
        Err(error) => return CommandResult::failure("INVALID_RESPONSE", format!("{error:?}"), false),
    };

    // Served at twice the page, whatever the model's own factor is. A x4 model
    // produces sixteen times the pixels of the page — a 1400x2000 scan becomes
    // 5600x8000, which is 45 MB of RGBA to encode, cache, decode and then draw
    // into a slot a fraction of that size. Two is the point where the detail is
    // visible and the cost is not.
    let (final_rgba, final_width, final_height) = fit_enhanced_output(
        &upscaled.rgba,
        upscaled.width,
        upscaled.height,
        width,
        height,
    );

    let mut encoded = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut encoded);
    {
        use image::ImageEncoder;
        if let Err(error) = encoder.write_image(&final_rgba, final_width, final_height, image::ExtendedColorType::Rgba8) {
            return CommandResult::failure("UNKNOWN", error.to_string(), true);
        }
    }
    if let Err(error) = store_image_cache(&connection, app_data, &enhanced, "image/png", &encoded) {
        // Serving the image still works without a cache entry.
        eprintln!("yomika: enhanced image cache write failed: {error}");
    }
    CommandResult::success(encoded)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecensorPageInput {
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    /// The installed de-censoring bundle to run.
    pub model_id: String,
}

#[tauri::command]
pub fn inference_decensor_page(
    input: DecensorPageInput,
    database: tauri::State<'_, crate::db::Database>,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    use tauri::Manager;
    let app_data = match app.path().app_data_dir() {
        Ok(value) => value,
        Err(error) => return Ok(crate::domain::result::into_binary_response(
            crate::domain::result::CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), true),
        )),
    };
    let result = decensor_cached_page(&database, &app_data, &input);
    Ok(crate::domain::result::into_binary_response(result))
}

/// The newest installed version of `model_id` that is a complete de-censoring
/// bundle, with its manifest for the cache revision.
fn resolve_installed_bundle(
    app_data_dir: &std::path::Path,
    model_id: &str,
) -> Option<(decensor::DecensorBundle, ModelManifest)> {
    installed_models_in(app_data_dir)
        .into_iter()
        .filter(|model| model.id == model_id && model.kind == MODEL_KIND_DECENSOR)
        .find_map(|model| {
            let root = app_data_dir.join("models").join(&model.id).join(&model.version);
            let manifest = read_model_manifest(&root)?;
            decensor::bundle_in(&root).map(|bundle| (bundle, manifest))
        })
}

fn decensor_cached_page(
    database: &crate::db::Database,
    app_data: &std::path::Path,
    input: &DecensorPageInput,
) -> crate::domain::result::CommandResult<Vec<u8>> {
    use crate::cache::{load_image_cache, store_image_cache, CacheImageIdentity};
    use crate::domain::result::CommandResult;

    if input.page_index < 0 {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid page index", false);
    }
    let Some((bundle, manifest)) = resolve_installed_bundle(app_data, &input.model_id) else {
        return CommandResult::failure(
            "INFERENCE_UNAVAILABLE",
            "No complete de-censoring bundle is installed under that id",
            false,
        );
    };
    // Keyed on the bundle version: a newer bundle has to miss rather than serve the
    // previous one's output.
    let mut decensored = CacheImageIdentity::new(&input.scope_id, &input.archive_id, "decensored", input.page_index);
    decensored.revision = Some(format!("{}@{}", manifest.id, manifest.version));
    let source = CacheImageIdentity::new(&input.scope_id, &input.archive_id, "reader-page", input.page_index);

    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    match load_image_cache(&connection, app_data, &decensored) {
        Ok(Some(image)) => return CommandResult::success(image.bytes),
        Ok(None) => {}
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    }
    let page = match load_image_cache(&connection, app_data, &source) {
        Ok(Some(image)) => image,
        Ok(None) => return CommandResult::failure("LRR_NOT_FOUND", "Page is not cached yet", true),
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let decoded = match image::load_from_memory(&page.bytes) {
        Ok(value) => value.to_rgba8(),
        Err(error) => return CommandResult::failure("INVALID_RESPONSE", error.to_string(), false),
    };
    let (width, height) = (decoded.width(), decoded.height());
    let mut rgba = decoded.into_raw();
    let engines = match decensor_engines_for(&bundle) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("INFERENCE_UNAVAILABLE", format!("{error:?}"), false),
    };
    if let Err(error) = decensor::decensor_page(&engines, &mut rgba, width, height) {
        return CommandResult::failure("INFERENCE_UNAVAILABLE", format!("{error:?}"), false);
    }

    let mut encoded = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut encoded);
        if let Err(error) = encoder.write_image(&rgba, width, height, image::ExtendedColorType::Rgba8) {
            return CommandResult::failure("UNKNOWN", error.to_string(), true);
        }
    }
    // A page with nothing censored is cached unchanged on purpose: detection is the
    // expensive half, and re-running it on every view would cost seconds to reach
    // the same answer.
    if let Err(error) = store_image_cache(&connection, app_data, &decensored, "image/png", &encoded) {
        // Serving the image still works without a cache entry.
        eprintln!("yomika: de-censored image cache write failed: {error}");
    }
    CommandResult::success(encoded)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuScaleInput {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub scale: u32,
    pub max_pixels: usize,
}

#[tauri::command]
pub fn inference_cpu_scale(input: CpuScaleInput) -> crate::domain::result::CommandResult<CpuRgbaOutput> {
    match cpu_scale_rgba(&input.rgba, input.width, input.height, input.scale, input.max_pixels) {
        Ok(output) => crate::domain::result::CommandResult::success(output),
        Err(InferenceError::InvalidInput(message)) => crate::domain::result::CommandResult::failure("INVALID_RESPONSE", message, false),
        Err(InferenceError::PixelBudgetExceeded { pixels, max_pixels }) => crate::domain::result::CommandResult::failure("INFERENCE_UNAVAILABLE", format!("Image pixel budget exceeded: {pixels} > {max_pixels}"), false),
        Err(InferenceError::InvalidManifest(message)) => crate::domain::result::CommandResult::failure("INVALID_RESPONSE", message, false),
        Err(InferenceError::CacheBusy) => crate::domain::result::CommandResult::failure("INFERENCE_UNAVAILABLE", "Inference cache is in use", true),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceStartInput { pub id: String, pub source_scope: String, pub source_id: String, pub model_id: String, pub model_version: String, pub input_hashes: Vec<String> }

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceJob { pub id: String, pub status: String, pub item_count: usize, pub completed_count: usize }

fn load_job(connection: &rusqlite::Connection, id: &str) -> Result<InferenceJob, String> {
    connection.query_row("SELECT j.id,j.status,COUNT(i.item_index),COALESCE(SUM(CASE WHEN i.status='completed' THEN 1 ELSE 0 END),0) FROM inference_jobs j LEFT JOIN inference_items i ON i.job_id=j.id WHERE j.id=?1 GROUP BY j.id,j.status", rusqlite::params![id], |row| Ok(InferenceJob { id: row.get(0)?, status: row.get(1)?, item_count: row.get::<_, i64>(2)? as usize, completed_count: row.get::<_, i64>(3)? as usize })).map_err(|e| e.to_string())
}

fn start_job(connection: &mut rusqlite::Connection, input: InferenceStartInput) -> Result<InferenceJob, String> {
    if input.id.trim().is_empty() || input.source_scope.trim().is_empty() || input.input_hashes.is_empty() || input.input_hashes.iter().any(|hash| hash.trim().is_empty()) { return Err("Invalid inference job".to_string()); }
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction.execute("INSERT INTO inference_jobs (id,source_scope,source_id,model_id,model_version,status) VALUES (?1,?2,?3,?4,?5,'queued') ON CONFLICT(id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP", rusqlite::params![input.id,input.source_scope,input.source_id,input.model_id,input.model_version]).map_err(|e| e.to_string())?;
    for (index, hash) in input.input_hashes.iter().enumerate() { transaction.execute("INSERT OR IGNORE INTO inference_items (job_id,item_index,input_hash,status) VALUES (?1,?2,?3,'pending')", rusqlite::params![input.id,index as i64,hash]).map_err(|e| e.to_string())?; }
    let job = load_job(&transaction, &input.id)?; transaction.commit().map_err(|e| e.to_string())?; Ok(job)
}

fn checkpoint_item(connection: &rusqlite::Connection, job_id: &str, item_index: i64, completed_tile: i64, status: &str, output_path: Option<&str>) -> Result<(), String> {
    if completed_tile < 0 || !matches!(status, "pending" | "running" | "completed" | "failed" | "cancelled") {
        return Err("Invalid inference checkpoint".to_string());
    }
    if status == "completed" && output_path.is_none() { return Err("Completed inference item requires output".to_string()); }
    let changed = connection.execute("UPDATE inference_items SET completed_tile=MAX(completed_tile,?1),status=?2,output_path=COALESCE(?3,output_path),updated_at=CURRENT_TIMESTAMP WHERE job_id=?4 AND item_index=?5 AND status!='completed'", rusqlite::params![completed_tile,status,output_path,job_id,item_index]).map_err(|e| e.to_string())?;
    if changed == 0 { return Err("Inference item not found or already completed".to_string()); }
    if status == "completed" {
        connection.execute("UPDATE inference_jobs SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM inference_items WHERE job_id=?1 AND status!='completed') THEN 'completed' ELSE 'running' END,updated_at=CURRENT_TIMESTAMP WHERE id=?1", rusqlite::params![job_id]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

fn transition_job(connection: &rusqlite::Connection, job_id: &str, target: &str) -> Result<InferenceJob, String> {
    if !matches!(target, "paused" | "running" | "completed") {
        return Err("Invalid inference job transition".to_string());
    }
    let current: String = connection.query_row("SELECT status FROM inference_jobs WHERE id=?1", rusqlite::params![job_id], |row| row.get(0)).map_err(|e| e.to_string())?;
    let allowed = match (current.as_str(), target) {
        ("queued", "running") | ("queued", "paused") | ("running", "paused") | ("paused", "running") => true,
        ("running", "completed") => {
            let pending: i64 = connection.query_row("SELECT COUNT(*) FROM inference_items WHERE job_id=?1 AND status!='completed'", rusqlite::params![job_id], |row| row.get(0)).map_err(|e| e.to_string())?;
            pending == 0
        }
        _ => false,
    };
    if !allowed { return Err("Inference job transition not allowed".to_string()); }
    connection.execute("UPDATE inference_jobs SET status=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2", rusqlite::params![target, job_id]).map_err(|e| e.to_string())?;
    if target == "running" {
        connection.execute("UPDATE inference_items SET status='pending',updated_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND status='running'", rusqlite::params![job_id]).map_err(|e| e.to_string())?;
    }
    load_job(connection, job_id)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceCheckpointInput { pub job_id: String, pub item_index: i64, pub completed_tile: i64, pub status: String, pub output_path: Option<String> }

#[tauri::command]
pub fn inference_checkpoint(input: InferenceCheckpointInput, database: tauri::State<'_, crate::db::Database>) -> crate::domain::result::CommandResult<()> {
    let connection=match database.connection.lock(){Ok(value)=>value,Err(_)=>return crate::domain::result::CommandResult::failure("UNKNOWN","Database lock failed",true)};
    match checkpoint_item(&connection,&input.job_id,input.item_index,input.completed_tile,&input.status,input.output_path.as_deref()) { Ok(())=>crate::domain::result::CommandResult::success(()),Err(error)=>crate::domain::result::CommandResult::failure("INVALID_RESPONSE",error,false) }
}

fn transition_command(job_id: String, target: &str, database: tauri::State<'_, crate::db::Database>) -> crate::domain::result::CommandResult<InferenceJob> {
    let connection = match database.connection.lock() { Ok(value) => value, Err(_) => return crate::domain::result::CommandResult::failure("UNKNOWN", "Database lock failed", true) };
    match transition_job(&connection, &job_id, target) { Ok(value) => crate::domain::result::CommandResult::success(value), Err(error) => crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false) }
}

#[tauri::command]
pub fn inference_pause(id: String, database: tauri::State<'_, crate::db::Database>) -> crate::domain::result::CommandResult<InferenceJob> { transition_command(id, "paused", database) }

#[tauri::command]
pub fn inference_resume(id: String, database: tauri::State<'_, crate::db::Database>) -> crate::domain::result::CommandResult<InferenceJob> { transition_command(id, "running", database) }

#[tauri::command]
pub fn inference_start(input: InferenceStartInput, database: tauri::State<'_, crate::db::Database>) -> crate::domain::result::CommandResult<InferenceJob> { let mut connection=match database.connection.lock(){Ok(value)=>value,Err(_)=>return crate::domain::result::CommandResult::failure("UNKNOWN","Database lock failed",true)}; match start_job(&mut connection,input){Ok(value)=>crate::domain::result::CommandResult::success(value),Err(error)=>crate::domain::result::CommandResult::failure("INVALID_RESPONSE",error,false)} }

#[tauri::command]
pub fn inference_get_job(id: String, database: tauri::State<'_, crate::db::Database>) -> crate::domain::result::CommandResult<InferenceJob> { let connection=match database.connection.lock(){Ok(value)=>value,Err(_)=>return crate::domain::result::CommandResult::failure("UNKNOWN","Database lock failed",true)}; match load_job(&connection,&id){Ok(value)=>crate::domain::result::CommandResult::success(value),Err(error)=>crate::domain::result::CommandResult::failure("LRR_NOT_FOUND",error,false)} }

#[tauri::command]
pub fn inference_cancel(id: String, database: tauri::State<'_, crate::db::Database>) -> crate::domain::result::CommandResult<InferenceJob> { let connection=match database.connection.lock(){Ok(value)=>value,Err(_)=>return crate::domain::result::CommandResult::failure("UNKNOWN","Database lock failed",true)}; let result=(||{connection.execute("UPDATE inference_jobs SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status NOT IN ('completed','cancelled')",rusqlite::params![id]).map_err(|e|e.to_string())?;connection.execute("UPDATE inference_items SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND status NOT IN ('completed','cancelled')",rusqlite::params![id]).map_err(|e|e.to_string())?;load_job(&connection,&id)})();match result{Ok(value)=>crate::domain::result::CommandResult::success(value),Err(error)=>crate::domain::result::CommandResult::failure("UNKNOWN",error,true)} }

pub fn cpu_scale_rgba(
    source: &[u8],
    width: u32,
    height: u32,
    scale: u32,
    max_pixels: usize,
) -> Result<CpuRgbaOutput, InferenceError> {
    if width == 0 || height == 0 || scale == 0 || source.len() != width as usize * height as usize * 4 {
        return Err(InferenceError::InvalidInput("RGBA buffer dimensions do not match".to_string()));
    }
    let output_width = width.checked_mul(scale).ok_or_else(|| InferenceError::PixelBudgetExceeded { pixels: usize::MAX, max_pixels })?;
    let output_height = height.checked_mul(scale).ok_or_else(|| InferenceError::PixelBudgetExceeded { pixels: usize::MAX, max_pixels })?;
    let pixels = output_width as usize * output_height as usize;
    if pixels > max_pixels {
        return Err(InferenceError::PixelBudgetExceeded { pixels, max_pixels });
    }
    let mut rgba = vec![0_u8; pixels * 4];
    for y in 0..output_height {
        for x in 0..output_width {
            let source_index = ((y / scale) as usize * width as usize + (x / scale) as usize) * 4;
            let target_index = (y as usize * output_width as usize + x as usize) * 4;
            rgba[target_index..target_index + 4].copy_from_slice(&source[source_index..source_index + 4]);
        }
    }
    Ok(CpuRgbaOutput { rgba, width: output_width, height: output_height })
}

#[cfg(test)]
mod tests {

    #[test]
    fn an_enhanced_page_is_served_at_twice_the_source() {
        // The installed models are x4, which is sixteen times the pixels of the
        // page: a 1400x2000 scan would be encoded, cached and decoded at
        // 5600x8000 to be drawn into a slot a fraction of that. Two keeps the
        // detail and drops three quarters of the bytes.
        let source = (10_u32, 8_u32);
        let quadrupled = vec![0_u8; (source.0 * 4) as usize * (source.1 * 4) as usize * 4];
        let (rgba, width, height) = fit_enhanced_output(&quadrupled, source.0 * 4, source.1 * 4, source.0, source.1);
        assert_eq!((width, height), (source.0 * 2, source.1 * 2));
        assert_eq!(rgba.len(), (width * height * 4) as usize);

        // Already at or below the target: handed back untouched rather than
        // resampled for nothing.
        let doubled = vec![7_u8; (source.0 * 2) as usize * (source.1 * 2) as usize * 4];
        let (same, w, h) = fit_enhanced_output(&doubled, source.0 * 2, source.1 * 2, source.0, source.1);
        assert_eq!((w, h), (source.0 * 2, source.1 * 2));
        assert!(matches!(same, std::borrow::Cow::Borrowed(_)));
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
        assert_eq!(
            capabilities.hardware_acceleration,
            platform_backend_preference().iter().any(|backend| backend.is_hardware_accelerated()),
        );
        if cfg!(target_os = "windows") {
            assert_eq!(capabilities.backends.first().map(String::as_str), Some("directml"));
        }
    }

    #[test]
    fn chaining_reads_the_de_censored_page_rather_than_the_plain_one() {
        // The order matters and only one order is right: the detector and the
        // inpainter were trained at page scale, so the regions are filled first and
        // the finished page is what gets enlarged. This proves the chain by leaving
        // the plain rendition out of the cache entirely — an upscaler that still
        // read `reader-page` could not produce anything at all.
        use crate::cache::{store_image_cache, CacheImageIdentity};
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        for migration in [
            include_str!("../migrations/0001_initial.sql"),
            include_str!("../migrations/0002_local_library.sql"),
            include_str!("../migrations/0010_cache_path_sharing.sql"),
            include_str!("../migrations/0013_unified_image_cache.sql"),
            include_str!("../migrations/0014_cache_archive_scope.sql"),
        ] {
            connection.execute_batch(migration).unwrap();
        }
        let app_data = std::env::temp_dir().join(format!("yomika-chain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&app_data);
        // An installed bundle: the four files are what makes a directory a bundle,
        // and none of them is opened on this path.
        let install = app_data.join("models").join("aletheia").join("1");
        for (directory, file) in [
            ("mrcnn", "weights.onnx"),
            ("deepcreampy", "bar.onnx"),
            ("deepcreampy", "mosaic.onnx"),
            ("esrgan", "4x-Fatal-Pixels.onnx"),
        ] {
            std::fs::create_dir_all(install.join(directory)).unwrap();
            std::fs::write(install.join(directory).join(file), b"stub").unwrap();
        }
        let manifest = ModelManifest { id: "aletheia".into(), version: "1".into(), ..model_manifest(b"x") };
        std::fs::write(install.join(MODEL_MANIFEST_FILE), serde_json::to_vec(&manifest).unwrap()).unwrap();

        let mut page = Vec::new();
        {
            use image::ImageEncoder;
            let rgba = vec![9_u8, 9, 9, 255, 9, 9, 9, 255, 9, 9, 9, 255, 9, 9, 9, 255];
            image::codecs::png::PngEncoder::new(&mut page)
                .write_image(&rgba, 2, 2, image::ExtendedColorType::Rgba8)
                .unwrap();
        }
        // Only the de-censored rendition exists, under the revision the de-censoring
        // command writes.
        let mut decensored = CacheImageIdentity::new("scope-a", "archive-a", "decensored", 0);
        decensored.revision = Some("aletheia@1".to_string());
        store_image_cache(&connection, &app_data, &decensored, "image/png", &page).unwrap();

        let database = crate::db::Database { connection: std::sync::Mutex::new(connection) };
        let chained = upscale_cached_page(&database, &app_data, &UpscalePageInput {
            scope_id: "scope-a".into(), archive_id: "archive-a".into(), page_index: 0,
            scale: Some(2), model_id: None, tile_size: None, tile_sleep_ms: None,
            decensor_model: Some("aletheia".into()),
        });
        let bytes = match chained {
            crate::domain::result::CommandResult::Success { value, .. } => value,
            other => panic!("chaining did not read the de-censored page: {other:?}"),
        };
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 4);

        // Without the bundle it looks for the plain page, which is not there.
        let unchained = upscale_cached_page(&database, &app_data, &UpscalePageInput {
            scope_id: "scope-a".into(), archive_id: "archive-a".into(), page_index: 0,
            scale: Some(2), model_id: None, tile_size: None, tile_sleep_ms: None, decensor_model: None,
        });
        assert!(
            matches!(unchained, crate::domain::result::CommandResult::Failure { .. }),
            "the unchained path must read the plain rendition, which this test never cached",
        );
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn upscaling_a_cached_page_reuses_the_enhanced_rendition() {
        use crate::cache::{CacheImageIdentity, load_image_cache, store_image_cache};
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        for migration in [
            include_str!("../migrations/0001_initial.sql"),
            include_str!("../migrations/0002_local_library.sql"),
            include_str!("../migrations/0010_cache_path_sharing.sql"),
            include_str!("../migrations/0013_unified_image_cache.sql"),
            include_str!("../migrations/0014_cache_archive_scope.sql"),
        ] {
            connection.execute_batch(migration).unwrap();
        }
        let app_data = std::env::temp_dir().join(format!("yomika-upscale-{}", std::process::id()));
        std::fs::create_dir_all(&app_data).unwrap();

        // A tiny red PNG stands in for a cached reader page.
        let mut page = Vec::new();
        {
            use image::ImageEncoder;
            let rgba = vec![255_u8, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255];
            image::codecs::png::PngEncoder::new(&mut page)
                .write_image(&rgba, 2, 2, image::ExtendedColorType::Rgba8)
                .unwrap();
        }
        let source = CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 0);
        store_image_cache(&connection, &app_data, &source, "image/png", &page).unwrap();

        let database = crate::db::Database { connection: std::sync::Mutex::new(connection) };
        let input = UpscalePageInput {
            scope_id: "scope-a".into(), archive_id: "archive-a".into(), page_index: 0,
            scale: Some(2), model_id: None, tile_size: None, tile_sleep_ms: None, decensor_model: None,
        };

        let first = match upscale_cached_page(&database, &app_data, &input) {
            crate::domain::result::CommandResult::Success { value, .. } => value,
            other => panic!("expected success, got {other:?}"),
        };
        let decoded = image::load_from_memory(&first).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (4, 4), "a 2x model doubles both axes");

        // The result is cached under the enhanced rendition, keyed by scale and
        // by which engine produced it — a later model must not be served this.
        let mut enhanced = CacheImageIdentity::new("scope-a", "archive-a", "enhanced", 0);
        enhanced.revision = Some("x2:nearest".into());
        let connection = database.connection.lock().unwrap();
        assert!(load_image_cache(&connection, &app_data, &enhanced).unwrap().is_some());
        drop(connection);

        let second = match upscale_cached_page(&database, &app_data, &input) {
            crate::domain::result::CommandResult::Success { value, .. } => value,
            other => panic!("expected cache hit, got {other:?}"),
        };
        assert_eq!(first, second);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn upscaling_reports_a_page_that_is_not_cached_yet() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        for migration in [
            include_str!("../migrations/0001_initial.sql"),
            include_str!("../migrations/0002_local_library.sql"),
            include_str!("../migrations/0010_cache_path_sharing.sql"),
            include_str!("../migrations/0013_unified_image_cache.sql"),
            include_str!("../migrations/0014_cache_archive_scope.sql"),
        ] {
            connection.execute_batch(migration).unwrap();
        }
        let app_data = std::env::temp_dir().join(format!("yomika-upscale-missing-{}", std::process::id()));
        std::fs::create_dir_all(&app_data).unwrap();
        let database = crate::db::Database { connection: std::sync::Mutex::new(connection) };

        let result = upscale_cached_page(&database, &app_data, &UpscalePageInput {
            scope_id: "scope-a".into(), archive_id: "archive-a".into(), page_index: 0,
            scale: None, model_id: None, tile_size: None, tile_sleep_ms: None, decensor_model: None,
        });

        assert!(matches!(result, crate::domain::result::CommandResult::Failure { .. }));
        std::fs::remove_dir_all(app_data).unwrap();
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
            .join("../docs/models/realesr-general-x4v3.onnx");
        if !source.exists() {
            eprintln!("skipping: {} is not present", source.display());
            return;
        }
        let model_bytes = std::fs::read(&source).expect("read the downloaded model");

        let base = std::env::temp_dir().join("yomika-install-real-model");
        let _ = std::fs::remove_dir_all(&base);
        let (staging, install) = model_install_roots(&base, "realesr-general-x4v3", "2026.09.04")
            .expect("install roots");

        let mut manifest = model_manifest(&model_bytes);
        manifest.id = "realesr-general-x4v3".into();
        manifest.version = "2026.09.04".into();
        manifest.scale = 4;
        install_model_archive(&model_zip(&[("model.onnx", &model_bytes)]), &manifest, &staging, &install)
            .expect("install the downloaded model");

        let (path, resolved) = resolve_installed_model(&base, "realesr-general-x4v3")
            .expect("resolve the installed model");
        assert_eq!(path, install.join("model.onnx"));
        assert_eq!(resolved, manifest, "the manifest must survive installation verbatim");

        let engine = onnx::OnnxEngine::open(&path, resolved.scale, resolved.max_pixels)
            .expect("open the installed model");
        let rgba = vec![128_u8; 8 * 8 * 4];
        let output = upscale::UpscaleEngine::upscale_tile(&engine, &rgba, 8, 8)
            .expect("upscale a tile with the installed model");
        assert_eq!(output.len(), 32 * 32 * 4, "a x4 model turns 8x8 into 32x32");
        std::fs::remove_dir_all(base).unwrap();
    }

    fn model_manifest(bytes: &[u8]) -> ModelManifest {
        use sha2::{Digest, Sha256};
        let sha256 = Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect();
        ModelManifest {
            id: "waifu".into(),
            version: "1".into(),
            format: "onnx".into(),
            scale: 2,
            max_pixels: 64_000_000,
            sha256,
            supported_backends: vec!["cpu".into()],
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

    fn install_test_roots(name: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("yomika-{name}-{}-{nonce}", std::process::id()));
        (base.join(".staging"), base.join("model"), base)
    }

    #[test]
    fn cpu_fallback_scales_rgba_pixels_and_preserves_corners() {
        let source = vec![
            255, 0, 0, 255, 0, 255, 0, 255,
            0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let output = cpu_scale_rgba(&source, 2, 2, 2, 64).expect("scaled image");
        assert_eq!(output.width, 4);
        assert_eq!(output.height, 4);
        assert_eq!(&output.rgba[..4], &[255, 0, 0, 255]);
        assert_eq!(&output.rgba[12..16], &[0, 255, 0, 255]);
        assert_eq!(&output.rgba[48..52], &[0, 0, 255, 255]);
        assert_eq!(&output.rgba[60..64], &[255, 255, 255, 255]);
    }

    #[test]
    fn cpu_fallback_rejects_bad_buffer_and_pixel_budget() {
        assert!(matches!(cpu_scale_rgba(&[0; 3], 1, 1, 1, 4), Err(InferenceError::InvalidInput(_))));
        assert!(matches!(cpu_scale_rgba(&[0; 4], 1, 1, 3, 4), Err(InferenceError::PixelBudgetExceeded { .. })));
    }

    #[test]
    fn manifest_validation_requires_hash_scale_and_cpu_support() {
        let manifest = ModelManifest { id: "waifu".into(), version: "1".into(), format: "onnx".into(), scale: 2, max_pixels: 64_000_000, sha256: "a".repeat(64), supported_backends: vec!["directml".into(), "cpu".into()] };
        assert!(validate_manifest(&manifest).is_ok());
        let mut invalid = manifest.clone(); invalid.supported_backends.clear();
        assert!(matches!(validate_manifest(&invalid), Err(InferenceError::InvalidManifest(_))));
    }

    #[test]
    fn model_bytes_must_match_manifest_sha256() {
        use sha2::{Digest, Sha256};
        let bytes = b"model";
        let hash = Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let manifest = ModelManifest { id: "waifu".into(), version: "1".into(), format: "onnx".into(), scale: 2, max_pixels: 64_000_000, sha256: hash, supported_backends: vec!["cpu".into()] };
        assert!(validate_model_bytes(&manifest, bytes).is_ok());
        assert!(matches!(validate_model_bytes(&manifest, b"tampered"), Err(InferenceError::InvalidManifest(_))));
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
        assert_eq!(planned, vec![
            staging.join("model.onnx"),
            staging.join("assets").join("config.json"),
            staging.join("tokenizer").join("vocab.json"),
        ]);
        assert!(planned.iter().all(|path| path.starts_with(staging)));
    }

    #[test]
    fn model_archive_planner_rejects_unsafe_paths_and_non_regular_entries() {
        for name in ["/model.onnx", "\\model.onnx", "C:\\model.onnx", "C:model.onnx", "//server/share/model.onnx", "\\\\server\\share\\model.onnx", "../model.onnx", "assets/../model.onnx", "./model.onnx", "assets//model.onnx"] {
            assert!(plan_model_archive_entries(std::path::Path::new("staging"), &[ModelArchiveEntry::regular(name)]).is_err(), "accepted {name}");
        }
        for kind in [ModelArchiveEntryKind::Directory, ModelArchiveEntryKind::Symlink, ModelArchiveEntryKind::Other] {
            assert!(plan_model_archive_entries(std::path::Path::new("staging"), &[ModelArchiveEntry { name: "entry".into(), kind }]).is_err());
        }
    }

    #[test]
    fn model_archive_planner_rejects_duplicate_normalized_targets() {
        let entries = vec![ModelArchiveEntry::regular("assets/model.onnx"), ModelArchiveEntry::regular("ASSETS\\MODEL.ONNX")];
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

        for invalid in ["", ".", "..", "a/b", "a\\b", "C:model", " spaced", "model@latest"] {
            assert!(model_install_roots(&app_data, invalid, "1").is_err(), "accepted id {invalid:?}");
            assert!(model_install_roots(&app_data, "model", invalid).is_err(), "accepted version {invalid:?}");
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
            models.join("realesr-general").join("2026.09.2").join(MODEL_MANIFEST_FILE),
            serde_json::to_vec(&model_manifest(b"x")).unwrap(),
        ).unwrap();

        assert_eq!(installed_models_in(&base), vec![
            InstalledModel { id: "realesr-general".into(), version: "2026.09.2".into(), scale: Some(2), kind: MODEL_KIND_UPSCALE.into() },
            InstalledModel { id: "realesr-general".into(), version: "2026.08.1".into(), scale: None, kind: MODEL_KIND_UPSCALE.into() },
            InstalledModel { id: "waifu2x".into(), version: "1".into(), scale: None, kind: MODEL_KIND_UPSCALE.into() },
        ]);
        // No models directory at all is an empty list, not an error: a fresh
        // install has nowhere to look yet.
        assert!(installed_models_in(&base.join("elsewhere")).is_empty());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn resolving_a_model_needs_both_a_manifest_and_exactly_one_onnx_file() {
        let base = std::env::temp_dir().join("yomika-resolve-model");
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("models").join("realesr").join("1");
        std::fs::create_dir_all(&root).unwrap();

        // Manifest but no model file.
        std::fs::write(root.join(MODEL_MANIFEST_FILE), serde_json::to_vec(&model_manifest(b"x")).unwrap()).unwrap();
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

        let installed = install_model_archive(&archive, &manifest, &staging, &install).expect("installed model");

        assert_eq!(installed, install);
        assert_eq!(std::fs::read(install.join("model.onnx")).unwrap(), model);
        assert_eq!(std::fs::read(install.join("assets/config.json")).unwrap(), b"{}");
        // The manifest travels with the model, because nothing else records the
        // scale the upscaler needs.
        assert_eq!(read_model_manifest(&install).expect("installed manifest"), manifest);
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
        if base.exists() { std::fs::remove_dir_all(base).unwrap(); }
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
        assert!(install_model_archive(&archive, &model_manifest(model), &staging, &install).is_err());
        assert_eq!(std::fs::read(install.join("keep.txt")).unwrap(), b"keep");
        assert!(!staging.exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    fn cache_test_db() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(include_str!("../migrations/0001_initial.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0002_local_library.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0009_inference_jobs.sql")).unwrap();
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
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
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
        assert_eq!(select_backend(&["nnapi".into(), "coreml".into()], &[]), BackendId::Cpu);
        assert_eq!(select_backend(&["cpu".into()], &["cpu".into()]), BackendId::Cpu);
    }

    #[test]
    fn inference_job_resumes_without_recreating_items_and_cancel_persists() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(include_str!("../migrations/0001_initial.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0009_inference_jobs.sql")).unwrap();
        let make = || InferenceStartInput { id:"job-a".into(),source_scope:"scope-a".into(),source_id:"gallery-a".into(),model_id:"model-a".into(),model_version:"1".into(),input_hashes:vec!["h1".into(),"h2".into()] };
        assert_eq!(start_job(&mut connection, make()).unwrap().item_count, 2);
        assert_eq!(start_job(&mut connection, make()).unwrap().item_count, 2);
        connection.execute("UPDATE inference_items SET status='completed' WHERE job_id='job-a' AND item_index=0",[]).unwrap();
        connection.execute("UPDATE inference_jobs SET status='cancelled' WHERE id='job-a'",[]).unwrap();
        let job=load_job(&connection,"job-a").unwrap(); assert_eq!(job.completed_count,1); assert_eq!(job.status,"cancelled");
    }

    #[test]
    fn item_checkpoint_is_monotonic_and_completion_requires_output() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(include_str!("../migrations/0001_initial.sql")).unwrap();
        connection.execute_batch(include_str!("../migrations/0009_inference_jobs.sql")).unwrap();
        start_job(&mut connection, InferenceStartInput { id:"job-b".into(),source_scope:"scope-a".into(),source_id:"gallery-a".into(),model_id:"model-a".into(),model_version:"1".into(),input_hashes:vec!["h1".into()] }).unwrap();
        checkpoint_item(&connection, "job-b", 0, 4, "running", None).unwrap();
        checkpoint_item(&connection, "job-b", 0, 2, "running", None).unwrap();
        assert!(checkpoint_item(&connection, "job-b", 0, 5, "completed", None).is_err());
        checkpoint_item(&connection, "job-b", 0, 5, "completed", Some("out.png")).unwrap();
        let stored: (i64, String, Option<String>) = connection.query_row("SELECT completed_tile,status,output_path FROM inference_items WHERE job_id='job-b'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(stored, (5, "completed".into(), Some("out.png".into())));
    }

    #[test]
    fn pause_and_resume_preserve_completed_items() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap(); connection.execute_batch(include_str!("../migrations/0001_initial.sql")).unwrap(); connection.execute_batch(include_str!("../migrations/0009_inference_jobs.sql")).unwrap();
        start_job(&mut connection, InferenceStartInput { id:"job-c".into(),source_scope:"scope".into(),source_id:"g".into(),model_id:"m".into(),model_version:"1".into(),input_hashes:vec!["a".into(),"b".into()] }).unwrap();
        checkpoint_item(&connection,"job-c",0,3,"completed",Some("out.png")).unwrap();
        transition_job(&connection,"job-c","paused").unwrap(); transition_job(&connection,"job-c","running").unwrap();
        let statuses: Vec<String> = connection.prepare("SELECT status FROM inference_items WHERE job_id='job-c' ORDER BY item_index").unwrap().query_map([],|row|row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(statuses, vec!["completed", "pending"]);
        assert!(transition_job(&connection,"job-c","completed").is_err());
    }
}
