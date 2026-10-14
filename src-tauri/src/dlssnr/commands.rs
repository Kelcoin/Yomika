//! DLSSNR 对前端与算力中心的入口（Tauri 命令）。
//!
//! 形状照 `inference.rs` 里超分那几条命令：状态与检测是便宜的调用，真正跑
//! 图的那条走 `run_heavy`（全局只允许一件重活），返回二进制 PNG。

use std::path::PathBuf;

use tauri::Manager;

use crate::domain::result::CommandResult;

use super::release::{self, DlssnrCatalog};
use super::settings::DlssnrSettings;
use super::{DlssnrImage, DlssnrStatus, InstalledDll, ProbeReport};

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
    // 引擎那一侧有没有 NGX、这台机器有什么卡：前者只能听 worker 说（宿主这份二进制里
    // 没有垫片），后者由 DXGI 枚举。取构建事实要赶在进阻塞线程之前——`manager` 不是
    // `Send` 到那边去用的东西。
    let build = crate::compute::manager_from_app(&app).and_then(|manager| manager.worker_build());
    match tauri::async_runtime::spawn_blocking(move || {
        let mut status = super::status_with(&data, super::engine_facts(build.as_ref()));
        status.probe = super::last_probe_for(&data);
        status.probe_valid = super::probe_is_valid(&data);
        status
    }).await {
        Ok(status) => CommandResult::success(status),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

/// 真机跑一遍（合成图走完整条链路）。`force` 为假时给上次的结论。
///
/// **不在本进程里跑引擎**：合成图在这里编成 PNG，跑它的是计算进程（`proxy::dlssnr`），
/// 拿回来的产物解码之后再比像素差。宿主这一侧只有两件纯事——画那张图、比两个像素数组。
#[tauri::command]
pub async fn dlssnr_probe(app: tauri::AppHandle, force: Option<bool>) -> CommandResult<ProbeReport> {
    let data = match data_dir(&app) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    let force = force.unwrap_or(false);
    // 与 `dlssnr_status` 同一条理由：取计算进程的手要赶在进阻塞线程之前（`AppHandle`
    // 那边取不到，而这一次闭包要活到那边去）。
    let manager = crate::compute::manager_from_app(&app);
    match crate::inference::run_heavy(
        crate::inference::HeavyPriority::Background,
        None,
        move || {
            super::probe_cached_with(&data, force, || {
                probe_through_worker(manager.as_deref(), &data)
            })
        },
    )
    .await
    {
        Ok(report) => CommandResult::success(report),
        Err(error) => CommandResult::failure("INFERENCE_UNAVAILABLE", error, false),
    }
}

/// 探针那张合成图的边长：在 `filter::MIN_EDGE` 之上（太小 NGX 自己会拒），小到跑一遍
/// 只要一两秒——设置页的「检测」按钮按下去就在等它。
const PROBE_EDGE: u32 = 96;

/// 「算过了」的下限：平均逐通道绝对差低于这个数就算网络没参与。
///
/// 真机上一张合成图过 DLSSNR 的差值远高于它（几百倍），而原样交回是**恰好** 0——阈值
/// 取在这里两边都不会看错（`filter::PASSTHROUGH` 那一段 doc 记着这道判据的来由）。
const PROBE_MIN_DIFFERENCE: f64 = 0.05;

/// 探针任务在账上的身份：同一次设置页里连按两次「检测」会被调度器合并，而跑完之后
/// 那条任务就从账上摘掉，所以下一次按还是会真跑（这正是 `force` 之外要的效果）。
const PROBE_INPUT_ID: &str = "probe:synthetic";
const PROBE_SETTINGS_ID: &str = "probe:default";
const PROBE_SOURCE_REVISION: &str = "probe";

/// 探针的结论是一条**报告**（不是命令失败）：只画得出一半事实时也把那一半说清楚。
fn probe_refused(error: String) -> ProbeReport {
    ProbeReport {
        supported: false,
        width: PROBE_EDGE,
        height: PROBE_EDGE,
        elapsed_ms: 0,
        difference: 0.0,
        error: Some(error),
    }
}

/// 合成图 + 它的 PNG 容器。
///
/// 交给计算进程的必须是**一个容器**：协议帧只有 64 KiB，像素走只读输入根（worker 那边
/// 按容器解码，见 `worker/src/dlssnr.rs`）。
fn synthetic_png(width: u32, height: u32) -> Result<(DlssnrImage, Vec<u8>), String> {
    use image::ImageEncoder;
    let image = crate::dlssnr::synthetic_image(width, height);
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&image.rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|error| format!("这张合成图编不成 PNG：{error}"))?;
    Ok((image, bytes))
}

/// 拿回来的产物与合成图差多少 → 报告。
///
/// 「原样交回」不是一种失败：它是一份**明确的**结论（网络没有参与），所以它落在
/// `supported` 与 `error` 上，而不是让命令报错。
fn probe_report_from(
    image: &DlssnrImage,
    outcome: Result<crate::compute::proxy::DlssnrOutput, String>,
    elapsed_ms: u64,
) -> ProbeReport {
    let failed = |error: String| ProbeReport {
        supported: false,
        width: image.width,
        height: image.height,
        elapsed_ms,
        difference: 0.0,
        error: Some(error),
    };
    let output = match outcome {
        Ok(output) => output,
        Err(error) => return failed(error),
    };
    let rendered = match image::load_from_memory(&output.bytes) {
        Ok(decoded) => decoded.into_rgba8(),
        Err(error) => return failed(format!("算出来的那一张解不开：{error}")),
    };
    let difference =
        crate::dlssnr::mean_absolute_difference(&image.rgba, rendered.as_raw());
    let supported = difference > PROBE_MIN_DIFFERENCE;
    ProbeReport {
        supported,
        width: image.width,
        height: image.height,
        elapsed_ms,
        difference,
        error: (!supported).then(|| "输出与输入一模一样：网络没有参与".to_string()),
    }
}

/// 探针的编排：二次校验 → 合成图 → 交给计算进程 → 比像素差。
///
/// 卡由调用方递进来（与 `runtime_gate_with` 同一条口径）：这样「没卡 / 这一代不支持 /
/// 没有计算进程 / 跑失败」四条都能被换成合成的事实来测，而不必真的换一张显卡。
fn probe_with_gpu(
    manager: Option<&crate::compute::manager::ComputeManager>,
    data_dir: &std::path::Path,
    gpu: Option<yomika_compute_core::dlssnr::GpuInfo>,
) -> ProbeReport {
    if let Err(error) = super::runtime_gate_with(data_dir, gpu) {
        return probe_refused(error);
    }
    let Some(manager) = manager else {
        return probe_refused(
            "计算进程还没起来，这一页没人算（宿主这边已经没有 NGX 了）".to_string(),
        );
    };
    let (image, page) = match synthetic_png(PROBE_EDGE, PROBE_EDGE) {
        Ok(pair) => pair,
        Err(error) => return probe_refused(error),
    };
    let settings = DlssnrSettings::default();
    let started = std::time::Instant::now();
    let outcome = crate::compute::proxy::dlssnr(
        manager,
        crate::compute::proxy::DlssnrJob {
            input_id: PROBE_INPUT_ID,
            settings_id: PROBE_SETTINGS_ID,
            source_revision: PROBE_SOURCE_REVISION,
            priority: crate::compute::scheduler::Priority::Background,
            stage_id: crate::compute::proxy::DLSSNR_STAGE_ID,
            feature: &crate::dlssnr::dll_path(data_dir),
            settings: &settings,
            page: &page,
        },
        // 探针没有可取消的说法：它只有一张 96×96 的图，用户按下去就是在等它。
        &|| false,
    )
    .map_err(|error| error.message);
    probe_report_from(&image, outcome, started.elapsed().as_millis() as u64)
}

/// [`probe_with_gpu`] 外面那一层：卡从这台机器上问出来（DXGI 枚举，纯元数据）。
///
/// 引擎那一侧有没有 NGX 不在这里问——那是 worker 的事（`engine_facts` 的 `core_available`
/// 那一半，探针的这条路上用不着它）。
fn probe_through_worker(
    manager: Option<&crate::compute::manager::ComputeManager>,
    data_dir: &std::path::Path,
) -> ProbeReport {
    let facts = super::engine_facts(manager.and_then(|manager| manager.worker_build()).as_ref());
    probe_with_gpu(manager, data_dir, facts.gpu)
}

/// 把进程里缓存着的 DLSSNR 工作区交回系统，返回交回了几个。
///
/// 工作区（以及它内部每个 NGX feature 自己的资源）是按「层数 × 页面积」占**提交
/// 内存**的：真机实测五层在 2731×4096 的一页上，两份缓存档加起来把进程提交内存抬到
/// 9.5GB（见 `device::release_cached_workspaces` 上那段数字）。翻页期间它们是速度的
/// 来源（重建一次 feature 几十到几百毫秒），所以这条命令留给「没事做」的时候：前端
/// 在离开阅读器、以及整本预处理停下来一会儿之后各调一次。
///
/// **这些工作区在 worker 进程里**（8-g④-b2c 之后宿主这一侧没有引擎了），所以这条命令
/// 是一次真往返：问 manager，由它请 worker 交回，worker 把交回了几份报回来。没有会话、
/// 有活正在跑或排队、或者 worker 没答上来，都回 0——而且**不会**为了交回把 worker 拉起来。
///
/// 刻意**不**顺手做 `memory::trim_process_memory` 那件事：清空工作集会把常驻的 ONNX
/// 模型与那份 DLL（约 165MB）一起扫出去，下一页的第一张图要重新读盘。
/// 这条命令只交回几个 GB 的提交内存，不动那些还在用的页。
#[tauri::command(async)]
pub fn dlssnr_release_workspaces(app: tauri::AppHandle) -> CommandResult<u32> {
    let count =
        crate::compute::manager_from_app(&app).map_or(0, |manager| manager.release_idle());
    CommandResult::success(count)
}

/// 新的 DLL 片段装上了：这一代 worker 手里的进程内状态就此作废（docs/71:640）。
///
/// NGX 的 context 活在 worker 进程里，而且**同一份 context 上换不了片段**（`worker/src/dlssnr.rs`
/// 里那句原话）。所以装完必须让这一代退下：不退的话，worker 会拿新片段去要一份新 context，
/// 而它会拒绝——用户点完「导入」看到的还是旧片段跑出来的结论。
///
/// 顺手作废宿主这边的探针结论：它记的是旧片段跑出来的数。
fn a_new_snippet_arrived(app: &tauri::AppHandle) {
    if let Some(manager) = crate::compute::manager_from_app(app) {
        manager.retire_worker("DLSSNR 片段换了版本");
    }
    super::forget_probe();
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
            a_new_snippet_arrived(&app);
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
            a_new_snippet_arrived(&app);
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
    /// 从哪一版开始跑：`reader-page`（原图）/ `enhanced`（超分产物）。
    #[serde(default)]
    pub source: Option<String>,
    /// 起点那一版是哪个模型产出的。起点是按「产出它的模型」存的（超分产物按超分模型
    /// 的指纹），所以要算出同一个 revision 才读得到；`reader-page` 起点不需要它。
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
    let heavy = crate::inference::HeavyPriority::parse(input.priority.as_deref());
    // 两层优先级来回译的唯一一处：宿主这一页只负责**等**，排在哪一档是调度器的说法，
    // 而 heaviness 是宿主自己的说法（`HeavyPriority` 管的是「本进程里谁先跑」）。
    let priority = match &heavy {
        crate::inference::HeavyPriority::Foreground => crate::compute::scheduler::Priority::Foreground,
        crate::inference::HeavyPriority::Background => crate::compute::scheduler::Priority::Background,
    };
    // 计算进程的手柄。NGX 现在只活在那边，宿主这一页只是等它（a3）。
    let manager = app
        .try_state::<crate::compute::ComputeHandle>()
        .and_then(|handle| handle.get().cloned());
    let task_id = input.task_id.clone();
    let result = crate::inference::run_heavy(heavy, task_id, move || {
        let database = app.state::<crate::db::Database>();
        apply_cached_page(&database, manager.as_deref(), priority, &data, &input)
    })
    .await?;
    Ok(crate::domain::result::into_binary_response(result))
}

/// 缓存页 → DLSSNR → PNG。抽出来是为了能在测试里直接调（不用起 Tauri）。
///
/// `manager` 是计算进程的手柄：`None` 表示编排没起来（或测试里没给），这时这一页**没有
/// 人算**——宿主这边已经没有 NGX 了，所以那不是「退回家算」，是一条明确的失败。门控
/// （`runtime_gate_with`）仍然排在它前面：用户拿到的第一条理由应当是「这台机器不行」。
fn apply_cached_page(
    database: &crate::db::Database,
    manager: Option<&crate::compute::manager::ComputeManager>,
    priority: crate::compute::scheduler::Priority,
    data_dir: &std::path::Path,
    input: &DlssnrPageInput,
) -> CommandResult<Vec<u8>> {
    use crate::cache::CacheImageIdentity;

    if input.page_index < 0 {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid page index", false);
    }
    let rendition = input.source.as_deref().unwrap_or("reader-page");
    // 起点那一版属于哪个模型：读的是别人写的产物，就得按同一个 revision 去找
    // （`reader-page` 是服务端拉下来的原图，没有模型，也就没有 revision）。
    let revision = match crate::inference::source_revision(
        data_dir,
        rendition,
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
    // 点留在后面原来的位置。
    //
    // 走 `read_cached_image`：读文件与算摘要在锁外。
    let page = crate::cache::read_cached_image(&database, data_dir, &source);
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
    // 放在 `runtime_gate_with` 之前：能命中就说明这同一份 DLL 已经跑出过这一页，此刻机器
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
    // 事实。放在取页之前——跑不起来时连缓存都不该碰。卡那一条由 worker 的构建事实
    // 与 DXGI 拼出来（宿主不再问自己有没有 NGX：那答案永远是「没有」）。
    let gpu = super::engine_facts(
        manager
            .and_then(|manager| manager.worker_build())
            .as_ref(),
    )
    .gpu;
    if let Err(error) = super::runtime_gate_with(data_dir, gpu) {
        return CommandResult::failure("INFERENCE_UNAVAILABLE", error, false);
    }

    let page = match page {
        Ok(Some(image)) => image,
        // 可重试：上一步（超分）可能还在跑，落地之后再问一次。
        Ok(None) => return CommandResult::failure("LRR_NOT_FOUND", "Page is not cached yet", true),
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };

    // 静帧的尺寸在这里量一次，后面那条「原样交回」的日志要用它；动图没有这一步。
    let mut edge = None;
    // 静帧在本地先看一眼尺寸下限（`filter::MIN_EDGE`）：worker 那边也会挡，但这里能在把
    // 一百多兆的片段摆进只读输入根、起一趟计算之前就把「这张图不适用」说清楚。动图不在
    // 这里判——它的处理单位是每一帧，容器尺寸说明不了帧尺寸，判定留在 worker 那边。
    if !animated {
        let decoded = match image::load_from_memory(&page.bytes) {
            Ok(value) => value.to_rgba8(),
            Err(error) => {
                return CommandResult::failure("INVALID_RESPONSE", error.to_string(), false)
            }
        };
        let (width, height) = (decoded.width(), decoded.height());
        edge = Some((width, height));
        if width < DLSSNR_MIN_EDGE || height < DLSSNR_MIN_EDGE {
            return CommandResult::failure(
                "INVALID_RESPONSE",
                format!("这一页太小（{width}×{height}）：DLSSNR 至少要 {DLSSNR_MIN_EDGE}×{DLSSNR_MIN_EDGE}"),
                false,
            );
        }
    }

    // 宿主这边已经没有 NGX 了（Task 8 的出口）：这一页只能交给计算进程。编排没起来就是
    // 「这一页没人算」，不是退回家算——所以这里明说，别让它看起来像这一页坏了。
    let Some(manager) = manager else {
        return CommandResult::failure(
            "INFERENCE_UNAVAILABLE",
            "计算进程还没起来，这一页没人算（宿主这边已经没有 NGX 了）",
            false,
        );
    };
    let guard = crate::inference::cancel::begin(input.task_id.as_deref());
    // 身份那两栏与产物缓存用的是同一套说法：`settings_id` 就是 `output.revision`（那一版
    // 的身份），`source_revision` 就是起点那一版的修订。同一个东西两处各拼一次，迟早会
    // 让「缓存认得这一版」与「调度器认得这一版」变成两件事。
    let settings_id = output.revision.clone().unwrap_or_default();
    let source_revision = source
        .revision
        .clone()
        .unwrap_or_else(|| rendition.to_string());
    let outcome = crate::compute::proxy::dlssnr(
        manager,
        crate::compute::proxy::DlssnrJob {
            // 内容寻址的那一半由 proxy 自己算（页、参数、片段），这里给的是「这是谁」：
            // 同一页的原图与它的超分产物是不同的输入，所以前缀写清来路。
            input_id: &format!("host:{}", blake3::hash(&page.bytes).to_hex()),
            settings_id: &settings_id,
            source_revision: &source_revision,
            priority,
            stage_id: crate::compute::proxy::DLSSNR_STAGE_ID,
            feature: &super::dll_path(data_dir),
            settings: &settings,
            page: &page.bytes,
        },
        &|| guard.token().cancelled(),
    );
    let outcome = match outcome {
        Ok(value) => value,
        Err(error) => return CommandResult::failure(error.code, error.message, error.retryable),
    };
    drop(guard);

    // 「原样交回」：worker 报的引擎名是 `passthrough`，说明这一页确实**没被算过**。两种
    // 成因都会走到这里：两次评估都与输入逐像素相同（`filter::PASSTHROUGH`），或者评估
    // 什么都没写出来、产物整幅透明（`filter::BLANK`——用户那一页 3000×4000 只剩背景就是
    // 这一种）。原图交回是看得见的诚实结果；**不写产物缓存**——写进去就等于把「没处理过」
    // 固化下来，用户那一页会一直停在未处理的样子（真机缓存里抓到过：同样的键、同样的
    // 字节、还被阅读器读走显示过，全透明那一份 242,617 字节）。
    //
    // 静帧多记一条日志：机制本身还没复现，下次撞上时能对上尺寸与参数。动图不记——它
    // 不适用是常态（帧太多、画布太大），每翻一页都记一条会把错误日志淹掉。
    if !outcome.computed {
        if let Some((width, height)) = edge {
            if let Err(log_error) = crate::error_log::record_at_data_dir(
                data_dir,
                "warn",
                "dlssnr/passthrough",
                &format!(
                    "这一页没有产出（评估原样交回了输入，或者什么都没写出来），这次不写产物缓存：{width}×{height}"
                ),
                Some(&settings.to_json()),
            ) {
                eprintln!("yomika: DLSSNR 原样交回没能写进错误日志：{log_error}");
            }
        }
        return CommandResult::success(page.bytes);
    }
    // 产物落盘：这一页下次翻回来（或者重启应用之后）就是上面那条命中路径，整段计算与
    // 编码都不再走。取消掉的任务在上面就返回了，不会写。写不进去也照样把这一页交出去，
    // 只是记一条 `CACHE_WRITE_FAILED`（见 `inference::finish_derived`）。
    let encoded = crate::inference::finish_derived(
        database,
        data_dir,
        DLSSNR_CACHE_SOURCE,
        &output,
        DLSSNR_MIME,
        outcome.bytes,
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
    use crate::compute::scheduler::Priority;

    fn expect_failure(result: CommandResult<Vec<u8>>) -> crate::domain::result::DomainError {
        match result {
            CommandResult::Failure { error, .. } => error,
            CommandResult::Success { .. } => panic!("这一步该失败"),
        }
    }

    /// 一页的 PNG（测试里当「已经是这个尺寸的图」用）。
    fn page_png(width: u32, height: u32) -> Vec<u8> {
        synthetic_png(width, height).expect("编码 PNG").1
    }

    /// 一块合成出来的卡：探针那条路上的「这一代支不支持」由它决定，测试就不必真换显卡
    /// （与 `runtime_gate_with` 的测试同一条口径）。
    fn gpu_with_series(series: Option<u32>) -> yomika_compute_core::dlssnr::GpuInfo {
        yomika_compute_core::dlssnr::GpuInfo {
            name: format!("NVIDIA GeForce RTX（series {series:?}）"),
            vendor_id: 0x10DE,
            device_id: 0x2C02,
            is_nvidia: true,
            series,
            driver: Some("32.0.16.1714".to_string()),
            memory_bytes: 32_607 * 1024 * 1024,
        }
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
            upscale_model: None,
            priority: None,
        }
    }

    /// 宿主这一边**不再自己开 NGX**：这一页必须交给计算进程（docs/71 §11 里 Task 8 的
    /// 出口就是「宿主无 ORT/NGX 资源」）。
    ///
    /// 判据不是「算出来了」：`fake_dll` 只是一枚让门控放行的占位（门控只看片段在不在、
    /// 显卡在不在，不看那份字节是不是真 DLL），真到 NGX 初始化那一步必然失败。判据是
    /// **失败的时候宿主说的是谁**——编排还没起来时它必须说「计算进程」，而不是自己在本
    /// 进程里拿那份假片段试一次。改动之前走的正是后者：命令直接进 `apply_with_token`，
    /// 报回来的是那份片段自己的错（真机上还会**成功**，因为真片段是好的）。
    #[test]
    fn the_page_command_hands_the_page_to_the_compute_process() {
        let dir = tempfile::tempdir().expect("临时目录");
        let database = crate::db::Database::open_path(dir.path().join("test.sqlite")).expect("库");
        fake_dll(dir.path(), 1024);
        store_source_page(&database, dir.path(), "image/png", &page_png(96, 96));

        let error =
            expect_failure(apply_cached_page(&database, None, Priority::Background, dir.path(), &input_with(None)));
        assert_eq!(error.code, "INFERENCE_UNAVAILABLE", "{}", error.message);
        // 编排是开机时起来的：这一栏说「还没起来」，重试不会让它起来，和「这台机器跑
        // 不起来」同一类，不是缓存未命中。
        assert!(!error.retryable, "{}", error.message);
        assert!(
            error.message.contains("计算进程"),
            "这一页没人算的时候要说清楚是谁没起来：{}",
            error.message
        );
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
        match apply_cached_page(&database, None, Priority::Background, dir.path(), &input_with(Some(settings))) {
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
            crate::dlssnr::output_revision(dir.path(), Some("enhanced:abc"), &settings),
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
        // 假 PE，没有签名：显式跳过验签（这一条问的是「导入之后身份跟不跟得上新内容」）。
        crate::dlssnr::install_dll_with(
            &source,
            dir.path(),
            crate::dlssnr::SnippetTrust::Skipped,
        )
        .expect("导入");

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
        let result = apply_cached_page(&database, None, Priority::Background, dir.path(), &input_with(Some(stronger)));
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
            upscale_model: None,
            priority: None,
        };
        let result = apply_cached_page(&database, None, Priority::Background, dir.path(), &input);
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
            upscale_model: None,
            priority: None,
        };
        let result = apply_cached_page(&database, None, Priority::Background, dir.path(), &input);
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
            upscale_model: None,
            priority: None,
        };
        let error = expect_failure(apply_cached_page(&database, None, Priority::Background, dir.path(), &input));
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

        match apply_cached_page(&database, None, Priority::Background, dir.path(), &input_with(Some(settings))) {
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

        match apply_cached_page(&database, None, Priority::Background, dir.path(), &input_with(Some(settings))) {
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
            upscale_model: None,
            priority: None,
        };
        let result = apply_cached_page(&database, None, Priority::Background, dir.path(), &input);
        let error = expect_failure(result);
        // 这台机器能不能跑 DLSSNR 决定了这条路径从哪一步开始失败：能跑时是缓存没命中
        // （可重试），不能跑时是门控（不可重试）。两种都对，但要说清楚是哪一种。
        match error.code {
            "LRR_NOT_FOUND" => assert!(error.retryable),
            "INFERENCE_UNAVAILABLE" => assert!(error.message.contains("DLSSNR") || !error.retryable),
            other => panic!("unexpected code {other}: {}", error.message),
        }
    }

    /// 探针在老路上是在**本进程**里调 `apply` 的：那份合成图这一次要交给计算进程，没起来
    /// 就必须说清是谁没起来，而不是自己拿片段试一次。
    #[test]
    fn a_probe_without_a_compute_process_says_who_did_not_show_up() {
        let dir = tempfile::tempdir().expect("临时目录");
        fake_dll(dir.path(), 1024);
        let report = probe_with_gpu(None, dir.path(), Some(gpu_with_series(Some(50))));
        assert!(!report.supported, "没人算过就不算支持");
        assert_eq!(report.difference, 0.0);
        assert_eq!(report.elapsed_ms, 0, "没跑起来就没有耗时");
        assert_eq!(report.width, PROBE_EDGE);
        assert_eq!(report.height, PROBE_EDGE);
        let error = report.error.expect("要说清谁没起来");
        assert!(error.contains("计算进程"), "{error}");
    }

    /// 二次校验排在合成之前：没有片段时连图都不画（`elapsed_ms` 是 0），而且说的是
    /// 「还没有导入」而不是片段自己的文件错误。
    #[test]
    fn a_probe_stops_before_drawing_when_no_snippet_is_installed() {
        let dir = tempfile::tempdir().expect("临时目录");
        let report = probe_with_gpu(None, dir.path(), Some(gpu_with_series(Some(50))));
        assert!(!report.supported);
        assert_eq!(report.elapsed_ms, 0);
        let error = report.error.expect("要说清缺什么");
        assert!(error.contains("nvngx_dlssnr.dll"), "{error}");
    }

    /// 没卡、或这一代不在支持范围：同一份报告、同一栏 `error`（探针的结论不是命令失败）。
    #[test]
    fn a_probe_reports_a_machine_it_cannot_run_on() {
        let dir = tempfile::tempdir().expect("临时目录");
        fake_dll(dir.path(), 1024);
        let no_card = probe_with_gpu(None, dir.path(), None);
        assert!(no_card.error.expect("没卡").contains("NVIDIA 显卡"));
        let old_card = probe_with_gpu(None, dir.path(), Some(gpu_with_series(Some(10))));
        assert!(old_card
            .error
            .expect("这一代不支持")
            .contains("支持范围"));
    }

    /// 产物与合成图比出来的结论：原样交回是**明确的**结论（差值恰好 0），挪过就是支持。
    #[test]
    fn the_probe_tells_a_passthrough_from_a_network_that_ran() {
        let (image, page) = synthetic_png(PROBE_EDGE, PROBE_EDGE).expect("合成一张 PNG");
        let same = probe_report_from(
            &image,
            Ok(crate::compute::proxy::DlssnrOutput {
                bytes: page,
                computed: false,
            }),
            123,
        );
        assert!(!same.supported);
        assert_eq!(same.difference, 0.0);
        assert_eq!(same.elapsed_ms, 123);
        assert_eq!(
            same.error.as_deref(),
            Some("输出与输入一模一样：网络没有参与")
        );

        let mut shifted = image.rgba.clone();
        for byte in shifted.iter_mut().take(64) {
            *byte = byte.wrapping_add(9);
        }
        let moved = probe_report_from(
            &image,
            Ok(crate::compute::proxy::DlssnrOutput {
                bytes: encode_rgba_png(&shifted, PROBE_EDGE, PROBE_EDGE),
                computed: true,
            }),
            7,
        );
        assert!(moved.supported, "挪过 9 就该算网络参与了");
        assert!(moved.difference > PROBE_MIN_DIFFERENCE);
        assert!(moved.error.is_none());

        // 报回来的错原样透传（那是 worker 说的那一句，不该在这里被换掉）。
        let refused = probe_report_from(&image, Err("NGX 起不来".to_string()), 5);
        assert!(!refused.supported);
        assert_eq!(refused.error.as_deref(), Some("NGX 起不来"));
    }

    /// 任意 RGBA 编成 PNG（上面那条要用一张「被挪过」的产物）。
    fn encode_rgba_png(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
            .expect("编码 PNG");
        bytes
    }
}
