use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};

/// 取消标记只在下载真被打断的那段时间里有意义，而 destination 是前端传进来的
/// 字符串：只插不删的表会随「取消过、之后没再下同一个文件」无限增长。所以按插入
/// 顺序淘汰，上限与 inference/cancel.rs 的 pending 表一致。
const MAX_CANCELLED_DOWNLOADS: usize = 256;

#[derive(Default)]
struct CancelledDownloads {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl CancelledDownloads {
    fn mark(&mut self, key: String) {
        if self.set.insert(key.clone()) {
            self.order.push_back(key);
        }
        while self.order.len() > MAX_CANCELLED_DOWNLOADS {
            if let Some(oldest) = self.order.pop_front() {
                self.set.remove(&oldest);
            }
        }
    }

    /// 读到即消费：已经据此中断的下载，不该把标记留给同一目标的下一次下载。
    fn take(&mut self, key: &str) -> bool {
        if !self.set.remove(key) {
            return false;
        }
        if let Some(index) = self.order.iter().position(|item| item == key) {
            self.order.remove(index);
        }
        true
    }

    /// 下载开始时清掉上一次留下的残留标记。
    fn clear(&mut self, key: &str) {
        let _ = self.take(key);
    }

    fn len(&self) -> usize {
        self.set.len()
    }
}

static CANCELLED_DOWNLOADS: OnceLock<Mutex<CancelledDownloads>> = OnceLock::new();
fn cancelled() -> &'static Mutex<CancelledDownloads> {
    CANCELLED_DOWNLOADS.get_or_init(|| Mutex::new(CancelledDownloads::default()))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    pub role: String,
    /// Relative path inside the installed model bundle.
    pub path: String,
    /// Flat filename used by the GitHub Release asset. GitHub release assets
    /// do not preserve directory names, while model bundles must.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_name: Option<String>,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub companions: Vec<String>,
    /// Optional upstream URL. It is attempted first; the project Release
    /// mirrors remain the deterministic fallback when it is absent or stale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_url: Option<String>,
}

impl ReleaseAsset {
    fn remote_name(&self) -> &str {
        self.download_name.as_deref().unwrap_or(&self.path)
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelReleaseManifest {
    pub tag: String,
    pub assets: Vec<ReleaseAsset>,
}

/// Super-resolution models the project hosts online, by id — in the order the
/// settings menu offers them, so the recommended one comes first.
///
/// The release asset, the installed file and the local engine fixture are all
/// `<id>.onnx` — one name for one artifact, so a downloaded file can be checked
/// against the copy that was actually run before it was published.
pub const HOSTED_UPSCALE_MODEL_IDS: &[&str] = &[
    // Real-CUGAN 2x, the manga upscaler this reader is meant to use: a safe
    // general-purpose pass first, then the strong denoise for noisy scans.
    // Real-ESRGAN used to be listed here too and no longer is.
    "realcugan-2x-conservative",
    "realcugan-2x-denoise3x",
];

/// The hosted upscaler catalog: which models exist, what they cost, and the
/// digest each file must have.
///
/// The de-censor manifest (`manifest.json`) is a single bundle whose assets are
/// all downloaded into one directory, so it cannot describe an installable
/// choice. This one can: one entry per selectable model, its scale, and the
/// files that make up `models/<id>/<version>/`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleCatalogFile {
    /// File name inside the install directory, and the release asset name.
    pub name: String,
    pub size: u64,
    pub sha256: String,
    /// Upstream URL, tried before the project's own mirrors. Present for models
    /// that were taken from a public export rather than converted here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleCatalogModel {
    /// Also the install directory name.
    pub id: String,
    /// Shown in settings. The UI falls back to prettifying the id when a model
    /// is listed before the catalog has been fetched.
    pub label: String,
    /// How much bigger the image comes out. Nothing else records it: an ONNX
    /// output shape is dynamic, so the file cannot be asked.
    pub scale: u32,
    pub version: String,
    /// Where the model came from, for the record. Not downloaded from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Smallest tile edge the graph accepts, in source pixels, recorded into the
    /// installed `yomika-model.json`. Absent means the graph takes whatever the
    /// tiler hands it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_input_edge: Option<u32>,
    pub files: Vec<UpscaleCatalogFile>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleCatalog {
    pub tag: String,
    pub models: Vec<UpscaleCatalogModel>,
}

impl UpscaleCatalogModel {
    /// The one ONNX graph in the install. `None` only for an entry that has not
    /// been through [`validate_upscale_catalog`], which requires exactly one.
    pub fn model_file(&self) -> Option<&UpscaleCatalogFile> {
        self.files
            .iter()
            .find(|file| file.name.to_ascii_lowercase().ends_with(".onnx"))
    }
}

/// The `yomika-model.json` an install of this entry gets.
///
/// Nothing else records a model's scale, so a download that skipped this file
/// would put a directory in `models/` that can be listed and not run — the same
/// shape as a half-finished import.
fn hosted_model_manifest(
    model: &UpscaleCatalogModel,
) -> Result<crate::inference::ModelManifest, String> {
    let graph = model
        .model_file()
        .ok_or_else(|| format!("模型 {} 的目录条目里没有 ONNX 文件", model.id))?;
    let manifest = crate::inference::ModelManifest {
        id: model.id.clone(),
        version: model.version.clone(),
        format: "onnx".into(),
        scale: model.scale,
        max_pixels: crate::inference::DEFAULT_MAX_PIXELS,
        sha256: graph.sha256.to_ascii_lowercase(),
        supported_backends: vec!["cpu".into()],
        min_input_edge: model.min_input_edge.unwrap_or(1),
    };
    crate::inference::validate_manifest(&manifest).map_err(|error| format!("{error:?}"))?;
    Ok(manifest)
}

/// A catalog entry is only usable if its identity can be a directory name and
/// its files can be written as-is: the download writes these names into the
/// install directory, so anything that could escape it is refused here rather
/// than at install time.
pub fn validate_upscale_catalog(catalog: &UpscaleCatalog) -> Result<(), String> {
    if catalog.tag.is_empty() || catalog.models.is_empty() {
        return Err("upscale catalog tag/models missing".into());
    }
    let mut ids = std::collections::HashSet::new();
    for model in &catalog.models {
        if !safe_segment(&model.id) || !safe_segment(&model.version) {
            return Err(format!("unsafe model identity {}", model.id));
        }
        if model.label.trim().is_empty() || model.scale == 0 {
            return Err(format!("invalid model {} label/scale", model.id));
        }
        // The floor ends up in the installed manifest, which validates it again;
        // catching it here names the catalog entry instead of the install.
        if model.min_input_edge.is_some_and(|edge| edge == 0 || edge > 4096) {
            return Err(format!("model {} minimum input edge is out of range", model.id));
        }
        if !ids.insert(model.id.clone()) {
            return Err(format!("duplicate model {}", model.id));
        }
        let mut names = std::collections::HashSet::new();
        let mut graphs = 0;
        for file in &model.files {
            if !safe_segment(&file.name) {
                return Err(format!("unsafe file name {}", file.name));
            }
            if file.size == 0
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(format!("invalid size/hash for {}", file.name));
            }
            if let Some(url) = file.direct_url.as_deref() {
                if !url.starts_with("https://") {
                    return Err(format!("external model URL must use HTTPS: {url}"));
                }
            }
            if !names.insert(file.name.clone()) {
                return Err(format!("duplicate file {}", file.name));
            }
            if file.name.to_ascii_lowercase().ends_with(".onnx") {
                graphs += 1;
            }
        }
        // `model_file_in` refuses an install holding two graphs, so a two-graph
        // entry could never be resolved after a successful download.
        if graphs != 1 {
            return Err(format!("model {} must list exactly one ONNX file", model.id));
        }
    }
    Ok(())
}

/// A single path segment that can be used as a directory or file name.
pub(crate) fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', ':', '\0'])
}

fn upscale_catalog_urls(owner_repo: &str) -> Vec<String> {
    let raw =
        format!("https://raw.githubusercontent.com/{owner_repo}/main/upscale-manifest.json");
    let mut urls = vec![raw.clone()];
    for (_, prefix) in MIRROR_PRESETS.iter().filter(|(id, _)| *id != "direct") {
        urls.push(format!("{prefix}{raw}"));
    }
    urls
}

fn fetch_upscale_catalog_with_fallback(owner_repo: &str) -> Result<UpscaleCatalog, String> {
    let mut errors = Vec::new();
    for url in upscale_catalog_urls(owner_repo) {
        match reqwest::blocking::get(&url).and_then(|response| response.error_for_status()) {
            Ok(response) => match response.json::<UpscaleCatalog>() {
                Ok(catalog) => match validate_upscale_catalog(&catalog) {
                    Ok(()) => return Ok(catalog),
                    Err(error) => errors.push(format!("{url}: {error}")),
                },
                Err(error) => errors.push(format!("{url}: {error}")),
            },
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(format!(
        "all upscale catalog sources failed: {}",
        errors.join("; ")
    ))
}

pub const MIRROR_PRESETS: &[(&str, &str)] = &[
    ("direct", ""),
    ("gh-proxy", "https://gh-proxy.com/"),
    ("ghfast", "https://ghfast.top/"),
    ("ghproxy", "https://ghproxy.net/"),
];

fn candidate_urls(owner_repo: &str, tag: &str, path: &str) -> Vec<String> {
    MIRROR_PRESETS
        .iter()
        .map(|(_, prefix)| asset_url(prefix, owner_repo, tag, path))
        .collect()
}

fn candidate_urls_with_prefix(
    prefix: &str,
    owner_repo: &str,
    tag: &str,
    path: &str,
) -> Vec<String> {
    let mut urls = Vec::new();
    if !prefix.trim().is_empty() {
        urls.push(asset_url(prefix, owner_repo, tag, path));
    }
    for url in candidate_urls(owner_repo, tag, path) {
        if !urls.iter().any(|item| item == &url) {
            urls.push(url);
        }
    }
    urls
}

fn download_asset_with_fallback(
    owner_repo: &str,
    tag: &str,
    asset: &ReleaseAsset,
    destination: &std::path::Path,
) -> Result<(), String> {
    download_asset_with_fallback_progress(owner_repo, tag, asset, destination, |_, _| {})
}

/// The same source chain, with the byte counter handed out so a long download
/// can be shown. `direct_url` (the upstream export) is tried first, then the
/// project's release assets behind every mirror.
fn download_asset_with_fallback_progress<F: FnMut(u64, Option<u64>)>(
    owner_repo: &str,
    tag: &str,
    asset: &ReleaseAsset,
    destination: &std::path::Path,
    mut progress: F,
) -> Result<(), String> {
    let mut errors = Vec::new();
    let mut urls = Vec::new();
    if let Some(url) = asset
        .direct_url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
    {
        urls.push(url.to_string());
    }
    urls.extend(candidate_urls(owner_repo, tag, asset.remote_name()));
    for url in urls {
        match download_asset_with_progress(&url, asset, destination, &mut progress) {
            Ok(()) => return Ok(()),
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(format!(
        "all model download sources failed: {}",
        errors.join("; ")
    ))
}

fn aletheia_direct_url(asset: &ReleaseAsset) -> Option<String> {
    // The upstream project publishes the ONNX files as flat Release assets;
    // Yomika's manifest keeps their installed subdirectories separately.
    let name = asset.remote_name();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return None;
    }
    Some(format!(
        "https://github.com/Cec1c/Aletheia-Lens/releases/download/models-v1/{name}"
    ))
}

/// The standalone repository that carries the model releases. Its body keeps
/// the current `manifest.json` and its Release holds the flat model assets;
/// the main application repository carries no model files.
pub const MODEL_RELEASE_REPO: &str = "Kelcoin/Yomika-Models";
pub const MODEL_RELEASE_TAG: &str = "models-v1";

fn manifest_urls(owner_repo: &str, tag: &str) -> Vec<String> {
    let raw = format!("https://raw.githubusercontent.com/{owner_repo}/main/manifest.json");
    let mut urls = vec![raw.clone()];
    for (_, prefix) in MIRROR_PRESETS.iter().filter(|(id, _)| *id != "direct") {
        urls.push(format!("{prefix}{raw}"));
    }
    for url in candidate_urls(owner_repo, tag, &format!("{tag}.manifest.json")) {
        urls.push(url);
    }
    urls
}

fn fetch_manifest_with_fallback(
    owner_repo: &str,
    tag: &str,
) -> Result<ModelReleaseManifest, String> {
    let mut errors = Vec::new();
    for url in manifest_urls(owner_repo, tag) {
        match reqwest::blocking::get(&url).and_then(|response| response.error_for_status()) {
            Ok(response) => match response.json::<ModelReleaseManifest>() {
                Ok(manifest) => {
                    if let Err(error) = validate_manifest(&manifest) {
                        errors.push(format!("{url}: {error}"));
                    } else {
                        return Ok(manifest);
                    }
                }
                Err(error) => errors.push(format!("{url}: {error}")),
            },
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(format!(
        "all model manifest sources failed: {}",
        errors.join("; ")
    ))
}

pub fn asset_url(prefix: &str, owner_repo: &str, tag: &str, path: &str) -> String {
    let target = format!("https://github.com/{owner_repo}/releases/download/{tag}/{path}");
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return target;
    }
    format!("{}/{}", prefix.trim_end_matches('/'), target)
}

pub fn validate_manifest(manifest: &ModelReleaseManifest) -> Result<(), String> {
    if manifest.tag.is_empty() || manifest.assets.is_empty() {
        return Err("manifest tag/assets missing".into());
    }
    let mut paths = std::collections::HashSet::new();
    for asset in &manifest.assets {
        if asset.role.is_empty()
            || asset.path.is_empty()
            || asset.size == 0
            || asset.sha256.len() != 64
            || !asset.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(format!("invalid asset {}", asset.path));
        }
        if let Some(url) = asset.direct_url.as_deref() {
            if !url.starts_with("https://") {
                return Err(format!("external model URL must use HTTPS: {url}"));
            }
        }
        if !paths.insert(asset.path.clone()) {
            return Err(format!("duplicate asset {}", asset.path));
        }
        for path in std::iter::once(&asset.path).chain(asset.companions.iter()) {
            // Release paths use forward slashes on every host. Reject Windows
            // drive prefixes and alternate streams even when validating on Unix.
            if path.contains(['\\', ':', '\0'])
                || path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err(format!("unsafe asset or companion path {path}"));
            }
        }
        if let Some(download_name) = &asset.download_name {
            if download_name.contains(['/', '\\', ':', '\0'])
                || download_name.is_empty()
                || download_name == "."
                || download_name == ".."
            {
                return Err(format!("unsafe release asset name {download_name}"));
            }
        }
    }
    Ok(())
}

pub fn verify_bytes(asset: &ReleaseAsset, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != asset.size {
        return Err(format!("size mismatch for {}", asset.path));
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    if digest != asset.sha256.to_ascii_lowercase() {
        return Err(format!("sha256 mismatch for {}", asset.path));
    }
    Ok(())
}

/// Windows 检索/杀软的实时扫描会在刚写完的文件上短暂保持句柄，改名撞上扫描
/// 就回答"拒绝访问"（os error 5）或共享冲突（32/33）。退避重试几次再放弃。
/// 把装好资产的暂存目录就位。优先整体改名；数据目录常位于 OneDrive 一类的
/// 云同步目录里，同步过滤器会长时间钉住含新写入大文件的目录（Pinned 属性），
/// 整目录改名可以持续数分钟失败——此时退回逐文件移动（同一卷上的文件改名
/// 不受影响），最后清空暂存目录，安装结果与整体改名完全一致。
fn install_staging_dir(staging: &std::path::Path, root: &std::path::Path) -> Result<(), String> {
    if rename_with_retry(staging, root).is_ok() {
        return Ok(());
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    move_dir_contents(staging, root)?;
    std::fs::remove_dir_all(staging).map_err(|e| e.to_string())
}

fn move_dir_contents(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            move_dir_contents(&entry.path(), &target)?;
        } else {
            rename_with_retry(&entry.path(), &target)?;
        }
    }
    Ok(())
}
fn rename_with_retry(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    let mut delay = 500_u64;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if delay <= 8000 && matches!(error.raw_os_error(), Some(5) | Some(32) | Some(33)) => {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                delay *= 2;
            }
            Err(error) => {
                return Err(format!(
                    "rename {} -> {}: {error}",
                    from.display(),
                    to.display()
                ));
            }
        }
    }
}

pub fn download_asset_with_progress<F: FnMut(u64, Option<u64>)>(
    url: &str,
    asset: &ReleaseAsset,
    destination: &std::path::Path,
    mut progress: F,
) -> Result<(), String> {
    let key = destination.to_string_lossy().to_string();
    cancelled().lock().unwrap().clear(&key);
    let mut response = reqwest::blocking::get(url).map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download HTTP {}", response.status()));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "destination has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = destination.with_extension("part");
    let result = (|| {
        let mut file = std::fs::File::create(&temp).map_err(|e| format!("create {}: {e}", temp.display()))?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 1024 * 128];
        let length = response.content_length();
        loop {
            if cancelled().lock().unwrap().take(&key) {
                return Err("download cancelled".into());
            }
            let read = response.read(&mut buffer).map_err(|e| format!("read {url}: {e}"))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read]).map_err(|e| format!("write {}: {e}", temp.display()))?;
            hasher.update(&buffer[..read]);
            total += read as u64;
            progress(total, length);
        }
        if total != asset.size {
            return Err(format!("size mismatch for {}", asset.path));
        }
        if format!("{:x}", hasher.finalize()) != asset.sha256.to_ascii_lowercase() {
            return Err(format!("sha256 mismatch for {}", asset.path));
        }
        rename_with_retry(&temp, destination)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

pub fn validate_import_directory(
    root: &std::path::Path,
    manifest: &ModelReleaseManifest,
) -> Result<(), String> {
    validate_manifest(manifest)?;
    for asset in &manifest.assets {
        let path = root.join(
            asset
                .path
                .replace('/', &std::path::MAIN_SEPARATOR.to_string()),
        );
        if !path.is_file() {
            return Err(format!("missing asset {}", asset.path));
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        verify_bytes(asset, &bytes)?;
        for companion in &asset.companions {
            if !root
                .join(companion.replace('/', &std::path::MAIN_SEPARATOR.to_string()))
                .is_file()
            {
                return Err(format!("missing companion {companion}"));
            }
        }
    }
    Ok(())
}

pub fn validate_import_archive(
    bytes: &[u8],
    manifest: &ModelReleaseManifest,
    data: &std::path::Path,
) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("invalid model archive: {e}"))?;
    let staging = data.join("temp");
    std::fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let temporary = tempfile::tempdir_in(staging).map_err(|error| error.to_string())?;
    let root = temporary.path();
    let result = (|| {
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().replace('\\', "/");
            if name.starts_with('/')
                || name
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == ".." || p.contains(':'))
            {
                return Err("unsafe model archive path".into());
            }
            let target = root.join(&name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
        validate_import_directory(&root, manifest)
    })();
    result
}

pub fn activate_import_directory(
    staging: &std::path::Path,
    install: &std::path::Path,
) -> Result<(), String> {
    if !staging.is_dir() {
        return Err("staging directory missing".into());
    }
    if install.exists() {
        return Err("model version already installed".into());
    }
    std::fs::rename(staging, install).map_err(|e| format!("atomic model activation failed: {e}"))
}

#[tauri::command]
pub fn model_release_url(
    prefix: String,
    owner_repo: String,
    tag: String,
    path: String,
) -> crate::domain::result::CommandResult<String> {
    crate::domain::result::CommandResult::success(asset_url(&prefix, &owner_repo, &tag, &path))
}

#[tauri::command(async)]
pub fn model_release_fetch_manifest(
    prefix: String,
    owner_repo: String,
    tag: String,
) -> crate::domain::result::CommandResult<ModelReleaseManifest> {
    let result =
        candidate_urls_with_prefix(&prefix, &owner_repo, &tag, &format!("{tag}.manifest.json"))
            .into_iter()
            .find_map(|url| {
                reqwest::blocking::get(url)
                    .ok()
                    .and_then(|r| r.error_for_status().ok())
                    .and_then(|r| r.json::<ModelReleaseManifest>().ok())
                    .and_then(|m| validate_manifest(&m).ok().map(|_| m))
            })
            .ok_or_else(|| "all model manifest sources failed".to_string());
    match result {
        Ok(manifest) => crate::domain::result::CommandResult::success(manifest),
        Err(error) => crate::domain::result::CommandResult::failure(
            "MODEL_MANIFEST_FETCH_FAILED",
            error,
            true,
        ),
    }
}

#[tauri::command]
pub fn model_release_validate(
    manifest: ModelReleaseManifest,
) -> crate::domain::result::CommandResult<()> {
    match validate_manifest(&manifest) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => {
            crate::domain::result::CommandResult::failure("INVALID_MANIFEST", error, false)
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadInput {
    pub url: String,
    pub asset: ReleaseAsset,
    pub destination: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBundleDownloadInput {
    pub prefix: String,
    pub owner_repo: String,
    pub manifest: ModelReleaseManifest,
    pub destination: String,
}

#[tauri::command(async)]
pub fn model_release_download_bundle(
    app: tauri::AppHandle,
    input: ModelBundleDownloadInput,
) -> crate::domain::result::CommandResult<()> {
    if let Err(error) = validate_manifest(&input.manifest) {
        return crate::domain::result::CommandResult::failure("INVALID_MANIFEST", error, false);
    }
    let root = std::path::PathBuf::from(&input.destination);
    if !root.is_absolute() {
        return crate::domain::result::CommandResult::failure(
            "INVALID_INPUT",
            "destination must be absolute",
            false,
        );
    }
    if root.exists() {
        return crate::domain::result::CommandResult::failure(
            "MODEL_ALREADY_EXISTS",
            "destination already exists",
            false,
        );
    }
    let staging = root.with_file_name(format!(
        ".{}.installing",
        root.file_name().unwrap_or_default().to_string_lossy()
    ));
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(error) = std::fs::create_dir_all(&staging) {
        return crate::domain::result::CommandResult::failure(
            "MODEL_DOWNLOAD_FAILED",
            error.to_string(),
            true,
        );
    }
    let result = (|| {
        for asset in &input.manifest.assets {
            let target = staging.join(
                asset
                    .path
                    .replace('/', &std::path::MAIN_SEPARATOR.to_string()),
            );
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut errors = Vec::new();
            let mut downloaded = false;
            let mut urls = Vec::new();
            if let Some(url) = asset
                .direct_url
                .as_deref()
                .filter(|url| !url.trim().is_empty())
            {
                urls.push(url.to_string());
            }
            urls.extend(candidate_urls_with_prefix(
                &input.prefix,
                &input.owner_repo,
                &input.manifest.tag,
                asset.remote_name(),
            ));
            for url in urls {
                match download_asset_with_progress(&url, asset, &target, |done, total| {
                    let _ = tauri::Emitter::emit(
                        &app,
                        "model-download-progress",
                        serde_json::json!({"path":asset.path,"completed":done,"total":total}),
                    );
                }) {
                    Ok(()) => {
                        downloaded = true;
                        break;
                    }
                    Err(error) => errors.push(format!("{url}: {error}")),
                }
            }
            if !downloaded {
                return Err(format!(
                    "all model download sources failed: {}",
                    errors.join("; ")
                ));
            }
        }
        install_staging_dir(&staging, &root)
    })();
    match result {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            crate::domain::result::CommandResult::failure("MODEL_DOWNLOAD_FAILED", error, true)
        }
    }
}

#[tauri::command(async)]
pub fn model_release_list_upscalers() -> crate::domain::result::CommandResult<UpscaleCatalog> {
    match fetch_upscale_catalog_with_fallback(MODEL_RELEASE_REPO) {
        Ok(catalog) => crate::domain::result::CommandResult::success(catalog),
        Err(error) => crate::domain::result::CommandResult::failure(
            "MODEL_CATALOG_FETCH_FAILED",
            error,
            true,
        ),
    }
}

/// Downloads one catalog model into `models/<id>/<version>/`.
///
/// The install is the same shape a hand-imported model has — the graph, whatever
/// the export shipped beside it, and a `yomika-model.json` recording the scale —
/// so the upscaler resolves it exactly like a model the user imported, and the
/// settings list stops offering it for download once it is there.
fn install_hosted_upscale_model(
    app: &tauri::AppHandle,
    data: &std::path::Path,
    model_id: &str,
) -> Result<(), String> {
    let catalog = fetch_upscale_catalog_with_fallback(MODEL_RELEASE_REPO)?;
    let model = catalog
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| format!("模型 {model_id} 没有可用的在线下载源，请导入模型文件"))?;
    let (staging, root) = crate::inference::model_install_roots(data, &model.id, &model.version)
        .map_err(|error| format!("{error:?}"))?;
    if crate::inference::read_model_manifest(&root).is_some() {
        return Ok(());
    }
    if root.exists() {
        return Err("模型安装目录已存在但不完整，请删除后重新下载".into());
    }
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        for file in &model.files {
            let target = staging.join(&file.name);
            let asset = ReleaseAsset {
                role: "upscale".into(),
                path: file.name.clone(),
                download_name: Some(file.name.clone()),
                size: file.size,
                sha256: file.sha256.clone(),
                companions: Vec::new(),
                // The upstream export is attempted first and the project's own
                // release assets behind it, so a reachable Hugging Face means we
                // are not the ones paying for the bandwidth.
                direct_url: file.direct_url.clone(),
            };
            // `path` is the event's stable key, so the settings row can tell
            // which model the bar belongs to.
            let path = model.id.clone();
            download_asset_with_fallback_progress(
                MODEL_RELEASE_REPO,
                &catalog.tag,
                &asset,
                &target,
                |completed, total| {
                    let _ = tauri::Emitter::emit(
                        app,
                        "model-download-progress",
                        serde_json::json!({"path": path, "completed": completed, "total": total}),
                    );
                },
            )?;
        }
        let manifest = hosted_model_manifest(model)?;
        std::fs::write(
            staging.join(crate::inference::MODEL_MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        install_staging_dir(&staging, &root)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

#[tauri::command]
pub async fn model_release_download_default(
    app: tauri::AppHandle,
    model_id: Option<String>,
) -> crate::domain::result::CommandResult<()> {
    // 下载是几分钟的阻塞网络 IO，而不带 `async` 的 command 跑在主线程上——事件也是
    // 从主线程投递给 webview 的，于是 model-download-progress 要等下载整个结束才一起
    // 到达，进度条永远停在起点。丢给阻塞线程池，主线程才有空把每一帧进度发出去。
    match tauri::async_runtime::spawn_blocking(move || download_default(&app, model_id)).await {
        Ok(result) => result,
        Err(error) => crate::domain::result::CommandResult::failure(
            "MODEL_DOWNLOAD_FAILED",
            error.to_string(),
            true,
        ),
    }
}

/// 真正干活的那一段：跑在阻塞线程池上，因为里面的 reqwest 是阻塞版。
fn download_default(
    app: &tauri::AppHandle,
    model_id: Option<String>,
) -> crate::domain::result::CommandResult<()> {
    let requested = model_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "aletheia-lens".into());
    let result = crate::inference::model_data_dir(app)
        .map_err(|e| e.to_string())
        .and_then(|data| match requested.as_str() {
            // This model ships with the application. The operation is still
            // exposed through the same button so the UI has one download flow,
            // but it never performs a network request or writes outside data/.
            "waifu2x-upconv7" => crate::bundled_models::prepare(&data).map_err(|e| e.to_string()),
            "aletheia-lens" => {
                let manifest = fetch_manifest_with_fallback(MODEL_RELEASE_REPO, MODEL_RELEASE_TAG)?;
                let root = data.join("models").join("aletheia-lens").join("1");
                if crate::inference::decensor::bundle_in(&root).is_some() {
                    return Ok(());
                }
                if root.exists() {
                    return Err("去码模型安装目录已存在但不完整，请重新导入完整模型包".into());
                }
                let staging = root.with_file_name(".1.installing");
                let _ = std::fs::remove_dir_all(&staging);
                std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
                let result = (|| {
                    for asset in &manifest.assets {
                        let target = staging.join(
                            asset
                                .path
                                .replace('/', &std::path::MAIN_SEPARATOR.to_string()),
                        );
                        if let Some(parent) = target.parent() {
                            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                        }
                        let mut configured_asset = asset.clone();
                        configured_asset.direct_url = configured_asset
                            .direct_url
                            .clone()
                            .or_else(|| aletheia_direct_url(asset));
                        download_asset_with_fallback(
                            MODEL_RELEASE_REPO,
                            &manifest.tag,
                            &configured_asset,
                            &target,
                        )?;
                    }
                    std::fs::write(
                        staging.join("release-manifest.json"),
                        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                    install_staging_dir(&staging, &root)
                })();
                if result.is_err() {
                    let _ = std::fs::remove_dir_all(&staging);
                }
                result
            }
            // Anything else is a hosted upscaler: the settings list offers the
            // catalog's models, and downloading one is an ordinary install.
            other => install_hosted_upscale_model(app, &data, other),
        });
    match result {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(e) => crate::domain::result::CommandResult::failure("MODEL_DOWNLOAD_FAILED", e, true),
    }
}

#[tauri::command(async)]
pub fn model_release_download(
    app: tauri::AppHandle,
    input: ModelDownloadInput,
) -> crate::domain::result::CommandResult<()> {
    let destination = std::path::PathBuf::from(input.destination);
    if !destination.is_absolute() {
        return crate::domain::result::CommandResult::failure(
            "INVALID_INPUT",
            "destination must be absolute",
            false,
        );
    }
    match download_asset_with_progress(
        &input.url,
        &input.asset,
        &destination,
        |completed, total| {
            let _ = tauri::Emitter::emit(
                &app,
                "model-download-progress",
                serde_json::json!({"path": input.asset.path, "completed": completed, "total": total}),
            );
        },
    ) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => {
            crate::domain::result::CommandResult::failure("MODEL_DOWNLOAD_FAILED", error, true)
        }
    }
}

#[tauri::command]
pub fn model_release_cancel(destination: String) -> crate::domain::result::CommandResult<()> {
    cancelled().lock().unwrap().mark(destination);
    crate::domain::result::CommandResult::success(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImportInput {
    pub root: String,
    pub manifest: ModelReleaseManifest,
}

#[tauri::command(async)]
pub fn model_release_validate_import(
    input: ModelImportInput,
) -> crate::domain::result::CommandResult<()> {
    match validate_import_directory(std::path::Path::new(&input.root), &input.manifest) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => {
            crate::domain::result::CommandResult::failure("INVALID_MODEL_IMPORT", error, false)
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArchiveImportInput {
    pub archive: Vec<u8>,
    pub manifest: ModelReleaseManifest,
}

#[tauri::command(async)]
pub fn model_release_validate_archive(
    app: tauri::AppHandle,
    input: ModelArchiveImportInput,
) -> crate::domain::result::CommandResult<()> {
    match crate::data_paths::data_dir(&app)
        .map_err(|error| error.to_string())
        .and_then(|data| validate_import_archive(&input.archive, &input.manifest, &data))
    {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => {
            crate::domain::result::CommandResult::failure("INVALID_MODEL_IMPORT", error, false)
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLocalImportInput {
    pub path: String,
    pub manifest: ModelReleaseManifest,
}

#[tauri::command(async)]
pub fn model_release_validate_local(
    app: tauri::AppHandle,
    input: ModelLocalImportInput,
) -> crate::domain::result::CommandResult<()> {
    let path = std::path::Path::new(&input.path);
    let result = if path.is_dir() {
        validate_import_directory(path, &input.manifest)
    } else if path.is_file() {
        crate::data_paths::data_dir(&app)
            .map_err(|error| error.to_string())
            .and_then(|data| {
                std::fs::read(path)
                    .map_err(|e| e.to_string())
                    .and_then(|bytes| validate_import_archive(&bytes, &input.manifest, &data))
            })
    } else {
        Err("model path does not exist".into())
    };
    match result {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => {
            crate::domain::result::CommandResult::failure("INVALID_MODEL_IMPORT", error, false)
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelActivateInput {
    pub staging: String,
    pub install: String,
}

#[tauri::command(async)]
pub fn model_release_activate(
    input: ModelActivateInput,
) -> crate::domain::result::CommandResult<()> {
    match activate_import_directory(
        std::path::Path::new(&input.staging),
        std::path::Path::new(&input.install),
    ) {
        Ok(()) => crate::domain::result::CommandResult::success(()),
        Err(error) => {
            crate::domain::result::CommandResult::failure("MODEL_ACTIVATION_FAILED", error, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn asset() -> ReleaseAsset {
        ReleaseAsset {
            role: "detector".into(),
            path: "mrcnn/weights.onnx".into(),
            download_name: None,
            size: 4,
            sha256: format!("{:x}", Sha256::digest(b"test")),
            companions: vec![],
            direct_url: None,
        }
    }
    #[test]
    fn rejects_absolute_and_non_normal_asset_and_companion_paths() {
        for path in [
            "C:/outside",
            "C:relative",
            "../outside",
            "weights/../outside",
            "/outside",
            "weights\\outside",
            "",
            "weights//data",
            "weights/",
            "./weights",
            "weights/./data",
            "weights:data",
        ] {
            let mut invalid_asset = asset();
            invalid_asset.path = path.into();
            assert!(
                validate_manifest(&ModelReleaseManifest {
                    tag: "v1".into(),
                    assets: vec![invalid_asset]
                })
                .is_err(),
                "accepted asset path: {path}"
            );
            let mut invalid_companion = asset();
            invalid_companion.companions.push(path.into());
            assert!(
                validate_manifest(&ModelReleaseManifest {
                    tag: "v1".into(),
                    assets: vec![invalid_companion]
                })
                .is_err(),
                "accepted companion path: {path}"
            );
        }
        let mut valid = asset();
        valid.companions.push("mrcnn/weights.onnx.data".into());
        assert!(validate_manifest(&ModelReleaseManifest {
            tag: "v1".into(),
            assets: vec![valid]
        })
        .is_ok());

        let mut flat_asset = asset();
        flat_asset.download_name = Some("mrcnn-weights.onnx".into());
        assert!(validate_manifest(&ModelReleaseManifest {
            tag: "v1".into(),
            assets: vec![flat_asset]
        })
        .is_ok());
        let mut unsafe_download_name = asset();
        unsafe_download_name.download_name = Some("mrcnn/weights.onnx".into());
        assert!(validate_manifest(&ModelReleaseManifest {
            tag: "v1".into(),
            assets: vec![unsafe_download_name]
        })
        .is_err());
    }

    #[test]
    fn release_url_command_returns_the_bridge_envelope() {
        let response = model_release_url("".into(), "o/r".into(), "v1".into(), "m.onnx".into());
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "ok": true,
                "value": "https://github.com/o/r/releases/download/v1/m.onnx",
            })
        );
    }
    #[test]
    fn builds_direct_url() {
        assert_eq!(
            asset_url("", "o/r", "v1", "m.onnx"),
            "https://github.com/o/r/releases/download/v1/m.onnx"
        );
    }
    #[test]
    fn builds_mirror_url_without_double_slash() {
        assert_eq!(
            asset_url("https://gh-proxy.com/", "o/r", "v1", "m.onnx"),
            "https://gh-proxy.com/https://github.com/o/r/releases/download/v1/m.onnx"
        );
    }
    #[test]
    fn the_default_model_source_is_the_standalone_repository() {
        assert_eq!(MODEL_RELEASE_REPO, "Kelcoin/Yomika-Models");
        assert_eq!(MODEL_RELEASE_TAG, "models-v1");
    }

    fn catalog_file(name: &str) -> UpscaleCatalogFile {
        UpscaleCatalogFile {
            name: name.into(),
            size: 4,
            sha256: format!("{:x}", Sha256::digest(b"test")),
            direct_url: None,
        }
    }

    fn catalog_model(id: &str) -> UpscaleCatalogModel {
        UpscaleCatalogModel {
            id: id.into(),
            label: "Real-ESRGAN".into(),
            scale: 4,
            version: "2026.09.20".into(),
            source: Some("https://huggingface.co/anakhiu/realesrgan-onnx".into()),
            min_input_edge: None,
            files: vec![
                catalog_file(&format!("{id}.onnx")),
                catalog_file(&format!("{id}--LICENSE.txt")),
            ],
        }
    }

    fn catalog(models: Vec<UpscaleCatalogModel>) -> UpscaleCatalog {
        UpscaleCatalog {
            tag: MODEL_RELEASE_TAG.into(),
            models,
        }
    }

    #[test]
    fn accepts_a_catalog_of_installable_models() {
        assert!(validate_upscale_catalog(&catalog(vec![catalog_model(
            "realcugan-2x-conservative"
        )]))
        .is_ok());
    }

    /// What a download writes next to the graph decides whether the model can run
    /// at all: no scale and the upscaler cannot size its output; a hash that is not
    /// the graph's and a later validation rejects an install that is actually
    /// fine. Both are invisible until a page is upscaled.
    #[test]
    fn a_catalog_entry_becomes_a_runnable_model_manifest() {
        let model = catalog_model("realcugan-2x-conservative");
        let manifest = hosted_model_manifest(&model).expect("manifest");
        assert_eq!(manifest.id, "realcugan-2x-conservative");
        assert_eq!(manifest.version, "2026.09.20");
        assert_eq!(manifest.format, "onnx");
        assert_eq!(manifest.scale, 4);
        assert_eq!(manifest.max_pixels, crate::inference::DEFAULT_MAX_PIXELS);
        assert_eq!(manifest.supported_backends, vec!["cpu".to_string()]);
        // The digest has to be the graph's own, not the license file's that
        // happens to sit beside it.
        assert_eq!(
            manifest.sha256,
            model.model_file().expect("graph").sha256.to_ascii_lowercase()
        );

        // An entry with no graph cannot be turned into an install.
        let mut graphless = catalog_model("m");
        graphless.files = vec![catalog_file("m--LICENSE.txt")];
        assert!(hosted_model_manifest(&graphless).is_err());
    }

    /// The layout the downloader writes has to be the layout the upscaler looks
    /// in, or a model downloads successfully and never shows up in the picker.
    /// Discovery reads the directory rather than the graph, so the bytes here can
    /// be a placeholder — that the published digests match the real files is the
    /// fixture test's job.
    #[test]
    fn the_installed_layout_is_the_one_the_upscaler_looks_for() {
        let data = tempfile::tempdir().unwrap();
        let model = catalog_model("realesr-general-x4v3");
        let (staging, root) =
            crate::inference::model_install_roots(data.path(), &model.id, &model.version)
                .expect("install roots");
        assert_eq!(
            staging,
            data.path()
                .join("models/realesr-general-x4v3/.2026.09.20.installing")
        );
        std::fs::create_dir_all(&root).unwrap();
        for file in &model.files {
            std::fs::write(root.join(&file.name), b"placeholder").unwrap();
        }
        std::fs::write(
            root.join(crate::inference::MODEL_MANIFEST_FILE),
            serde_json::to_vec_pretty(&hosted_model_manifest(&model).unwrap()).unwrap(),
        )
        .unwrap();

        let listed = crate::inference::installed_models_in(data.path());
        let installed = listed
            .iter()
            .find(|entry| entry.id == model.id)
            .expect("installed model");
        assert_eq!(installed.version, "2026.09.20");
        assert_eq!(installed.scale, Some(4));
        assert_eq!(installed.kind, crate::inference::MODEL_KIND_UPSCALE);
        assert_eq!(
            crate::inference::model_file_in(&root),
            Some(root.join("realesr-general-x4v3.onnx")),
            "the graph is not where the resolver looks for it"
        );
    }

    /// The whole download path, against the live catalog — everything the
    /// command does except the Tauri plumbing, which is why this is the one test
    /// that would have caught a wrong asset URL, a stale digest or an install
    /// layout the resolver does not read. Both catalog entries are walked, and
    /// both are files this project converted from the official weights rather
    /// than downloads of someone else's export.
    ///
    /// Ignored by default: it needs the network and pulls ~10 MB. Run it after
    /// anything on the publishing side changes:
    ///
    /// ```text
    /// cargo test --lib -- --ignored the_hosted_model_downloads_installs_and_runs
    /// ```
    #[test]
    #[ignore = "needs the network: fetches the hosted catalog and both models"]
    fn the_hosted_model_downloads_installs_and_runs() {
        for model_id in HOSTED_UPSCALE_MODEL_IDS {
            the_hosted_model_downloads_installs_and_runs_once(model_id);
        }
    }

    fn the_hosted_model_downloads_installs_and_runs_once(model_id: &str) {
        use crate::inference::upscale::UpscaleEngine;

        let catalog = fetch_upscale_catalog_with_fallback(MODEL_RELEASE_REPO)
            .expect("live catalog is reachable");
        let model = catalog
            .models
            .iter()
            .find(|model| model.id == model_id)
            .unwrap_or_else(|| panic!("{model_id} is still published"));

        let data = tempfile::tempdir().unwrap();
        let (staging, root) =
            crate::inference::model_install_roots(data.path(), &model.id, &model.version).unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        for file in &model.files {
            let asset = ReleaseAsset {
                role: "upscale".into(),
                path: file.name.clone(),
                download_name: Some(file.name.clone()),
                size: file.size,
                sha256: file.sha256.clone(),
                companions: Vec::new(),
                direct_url: file.direct_url.clone(),
            };
            // The same call the command makes, digests and size included: a
            // published file that no longer matches its manifest fails here.
            download_asset_with_fallback_progress(
                MODEL_RELEASE_REPO,
                &catalog.tag,
                &asset,
                &staging.join(&file.name),
                |_, _| {},
            )
            .unwrap_or_else(|error| panic!("downloading {} failed: {error}", file.name));
        }
        let manifest = hosted_model_manifest(model).unwrap();
        std::fs::write(
            staging.join(crate::inference::MODEL_MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        install_staging_dir(&staging, &root).unwrap();

        // Now from the outside: the model has to be discoverable, resolvable and
        // actually able to upscale a tile.
        let listed = crate::inference::listed_upscale_models_in(data.path());
        let installed = listed
            .iter()
            .find(|entry| entry.id == model.id)
            .expect("the installed model is listed");
        assert_eq!(installed.scale, Some(model.scale), "the install lost its scale");
        let graph = crate::inference::model_file_in(&root).expect("one graph in the install");
        assert_eq!(graph.file_name().unwrap(), format!("{model_id}.onnx").as_str());

        let engine = crate::inference::onnx::OnnxEngine::open(
            &graph,
            manifest.scale,
            64_000_000,
            manifest.min_input_edge,
        )
        .expect("the downloaded graph loads");
        assert_eq!(
            manifest.min_input_edge,
            model.min_input_edge.unwrap_or(1),
            "the catalog's minimum edge has to reach the installed manifest, or the \
             engine will hand a page-edge strip to a graph that cannot take it"
        );
        // A tile at the floor, so a model with a declared minimum is exercised on
        // the size it will actually see rather than one it tolerates.
        let edge = manifest.min_input_edge.max(16);
        let rgba: Vec<u8> = (0..edge * edge)
            .flat_map(|index| {
                [
                    (index % edge * 255 / edge) as u8,
                    (index / edge * 255 / edge) as u8,
                    128,
                    200,
                ]
            })
            .collect();
        let output = engine.upscale_tile(&rgba, edge, edge).expect("upscale");
        assert_eq!(output.len(), (edge * manifest.scale * edge * manifest.scale * 4) as usize);
        assert!(output.chunks_exact(4).all(|pixel| pixel[3] == 200));
    }

    #[test]
    fn rejects_catalog_entries_that_could_not_be_installed() {
        // A model whose id is not a directory name.
        let mut bad_id = catalog_model("realesr-general-x4v3");
        bad_id.id = "../escape".into();
        assert!(validate_upscale_catalog(&catalog(vec![bad_id])).is_err());

        // No scale: the model could be installed but never run.
        let mut no_scale = catalog_model("m");
        no_scale.scale = 0;
        assert!(validate_upscale_catalog(&catalog(vec![no_scale])).is_err());

        // Two graphs: `model_file_in` refuses such an install, so a finished
        // download would be unusable.
        let mut two_graphs = catalog_model("m");
        two_graphs.files.push(catalog_file("m.extra.onnx"));
        assert!(validate_upscale_catalog(&catalog(vec![two_graphs])).is_err());

        // No graph at all.
        let mut no_graph = catalog_model("m");
        no_graph.files = vec![catalog_file("m--LICENSE.txt")];
        assert!(validate_upscale_catalog(&catalog(vec![no_graph])).is_err());

        // Plain HTTP upstream, and a file name that escapes the install root.
        let mut insecure = catalog_model("m");
        insecure.files[0].direct_url = Some("http://example.com/m.onnx".into());
        assert!(validate_upscale_catalog(&catalog(vec![insecure])).is_err());
        let mut escaping = catalog_model("m");
        escaping.files[0].name = "sub/../m.onnx".into();
        assert!(validate_upscale_catalog(&catalog(vec![escaping])).is_err());

        // The same model twice is one install fighting over one directory.
        assert!(
            validate_upscale_catalog(&catalog(vec![catalog_model("m"), catalog_model("m")]))
                .is_err()
        );
    }

    #[test]
    fn the_catalog_urls_fall_back_to_the_mirrors() {        let urls = upscale_catalog_urls(MODEL_RELEASE_REPO);
        assert_eq!(
            urls[0],
            "https://raw.githubusercontent.com/Kelcoin/Yomika-Models/main/upscale-manifest.json"
        );
        assert!(urls
            .iter()
            .any(|url| url.starts_with("https://gh-proxy.com/https://raw.githubusercontent.com/")));
    }

    /// The manifest published to the model repository has to satisfy the checks
    /// the downloader applies, or every install fails at validation instead of at
    /// the network — the failure would surface as "no download source" for a model
    /// that is present. The local fixture is the published bytes.
    #[test]
    fn the_published_catalog_validates_and_matches_the_local_fixtures() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/models/upscale-manifest.json");
        let Ok(bytes) = std::fs::read(&path) else {
            eprintln!("skipping: {} is not present", path.display());
            return;
        };
        let catalog: UpscaleCatalog =
            serde_json::from_slice(&bytes).expect("published catalog is valid JSON");
        validate_upscale_catalog(&catalog).expect("published catalog is installable");
        assert_eq!(catalog.tag, MODEL_RELEASE_TAG);
        assert_eq!(
            catalog
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            HOSTED_UPSCALE_MODEL_IDS,
            "the catalog and the ids the engine test runs have drifted apart"
        );
        // Every digest is the digest of the fixture it names, so the published
        // hash is the hash of the bytes that were actually run.
        let directory = path.parent().expect("fixture directory");
        for model in &catalog.models {
            for file in &model.files {
                let fixture = directory.join(&file.name);
                let Ok(bytes) = std::fs::read(&fixture) else {
                    eprintln!("skipping hashes: {} is not present", fixture.display());
                    continue;
                };
                assert_eq!(
                    bytes.len() as u64,
                    file.size,
                    "size mismatch for {}",
                    file.name
                );
                assert_eq!(
                    format!("{:x}", Sha256::digest(&bytes)),
                    file.sha256.to_ascii_lowercase(),
                    "sha256 mismatch for {}",
                    file.name
                );
            }
        }
    }
    #[test]
    fn manifest_urls_try_the_repo_body_before_release_assets() {
        let urls = manifest_urls("Kelcoin/Yomika-Models", "models-v1");
        assert_eq!(
            urls[0],
            "https://raw.githubusercontent.com/Kelcoin/Yomika-Models/main/manifest.json"
        );
        // Mirror prefixes ride on the raw body URL, then the release asset with
        // its own mirror chain.
        assert!(urls.iter().any(|url| url.starts_with("https://gh-proxy.com/https://raw.githubusercontent.com/")));
        assert!(urls.iter().any(|url| url.ends_with("/releases/download/models-v1/models-v1.manifest.json")));
        assert!(urls.iter().any(|url| url.starts_with("https://ghfast.top/https://github.com/")));
    }
    #[test]
    fn verifies_size_and_digest() {
        assert!(verify_bytes(&asset(), b"test").is_ok());
        assert!(verify_bytes(&asset(), b"bad").is_err());
    }
    #[test]
    fn rejects_duplicate_or_unsafe_paths() {
        let mut a = asset();
        a.path = "../x".into();
        assert!(validate_manifest(&ModelReleaseManifest {
            tag: "v1".into(),
            assets: vec![a]
        })
        .is_err());
    }
    #[test]
    fn validates_import_directory() {
        let root = std::env::temp_dir().join("yomika-release-import");
        let _ = std::fs::create_dir_all(&root);
        std::fs::write(root.join("m.onnx"), b"test").unwrap();
        let mut a = asset();
        a.path = "m.onnx".into();
        assert!(validate_import_directory(
            &root,
            &ModelReleaseManifest {
                tag: "v1".into(),
                assets: vec![a]
            }
        )
        .is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_cancel_table_stays_bounded_and_consumes_a_flag_on_read() {
        let mut table = CancelledDownloads::default();
        for index in 0..MAX_CANCELLED_DOWNLOADS + 16 {
            table.mark(format!("download-{index}.part"));
        }
        assert!(
            table.len() <= MAX_CANCELLED_DOWNLOADS,
            "取消表条数 {} 超过上限 {MAX_CANCELLED_DOWNLOADS}",
            table.len()
        );
        assert!(
            !table.take("download-0.part"),
            "最早的取消标记应已被淘汰"
        );
        assert!(
            table.take(&format!("download-{}.part", MAX_CANCELLED_DOWNLOADS + 15)),
            "最近的取消标记应还在"
        );
        assert!(
            !table.take(&format!("download-{}.part", MAX_CANCELLED_DOWNLOADS + 15)),
            "读到即消费：同一个标记只能中断一次下载"
        );
        table.clear("download-1.part");
        assert!(!table.take("download-1.part"));
    }
}
