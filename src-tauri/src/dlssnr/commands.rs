//! DLSSNR 对前端与算力中心的入口（Tauri 命令）。
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

/// 把这台机器上的 DLSSNR 现状说清楚：显卡、装了哪一种 DLL、最近一次检测的结论。
///
/// **不跑图**：设置页一打开就调它，所以只做枚举显卡、看文件、认哈希这些便宜事。
#[tauri::command]
pub async fn dlssnr_status(app: tauri::AppHandle) -> CommandResult<DlssnrStatus> {
    let data = match data_dir(&app) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let mut status = super::status(&data);
        status.probe = super::last_probe_for(&data);
        status.probe_valid = super::probe_is_valid(&data);
        status
    }).await {
        Ok(status) => CommandResult::success(status),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

/// 真机跑一遍（合成图走完整条链路）。`force` 为假时给上次的结论。
#[tauri::command]
pub async fn dlssnr_probe(app: tauri::AppHandle, force: Option<bool>) -> CommandResult<ProbeReport> {
    let data = match data_dir(&app) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    let force = force.unwrap_or(false);
    match crate::inference::run_heavy(
        crate::inference::HeavyPriority::Background,
        None,
        move || super::probe_cached(&data, force),
    )
    .await
    {
        Ok(report) => CommandResult::success(report),
        Err(error) => CommandResult::failure("INFERENCE_UNAVAILABLE", error, false),
    }
}

/// 导入一份 `nvngx_dlssnr.dll`（用户在文件选择器里指的那一份）。
#[tauri::command(async)]
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
#[tauri::command(async)]
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

/// 阅读器的页面入口：拿缓存里的一页（或它的某个派生版本），跑 1–5 层 DLSSNR，回 PNG。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DlssnrPageInput {
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    /// 从哪一版开始跑：`reader-page`（原图）/ `decensored` / `enhanced`。
    #[serde(default)]
    pub source: Option<String>,
    /// 起点那一版是哪两个模型产出的。起点是按「产出它的模型」存的（去码产物按去码
    /// 包的指纹，超分产物按超分模型的指纹），所以要算出同一个 revision 才读得到；
    /// `reader-page` 起点不需要它们。
    #[serde(default)]
    pub decensor_model: Option<String>,
    #[serde(default)]
    pub upscale_model: Option<String>,
    /// 层参数由前端给（设置页那份就是唯一真相）。
    #[serde(default)]
    pub settings: Option<DlssnrSettings>,
    /// 前端给这次任务起的号：切页 / 关开关 / 离开阅读器时用它取消。
    #[serde(default)]
    pub task_id: Option<String>,
    /// 这次请求是前台（用户正看着的那一页）还是后台（提前预扫）。
    #[serde(default)]
    pub priority: Option<String>,
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
    let priority = crate::inference::HeavyPriority::parse(input.priority.as_deref());
    let task_id = input.task_id.clone();
    let result = crate::inference::run_heavy(priority, task_id, move || {
        let database = app.state::<crate::db::Database>();
        apply_cached_page(&database, &data, &input)
    })
    .await?;
    Ok(crate::domain::result::into_binary_response(result))
}

/// 缓存页 → DLSSNR → PNG。抽出来是为了能在测试里直接调（不用起 Tauri）。
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
    // 起点那一版属于哪个模型：读的是别人写的产物，就得按同一个 revision 去找
    // （`reader-page` 是服务端拉下来的原图，没有模型，也就没有 revision）。
    let revision = match crate::inference::source_revision(
        data_dir,
        rendition,
        input.decensor_model.as_deref(),
        input.upscale_model.as_deref(),
    ) {
        Ok(revision) => revision,
        Err(error) => return CommandResult::failure(error.code, error.message, false),
    };
    let mut source = CacheImageIdentity::new(
        &input.scope_id,
        &input.archive_id,
        rendition,
        input.page_index,
    );
    source.revision = revision;
    let settings = input.settings.clone().unwrap_or_default().normalized();
    // 源页只读一次，而且读在这里是为了先判定动图：判定必须早于产物缓存命中——修复
    // 之前跑过的产物是「第一帧 + DLSSNR」的静帧，让缓存先命中就等于这次修复对用户
    // 已经读过的那一页没生效。读不到不在这里报错（产物缓存可能还留着这一页），失败
    // 点留在后面原来的位置，锁也在离开这个作用域前交出。
    let page = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
        };
        let page = load_image_cache(&connection, data_dir, &source);
        drop(connection);
        page
    };
    // 动图走另一条路（见 `super::animation`）：DLSSNR 对每一帧都是自足的空间滤波，逐帧
    // 跑完再编回 APNG。这里只判定「它是不是动图」——真正要字节的时候才动它。
    //
    // 判定必须排在这一步（已经读到源页、还没问产物缓存）：这次改动之前跑出来的产物是
    // 「第一帧 + DLSSNR」的静帧，让缓存先命中就等于这条修复对用户已经读过的那一页没
    // 生效。判定靠源页，所以源页必须先读——这也是它读在这个位置的原因。
    let animated =
        matches!(&page, Ok(Some(image)) if crate::cache::is_animated_image(&image.bytes));
    // 产物缓存先问一遍：键是「起点那一版 + 这一份 DLL + 这一套参数」。命中就整段跳过
    // ——不读页、不解码、不跑 GPU、不编码，重新挂载阅读器 / 重启应用之后也是这一条。
    // 放在 `runtime_gate` 之前：能命中就说明这同一份 DLL 已经跑出过这一页，此刻机器
    // 还说跑不起来（换驱动、拔显卡）也不该让人看不到手上已经有的图。
    let mut output = CacheImageIdentity::new(
        &input.scope_id,
        &input.archive_id,
        DLSSNR_RENDITION,
        input.page_index,
    );
    output.revision = Some(super::output_revision(
        data_dir,
        source.revision.as_deref(),
        &settings,
    ));
    if let Some(hit) = crate::inference::cached_derived(database, data_dir, &output) {
        // 动图页的产物必须**也是动图**：这台机器上上一版跑出来的产物是单帧静图，
        // 它是同一个键，命中它这一页就还是那张静帧。按内容对一下，旧静帧自然落空
        // （下次重跑并覆盖），新编出来的 APNG 照旧命中。
        if animated == crate::cache::is_animated_image(&hit) {
            return CommandResult::success(hit);
        }
    }
    // 二次校验：前端那个布尔值只是「用户想用」，跑不跑得起来是这台机器此刻的
    // 事实。放在取页之前——跑不起来时连缓存都不该碰。
    if let Err(error) = super::runtime_gate(data_dir) {
        return CommandResult::failure("INFERENCE_UNAVAILABLE", error, false);
    }

    let page = match page {
        Ok(Some(image)) => image,
        // 可重试：上一步（去码/超分）可能还在跑，落地之后再问一次。
        Ok(None) => return CommandResult::failure("LRR_NOT_FOUND", "Page is not cached yet", true),
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };

    // 动图：逐帧过 DLSSNR，再编回 APNG 交出去。帧与帧之间是独立的（DLL 那边
    // `DLSSNR.Reset = 1`、没有运动矢量与深度，见 `super::animation`），所以「每帧都
    // 当一张静图跑」跟它的语义是一致的。
    if animated {
        let guard = crate::inference::cancel::begin(input.task_id.as_deref());
        let processed = match super::animation::apply_dlssnr(
            data_dir,
            &page.bytes,
            &settings,
            &guard.token(),
        ) {
            Ok(Some(encoded)) => encoded,
            // 「不适用」而不是「失败」：画布太小、帧太多、超像素预算、容器说不清自己
            // 几帧——这些都在解码之前就判完了，原图本来就是能看的。**不写产物缓存**：
            // 缓存里存的每一份都是「DLSSNR 的输出」，把原图按同一个键塞进去，下次就
            // 分不清这一页是算过的还是没算的（也就没法再随参数变化重算）。
            Ok(None) => return CommandResult::success(page.bytes),
            Err(error) if error == super::filter::CANCELLED => {
                return CommandResult::failure("INFERENCE_CANCELLED", "这一页的处理已取消", false)
            }
            Err(error) => return CommandResult::failure("INFERENCE_UNAVAILABLE", error, false),
        };
        drop(guard);
        let encoded = crate::inference::finish_derived(
            database,
            data_dir,
            DLSSNR_CACHE_SOURCE,
            &output,
            DLSSNR_MIME,
            processed,
        );
        return CommandResult::success(encoded);
    }

    let decoded = match image::load_from_memory(&page.bytes) {
        Ok(value) => value.to_rgba8(),
        Err(error) => return CommandResult::failure("INVALID_RESPONSE", error.to_string(), false),
    };
    let (width, height) = (decoded.width(), decoded.height());
    // 尺寸下限是 DLL 自己的要求（`filter::MIN_EDGE`）：小图在排队前就该被挡下来，
    // 不该等一次原生失败再靠日志去发现。这里报的是「这张图不适用」，不是错误。
    if width < DLSSNR_MIN_EDGE || height < DLSSNR_MIN_EDGE {
        return CommandResult::failure(
            "INVALID_RESPONSE",
            format!("这一页太小（{width}×{height}）：DLSSNR 至少要 {DLSSNR_MIN_EDGE}×{DLSSNR_MIN_EDGE}"),
            false,
        );
    }
    let settings = input.settings.clone().unwrap_or_default().normalized();
    let image = match super::filter::DlssnrImage::new(width, height, decoded.into_raw()) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("INVALID_RESPONSE", error, false),
    };
    let guard = crate::inference::cancel::begin(input.task_id.as_deref());
    let processed = match super::filter::apply_with_token(data_dir, &image, &settings, &guard.token())
    {
        Ok(value) => value,
        Err(error) if error == super::filter::CANCELLED => {
            return CommandResult::failure("INFERENCE_CANCELLED", "这一页的处理已取消", false)
        }
        Err(error) => return CommandResult::failure("INFERENCE_UNAVAILABLE", error, false),
    };
    drop(guard);

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
    // 产物落盘：这一页下次翻回来（或者重启应用之后）就是上面那条命中路径，整段
    // GPU 与编码都不再走。取消掉的任务在上面就返回了，不会写。写不进去也照样把这一页
    // 交出去，只是记一条 `CACHE_WRITE_FAILED`（见 `inference::finish_derived`）。
    let encoded = crate::inference::finish_derived(
        database,
        data_dir,
        DLSSNR_CACHE_SOURCE,
        &output,
        DLSSNR_MIME,
        encoded,
    );
    CommandResult::success(encoded)
}

/// `filter::MIN_EDGE` 的同一条下限（命令这一层用它给出人话）。
const DLSSNR_MIN_EDGE: u32 = 32;

/// 产物在缓存里记成哪一版（`cache::IMAGE_RENDITIONS` 里必须有它）。
const DLSSNR_RENDITION: &str = "dlssnr";

/// 产物容器的 content-type。`cache::sniff_image_mime` 见到 `image/*` 就照收、不核对
/// magic bytes，所以这里必须与上面编出来的容器一致，否则取回来的一页会带着错的
/// content-type 发给前端。
const DLSSNR_MIME: &str = "image/png";

/// 统一错误日志里 `source` 那一栏（产物没落盘时那条 `CACHE_WRITE_FAILED`）。
const DLSSNR_CACHE_SOURCE: &str = "dlssnr.cache";

#[cfg(test)]
mod tests {
    use super::*;

    fn expect_failure(result: CommandResult<Vec<u8>>) -> crate::domain::result::DomainError {
        match result {
            CommandResult::Failure { error, .. } => error,
            CommandResult::Success { .. } => panic!("这一步该失败"),
        }
    }

    /// 一页的 PNG（测试里当「已经是这个尺寸的图」用）。
    fn page_png(width: u32, height: u32) -> Vec<u8> {
        use image::ImageEncoder;
        let image = crate::dlssnr::synthetic_image(width, height);
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&image.rgba, width, height, image::ExtendedColorType::Rgba8)
            .expect("编码 PNG");
        bytes
    }

    /// 摆一份「DLL 在这儿」的占位文件：产物 revision 按它的内容（SHA-256 + 字节数）认。
    fn fake_dll(dir: &std::path::Path, bytes: usize) {
        let dll = crate::dlssnr::dll_path(dir);
        std::fs::create_dir_all(dll.parent().expect("目录")).expect("建目录");
        std::fs::write(&dll, vec![0u8; bytes]).expect("写 DLL 占位");
    }

    /// 一份能过 `install_dll` 那几道检查的假片段：`MZ` 头 + 足够长。
    fn pe_stub(bytes: usize) -> Vec<u8> {
        let mut stub = vec![0u8; bytes];
        stub[0] = b'M';
        stub[1] = b'Z';
        stub
    }

    fn input_with(settings: Option<crate::dlssnr::DlssnrSettings>) -> DlssnrPageInput {
        DlssnrPageInput {
            scope_id: "scope".into(),
            archive_id: "archive".into(),
            page_index: 0,
            source: None,
            settings,
            task_id: Some("reader-task".into()),
            decensor_model: None,
            upscale_model: None,
            priority: None,
        }
    }

    /// R2：产物落盘之后，同一页再问一次不该再碰 GPU、不该再编码——直接给磁盘上那一份。
    /// 这条路径在真机上决定「重启应用 / 重新翻回这一页」要不要再等一次。
    #[test]
    fn a_stored_output_is_served_without_touching_the_gpu() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        fake_dll(dir.path(), 1024);

        let settings = crate::dlssnr::DlssnrSettings::default().normalized();
        let stored = page_png(96, 96);
        let mut identity =
            crate::cache::CacheImageIdentity::new("scope", "archive", DLSSNR_RENDITION, 0);
        identity.revision = Some(crate::dlssnr::output_revision(dir.path(), None, &settings));
        {
            let connection = database.connection.lock().expect("库锁");
            crate::cache::store_image_cache(
                &connection,
                dir.path(),
                &identity,
                "image/png",
                &stored,
            )
            .expect("落盘");
        }
        // 起点那一页**故意不存在**：命中路径必须在读页之前就返回。
        match apply_cached_page(&database, dir.path(), &input_with(Some(settings))) {
            CommandResult::Success { value, .. } => {
                assert_eq!(value, stored, "命中的应当就是落盘的那一份")
            }
            CommandResult::Failure { error, .. } => {
                panic!("该命中缓存，却失败了：{} {}", error.code, error.message)
            }
        }
    }

    /// 参数、起点、DLL 任何一样变了就是另一版：旧产物顶上来比重新算一遍糟得多。
    #[test]
    fn changing_the_settings_or_the_source_invalidates_a_stored_output() {
        let dir = tempfile::tempdir().expect("临时目录");
        fake_dll(dir.path(), 1024);

        let settings = crate::dlssnr::DlssnrSettings::default().normalized();
        let base = crate::dlssnr::output_revision(dir.path(), None, &settings);
        assert_eq!(
            base,
            crate::dlssnr::output_revision(dir.path(), None, &settings),
            "同一份输入要给出同一个键"
        );

        let stronger = crate::dlssnr::DlssnrSettings {
            passes: vec![crate::dlssnr::PassSettings {
                intensity: 1.5,
                ..Default::default()
            }],
        }
        .normalized();
        assert_ne!(
            base,
            crate::dlssnr::output_revision(dir.path(), None, &stronger),
            "层参数变了就是另一版"
        );
        assert_ne!(
            base,
            crate::dlssnr::output_revision(dir.path(), Some("decensored:abc"), &settings),
            "起点那一版变了就是另一版"
        );

        fake_dll(dir.path(), 2048);
        assert_ne!(
            base,
            crate::dlssnr::output_revision(dir.path(), None, &settings),
            "换了一份 DLL 就是另一版"
        );
    }

    /// 审计报告 P1-2：同样字节数、**同样修改时间**、内容不同的 DLL 也是另一版。
    ///
    /// 复制一份片段过来、从压缩包解出来、从云端同步下来、还原一份旧备份——这些都不保证
    /// 改动「字节数 + 修改时间」，而旧实现只认这两项，于是换汤不换药的产物会被端上来。
    /// 这里两份片段的大小与修改时间都对齐，身份只能从内容上看出来。
    #[test]
    fn two_dlls_of_the_same_size_and_timestamp_are_still_different_versions() {
        let first = tempfile::tempdir().expect("临时目录");
        let second = tempfile::tempdir().expect("临时目录");
        let settings = crate::dlssnr::DlssnrSettings::default().normalized();
        fake_dll(first.path(), 1024);
        fake_dll(second.path(), 1024);
        let second_dll = crate::dlssnr::dll_path(second.path());
        std::fs::write(&second_dll, vec![7u8; 1024]).expect("换片段");
        let timestamp = std::fs::metadata(crate::dlssnr::dll_path(first.path()))
            .expect("第一份片段")
            .modified()
            .expect("修改时间");
        std::fs::File::options()
            .write(true)
            .open(&second_dll)
            .expect("打开第二份片段")
            .set_modified(timestamp)
            .expect("对齐修改时间");

        assert_eq!(
            std::fs::metadata(crate::dlssnr::dll_path(first.path()))
                .expect("第一份片段")
                .len(),
            std::fs::metadata(&second_dll).expect("第二份片段").len(),
            "这两份片段的字节数要一样（不然这条测试就测不到内容了）"
        );
        assert_eq!(
            std::fs::metadata(crate::dlssnr::dll_path(first.path()))
                .expect("第一份片段")
                .modified()
                .expect("修改时间"),
            std::fs::metadata(&second_dll)
                .expect("第二份片段")
                .modified()
                .expect("修改时间"),
            "这两份片段的修改时间要一样"
        );
        assert_ne!(
            crate::dlssnr::output_revision(first.path(), None, &settings),
            crate::dlssnr::output_revision(second.path(), None, &settings),
            "内容不同就是另一版，哪怕字节数与修改时间一模一样"
        );
    }

    /// 导入边界：刚装进去的那一份立刻就是「当前这一份」（身份不许还记着上一份的内容）。
    #[test]
    fn installing_a_dll_makes_the_identity_follow_the_new_bytes() {
        const BYTES: usize = 1_048_576;
        let dir = tempfile::tempdir().expect("临时目录");
        let settings = crate::dlssnr::DlssnrSettings::default().normalized();
        // 先有一份在用的，把它的指纹读进进程内缓存。
        fake_dll(dir.path(), BYTES);
        let before = crate::dlssnr::output_revision(dir.path(), None, &settings);

        let source = dir.path().join("imported.dll");
        std::fs::write(&source, pe_stub(BYTES)).expect("写待导入的片段");
        crate::dlssnr::install_dll(&source, dir.path()).expect("导入");

        assert_ne!(
            before,
            crate::dlssnr::output_revision(dir.path(), None, &settings),
            "导入之后当前这一份就是刚装的那一份"
        );
        // 认得出的变体才会由 `installed_variant` 报字节数，所以这里直接核对身份串：
        // 它要跟着刚装进去的那份内容走。
        let digest = crate::dlssnr::file_sha256(&crate::dlssnr::dll_path(dir.path())).expect("哈希");
        assert!(
            crate::dlssnr::dll_identity(dir.path()).contains(&digest),
            "身份里要带上新内容的哈希"
        );
    }

    /// 没落盘过的那套参数不许命中：缓存是用来省一次计算的，不是用来给错图的。
    #[test]
    fn a_different_settings_combination_misses_the_stored_output() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        fake_dll(dir.path(), 1024);

        let settings = crate::dlssnr::DlssnrSettings::default().normalized();
        let mut identity =
            crate::cache::CacheImageIdentity::new("scope", "archive", DLSSNR_RENDITION, 0);
        identity.revision = Some(crate::dlssnr::output_revision(dir.path(), None, &settings));
        {
            let connection = database.connection.lock().expect("库锁");
            crate::cache::store_image_cache(
                &connection,
                dir.path(),
                &identity,
                "image/png",
                &page_png(96, 96),
            )
            .expect("落盘");
        }

        let stronger = crate::dlssnr::DlssnrSettings {
            passes: vec![crate::dlssnr::PassSettings {
                intensity: 1.5,
                ..Default::default()
            }],
        };
        let result = apply_cached_page(&database, dir.path(), &input_with(Some(stronger)));
        assert!(
            matches!(result, CommandResult::Failure { .. }),
            "另一种参数不该拿到那份图"
        );
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
            task_id: None,
            decensor_model: None,
            upscale_model: None,
            priority: None,
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
            task_id: None,
            decensor_model: None,
            upscale_model: None,
            priority: None,
        };
        let result = apply_cached_page(&database, dir.path(), &input);
        assert_eq!(expect_failure(result).code, "INVALID_RESPONSE");
    }

    /// 这台机器跑不起来时（没导入片段 / 没检测过），命令必须自己拒绝：偏好里那个
    /// 开关是持久化的，昨天的、别台机器的、或者换过 DLL 的值都可能写着 true，前端
    /// 那张布尔值不能当作事实。这里报的是「跑不起来」，也不是一次缓存未命中。
    #[test]
    fn the_native_side_refuses_to_run_when_this_machine_cannot() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        let input = DlssnrPageInput {
            scope_id: "scope".into(),
            archive_id: "archive".into(),
            page_index: 0,
            source: None,
            settings: None,
            task_id: Some("reader-task".into()),
            decensor_model: None,
            upscale_model: None,
            priority: None,
        };
        let error = expect_failure(apply_cached_page(&database, dir.path(), &input));
        assert_eq!(error.code, "INFERENCE_UNAVAILABLE");
        assert!(!error.retryable, "重试不会让这台机器长出 N 卡：{}", error.message);
    }

    /// 把一页放进源页缓存（`apply_cached_page` 只读这一份，不需要真去下载）。
    fn store_source_page(
        database: &crate::db::Database,
        data_dir: &std::path::Path,
        mime: &str,
        bytes: &[u8],
    ) {
        let identity = crate::cache::CacheImageIdentity::new("scope", "archive", "reader-page", 0);
        let connection = database.connection.lock().expect("库锁");
        crate::cache::store_image_cache(&connection, data_dir, &identity, mime, bytes)
            .expect("源页落盘");
    }

    /// 把一份产物放到这一页的产物键上。
    fn store_product(
        database: &crate::db::Database,
        data_dir: &std::path::Path,
        settings: &crate::dlssnr::DlssnrSettings,
        bytes: &[u8],
    ) {
        let mut identity =
            crate::cache::CacheImageIdentity::new("scope", "archive", DLSSNR_RENDITION, 0);
        identity.revision = Some(crate::dlssnr::output_revision(data_dir, None, settings));
        let connection = database.connection.lock().expect("库锁");
        crate::cache::store_image_cache(&connection, data_dir, &identity, "image/png", bytes)
            .expect("产物落盘");
    }

    /// 动图页的产物必须**也是动图**：上一版在这台机器上跑出来的那张「第一帧 + DLSSNR」
    /// 挂在同一个键上，命中它这一页就还是那张静帧。这里摆一张静帧产物 + 一份真的动图源页，
    /// 命令必须不去取那张静帧（这台机器上那一下跑不起来，所以它接着在门控上失败——这条测
    /// 真正锁的是「不许把静帧交出去」）。
    #[test]
    fn a_stored_still_frame_does_not_satisfy_an_animated_page() {
        const GIF: &[u8] = include_bytes!("testdata/animated.gif");
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        fake_dll(dir.path(), 1024);
        let settings = crate::dlssnr::DlssnrSettings::default().normalized();
        store_source_page(&database, dir.path(), "image/gif", GIF);
        let still = page_png(96, 96);
        store_product(&database, dir.path(), &settings, &still);

        match apply_cached_page(&database, dir.path(), &input_with(Some(settings))) {
            CommandResult::Success { value, .. } => panic!(
                "动图页不该拿到上一版留下的静帧：交出来的是 {} 字节，静帧是 {} 字节",
                value.len(),
                still.len()
            ),
            CommandResult::Failure { error, .. } => {
                assert_eq!(error.code, "INFERENCE_UNAVAILABLE", "{}", error.message)
            }
        }
    }

    /// 反过来：产物本身就是动图时照旧命中。命中路径排在门控之前，所以这台机器上没有一
    /// 份能用的片段（`fake_dll` 是零字节占位）也必须给得出来。源页与产物故意用两份不同的
    /// 容器：不然「命中缓存」和「原样交回」这两种行为给出的字节完全一样，这条就测不到东西
    /// 了（改动之前这里正是那个更早的动图早退）。
    #[test]
    fn a_stored_animation_satisfies_an_animated_page_without_touching_the_gpu() {
        const APNG: &[u8] = include_bytes!("testdata/animated.png");
        const WEBP: &[u8] = include_bytes!("testdata/animated.webp");
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        fake_dll(dir.path(), 1024);
        let settings = crate::dlssnr::DlssnrSettings::default().normalized();
        store_source_page(&database, dir.path(), "image/webp", WEBP);
        store_product(&database, dir.path(), &settings, APNG);

        match apply_cached_page(&database, dir.path(), &input_with(Some(settings))) {
            CommandResult::Success { value, .. } => {
                assert_eq!(value, APNG, "命中的就是落盘那一份产物，不是源页")
            }
            CommandResult::Failure { error, .. } => {
                panic!("该命中缓存，却失败了：{} {}", error.code, error.message)
            }
        }
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
            task_id: None,
            decensor_model: None,
            upscale_model: None,
            priority: None,
        };
        let result = apply_cached_page(&database, dir.path(), &input);
        let error = expect_failure(result);
        // 这台机器能不能跑 DLSSNR 决定了这条路径从哪一步开始失败：能跑时是缓存没命中
        // （可重试），不能跑时是门控（不可重试）。两种都对，但要说清楚是哪一种。
        match error.code {
            "LRR_NOT_FOUND" => assert!(error.retryable),
            "INFERENCE_UNAVAILABLE" => assert!(error.message.contains("DLSSNR") || !error.retryable),
            other => panic!("unexpected code {other}: {}", error.message),
        }
    }
}
