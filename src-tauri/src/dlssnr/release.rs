//! DLSS5 片段的目录：三种变体在模型仓库里各自一份，用户自己挑一种。
//!
//! 片段（`nvngx_dlssnr.dll`）按名字固定地住在数据目录的 `dlssnr/` 下，同一时刻
//! 只有一种，所以「能选哪些」这件事必须由清单来说：仓库正文的
//! `dlssnr-manifest.json` 一条变体一条，各自记着自己的字节数与 SHA-256。官方原版
//! 与社区兼容版因此可以分开维护——谁也不覆盖谁，用户点哪一条就装哪一条。
//!
//! 和超分模型那套走同一条路：`raw.githubusercontent.com` 上的本体文件 → 镜像前缀
//! → Release 资产，逐条回退；下载完先校验再改名就位。

use serde::{Deserialize, Serialize};

use crate::model_release::{
    asset_url, download_asset_with_progress, safe_segment, ReleaseAsset, MIRROR_PRESETS,
    MODEL_RELEASE_REPO,
};

use super::{dll_path, file_sha256, installed_variant, InstalledDll};

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

/// 把校验过的暂存文件改成数据目录里那一份。
///
/// Windows 上正在被这个进程加载的 DLL 挡得住改名（拒绝访问 / 共享冲突），所以失败
/// 时先删再改名——已被映射的镜像允许删除，真正危险的是把原来那份弄丢，所以两个
/// 动作都失败就原样报错，暂存文件留着，用户重启应用再点一次即可。
fn put_in_place(staged: &std::path::Path, data_dir: &std::path::Path) -> Result<(), String> {
    let target = dll_path(data_dir);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("建目录失败：{error}"))?;
    }
    let mut last = match std::fs::rename(staged, &target) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    if matches!(last.raw_os_error(), Some(5) | Some(32) | Some(33)) {
        // 旧的那份正被用着：先摘掉它，再让新的就位。
        if std::fs::remove_file(&target).is_ok() {
            match std::fs::rename(staged, &target) {
                Ok(()) => return Ok(()),
                Err(error) => last = error,
            }
        }
    }
    Err(format!(
        "换不了 {}：{last}。如果应用正在用它，重启应用后再试。",
        target.display()
    ))
}

/// 把已经校验过的暂存文件装进数据目录，并报出装的是哪一种。
fn install_staged(staged: &std::path::Path, data_dir: &std::path::Path) -> Result<InstalledDll, String> {
    put_in_place(staged, data_dir)?;
    let target = dll_path(data_dir);
    let bytes = std::fs::metadata(&target).map(|value| value.len()).unwrap_or(0);
    let variant = installed_variant(data_dir).map(|(variant, _)| variant);
    Ok(InstalledDll {
        bytes,
        variant: variant.map(|value| value.id().to_string()),
        variant_label: variant.map(|value| value.label().to_string()),
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
    for (_, prefix) in MIRROR_PRESETS.iter() {
        let url = asset_url(prefix, MODEL_RELEASE_REPO, &catalog.tag, &asset.path);
        match download_asset_with_progress(&url, &asset, &staged, &mut progress) {
            Ok(()) => {
                // 下载器按清单校验过一遍；这里再核对一次落盘结果，两处都用同一份事实。
                verify_file(&staged, variant.size, &variant.sha256)?;
                return install_staged(&staged, data_dir);
            }
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
        let installed = install_staged(&staged, directory.path()).expect("就位");
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
    #[test]
    fn the_local_pack_matches_the_published_sizes() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/DLSSNR-DLL-Options-310.8.0.0");
        let catalog = published_catalog();
        let directories = [
            ("official", "NVIDIA-Original"),
            ("community", "Community-RTX40-RTX50"),
            ("sf-v2", "SF-v2"),
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

    #[test]
    fn an_unknown_variant_id_is_refused_with_the_choices_named() {
        let catalog = published_catalog();
        assert!(catalog.variant("official").is_some());
        assert!(catalog.variant("wat").is_none());
        assert!(catalog.ids().contains("community"));
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
        let variant = catalog.variant("sf-v2").expect("清单里有 FP16 兼容版").clone();

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
        let installed = install_staged(&staged, data.path()).expect("就位");
        assert_eq!(installed.variant.as_deref(), Some("sf-v2"));
        assert_eq!(installed_id(data.path()).as_deref(), Some("sf-v2"));
    }
}
