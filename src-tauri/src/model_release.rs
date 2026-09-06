use sha2::{Digest, Sha256};

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

#[tauri::command]
pub fn model_release_url(prefix: String, owner_repo: String, tag: String, path: String) -> String {
    asset_url(&prefix, &owner_repo, &tag, &path)
}

#[tauri::command]
pub fn model_release_validate(manifest: ModelReleaseManifest) -> crate::domain::result::CommandResult<()> {
    match validate_manifest(&manifest) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => crate::domain::result::CommandResult::failure("INVALID_MANIFEST", error, false),
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
}
