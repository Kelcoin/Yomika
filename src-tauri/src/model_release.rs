use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};
static CANCELLED_DOWNLOADS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
fn cancelled() -> &'static Mutex<std::collections::HashSet<String>> { CANCELLED_DOWNLOADS.get_or_init(|| Mutex::new(std::collections::HashSet::new())) }

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    pub role: String,
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub companions: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelReleaseManifest {
    pub tag: String,
    pub assets: Vec<ReleaseAsset>,
}

pub const MIRROR_PRESETS: &[(&str, &str)] = &[
    ("direct", ""),
    ("gh-proxy", "https://gh-proxy.com/"),
    ("ghfast", "https://ghfast.top/"),
    ("ghproxy", "https://ghproxy.net/"),
];

pub fn asset_url(prefix: &str, owner_repo: &str, tag: &str, path: &str) -> String {
    let target = format!("https://github.com/{owner_repo}/releases/download/{tag}/{path}");
    let prefix = prefix.trim();
    if prefix.is_empty() { return target; }
    format!("{}/{}", prefix.trim_end_matches('/'), target)
}

pub fn validate_manifest(manifest: &ModelReleaseManifest) -> Result<(), String> {
    if manifest.tag.is_empty() || manifest.assets.is_empty() { return Err("manifest tag/assets missing".into()); }
    let mut paths = std::collections::HashSet::new();
    for asset in &manifest.assets {
        if asset.role.is_empty() || asset.path.is_empty() || asset.size == 0 || asset.sha256.len() != 64 || !asset.sha256.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(format!("invalid asset {}", asset.path)); }
        if !paths.insert(asset.path.clone()) { return Err(format!("duplicate asset {}", asset.path)); }
        if asset.path.starts_with('/') || asset.path.contains("..") || asset.path.contains('\\') { return Err(format!("unsafe asset path {}", asset.path)); }
    }
    Ok(())
}

pub fn verify_bytes(asset: &ReleaseAsset, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != asset.size { return Err(format!("size mismatch for {}", asset.path)); }
    let digest = format!("{:x}", Sha256::digest(bytes));
    if digest != asset.sha256.to_ascii_lowercase() { return Err(format!("sha256 mismatch for {}", asset.path)); }
    Ok(())
}

pub fn download_asset_with_progress<F: FnMut(u64, Option<u64>)>(url: &str, asset: &ReleaseAsset, destination: &std::path::Path, mut progress: F) -> Result<(), String> {
    let key = destination.to_string_lossy().to_string();
    cancelled().lock().unwrap().remove(&key);
    let mut response = reqwest::blocking::get(url).map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() { return Err(format!("download HTTP {}", response.status())); }
    let parent = destination.parent().ok_or_else(|| "destination has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = destination.with_extension("part");
    let result = (|| {
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new(); let mut total = 0u64; let mut buffer = [0u8; 1024 * 128];
        let length = response.content_length();
        loop { if cancelled().lock().unwrap().contains(&key) { return Err("download cancelled".into()); } let read = response.read(&mut buffer).map_err(|e| e.to_string())?; if read == 0 { break; } file.write_all(&buffer[..read]).map_err(|e| e.to_string())?; hasher.update(&buffer[..read]); total += read as u64; progress(total, length); }
        if total != asset.size { return Err(format!("size mismatch for {}", asset.path)); }
        if format!("{:x}", hasher.finalize()) != asset.sha256.to_ascii_lowercase() { return Err(format!("sha256 mismatch for {}", asset.path)); }
        std::fs::rename(&temp, destination).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result
}

pub fn download_asset(url: &str, asset: &ReleaseAsset, destination: &std::path::Path) -> Result<(), String> { download_asset_with_progress(url, asset, destination, |_, _| {}) }

pub fn validate_import_directory(root: &std::path::Path, manifest: &ModelReleaseManifest) -> Result<(), String> {
    validate_manifest(manifest)?;
    for asset in &manifest.assets {
        let path = root.join(asset.path.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
        if !path.is_file() { return Err(format!("missing asset {}", asset.path)); }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        verify_bytes(asset, &bytes)?;
        for companion in &asset.companions {
            if !root.join(companion.replace('/', &std::path::MAIN_SEPARATOR.to_string())).is_file() { return Err(format!("missing companion {companion}")); }
        }
    }
    Ok(())
}

pub fn validate_import_archive(bytes: &[u8], manifest: &ModelReleaseManifest) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("invalid model archive: {e}"))?;
    let root = std::env::temp_dir().join(format!("yomika-model-import-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root); std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let result = (|| {
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            if entry.is_dir() { continue; }
            let name = entry.name().replace('\\', "/");
            if name.starts_with('/') || name.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p.contains(':')) { return Err("unsafe model archive path".into()); }
            let target = root.join(&name); if let Some(parent) = target.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
            let mut out = std::fs::File::create(target).map_err(|e| e.to_string())?; std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
        validate_import_directory(&root, manifest)
    })();
    let _ = std::fs::remove_dir_all(&root); result
}

pub fn activate_import_directory(staging: &std::path::Path, install: &std::path::Path) -> Result<(), String> {
    if !staging.is_dir() { return Err("staging directory missing".into()); }
    if install.exists() { return Err("model version already installed".into()); }
    std::fs::rename(staging, install).map_err(|e| format!("atomic model activation failed: {e}"))
}

#[tauri::command]
pub fn model_release_url(prefix: String, owner_repo: String, tag: String, path: String) -> String {
    asset_url(&prefix, &owner_repo, &tag, &path)
}

#[tauri::command]
pub fn model_release_fetch_manifest(prefix: String, owner_repo: String, tag: String) -> crate::domain::result::CommandResult<ModelReleaseManifest> {
    let url = asset_url(&prefix, &owner_repo, &tag, &format!("{tag}.manifest.json"));
    let result = reqwest::blocking::get(url).map_err(|e| e.to_string()).and_then(|r| r.error_for_status().map_err(|e| e.to_string())).and_then(|r| r.json::<ModelReleaseManifest>().map_err(|e| e.to_string())).and_then(|m| validate_manifest(&m).map(|_| m));
    match result { Ok(manifest) => crate::domain::result::CommandResult::success(manifest), Err(error) => crate::domain::result::CommandResult::failure("MODEL_MANIFEST_FETCH_FAILED", error, true) }
}

#[tauri::command]
pub fn model_release_validate(manifest: ModelReleaseManifest) -> crate::domain::result::CommandResult<()> {
    match validate_manifest(&manifest) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => crate::domain::result::CommandResult::failure("INVALID_MANIFEST", error, false),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadInput { pub url: String, pub asset: ReleaseAsset, pub destination: String }

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBundleDownloadInput { pub prefix: String, pub owner_repo: String, pub manifest: ModelReleaseManifest, pub destination: String }

#[tauri::command]
pub fn model_release_download_bundle(app: tauri::AppHandle, input: ModelBundleDownloadInput) -> crate::domain::result::CommandResult<()> {
    if let Err(error) = validate_manifest(&input.manifest) { return crate::domain::result::CommandResult::failure("INVALID_MANIFEST", error, false); }
    let root = std::path::PathBuf::from(&input.destination); if !root.is_absolute() { return crate::domain::result::CommandResult::failure("INVALID_INPUT", "destination must be absolute", false); }
    if root.exists() { return crate::domain::result::CommandResult::failure("MODEL_ALREADY_EXISTS", "destination already exists", false); }
    if let Err(error) = std::fs::create_dir_all(&root) { return crate::domain::result::CommandResult::failure("MODEL_DOWNLOAD_FAILED", error.to_string(), true); }
    let result = (|| { for asset in &input.manifest.assets { let url = asset_url(&input.prefix, &input.owner_repo, &input.manifest.tag, &asset.path); let target = root.join(asset.path.replace('/', &std::path::MAIN_SEPARATOR.to_string())); if let Some(parent)=target.parent(){std::fs::create_dir_all(parent).map_err(|e|e.to_string())?;} download_asset_with_progress(&url, asset, &target, |done,total| { let _=tauri::Emitter::emit(&app,"model-download-progress",serde_json::json!({"path":asset.path,"completed":done,"total":total})); })?; } Ok::<(),String>(()) })();
    match result { Ok(()) => crate::domain::result::CommandResult::success(()), Err(error) => { let _=std::fs::remove_dir_all(&root); crate::domain::result::CommandResult::failure("MODEL_DOWNLOAD_FAILED", error, true) } }
}

#[tauri::command]
pub fn model_release_download(app: tauri::AppHandle, input: ModelDownloadInput) -> crate::domain::result::CommandResult<()> {
    let destination = std::path::PathBuf::from(input.destination);
    if !destination.is_absolute() { return crate::domain::result::CommandResult::failure("INVALID_INPUT", "destination must be absolute", false); }
    match download_asset_with_progress(&input.url, &input.asset, &destination, |completed, total| { let _ = tauri::Emitter::emit(&app, "model-download-progress", serde_json::json!({"path": input.asset.path, "completed": completed, "total": total})); }) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => crate::domain::result::CommandResult::failure("MODEL_DOWNLOAD_FAILED", error, true),
    }
}

#[tauri::command]
pub fn model_release_cancel(destination: String) -> crate::domain::result::CommandResult<()> {
    cancelled().lock().unwrap().insert(destination);
    crate::domain::result::CommandResult::success(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImportInput { pub root: String, pub manifest: ModelReleaseManifest }

#[tauri::command]
pub fn model_release_validate_import(input: ModelImportInput) -> crate::domain::result::CommandResult<()> {
    match validate_import_directory(std::path::Path::new(&input.root), &input.manifest) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => crate::domain::result::CommandResult::failure("INVALID_MODEL_IMPORT", error, false),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArchiveImportInput { pub archive: Vec<u8>, pub manifest: ModelReleaseManifest }

#[tauri::command]
pub fn model_release_validate_archive(input: ModelArchiveImportInput) -> crate::domain::result::CommandResult<()> {
    match validate_import_archive(&input.archive, &input.manifest) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => crate::domain::result::CommandResult::failure("INVALID_MODEL_IMPORT", error, false),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLocalImportInput { pub path: String, pub manifest: ModelReleaseManifest }

#[tauri::command]
pub fn model_release_validate_local(input: ModelLocalImportInput) -> crate::domain::result::CommandResult<()> {
    let path = std::path::Path::new(&input.path);
    let result = if path.is_dir() { validate_import_directory(path, &input.manifest) }
        else if path.is_file() { std::fs::read(path).map_err(|e| e.to_string()).and_then(|bytes| validate_import_archive(&bytes, &input.manifest)) }
        else { Err("model path does not exist".into()) };
    match result { Ok(()) => crate::domain::result::CommandResult::success(()), Err(error) => crate::domain::result::CommandResult::failure("INVALID_MODEL_IMPORT", error, false) }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelActivateInput { pub staging: String, pub install: String }

#[tauri::command]
pub fn model_release_activate(input: ModelActivateInput) -> crate::domain::result::CommandResult<()> {
    match activate_import_directory(std::path::Path::new(&input.staging), std::path::Path::new(&input.install)) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => crate::domain::result::CommandResult::failure("MODEL_ACTIVATION_FAILED", error, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn asset() -> ReleaseAsset { ReleaseAsset { role: "detector".into(), path: "mrcnn/weights.onnx".into(), size: 4, sha256: format!("{:x}", Sha256::digest(b"test")), companions: vec![] } }
    #[test] fn builds_direct_url() { assert_eq!(asset_url("", "o/r", "v1", "m.onnx"), "https://github.com/o/r/releases/download/v1/m.onnx"); }
    #[test] fn builds_mirror_url_without_double_slash() { assert_eq!(asset_url("https://gh-proxy.com/", "o/r", "v1", "m.onnx"), "https://gh-proxy.com/https://github.com/o/r/releases/download/v1/m.onnx"); }
    #[test] fn verifies_size_and_digest() { assert!(verify_bytes(&asset(), b"test").is_ok()); assert!(verify_bytes(&asset(), b"bad").is_err()); }
    #[test] fn rejects_duplicate_or_unsafe_paths() { let mut a=asset(); a.path="../x".into(); assert!(validate_manifest(&ModelReleaseManifest{tag:"v1".into(),assets:vec![a]}).is_err()); }
    #[test] fn validates_import_directory() { let root=std::env::temp_dir().join("yomika-release-import"); let _=std::fs::create_dir_all(&root); std::fs::write(root.join("m.onnx"), b"test").unwrap(); let mut a=asset(); a.path="m.onnx".into(); assert!(validate_import_directory(&root,&ModelReleaseManifest{tag:"v1".into(),assets:vec![a]}).is_ok()); let _=std::fs::remove_dir_all(root); }
}
