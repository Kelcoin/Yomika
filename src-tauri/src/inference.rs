#[derive(Debug, PartialEq, Eq)]
pub enum InferenceError {
    InvalidInput(String),
    PixelBudgetExceeded { pixels: usize, max_pixels: usize },
    InvalidManifest(String),
    CacheBusy,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendId { Cpu }

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceCapabilities {
    pub backends: Vec<String>,
    pub max_pixels: usize,
    pub hardware_acceleration: bool,
}

#[tauri::command]
pub fn inference_probe() -> crate::domain::result::CommandResult<InferenceCapabilities> {
    crate::domain::result::CommandResult::success(InferenceCapabilities {
        backends: vec!["cpu".to_string()], max_pixels: 64_000_000, hardware_acceleration: false,
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

#[derive(Debug, serde::Serialize)]
pub struct InstalledModel { pub id: String, pub version: String }

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
        Ok(_) => crate::domain::result::CommandResult::success(InstalledModel {
            id: input.manifest.id,
            version: input.manifest.version,
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

pub fn select_backend(supported: &[String], blacklist: &[String]) -> BackendId {
    if supported.iter().any(|backend| backend == "cpu") && !blacklist.iter().any(|backend| backend == "cpu") {
        return BackendId::Cpu;
    }
    BackendId::Cpu
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
    use super::*;

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
    fn model_archive_install_extracts_validated_model_then_publishes_atomically() {
        let model = b"valid onnx model";
        let archive = model_zip(&[("model.onnx", model), ("assets/config.json", b"{}")]);
        let manifest = model_manifest(model);
        let (staging, install, base) = install_test_roots("model-install-ok");

        let installed = install_model_archive(&archive, &manifest, &staging, &install).expect("installed model");

        assert_eq!(installed, install);
        assert_eq!(std::fs::read(install.join("model.onnx")).unwrap(), model);
        assert_eq!(std::fs::read(install.join("assets/config.json")).unwrap(), b"{}");
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
    fn backend_selector_always_falls_back_to_cpu() {
        assert_eq!(select_backend(&["directml".into(), "cpu".into()], &[]), BackendId::Cpu);
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
