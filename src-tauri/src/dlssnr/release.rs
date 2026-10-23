//! DLSSNR 片段的目录：三种变体在模型仓库里各自一份，用户自己挑一种。
//!
//! 片段（`nvngx_dlssnr.dll`）按名字固定地住在数据目录的 `dlssnr/` 下——NGX 核心就是按
//! 这个名字在搜索路径里找它的，所以「正在用」的那一份永远是固定名。用户装过的每一种各
//! 在 `dlssnr/variants/` 下占一份（文件名就是清单里的资产名），下载 / 导入先落库、再复制
//! 到固定名上，切换也走同一条复制：谁也不顶掉谁。
//!
//! 「能选哪些」这件事由清单来说：仓库正文的 `dlssnr-manifest.json` 一条变体一条，各自
//! 记着自己的字节数与 SHA-256。官方原版与Lecram 版因此可以分开维护——用户点哪一条就装
//! 哪一条，装过的都留在库里。
//!
//! 和超分模型那套走同一条路：`raw.githubusercontent.com` 上的本体文件 → 镜像前缀
//! → Release 资产，逐条回退；下载完先校验，再收进变体库、复制到固定名上。

use serde::{Deserialize, Serialize};

use crate::model_release::{
    asset_url, download_asset_with_progress, safe_segment, ReleaseAsset, MIRROR_PRESETS,
    MODEL_RELEASE_REPO,
};

use super::{dll_path, file_sha256, installed_variant, require_valid_snippet, variant_of, InstalledDll, SnippetTrust};

/// 仓库正文里这份清单的文件名（与 `manifest.json` / `upscale-manifest.json` 同规矩）。
pub const CATALOG_FILE: &str = "dlssnr-manifest.json";

/// 清单里的一条变体：装哪一种、从哪里取、取回来该是什么。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVariant {
    /// 变体 id（`official` / `community` / `sf-v2`）。
    pub id: String,
    /// 设置页显示的名字。
    pub label: String,
    /// 一句话说明这一条是谁用的（哪一代卡、什么取舍）。
    #[serde(default)]
    pub note: String,
    /// 这一条面向哪几代卡，只作说明与「推荐」提示。
    #[serde(default)]
    pub series: Vec<u32>,
    /// Release 资产的平铺文件名（下载完落到 `dlssnr/nvngx_dlssnr.dll`）。
    pub asset: String,
    pub size: u64,
    pub sha256: String,
}

/// 片段内嵌的 NVIDIA DLSS SDK 许可（要求随包分发全文的那一份）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLicense {
    pub name: String,
    pub asset: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DlssnrCatalog {
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<CatalogLicense>,
    pub variants: Vec<CatalogVariant>,
}

impl DlssnrCatalog {
    pub fn variant(&self, id: &str) -> Option<&CatalogVariant> {
        self.variants.iter().find(|variant| variant.id == id)
    }

    /// 目录里的 id 列表，出错时用来告诉用户有哪些可选。
    fn ids(&self) -> String {
        self.variants
            .iter()
            .map(|variant| variant.id.as_str())
            .collect::<Vec<_>>()
            .join(" / ")
    }
}

/// 一条目要能下载、能落地才收：id 与资产名都当文件名用，哈希要 64 位十六进制。
pub fn validate_catalog(catalog: &DlssnrCatalog) -> Result<(), String> {
    if catalog.tag.is_empty() || catalog.variants.is_empty() {
        return Err("dlssnr catalog tag/variants missing".into());
    }
    let mut ids = std::collections::HashSet::new();
    for variant in &catalog.variants {
        if !safe_segment(&variant.id) {
            return Err(format!("unsafe variant id {}", variant.id));
        }
        // 资产名是平铺的 Release 文件名，下载时也会当落盘名用。
        if !safe_segment(&variant.asset) {
            return Err(format!("unsafe asset name {}", variant.asset));
        }
        if variant.label.trim().is_empty() {
            return Err(format!("variant {} has no label", variant.id));
        }
        if variant.size == 0 || !is_sha256(&variant.sha256) {
            return Err(format!("invalid size/hash for {}", variant.id));
        }
        // 按名字固定的一份文件，两条同 id 就是两个说法打架。
        if !ids.insert(variant.id.clone()) {
            return Err(format!("duplicate variant {}", variant.id));
        }
    }
    if let Some(license) = &catalog.license {
        if !safe_segment(&license.asset) || license.size == 0 || !is_sha256(&license.sha256) {
            return Err(format!("invalid license entry {}", license.asset));
        }
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 取清单的地方：仓库正文的原始文件，再逐个镜像前缀。与超分目录同一套顺序。
pub fn catalog_urls(owner_repo: &str) -> Vec<String> {
    let raw = format!("https://raw.githubusercontent.com/{owner_repo}/main/{CATALOG_FILE}");
    let mut urls = vec![raw.clone()];
    for (_, prefix) in MIRROR_PRESETS.iter().filter(|(id, _)| *id != "direct") {
        urls.push(format!("{prefix}{raw}"));
    }
    urls
}

pub fn fetch_catalog_with_fallback(owner_repo: &str) -> Result<DlssnrCatalog, String> {
    let mut errors = Vec::new();
    for url in catalog_urls(owner_repo) {
        match reqwest::blocking::get(&url).and_then(|response| response.error_for_status()) {
            Ok(response) => match response.json::<DlssnrCatalog>() {
                Ok(catalog) => match validate_catalog(&catalog) {
                    Ok(()) => return Ok(catalog),
                    Err(error) => errors.push(format!("{url}: {error}")),
                },
                Err(error) => errors.push(format!("{url}: {error}")),
            },
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(format!(
        "all dlssnr catalog sources failed: {}",
        errors.join("; ")
    ))
}

/// 数据目录里装的是哪一条（按字节数与 SHA-256 认，认不出就是 `None`）。
///
/// 只认得出内置表里的那三种——正是目录里的三条。清单日后加了新变体，它需要跟着
/// 更新内置表才认得出「使用中」。
pub fn installed_id(data_dir: &std::path::Path) -> Option<String> {
    installed_variant(data_dir).map(|(variant, _)| variant.id().to_string())
}

/// 重下一遍、或者库里那份认不出是哪一种时，就用这个名字收着。
const CUSTOM_ASSET: &str = "nvngx_dlssnr--custom.dll";

/// 变体库：装过的每一种各占一份，文件名就是它的资产名。
///
/// 固定名那一份（[`dll_path`]）永远是「正在用」的那一份的**副本**：NGX 核心按名字找
/// `nvngx_dlssnr.dll`，所以换一种只能是往固定名上复制，库里那份得原样留着——用户才能
/// 随时切回去。
pub fn library_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("dlssnr").join("variants")
}

/// 库里的某一份（`asset` 是资产名，例如 `nvngx_dlssnr--official.dll`）。
pub fn library_file(data_dir: &std::path::Path, asset: &str) -> std::path::PathBuf {
    library_dir(data_dir).join(asset)
}

/// 库里的一个文件认出来的样子。认不出是哪一种也列出来（清单之外的自定义片段照样能用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledVariant {
    /// 内置表认出来的变体 id（`official` / `community` / `sf-v2`）；认不出是 `None`。
    pub id: Option<String>,
    /// 设置页显示的名字；认不出是 `None`。
    pub label: Option<String>,
    pub bytes: u64,
    /// 现在固定名那份就是它（内容完全相同）。
    pub active: bool,
    /// 库里的文件名（不含目录）。
    pub file: String,
    pub sha256: Option<String>,
    pub version: Option<String>,
}

/// 库里装过的每一种，按文件名排序（顺序稳定，设置页不用自己排）。
///
/// 「正在用」= 与固定名那份**内容哈希相同**的那一条：拿字节数比不行——官方原版与
/// Lecram 版一样大（见 `docs/144`），只有哈希分得开。
pub fn installed_variants(data_dir: &std::path::Path) -> Vec<InstalledVariant> {
    let active = active_fingerprint(data_dir);
    let mut variants = Vec::new();
    let Ok(entries) = std::fs::read_dir(library_dir(data_dir)) else {
        return variants;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|value| value.to_str()) {
            Some(name) if is_library_asset(name) && path.is_file() => name.to_string(),
            _ => continue,
        };
        let bytes = std::fs::metadata(&path).map(|value| value.len()).unwrap_or(0);
        let digest = file_sha256(&path);
        let variant = digest
            .as_deref()
            .and_then(|digest| variant_of(bytes as usize, digest));
        let in_use = match (&active, digest.as_deref()) {
            (Some((active_bytes, active_digest)), Some(digest)) => {
                *active_bytes == bytes && active_digest == digest
            }
            _ => false,
        };
        variants.push(InstalledVariant {
            id: variant.map(|value| value.id().to_string()),
            label: variant.map(|value| value.label().to_string()),
            bytes,
            active: in_use,
            file: name,
            sha256: digest,
            version: super::dll_version(&path),
        });
    }
    variants.sort_by(|left, right| left.file.cmp(&right.file));
    let mut seen = std::collections::HashSet::new();
    variants.retain(|variant| variant.sha256.as_ref().is_none_or(|sha| seen.insert(sha.clone())));
    variants
}

/// 固定名那份的（字节数，SHA-256）；还没装就是 `None`。
fn active_fingerprint(data_dir: &std::path::Path) -> Option<(u64, String)> {
    let target = dll_path(data_dir);
    let bytes = std::fs::metadata(&target).ok()?.len();
    Some((bytes, file_sha256(&target)?))
}

/// 库里的文件名是不是这个库该管的那些（`nvngx_dlssnr--*.dll`，且是单个安全路径段）。
fn is_library_asset(name: &str) -> bool {
    name.starts_with("nvngx_dlssnr--") && name.ends_with(".dll") && safe_segment(name)
}

/// 一份字节在库里该叫什么名字。
///
/// 认得出是哪一种就用它的资产名（`nvngx_dlssnr--<id>.dll`）——下载与导入两条路因此落到
/// 同一个文件上，**一个变体只占一份**。认不出来才轮到 `preferred`（下载时是清单给的资产
/// 名：清单日后加的新变体就是这么落库的），再不然就当自定义的一份收着。
fn library_asset_name(bytes: u64, digest: Option<&str>, preferred: Option<&str>) -> String {
    if let Some(id) = digest.and_then(|digest| variant_of(bytes as usize, digest).map(|value| value.id()))
    {
        return format!("nvngx_dlssnr--{id}.dll");
    }
    match preferred {
        Some(name) if is_library_asset(name) => name.to_string(),
        _ => CUSTOM_ASSET.to_string(),
    }
}

// Keep legacy names readable, but never replace different bytes at the same name.
// Downloads, imports and older installations all share this identity rule.
fn library_target(source: &std::path::Path, data_dir: &std::path::Path, preferred: Option<&str>) -> Result<std::path::PathBuf, String> {
    let digest = file_sha256(source).ok_or_else(|| "无法读取 DLL 指纹".to_string())?;
    for installed in installed_variants(data_dir) {
        if installed.sha256.as_deref() == Some(digest.as_str()) {
            return Ok(library_file(data_dir, &installed.file));
        }
    }
    let bytes = std::fs::metadata(source).map_err(|error| error.to_string())?.len();
    let name = library_asset_name(bytes, Some(&digest), preferred);
    let target = library_file(data_dir, &name);
    if !target.exists() { return Ok(target); }
    Ok(library_file(data_dir, &format!("{}--{digest}.dll", name.trim_end_matches(".dll"))))
}

/// 把校验过的暂存文件**改名**进库（下载那条路：暂存文件不留），返回库里的路径。
fn move_into_library(
    staged: &std::path::Path,
    data_dir: &std::path::Path,
    preferred: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let target = library_target(staged, data_dir, preferred)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("建目录失败：{error}"))?;
    }
    if target.exists() {
        std::fs::remove_file(staged).map_err(|error| error.to_string())?;
        return Ok(target);
    }
    std::fs::rename(staged, &target)
        .map_err(|error| format!("收进变体库失败：{error}（{}）", target.display()))?;
    Ok(target)
}

/// 把一份片段**复制**进库（导入那条路：源文件是用户给的，不能动），返回库里的路径。
pub fn copy_into_library(
    source: &std::path::Path,
    data_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let preferred = source.file_name().and_then(|value| value.to_str());
    let target = library_target(source, data_dir, preferred)?;
    if target.exists() { return Ok(target); }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("建目录失败：{error}"))?;
    }
    std::fs::copy(source, &target)
        .map_err(|error| format!("收进变体库失败：{error}（{}）", target.display()))?;
    Ok(target)
}

/// 把库里的那一份复制到固定名上（**不是改名**：库那份必须留着）。
///
/// Windows 上正在被这个进程加载的 DLL 挡得住改名/覆盖（拒绝访问 / 共享冲突），所以失败
/// 时先删再复制——已被映射的镜像允许删除，真正危险的是把原来那份弄丢：两个动作都失败就
/// 原样报错，库里那份留着，用户重启应用再切一次即可。
fn copy_into_place(source: &std::path::Path, data_dir: &std::path::Path) -> Result<(), String> {
    let target = dll_path(data_dir);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("建目录失败：{error}"))?;
    }
    let mut last = match std::fs::copy(source, &target) {
        Ok(_) => return Ok(()),
        Err(error) => error,
    };
    if matches!(last.raw_os_error(), Some(5) | Some(32) | Some(33)) {
        // 旧的那份正被用着：先摘掉它，再让新的就位。
        if std::fs::remove_file(&target).is_ok() {
            match std::fs::copy(source, &target) {
                Ok(_) => return Ok(()),
                Err(error) => last = error,
            }
        }
    }
    Err(format!(
        "换不了 {}：{last}。如果应用正在用它，重启应用后再试。",
        target.display()
    ))
}

/// 把库里已经装过的那一种换成正在用的那一份，返回与安装路径同形状的结果。
///
/// 认得出的按变体 id 找；**认不出的按库里的完整文件名找**——界面给这种片段的按钮发的是
/// 文件名（它没有 id 可发），没有这条兜底它会永远切不过去。找不到就直接报错，**固定名那份
/// 一个字节都不碰**：切换失败不该把用户现在能用的那份弄没。
pub fn activate_variant(
    data_dir: &std::path::Path,
    variant_id: &str,
) -> Result<InstalledDll, String> {
    let library = installed_variants(data_dir);
    let Some(found) = library
        .iter()
        .find(|variant| variant.id.as_deref() == Some(variant_id) || variant.file == variant_id)
    else {
        let known = library
            .iter()
            .map(|variant| variant.id.clone().unwrap_or_else(|| variant.file.clone()))
            .collect::<Vec<_>>();
        return Err(format!(
            "库里没有 {variant_id} 这一种（现有：{}）",
            if known.is_empty() {
                "空".to_string()
            } else {
                known.join(" / ")
            }
        ));
    };
    if dll_path(data_dir).is_file() { copy_into_library(&dll_path(data_dir), data_dir)?; }
    copy_into_place(&library_file(data_dir, &found.file), data_dir)?;
    // 文件名没变、内容变了：进程内记住的那份指纹要作废（与安装那条路同一条理由）。
    super::forget_fingerprint();
    let target = dll_path(data_dir);
    let bytes = std::fs::metadata(&target).map(|value| value.len()).unwrap_or(0);
    let variant = installed_variant(data_dir).map(|(variant, _)| variant);
    Ok(InstalledDll {
        bytes,
        variant: variant.map(|value| value.id().to_string()),
        variant_label: variant.map(|value| value.label().to_string()),
        version: super::dll_version(&target),
    })
}

/// 校验一个刚落盘的文件：字节数与 SHA-256 都要对上清单。
fn verify_file(path: &std::path::Path, size: u64, sha256: &str) -> Result<(), String> {
    let actual = std::fs::metadata(path).map_err(|error| error.to_string())?.len();
    if actual != size {
        return Err(format!("{} 应为 {size} 字节，实际 {actual}", path.display()));
    }
    let digest = file_sha256(path).ok_or_else(|| format!("读不出 {}", path.display()))?;
    if digest != sha256.to_ascii_lowercase() {
        return Err(format!("{} 的 SHA-256 与清单不符", path.display()));
    }
    Ok(())
}

/// 把已经校验过的暂存文件装进数据目录，并报出装的是哪一种。
///
/// 「校验过」说的是字节数与 SHA-256 对得上清单；**签名**从 2026-10-17 起不再拦——清单
/// 里那两条社区变体是签过名再被改过的（`docs/144`），旧卡只有它们能用 NR，而签名门本来
/// 就在 NVIDIA 核心那一步。现在拦的是「装上去也用不了」：结构不对、缺导出（见
/// `require_valid_snippet`）。签名结论照旧由 [`signature_verdict`] 报给设置页。
fn install_staged(staged: &std::path::Path, data_dir: &std::path::Path) -> Result<InstalledDll, String> {
    install_staged_with(staged, data_dir, SnippetTrust::Required)
}

/// 带策略的那一支：产品的下载路径走 [`SnippetTrust::Required`]，下面那几个拿合成字节
/// 当夹具的用例显式跳过（它们问的是「就位与认变体」那条路径，不问结构与导出）。
fn install_staged_with(
    staged: &std::path::Path,
    data_dir: &std::path::Path,
    trust: SnippetTrust,
) -> Result<InstalledDll, String> {
    if trust == SnippetTrust::Required {
        require_valid_snippet(staged)?;
    }
    // 先落库（每一种装过的都得留着，「切换」才有东西可切），再把库里那一份复制到固定名。
    let preferred = staged.file_name().and_then(|value| value.to_str());
    let library = move_into_library(staged, data_dir, preferred)?;
    copy_into_place(&library, data_dir)?;
    // 文件名没变、内容变了：进程内记住的那份指纹（产物身份与探针结论都看它）要作废。
    super::forget_fingerprint();
    let target = dll_path(data_dir);
    let bytes = std::fs::metadata(&target).map(|value| value.len()).unwrap_or(0);
    let variant = installed_variant(data_dir).map(|(variant, _)| variant);
    Ok(InstalledDll {
        bytes,
        variant: variant.map(|value| value.id().to_string()),
        variant_label: variant.map(|value| value.label().to_string()),
        version: super::dll_version(&target),
    })
}

/// 下载某一条变体并装进数据目录。逐镜像回退，取回来的字节先对清单校验再就位。
///
/// `progress` 收（已下载字节，总字节）—— 165 MB 的东西要给设置页一条进度。
pub fn download_variant<F: FnMut(u64, Option<u64>)>(
    data_dir: &std::path::Path,
    variant_id: &str,
    mut progress: F,
) -> Result<InstalledDll, String> {
    let catalog = fetch_catalog_with_fallback(MODEL_RELEASE_REPO)?;
    let variant = catalog
        .variant(variant_id)
        .ok_or_else(|| format!("目录里没有 {variant_id} 这一种（可选：{}）", catalog.ids()))?
        .clone();
    let asset = ReleaseAsset {
        role: "dlssnr".into(),
        path: variant.asset.clone(),
        download_name: None,
        size: variant.size,
        sha256: variant.sha256.clone(),
        companions: Vec::new(),
        direct_url: None,
    };
    let directory = data_dir.join("dlssnr");
    std::fs::create_dir_all(&directory).map_err(|error| format!("建目录失败：{error}"))?;
    // 暂存名就是资产名：下载器自己会加上 `.part` 后缀，失败时不会碰到已在用的那份。
    let staged = directory.join(&variant.asset);

    let mut errors = Vec::new();
    // 165 MB 的片段，下之前先量一遍谁快：顺序只影响先后，逐镜像回退照旧
    // （见 `model_release::order_sources_by_speed`）。
    let sources = crate::model_release::order_sources_by_speed(
        MIRROR_PRESETS
            .iter()
            .map(|(_, prefix)| asset_url(prefix, MODEL_RELEASE_REPO, &catalog.tag, &asset.path))
            .collect(),
    );
    for url in sources {
        match download_asset_with_progress(&url, &asset, &staged, &mut progress) {
            Ok(()) => {
                // 下载器按清单校验过一遍；这里再核对一次落盘结果，两处都用同一份事实。
                verify_file(&staged, variant.size, &variant.sha256)?;
                return install_staged(&staged, data_dir);
            }
            Err(error) if error == "download cancelled" => return Err(error),
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(format!(
        "all dlssnr download sources failed: {}",
        errors.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 发布出去的那一份（`src-tauri/resources/dlssnr/dlssnr-manifest.json`，与模型清单
    /// 同一种放法：跟着代码走，发布时原样推到模型仓库正文）。`docs/` 不进仓库，所以
    /// 不能放那边——`include_str!` 是编译期依赖，干净克隆里缺文件会直接编不过。
    const PUBLISHED: &str = include_str!("../../resources/dlssnr/dlssnr-manifest.json");

    fn published_catalog() -> DlssnrCatalog {
        serde_json::from_str(PUBLISHED).expect("清单得是能解析的 JSON")
    }

    #[test]
    fn the_published_catalog_is_valid() {
        let catalog = published_catalog();
        validate_catalog(&catalog).expect("发布的清单该过校验");
        assert_eq!(catalog.tag, "models-v1");
        assert_eq!(catalog.variants.len(), 3, "三种变体各自一条");
        assert!(catalog.license.is_some(), "许可要跟着清单一起分发");
    }

    /// 清单是给用户挑的，内置表是拿来认「装的是哪一种」的：两边的 id、名字、字节数
    /// 与哈希必须是同一套，否则下载完的设置页会认不出刚装的那一份。
    #[test]
    fn the_published_catalog_agrees_with_the_built_in_variant_table() {
        let catalog = published_catalog();
        for variant in &catalog.variants {
            let source = match variant.id.as_str() {
                "official" => super::super::Variant::Official,
                "community" => super::super::Variant::Community40,
                "sf-v2" => super::super::Variant::SfV2,
                other => panic!("清单里出现了内置表没有的变体 {other}"),
            };
            assert_eq!(variant.label, source.label(), "{} 的名字两边要一致", variant.id);
            assert!(
                super::super::variant_of(variant.size as usize, &variant.sha256).is_some(),
                "{} 的字节数与哈希内置表认不出",
                variant.id,
            );
        }
    }

    #[test]
    fn a_catalog_without_variants_or_with_a_bad_hash_is_refused() {
        let mut catalog = published_catalog();
        catalog.variants.clear();
        assert!(validate_catalog(&catalog).is_err());

        let mut catalog = published_catalog();
        catalog.variants[0].sha256 = "not-a-hash".into();
        assert!(validate_catalog(&catalog).is_err());

        let mut catalog = published_catalog();
        catalog.variants[0].asset = "../escape.dll".into();
        assert!(validate_catalog(&catalog).is_err());
    }

    #[test]
    fn catalog_urls_start_at_the_repo_body_and_then_mirror_it() {
        let urls = catalog_urls("Kelcoin/Yomika-Models");
        assert!(urls[0].contains("raw.githubusercontent.com/Kelcoin/Yomika-Models/main/"));
        assert!(urls[0].ends_with(CATALOG_FILE));
        assert!(urls.len() >= 2, "至少还有一个镜像前缀");
        assert!(urls[1..].iter().all(|url| url.contains("raw.githubusercontent.com")));
    }

    /// 从字节到位的整条安装路径（跳过网络）：校验 → 就位 → 认得出变体。
    ///
    /// 用合成的小文件跑，因为这里要证的只是路径本身；真实那份 165 MB 的字节与清单
    /// 对不对得上由下面两条按需跑的测试管（一条比字节数，一条按需下载再算哈希）。
    #[test]
    fn a_verified_file_is_installed_and_takes_over() {
        let directory = tempfile::tempdir().expect("临时目录");
        let bytes = b"not a real snippet, just bytes whose hash we can check".repeat(64);
        let digest = sha256_hex(&bytes);
        let staging = directory.path().join("dlssnr");
        std::fs::create_dir_all(&staging).expect("建目录");
        let staged = staging.join("nvngx_dlssnr--official.dll");
        std::fs::write(&staged, &bytes).expect("写暂存");

        verify_file(&staged, bytes.len() as u64, &digest).expect("校验该过");
        // 错的哈希与错的字节数都得被拦下——「换个字节顶旧哈希」就是这么被挡住的。
        assert!(verify_file(&staged, bytes.len() as u64, &"0".repeat(64)).is_err());
        assert!(verify_file(&staged, bytes.len() as u64 + 1, &digest).is_err());

        // 先占上旧的那一份：装上新的要把它换掉。
        let target = dll_path(directory.path());
        std::fs::create_dir_all(target.parent().expect("父目录")).expect("建目录");
        std::fs::write(&target, b"the previous snippet").expect("写旧的");
        let installed = install_staged_with(&staged, directory.path(), SnippetTrust::Skipped)
            .expect("就位");
        assert_eq!(installed.bytes, bytes.len() as u64);
        assert_eq!(std::fs::read(&target).expect("读回来"), bytes);
        assert!(!staged.exists(), "暂存文件该换成数据目录里那一份");
        // 认不出变体不算错：清单那三种之外还能有别的 DLL，照样能用。
        assert_eq!(installed.variant, None);
        assert_eq!(installed_id(directory.path()), None);
    }

    /// 本地社区包里那三个 DLL 的字节数要和清单里写的一致（只比字节数，不算哈希：
    /// 发布出去的那份字节由下面的下载测试验）。改了 docs 里的包却忘了更新清单，
    /// 这条会先说话。
    ///
    /// 2026-10-17 换过一轮：清单的社区槽变成 Lecram 310.8.3、FP16 槽变成社区
    /// compat-fp16 310.9.16，所以这两条指到新目录；`Community-RTX40-RTX50` 与 `SF-v2`
    /// 两个目录留着当**退役原件**（README.txt 记着它们的身世），不再对着清单比。
    #[test]
    fn the_local_pack_matches_the_published_sizes() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/DLSSNR-DLL-Options-310.8.0.0");
        let catalog = published_catalog();
        let directories = [
            ("official", "NVIDIA-Original"),
            ("community", "Community-Lecram-310.8.3"),
            ("sf-v2", "Compat-FP16-310.9.16"),
        ];
        let mut seen = 0;
        for (id, directory) in directories {
            let path = root.join(directory).join("nvngx_dlssnr.dll");
            let Ok(metadata) = std::fs::metadata(&path) else {
                continue;
            };
            let variant = catalog.variant(id).expect("清单里该有这一条");
            assert_eq!(
                metadata.len(),
                variant.size,
                "{id}（{}）的字节数与清单不符",
                path.display()
            );
            seen += 1;
        }
        if seen == 0 {
            println!("跳过：本地没有那份社区包（{}）", root.display());
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn installing_refuses_when_the_staged_file_is_missing() {
        let dir = tempfile::tempdir().expect("临时目录");
        let staged = dir.path().join("dlssnr").join("nvngx_dlssnr--official.dll");
        assert!(install_staged(&staged, dir.path()).is_err());
    }

    /// 签过名又被改过的片段**装得下去**，而且签名结论照旧报得出来（2026-10-17 起）。
    ///
    /// 旧卡只有社区版/FP16 版能用 NR，而签名门本来就在 NVIDIA 核心那一步（`docs/144`），
    /// 所以安装这一关拦的改成「装上去也用不了」：结构不对、缺导出。这条用**真片段**钉住
    /// 「改过的也装，而且 `signature_verdict` 还是说得出它是 Modified」——签名这种事问的是
    /// 文件自己，合成字节答不了。社区包是本地夹具（`docs/` 不进仓库），没有就跳过。
    #[test]
    fn a_signed_then_modified_snippet_is_installed_and_still_reports_its_verdict() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/DLSSNR-DLL-Options-310.8.0.0");
        let community = root.join("Community-RTX40-RTX50").join("nvngx_dlssnr.dll");
        if !community.is_file() {
            println!("跳过：本地没有那份社区包（{}）", community.display());
            return;
        }
        let dir = tempfile::tempdir().expect("临时目录");
        let staged = dir.path().join("dlssnr").join("nvngx_dlssnr--community.dll");
        std::fs::create_dir_all(staged.parent().expect("父目录")).expect("建目录");
        std::fs::copy(&community, &staged).expect("摆一份社区片段当暂存");

        let installed = install_staged(&staged, dir.path()).expect("改过的片段现在装得下去");
        assert!(dll_path(dir.path()).is_file(), "装成功就要落在数据目录");
        assert_eq!(installed.variant.as_deref(), Some("community"), "认得出是哪一种");
        assert_eq!(
            yomika_compute_core::dlssnr::signature_verdict(&community),
            yomika_compute_core::dlssnr::SignatureVerdict::Modified,
            "签名结论照旧报得出「改过」"
        );
    }

    /// 结构不对的字节仍然进不来：这一关拦的是「装上去也用不了」。
    #[test]
    fn a_file_that_is_not_a_snippet_is_not_put_in_place() {
        let dir = tempfile::tempdir().expect("临时目录");
        let staged = dir.path().join("dlssnr").join("nvngx_dlssnr--junk.dll");
        std::fs::create_dir_all(staged.parent().expect("父目录")).expect("建目录");
        std::fs::write(&staged, vec![0u8; 4096]).expect("写一份垃圾当暂存");

        let refused = install_staged(&staged, dir.path()).expect_err("不是 PE 的字节不该就位");
        assert!(!refused.is_empty(), "拒了要说清为什么");
        assert!(!dll_path(dir.path()).is_file(), "拒了就不许落下东西");
    }

    #[test]
    fn an_unknown_variant_id_is_refused_with_the_choices_named() {
        let catalog = published_catalog();
        assert!(catalog.variant("official").is_some());
        assert!(catalog.variant("wat").is_none());
        assert!(catalog.ids().contains("community"));
    }

    /// 合成一份「装得下去」的片段：这几条问的是**库与切换**那条路，签名与结构那两关显式
    /// 跳过，所以只要两份字节不一样、大小对得上即可。尾部带个标记，读回来一比就知道是谁。
    fn fake_snippet(seed: u8) -> Vec<u8> {
        let mut bytes = vec![seed; 65_536];
        bytes.extend_from_slice(&(seed as u64).to_le_bytes());
        bytes
    }

    /// 把一份字节摆成「刚下载完、还在暂存」的样子。
    fn staged_snippet(dir: &std::path::Path, asset: &str, bytes: &[u8]) -> std::path::PathBuf {
        let staged = dir.join("dlssnr").join(asset);
        std::fs::create_dir_all(staged.parent().expect("父目录")).expect("建目录");
        std::fs::write(&staged, bytes).expect("写暂存");
        staged
    }

    /// 同上，但源是本地那份真片段（要认得出是哪一种就得用真字节）。
    fn staged_from(
        dir: &std::path::Path,
        asset: &str,
        source: &std::path::Path,
    ) -> std::path::PathBuf {
        let staged = dir.join("dlssnr").join(asset);
        std::fs::create_dir_all(staged.parent().expect("父目录")).expect("建目录");
        std::fs::copy(source, &staged).expect("摆一份真片段当暂存");
        staged
    }

    /// 装过的每一种都得留在库里。以前固定名那一份是被**改名**覆盖的，所以下第二条变体时
    /// 第一条的字节就没了——用户报的「多个版本没法共存」就是这个。
    #[test]
    fn a_second_install_keeps_the_first_variant_in_the_library() {
        let dir = tempfile::tempdir().expect("临时目录");
        let first = fake_snippet(0x41);
        let second = fake_snippet(0x42);
        install_staged_with(
            &staged_snippet(dir.path(), "nvngx_dlssnr--official.dll", &first),
            dir.path(),
            SnippetTrust::Skipped,
        )
        .expect("第一条就位");
        install_staged_with(
            &staged_snippet(dir.path(), "nvngx_dlssnr--community.dll", &second),
            dir.path(),
            SnippetTrust::Skipped,
        )
        .expect("第二条就位");

        assert_eq!(
            std::fs::read(library_file(dir.path(), "nvngx_dlssnr--official.dll")).expect("第一条还在库里"),
            first,
            "下第二条不该把第一条顶掉"
        );
        assert_eq!(
            std::fs::read(library_file(dir.path(), "nvngx_dlssnr--community.dll")).expect("第二条在库里"),
            second
        );
        assert_eq!(
            std::fs::read(dll_path(dir.path())).expect("固定名那份"),
            second,
            "固定名换成最后装的那一份"
        );
    }

    /// 设置页要能看到「库里有哪些、现在用的是哪一条」；认不出是哪一种的也照样列出来。
    #[test]
    fn the_library_lists_every_variant_and_marks_the_one_in_use() {
        let dir = tempfile::tempdir().expect("临时目录");
        let first = fake_snippet(0x41);
        let second = fake_snippet(0x42);
        install_staged_with(
            &staged_snippet(dir.path(), "nvngx_dlssnr--official.dll", &first),
            dir.path(),
            SnippetTrust::Skipped,
        )
        .expect("第一条");
        install_staged_with(
            &staged_snippet(dir.path(), "nvngx_dlssnr--community.dll", &second),
            dir.path(),
            SnippetTrust::Skipped,
        )
        .expect("第二条");

        let listed = installed_variants(dir.path());
        assert_eq!(listed.len(), 2, "两条都得列出来：{listed:?}");
        assert_eq!(listed[0].file, "nvngx_dlssnr--community.dll", "按文件名排，顺序稳定");
        assert_eq!(listed[1].file, "nvngx_dlssnr--official.dll");
        assert!(listed[0].active, "刚装的是 community，它才是在用的那条");
        assert!(!listed[1].active, "official 在库里但没在用");
        assert_eq!(listed[0].bytes, second.len() as u64);
        // 合成字节认不出是哪一种——认不出不算错，照旧列出来。
        assert_eq!(listed[0].id, None);
        assert_eq!(listed[0].label, None);
    }

    /// 库里没有这一种：报出来，而且**一个字节都别动**——切换失败不该把现在能用的那份弄没。
    #[test]
    fn activating_a_variant_that_is_not_in_the_library_changes_nothing() {
        let dir = tempfile::tempdir().expect("临时目录");
        let first = fake_snippet(0x41);
        install_staged_with(
            &staged_snippet(dir.path(), "nvngx_dlssnr--official.dll", &first),
            dir.path(),
            SnippetTrust::Skipped,
        )
        .expect("先装一条");
        let before = std::fs::read(dll_path(dir.path())).expect("固定名那份");

        let refused = activate_variant(dir.path(), "sf-v2").expect_err("库里没有 sf-v2");
        assert!(refused.contains("库里没有 sf-v2"), "{refused}");
        assert!(refused.contains("现有"), "得说清库里有什么：{refused}");
        assert_eq!(
            std::fs::read(dll_path(dir.path())).expect("固定名那份"),
            before,
            "报错时不许碰固定名那份"
        );
    }

    /// 认不出的片段（库里那条的 `id` 是 `None`）在界面上只有文件名可发，切换必须按文件名
    /// 找得到它：没有这条兜底，用户自己拖进来的那份永远切不过去，只能再导入一次。
    #[test]
    fn activating_a_snippet_the_catalog_cannot_name_works_by_file_name() {
        let dir = tempfile::tempdir().expect("临时目录");
        let custom = fake_snippet(0x7c);
        install_staged_with(
            &staged_snippet(dir.path(), "nvngx_dlssnr--custom.dll", &custom),
            dir.path(),
            SnippetTrust::Skipped,
        )
        .expect("先装一条认不出的");
        let listed = installed_variants(dir.path());
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].id, None, "合成字节认不出是哪一种");
        assert_eq!(listed[0].file, "nvngx_dlssnr--custom.dll");

        // 把固定名那份换成别的字节（相当于后来装了另一份），再按**文件名**切回来。
        std::fs::write(dll_path(dir.path()), fake_snippet(0x11)).expect("换掉固定名那份");
        crate::dlssnr::forget_fingerprint();

        let switched =
            activate_variant(dir.path(), "nvngx_dlssnr--custom.dll").expect("按文件名切得回来");
        assert_eq!(switched.variant, None, "认不出的那条切过来仍然认不出");
        assert_eq!(
            std::fs::read(dll_path(dir.path())).expect("固定名那份"),
            custom,
            "固定名那份的字节得与库里那条完全相同"
        );
    }

    /// 切换 = 把库里那一份**复制**到固定名上（NGX 核心按固定名找片段，名字改不得），
    /// 库里那份留着，认出来的变体跟着变。用真片段：要认出是哪一种就得是真字节。
    #[test]
    fn activating_a_variant_copies_it_back_onto_the_fixed_name() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/DLSSNR-DLL-Options-310.8.0.0");
        let official = root.join("NVIDIA-Original").join("nvngx_dlssnr.dll");
        let community = root.join("Community-Lecram-310.8.3").join("nvngx_dlssnr.dll");
        if !official.is_file() || !community.is_file() {
            println!("跳过：本地没有那两份真片段（{}）", root.display());
            return;
        }
        let dir = tempfile::tempdir().expect("临时目录");
        // 先装官方原版，再装 Lecram 版：两条一样大、哈希不同（`docs/144` 那个坑）。
        install_staged_with(
            &staged_from(dir.path(), "nvngx_dlssnr--official.dll", &official),
            dir.path(),
            SnippetTrust::Skipped,
        )
        .expect("装官方原版");
        let second = install_staged_with(
            &staged_from(dir.path(), "nvngx_dlssnr--community.dll", &community),
            dir.path(),
            SnippetTrust::Skipped,
        )
        .expect("装 Lecram 版");
        assert_eq!(second.variant.as_deref(), Some("community"), "认得出是哪一种");

        let switched = activate_variant(dir.path(), "official").expect("库里那条切得回来");
        assert_eq!(switched.variant.as_deref(), Some("official"));
        assert_eq!(
            switched.bytes,
            std::fs::metadata(&official).expect("官方原版").len()
        );
        assert_eq!(
            std::fs::read(dll_path(dir.path())).expect("固定名那份"),
            std::fs::read(&official).expect("官方原版"),
            "固定名那份的字节得与库里的 official 完全相同"
        );
        assert_eq!(
            installed_variant(dir.path()).map(|(variant, _)| variant.id().to_string()),
            Some("official".to_string()),
            "进程内认出来的变体跟着变"
        );
        assert_eq!(installed_id(dir.path()).as_deref(), Some("official"));

        // 库里两条都在（**切走不等于搬走**：拿它当源改名就会把库里那条弄没），标记跟着换。
        let listed = installed_variants(dir.path());
        assert_eq!(listed.len(), 2, "{listed:?}");
        let in_use: Vec<_> = listed.iter().filter(|variant| variant.active).collect();
        assert_eq!(in_use.len(), 1, "同时只有一条在用：{listed:?}");
        assert_eq!(in_use[0].id.as_deref(), Some("official"));
        assert_eq!(in_use[0].label.as_deref(), Some("官方原版"));
        assert!(
            library_file(dir.path(), "nvngx_dlssnr--official.dll").is_file(),
            "切过来之后 official 那份还得留在库里（复制，不是改名）"
        );
        assert!(
            library_file(dir.path(), "nvngx_dlssnr--community.dll").is_file(),
            "切走不等于删掉"
        );
    }

    /// 同一种变体只占库里一个文件：下载那条路拿的是清单资产名、导入那条路拿的是用户给的
    /// 文件名，两条路必须落到同一个文件上，不然设置页会把同一种列两遍。
    #[test]
    fn one_variant_occupies_one_file_in_the_library() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/DLSSNR-DLL-Options-310.8.0.0");
        let community = root.join("Community-Lecram-310.8.3").join("nvngx_dlssnr.dll");
        if !community.is_file() {
            println!("跳过：本地没有那份社区包（{}）", community.display());
            return;
        }
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::create_dir_all(library_dir(dir.path())).expect("建库目录");

        // 下载那条路：暂存文件名就是清单里的资产名。
        install_staged_with(
            &staged_from(
                dir.path(),
                "nvngx_dlssnr--community-rtx40-50.dll",
                &community,
            ),
            dir.path(),
            SnippetTrust::Skipped,
        )
        .expect("下载那条路");
        // 导入那条路：文件躺在用户自己的目录里，名字与清单无关。
        let picked = dir.path().join("user-picked.dll");
        std::fs::copy(&community, &picked).expect("用户给的那份");
        copy_into_library(&picked, dir.path()).expect("导入那条路");

        let listed = installed_variants(dir.path());
        assert_eq!(listed.len(), 1, "同一种变体只该占一个文件：{listed:?}");
        assert_eq!(listed[0].file, "nvngx_dlssnr--community.dll");
        assert_eq!(listed[0].id.as_deref(), Some("community"));
        assert_eq!(
            listed[0].bytes,
            std::fs::metadata(&community).expect("社区包").len()
        );
    }

    #[test]
    fn unknown_dll_versions_coexist_and_switch_by_exact_file() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("nvngx_dlssnr.dll");
        std::fs::write(&source, b"custom DLL version one").unwrap();
        let first = copy_into_library(&source, dir.path()).unwrap();
        std::fs::write(&source, b"custom DLL version two").unwrap();
        let second = copy_into_library(&source, dir.path()).unwrap();
        assert_ne!(first, second, "different DLL contents must never overwrite each other");
        assert_eq!(std::fs::read(&first).unwrap(), b"custom DLL version one");
        assert_eq!(installed_variants(dir.path()).len(), 2);
        let again = copy_into_library(&source, dir.path()).unwrap();
        assert_eq!(again, second, "importing identical bytes should reuse the library entry");
        for file in [&first, &second] {
            activate_variant(dir.path(), file.file_name().unwrap().to_str().unwrap()).unwrap();
            assert_eq!(std::fs::read(dll_path(dir.path())).unwrap(), std::fs::read(file).unwrap());
        }
        std::fs::copy(&first, library_file(dir.path(), "nvngx_dlssnr--duplicate.dll")).unwrap();
        assert_eq!(installed_variants(dir.path()).len(), 2, "legacy copies of identical bytes should not create duplicate choices");
    }

    /// 整条下载路径，对着真仓库的那一份：清单取得到、解析得动，写在上面的资产名与
    /// SHA-256 就得真的对得上下载回来的字节。**一条变体 165 MB**，所以默认不跑
    /// （这就是发布侧改动之后该手动跑的那个）：
    ///
    /// ```text
    /// cargo test --lib -- --ignored a_variant_downloads_from_the_published_release
    /// ```
    #[test]
    #[ignore = "needs the network: pulls a 165 MB snippet from the published release"]
    fn a_variant_downloads_from_the_published_release() {
        let catalog =
            fetch_catalog_with_fallback(MODEL_RELEASE_REPO).expect("线上清单取得到");
        // 三条都一样大，挑 SF-v2（最小的一条）验一遍即可。
        let variant = catalog.variant("sf-v2").expect("清单里有 SF 版").clone();

        let data = tempfile::tempdir().expect("临时目录");
        let mut reported = 0u64;
        let (staged, total) = {
            let asset = ReleaseAsset {
                role: "dlssnr".into(),
                path: variant.asset.clone(),
                download_name: None,
                size: variant.size,
                sha256: variant.sha256.clone(),
                companions: Vec::new(),
                direct_url: None,
            };
            let directory = data.path().join("dlssnr");
            std::fs::create_dir_all(&directory).expect("建目录");
            let staged = directory.join(&variant.asset);
            let mut errors = Vec::new();
            let mut landed = false;
            for (_, prefix) in MIRROR_PRESETS.iter() {
                let url = asset_url(prefix, MODEL_RELEASE_REPO, &catalog.tag, &asset.path);
                match download_asset_with_progress(&url, &asset, &staged, |done, total| {
                    reported = done;
                    if done % (32 * 1024 * 1024) < 128 * 1024 {
                        println!("{}: {done}/{total:?}", variant.asset);
                    }
                }) {
                    Ok(()) => {
                        landed = true;
                        break;
                    }
                    Err(error) => errors.push(format!("{url}: {error}")),
                }
            }
            assert!(landed, "{}", errors.join("; "));
            (staged, asset.size)
        };
        assert_eq!(reported, total, "下载完该正好是清单上的字节数");
        verify_file(&staged, variant.size, &variant.sha256).expect("哈希对得上");
        // 这一条是清单里那两条社区变体的真实处境：字节数与哈希都对得上清单，**签名对不上**
        // 文件自己的内容，所以驱动拒它（`docs/144`）。产品路径（不跳签名的那一支）得当场拒。
        let refused = install_staged(&staged, data.path()).expect_err("改过的片段不该装进去");
        assert!(refused.contains("签名"), "{refused}");
        assert!(!dll_path(data.path()).is_file(), "拒了就不许落下东西");
        // 跳过签名那一支照样要走通：它证的是「就位 + 认得出是哪一条」这条路本身。
        let installed =
            install_staged_with(&staged, data.path(), SnippetTrust::Skipped).expect("就位");
        assert_eq!(installed.variant.as_deref(), Some("sf-v2"));
        assert_eq!(installed_id(data.path()).as_deref(), Some("sf-v2"));
    }
}
