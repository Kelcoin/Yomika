//! DLSS5 对前端与算力中心的入口（Tauri 命令）。
//!
//! 形状照 `inference.rs` 里超分/去码那几条命令：状态与检测是便宜的调用，真正跑
//! 图的那条走 `run_heavy`（全局只允许一件重活），返回二进制 PNG。

use std::path::PathBuf;

use tauri::Manager;

use crate::domain::result::CommandResult;

use super::release::{self, DlssnrCatalog};
use super::settings::DlssnrSettings;
use super::{DlssnrStatus, InstalledDll, ProbeReport};

/// 数据目录（DLL 与 NGX 的日志都落在这里）。
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::data_paths::data_dir(app).map_err(|error| error.to_string())
}

/// 把这台机器上的 DLSS5 现状说清楚：显卡、装了哪一种 DLL、最近一次检测的结论。
///
/// **不跑图**：设置页一打开就调它，所以只做枚举显卡、看文件、认哈希这些便宜事。
#[tauri::command]
pub fn dlssnr_status(app: tauri::AppHandle) -> CommandResult<DlssnrStatus> {
    let data = match data_dir(&app) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    let mut status = super::status(&data);
    // 上次检测的结论跟着一起给：设置页据此决定开关解不解锁。
    status.probe = super::last_probe();
    CommandResult::success(status)
}

/// 真机跑一遍（合成图走完整条链路）。`force` 为假时给上次的结论。
#[tauri::command]
pub async fn dlssnr_probe(app: tauri::AppHandle, force: Option<bool>) -> CommandResult<ProbeReport> {
    let data = match data_dir(&app) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    let force = force.unwrap_or(false);
    match crate::inference::run_heavy(move || super::probe_cached(&data, force)).await {
        Ok(report) => CommandResult::success(report),
        Err(error) => CommandResult::failure("INFERENCE_UNAVAILABLE", error, false),
    }
}

/// 导入一份 `nvngx_dlssnr.dll`（用户在文件选择器里指的那一份）。
#[tauri::command]
pub fn dlssnr_import_dll(app: tauri::AppHandle, path: String) -> CommandResult<InstalledDll> {
    let data = match data_dir(&app) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    match super::install_dll(std::path::Path::new(&path), &data) {
        Ok(installed) => {
            // 换了 DLL，旧结论作废（可能换了一种变体）。
            super::forget_probe();
            CommandResult::success(installed)
        }
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    }
}

/// 有哪些变体可选（模型仓库里的那份清单），以及这台机器上装的是哪一条。
///
/// 装没装由 [`DlssnrStatus::variant`] 回答，所以这里只报目录——前端把两者对上
/// 就得出每一条的「下载 / 使用中」。
#[tauri::command]
pub fn dlssnr_catalog() -> CommandResult<DlssnrCatalog> {
    match release::fetch_catalog_with_fallback(crate::model_release::MODEL_RELEASE_REPO) {
        Ok(catalog) => CommandResult::success(catalog),
        Err(error) => CommandResult::failure("MODEL_CATALOG_FETCH_FAILED", error, true),
    }
}

/// 下载目录里的某一条变体，校验通过后装进数据目录（旧的被换掉）。
#[tauri::command]
pub async fn dlssnr_download_variant(
    app: tauri::AppHandle,
    variant_id: String,
) -> CommandResult<InstalledDll> {
    let data = match data_dir(&app) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    // 阻塞版的 reqwest + 165 MB 的字节：丢给阻塞线程池，主线程才有空把进度发出去。
    let emitter = app.clone();
    let id = variant_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        release::download_variant(&data, &id, |done, total| {
            let _ = tauri::Emitter::emit(
                &emitter,
                "dlssnr-download-progress",
                serde_json::json!({"variantId": id, "completed": done, "total": total}),
            );
        })
    })
    .await;
    match result {
        // 换了 DLL，旧结论作废（刚换成另一种变体）。
        Ok(Ok(installed)) => {
            super::forget_probe();
            CommandResult::success(installed)
        }
        Ok(Err(error)) => CommandResult::failure("MODEL_DOWNLOAD_FAILED", error, true),
        Err(error) => CommandResult::failure("MODEL_DOWNLOAD_FAILED", error.to_string(), true),
    }
}

/// 阅读器的页面入口：拿缓存里的一页（或它的某个派生版本），跑 1–3 层 DLSS5，回 PNG。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DlssnrPageInput {
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    /// 从哪一版开始跑：`reader-page`（原图）/ `decensored` / `enhanced`。
    #[serde(default)]
    pub source: Option<String>,
    /// 层参数由前端给（设置页那份就是唯一真相）。
    #[serde(default)]
    pub settings: Option<DlssnrSettings>,
}

#[tauri::command]
pub async fn dlssnr_apply_page(
    input: DlssnrPageInput,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let data = match data_dir(&app) {
        Ok(value) => value,
        Err(error) => {
            return Ok(crate::domain::result::into_binary_response(
                CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
            ))
        }
    };
    let result = crate::inference::run_heavy(move || {
        let database = app.state::<crate::db::Database>();
        apply_cached_page(&database, &data, &input)
    })
    .await?;
    Ok(crate::domain::result::into_binary_response(result))
}

/// 缓存页 → DLSS5 → PNG。抽出来是为了能在测试里直接调（不用起 Tauri）。
fn apply_cached_page(
    database: &crate::db::Database,
    data_dir: &std::path::Path,
    input: &DlssnrPageInput,
) -> CommandResult<Vec<u8>> {
    use crate::cache::{load_image_cache, CacheImageIdentity};

    if input.page_index < 0 {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid page index", false);
    }
    let rendition = input.source.as_deref().unwrap_or("reader-page");
    let source = match rendition {
        "reader-page" | "decensored" | "enhanced" => {
            CacheImageIdentity::new(&input.scope_id, &input.archive_id, rendition, input.page_index)
        }
        other => {
            return CommandResult::failure(
                "INVALID_RESPONSE",
                format!("Unsupported source rendition: {other}"),
                false,
            )
        }
    };

    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let page = match load_image_cache(&connection, data_dir, &source) {
        Ok(Some(image)) => image,
        // 可重试：上一步（去码/超分）可能还在跑，落地之后再问一次。
        Ok(None) => return CommandResult::failure("LRR_NOT_FOUND", "Page is not cached yet", true),
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    drop(connection);

    let decoded = match image::load_from_memory(&page.bytes) {
        Ok(value) => value.to_rgba8(),
        Err(error) => return CommandResult::failure("INVALID_RESPONSE", error.to_string(), false),
    };
    let (width, height) = (decoded.width(), decoded.height());
    let settings = input.settings.clone().unwrap_or_default().normalized();
    let processed = match super::apply_rgba(data_dir, decoded.into_raw(), width, height, &settings) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("INFERENCE_UNAVAILABLE", error, false),
    };

    let mut encoded = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut encoded);
        if let Err(error) = encoder.write_image(
            &processed.rgba,
            processed.width,
            processed.height,
            image::ExtendedColorType::Rgba8,
        ) {
            return CommandResult::failure("UNKNOWN", error.to_string(), true);
        }
    }
    CommandResult::success(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expect_failure(result: CommandResult<Vec<u8>>) -> crate::domain::result::DomainError {
        match result {
            CommandResult::Failure { error, .. } => error,
            CommandResult::Success { .. } => panic!("这一步该失败"),
        }
    }

    #[test]
    fn an_unknown_source_rendition_is_rejected_before_touching_the_cache() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        let input = DlssnrPageInput {
            scope_id: "scope".into(),
            archive_id: "archive".into(),
            page_index: 0,
            source: Some("nonsense".into()),
            settings: None,
        };
        let result = apply_cached_page(&database, dir.path(), &input);
        let error = expect_failure(result);
        assert_eq!(error.code, "INVALID_RESPONSE");
        assert!(error.message.contains("nonsense"), "{}", error.message);
    }

    #[test]
    fn a_negative_page_index_is_rejected() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        let input = DlssnrPageInput {
            scope_id: "scope".into(),
            archive_id: "archive".into(),
            page_index: -1,
            source: None,
            settings: None,
        };
        let result = apply_cached_page(&database, dir.path(), &input);
        assert_eq!(expect_failure(result).code, "INVALID_RESPONSE");
    }

    #[test]
    fn a_page_that_is_not_cached_asks_the_caller_to_try_again() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        let input = DlssnrPageInput {
            scope_id: "scope".into(),
            archive_id: "archive".into(),
            page_index: 3,
            source: None,
            settings: None,
        };
        let result = apply_cached_page(&database, dir.path(), &input);
        let error = expect_failure(result);
        assert_eq!(error.code, "LRR_NOT_FOUND");
        assert!(error.retryable);
    }
}
