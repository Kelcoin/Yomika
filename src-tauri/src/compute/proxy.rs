//! 字节桥：一段图片字节进来，一段图片字节出去（docs/71 §11「宿主 inference 旧命令代理」）。
//!
//! 两条来路共用这一份：
//!   * 旧命令 `inference_upscale_page` 的代理（历史来路，第 8-g③-ii 之后只剩集成测试在点）；
//!   * **算力中心**（`compute_center::process` 的两个 op）——移动端发过来的是字节，那边没有
//!     本机的归档与页码，只有「哪一页 + 哪个模型」。
//!
//! 宿主在这里只做三件只有它才知道的事——把这一页按内容摆进只读输入根
//! （[`super::inputs::stage_bytes`]）、给出模型 id 与交出去的尺寸、等终态之后读回宿主自己
//! 复核过的产物字节。算那一页是 worker 的事。
//!
//! 为什么不在宿主里算完再发：那正是这次要拆掉的东西（docs/71 §5.1 的 private commit
//! 与 GPU 占用，宿主留在 WebView 的消息循环上）。第一次真跑模型那几秒也不该占着主进程。
//!
//! 这一层**不**碰产品语义：身份串（`inference::enhanced_revision` /
//! `decensored_revision`）、交出去的倍率上限（`ENHANCED_OUTPUT_SCALE`）、什么时候退回宿主
//! 内置引擎，全由调用方决定。这里只把「怎么用 worker 算这一页」收在一处：第二处调用时不许
//! 各自实现一遍，算力中心就是那第二处。

use std::path::Path;
use std::time::{Duration, Instant};

use yomika_compute_protocol::{EnginePolicy, PipelineStage, RunInput};

// DLSSNR 那一档是**目标门**：`compute-core` 的 `dlssnr` 模块只在 Windows 上编出来（见那份
// crate 的抬头：引擎那一半门在 feature 后面，元数据那一半不门 feature、门在目标上），所以这
// 条桥在别的目标上少一整条来路，而不是「有路但跑不动」。调用方也照同一道门分成两份——
// `compute_center::dlssnr_bytes` 的非 Windows 孪生回一句「这份构建没有 DLSSNR」。少这道门，
// 宿主就整个目标编不过：2026-10-03 的 Android release 构建正是这么红的
// （`error[E0432]: unresolved import yomika_compute_core::dlssnr`）。
#[cfg(windows)]
use yomika_compute_core::dlssnr::DlssnrSettings;
#[cfg(windows)]
use yomika_compute_protocol::{DlssnrGrant, PASSTHROUGH_ENGINE_ID};

use super::decensor::InpaintPreparation;
use super::inputs;
use super::manager::{ComputeManager, SubmitRequest};
use super::scheduler::{JobKey, JobState, Priority};

/// worker 是另一个进程，终态只能靠快照看出来（`ComputeManager` 没有「等终态」的 API，
/// 也不该有：命令层与调度器之间只有事件，没有回调）。20 ms 比一次超分的用时小三个数量级。
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// 交给调度器的 run 期限。旧命令从来没有期限（只有取消牌），所以取协议允许的最大值
/// （`MAX_DEADLINE_MS = 600_000`），别让本来能算完的大页面在这里被新加的期限掐掉。
const PROXY_DEADLINE_MS: u64 = 600_000;

/// 代理自己看门的兜底：宿主 supervisor 已经按 run 期限结算超时，这一层是防「supervisor
/// 自己卡住」时命令永远挂着。比期限多一分钟。
const PROXY_BUDGET: Duration = Duration::from_secs(660);

/// 这条路上跑的引擎。worker 收到的是 `EnginePolicy::Cpu`，所以键上的后端也写 cpu
/// ——GPU 候选接线是单独一步（docs/71 §7.4），到那时两处一起改。
const BACKEND_LABEL: &str = "cpu";

/// 交出去的两条授权名：产物落账时的名字。一条字节来路一个，两件任务挨在一起的时候
/// 才看得出哪件产物是哪条来路交的。
const BYTE_UPSCALE_GRANT: &str = "byte-upscale";
const BYTE_DECENSOR_GRANT: &str = "byte-decensor";
#[cfg(windows)]
const BYTE_DLSSNR_GRANT: &str = "byte-dlssnr";

/// DLSSNR 阶段在账上的名字。它**不**参与认领（这条来路一个阶段一件产物），只用来
/// 认产物文件名与日志：`{stage_id}.png` 由 worker 那边落。
pub const DLSSNR_STAGE_ID: &str = "dlssnr";

/// 一件「让 worker 把这一页放大」的请求。
pub struct UpscaleJob<'a> {
    /// 这一页是谁。与 `settings_id` 一起构成任务身份：两者都相同 = 同一件任务（§8.1）。
    pub input_id: &'a str,
    /// 宿主算出来的身份串（`enhanced_revision`）：与旧缓存认的身份是**同一个**，
    /// 于是「缓存认得这一版」与「调度器认得这一版」不会各说各话。
    pub settings_id: &'a str,
    /// 输入源图的修订。同一个页面但来路不同（原图 / 去码产物）就是不同的输入。
    pub source_revision: &'a str,
    pub priority: Priority,
    /// 模型原生倍率比它大时缩下来（产品常数 `ENHANCED_OUTPUT_SCALE` 由调用方给）。
    pub output_scale: Option<u32>,
    pub stage: StageSpec<'a>,
}

/// 一个阶段的输入：模型 id、放大倍率，以及**已经在手上的**那页字节。
///
/// 源图扩展名不在这里：它由字节自己说了算（`cache::sniff_image_mime`），
/// 免得调用方报一个与字节不符的扩展名。
pub struct StageSpec<'a> {
    pub stage_id: &'a str,
    pub model_spec_id: &'a str,
    pub scale: u32,
    pub page: &'a [u8],
}

/// 一件「让 worker 把这一页去码」的请求。
pub struct DecensorJob<'a> {
    /// 这一页是谁（与 `UpscaleJob::input_id` 同义）。
    pub input_id: &'a str,
    /// 宿主算出来的身份串（`decensored_revision`，包指纹那一版）。
    pub settings_id: &'a str,
    /// 输入源图的修订。同一页但来路不同就是不同的输入。
    pub source_revision: &'a str,
    pub priority: Priority,
    /// 哪一份去码包（`models/<id>/…` 那个目录名）。
    pub model_spec_id: &'a str,
    /// 三件套的真实位置：宿主在这里把「用哪三份模型」说清楚（`manager::prepare_run` 拿它们
    /// 直接摆进只读输入根）。检测集不在其中——谁看像素谁说了算，那是 worker 自己算的。
    pub inpaint: InpaintPreparation,
    pub page: &'a [u8],
}

/// 代理的失败。`code` 是 `&'static str`，因为它要原样进 `DomainError`
/// （`domain::result` 的字段就是这个类型）。
#[derive(Debug, PartialEq, Eq)]
pub struct ProxyError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

/// 把这一页交给 worker 算，等到终态，把产物字节交回来。
///
/// `cancelled` 是宿主的取消牌（`inference::cancel`，就是 core 那张）：等待过程中它一旦
/// 置位就把「用户走开了」转成对 worker 的取消请求——worker 停下来，宿主也不必继续等。
/// 这样「前台插队掐掉后台」与前端 `inference_cancel_page` 两条来路仍然是同一条链子。
pub fn upscale(
    manager: &ComputeManager,
    job: UpscaleJob<'_>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, ProxyError> {
    let staged = stage_page(manager, job.input_id, job.stage.page)?;
    let request = SubmitRequest {
        key: JobKey {
            input_id: job.input_id.to_string(),
            settings_id: job.settings_id.to_string(),
            source_revision: job.source_revision.to_string(),
            backend: BACKEND_LABEL.to_string(),
            // 字节桥不参与阅读器的代际（那是前端翻页时给的）。这两条来路的调用方都没有
            // 代际，用固定值：`drop_generation` 对它是空操作，任务身份完全由上面四个字段决定。
            generation: 1,
        },
        priority: job.priority,
        input: staged,
        pipeline: vec![PipelineStage {
            stage_id: job.stage.stage_id.to_string(),
            model_spec_id: job.stage.model_spec_id.to_string(),
            // 模型授权与最小边长由宿主在派发前补齐（`manager::prepare_run`）
            // ——调用方不许指名模型文件，这条在协议层就定了（docs/71 §7.2）。
            model: None,
            decensor: None,
            dlssnr: None,
            min_input_edge: None,
            output_scale: job.output_scale,
            engine_policy: EnginePolicy::Cpu,
            scale: Some(job.stage.scale),
            tile: None,
            layers: None,
            settings_id: None,
        }],
        output_grant_id: BYTE_UPSCALE_GRANT.to_string(),
        deadline_ms: PROXY_DEADLINE_MS,
        source: None,
        // 超分这一档只有超分阶段；去码那一条在下面的 `decensor` 里（它一个阶段就够）。
        inpaint: None,
    };
    run(manager, request, cancelled)
}

/// 让 worker 把这一页去码（检测与修补都在它那边），字节进字节出。
///
/// **只有一个阶段**：去码产物的身份是 `decensored_revision`（包指纹那一版），与链式那条路
/// 的 `enhanced` 不是同一个东西。算力中心那条来路里没有「顺手再超分一下」这个说法。
pub fn decensor(
    manager: &ComputeManager,
    job: DecensorJob<'_>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, ProxyError> {
    let staged = stage_page(manager, job.input_id, job.page)?;
    let request = SubmitRequest {
        key: JobKey {
            input_id: job.input_id.to_string(),
            settings_id: job.settings_id.to_string(),
            source_revision: job.source_revision.to_string(),
            backend: BACKEND_LABEL.to_string(),
            generation: 1,
        },
        priority: job.priority,
        input: staged,
        pipeline: vec![PipelineStage {
            stage_id: super::decensor::DECENSOR_STAGE_ID.to_string(),
            model_spec_id: job.model_spec_id.to_string(),
            // 去码阶段不认 `model`，它认的是「哪三份模型」：三件套由 `prepare_run` 从
            // `inpaint` 那一栏摆进只读输入根（协议里这两条路互斥）。
            model: None,
            decensor: None,
            dlssnr: None,
            min_input_edge: None,
            output_scale: None,
            // 去码在 worker 里只有 CPU 一条路（核心把检测定死在 `RuntimeId::Cpu`）。
            engine_policy: EnginePolicy::Cpu,
            scale: None,
            tile: None,
            layers: None,
            settings_id: None,
        }],
        output_grant_id: BYTE_DECENSOR_GRANT.to_string(),
        deadline_ms: PROXY_DEADLINE_MS,
        source: None,
        inpaint: Some(job.inpaint),
    };
    run(manager, request, cancelled)
}

/// 一件「让 worker 把这一页过一遍 DLSSNR」的请求。
///
/// 与去码那条不同的地方在于**模型从哪来**：去码的三件套是宿主解析出来的磁盘路径，
/// 交给 `prepare_run` 摆进输入根；这里的两样（片段 DLL 与参数文档）由这一层自己按
/// 内容摆——因为它们的来源不是「模型装了哪一版」，而是「这一份 DLL + 这一套参数」，
/// 内容本身就是要交给 worker 的东西（NGX 只按固定文件名找片段，见 `worker/src/dlssnr.rs`）。
// 下面这一整块（两件结构体、那条来路、两个摆盘 helper）都跟着目标门走：Android 上没有
// DLSSNR 这一档，见上面 `use` 处的说明。
#[cfg(windows)]
pub struct DlssnrJob<'a> {
    /// 这一页是谁（与 `UpscaleJob::input_id` 同义）。
    pub input_id: &'a str,
    /// 宿主算出来的身份串（`dlssnr::output_revision`）：与产物缓存认的身份是**同一个**，
    /// 于是「缓存认得这一版」与「调度器认得这一版」不会各说各话。
    pub settings_id: &'a str,
    /// 输入源图的修订。同一页但来路不同（原图 / 去码产物）就是不同的输入。
    pub source_revision: &'a str,
    pub priority: Priority,
    /// 这一档在账上叫什么（见 [`DLSSNR_STAGE_ID`]）。
    pub stage_id: &'a str,
    /// 已经装好的那份片段：`<data_dir>/dlssnr/nvngx_dlssnr.dll`（`dlssnr::dll_path`）。
    ///
    /// 传路径而不是字节：一百多兆的东西，这一层只负责给它算一次内容哈希再硬链接进
    /// 只读输入根，不经过内存。
    pub feature: &'a Path,
    /// 这一套参数。序列化成 JSON 当**文件**交出去——协议层刻意不依赖核心，而参数的真伪
    /// 与模型一样要能复核（`DlssnrSettings::from_json` / `to_json` 是唯一口径）。
    pub settings: &'a DlssnrSettings,
    pub page: &'a [u8],
}

/// 一趟 DLSSNR 的结果：产物字节，以及**这一页算过没有**。
///
/// `computed` 为什么必须跟着字节一起回来：DLSSNR 会在「评估两次都与输入逐像素相同」时
/// 把原图交回（`filter::PASSTHROUGH`），worker 那一边这时把引擎名报成 `passthrough`。
/// 把这种字节按「DLSSNR 的输出」落进缓存，等于把「没处理过」固化下来——用户那一页会
/// 一直停在未处理的样子。所以调用方需要区分，而判据只能来自 worker 的交代。
#[cfg(windows)]
pub struct DlssnrOutput {
    pub bytes: Vec<u8>,
    pub computed: bool,
}

/// 把这一页交给 worker 过一遍 DLSSNR（NGX 只在那边初始化）。
///
/// 一个阶段，两样输入外挂（片段 + 参数），产物是一张 PNG（动图那一页是编回去的 APNG，
/// 容器仍是 `image/png`，见 `compute-core::dlssnr::animation`）。
#[cfg(windows)]
pub fn dlssnr(
    manager: &ComputeManager,
    job: DlssnrJob<'_>,
    cancelled: &dyn Fn() -> bool,
) -> Result<DlssnrOutput, ProxyError> {
    let staged = stage_page(manager, job.input_id, job.page)?;
    let settings = stage_settings(manager, job.settings)?;
    let feature = stage_feature(manager, job.feature)?;
    let request = SubmitRequest {
        key: JobKey {
            input_id: job.input_id.to_string(),
            settings_id: job.settings_id.to_string(),
            source_revision: job.source_revision.to_string(),
            // DLSSNR 只有 D3D12 一条路（没有 CPU 回退），但键上写的仍是宿主这一层看到的
            // 后端标签：换后端那一天两处一起改（与超分/去码同一条口径）。
            backend: BACKEND_LABEL.to_string(),
            generation: 1,
        },
        priority: job.priority,
        input: staged,
        pipeline: vec![PipelineStage {
            stage_id: job.stage_id.to_string(),
            model_spec_id: DLSSNR_STAGE_ID.to_string(),
            // 模型是「哪一份片段」，走 `dlssnr` 那一栏；`model` 是 ONNX 模型那条路。
            model: None,
            decensor: None,
            dlssnr: Some(DlssnrGrant {
                feature,
                settings,
            }),
            min_input_edge: None,
            output_scale: None,
            // 引擎政策在这一档只有一个含义：显卡。DLSSNR 没有 CPU 回退，所以这不是
            // 「优先用 GPU」，而是「只能用它」——跑不起来时 worker 会报失败，不是回退。
            engine_policy: EnginePolicy::Gpu,
            scale: None,
            tile: None,
            layers: None,
            settings_id: None,
        }],
        output_grant_id: BYTE_DLSSNR_GRANT.to_string(),
        deadline_ms: PROXY_DEADLINE_MS,
        source: None,
        inpaint: None,
    };
    let finished = run_finished(manager, request, cancelled)?;
    Ok(DlssnrOutput {
        // worker 那一侧只在这一种情况下报 `passthrough`（动图原样交回、静态评估两次
        // 都与输入相同、容器说不清自己几帧），所以名字就是判据。
        computed: finished.engine_id != PASSTHROUGH_ENGINE_ID,
        bytes: finished.bytes,
    })
}

/// 把一套参数序列化之后按内容摆进只读输入根。
#[cfg(windows)]
fn stage_settings(
    manager: &ComputeManager,
    settings: &DlssnrSettings,
) -> Result<yomika_compute_protocol::GrantedFile, ProxyError> {
    let bytes = settings.to_json().into_bytes();
    let content_hash = blake3::hash(&bytes).to_hex().to_string();
    let byte_length = bytes.len() as u64;
    let relative_path = inputs::stage_bytes(manager.inputs_root(), &bytes, &content_hash, "json")
        .map_err(|error| ProxyError {
            code: "COMPUTE_INPUT_INVALID",
            message: format!("这一套参数摆不进只读输入根：{}", error.message()),
            retryable: false,
        })?;
    Ok(yomika_compute_protocol::GrantedFile {
        relative_path,
        content_hash,
        byte_length,
    })
}

/// 把片段 DLL 按内容摆进只读输入根。
///
/// 这里多一步算哈希（[`inputs::hash_file`]）：片段是**按路径**进来的（一百多兆，不该
/// 过内存），而内容寻址的名字与授权里那份复核都要 blake3。同卷时 `stage` 走硬链接，
/// 所以这一次读是整条路上唯一一次碰那份字节。
#[cfg(windows)]
fn stage_feature(
    manager: &ComputeManager,
    feature: &Path,
) -> Result<yomika_compute_protocol::GrantedFile, ProxyError> {
    let content_hash = inputs::hash_file(feature).map_err(|error| ProxyError {
        code: "COMPUTE_INPUT_INVALID",
        message: format!("读不出片段 {}：{}", feature.display(), error.message()),
        retryable: false,
    })?;
    let byte_length = std::fs::metadata(feature)
        .map_err(|error| ProxyError {
            code: "COMPUTE_INPUT_INVALID",
            message: format!("量不出片段 {}：{error}", feature.display()),
            retryable: false,
        })?
        .len();
    let relative_path = inputs::stage(manager.inputs_root(), feature, &content_hash).map_err(
        |error| ProxyError {
            code: "COMPUTE_INPUT_INVALID",
            message: format!("这一份片段摆不进只读输入根：{}", error.message()),
            retryable: false,
        },
    )?;
    Ok(yomika_compute_protocol::GrantedFile {
        relative_path,
        content_hash,
        byte_length,
    })
}

/// 把一页字节按内容摆进只读输入根，交出「输入在哪儿」那一份账。
///
/// 内容寻址：同一份字节第二次进来不会再写一遍，`input_id` 也可以跟着内容走——
/// 「同一页 + 同一份模型 = 同一件任务」（§8.1）正是靠这两件事同时成立。
fn stage_page(
    manager: &ComputeManager,
    input_id: &str,
    page: &[u8],
) -> Result<RunInput, ProxyError> {
    let content_hash = blake3::hash(page).to_hex().to_string();
    let byte_length = page.len() as u64;
    let relative_path = inputs::stage_bytes(
        manager.inputs_root(),
        page,
        &content_hash,
        extension_for(page),
    )
    .map_err(|error| ProxyError {
        code: "COMPUTE_INPUT_INVALID",
        // `InputError` 没有 `Display`：它自带 `code()`/`message()` 一对
        // （`compute-core::inputs`），这里要的是给人看的那一半。
        message: format!("这一页摆不进只读输入根：{}", error.message()),
        retryable: false,
    })?;
    Ok(RunInput {
        input_id: input_id.to_string(),
        content_hash,
        byte_length,
        // 已经在盘上了（`stage_bytes`），所以不再让宿主走 `source` 那条暂存路。
        relative_path: Some(relative_path),
    })
}

/// 提交、等终态、把宿主复核过的产物字节读回来。两条字节来路共用这一段。
fn run(
    manager: &ComputeManager,
    request: SubmitRequest,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, ProxyError> {
    Ok(run_finished(manager, request, cancelled)?.bytes)
}

/// 跑完之后宿主手里的两样东西：产物字节，以及 worker 对「谁算的」的交代。
///
/// 只有 DLSSNR 那一档要后一件（`passthrough` = 这一页没算过）；超分/去码那两条路只
/// 要字节，所以它们照旧走 [`run`]。
struct FinishedArtifact {
    bytes: Vec<u8>,
    /// worker 自报的引擎 id（`ArtifactRecord::engine_id` 是宿主**记下来**的那一份）。
    engine_id: String,
}

fn run_finished(
    manager: &ComputeManager,
    request: SubmitRequest,
    cancelled: &dyn Fn() -> bool,
) -> Result<FinishedArtifact, ProxyError> {
    let submitted = manager.submit(request).map_err(|error| ProxyError {
        code: "COMPUTE_QUEUE_FULL",
        message: format!("计算队列满了：{error:?}"),
        retryable: true,
    })?;
    let state = wait_for_terminal(manager, &submitted.job_id, submitted.subscription_id, cancelled)?;
    match state {
        JobState::Completed => read_artifact(manager, &submitted.job_id),
        JobState::Cancelled => Err(ProxyError {
            code: "INFERENCE_CANCELLED",
            message: "这一页的处理已取消".to_string(),
            retryable: false,
        }),
        JobState::Failed { code } => Err(failure(code)),
        // 终态之外的状态不可能从这里出去（`wait_for_terminal` 只看终态）；真出现了
        // 说明调度器坏了，不能装作成功。
        other => Err(ProxyError {
            code: "COMPUTE_INTERNAL",
            message: format!("任务停在了非终态：{other:?}"),
            retryable: true,
        }),
    }
}

/// 等一件任务到达终态；等待期间管两件事：取消牌，与自己的兜底期限。
fn wait_for_terminal(
    manager: &ComputeManager,
    job_id: &str,
    subscription_id: u64,
    cancelled: &dyn Fn() -> bool,
) -> Result<JobState, ProxyError> {
    let deadline = Instant::now() + PROXY_BUDGET;
    let mut cancel_sent = false;
    loop {
        match manager.job(job_id) {
            Some(snapshot) if snapshot.state.is_terminal() => return Ok(snapshot.state),
            Some(_) => {}
            // 提交成功之后快照不该消失。真消失了就说清楚，别猜。
            None => {
                return Err(ProxyError {
                    code: "COMPUTE_INTERNAL",
                    message: format!("任务 {job_id} 的快照不见了"),
                    retryable: true,
                })
            }
        }
        if !cancel_sent && cancelled() {
            cancel_sent = true;
            // 取消是**请求**：worker 可能正跑在一片瓦片里，宿主给的宽限是
            // `CANCEL_GRACE_MS`。这里不立刻返回，让它走完自己的收拾。
            let _ = manager.cancel(job_id, subscription_id);
        }
        if Instant::now() >= deadline {
            let _ = manager.cancel(job_id, subscription_id);
            return Err(ProxyError {
                code: "COMPUTE_TIMEOUT",
                message: format!("等了 {} 秒还没算完", deadline.elapsed().as_secs()),
                retryable: true,
            });
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 读回宿主自己复核过的产物。
fn read_artifact(manager: &ComputeManager, job_id: &str) -> Result<FinishedArtifact, ProxyError> {
    let artifact = manager
        .job_artifacts(job_id)
        .into_iter()
        .next()
        .ok_or_else(|| ProxyError {
            code: "COMPUTE_INTERNAL",
            message: format!("任务 {job_id} 报完成，却没有任何产物"),
            retryable: true,
        })?;
    if !artifact.verified {
        return Err(ProxyError {
            code: "COMPUTE_ARTIFACT_INVALID",
            message: format!("产物 {} 没有被宿主复核过，不能拿", artifact.artifact_id),
            retryable: true,
        });
    }
    let bytes = std::fs::read(&artifact.path).map_err(|error| ProxyError {
        code: "COMPUTE_ARTIFACT_INVALID",
        message: format!("读不回产物 {}：{error}", artifact.path.display()),
        retryable: true,
    })?;
    // 发布是 create-new + rename，但盘上的东西仍然要当面点一次数——这是读回字节这一侧
    // 最后一次能发现「档与字节不是一回事」的机会。
    if bytes.len() as u64 != artifact.byte_length {
        return Err(ProxyError {
            code: "COMPUTE_ARTIFACT_INVALID",
            message: format!(
                "产物 {} 的长度对不上：档里 {} 字节，盘上 {} 字节",
                artifact.artifact_id,
                artifact.byte_length,
                bytes.len()
            ),
            retryable: true,
        });
    }
    Ok(FinishedArtifact {
        bytes,
        engine_id: artifact.engine_id,
    })
}

/// 失败码的翻译。
///
/// 同一条命令不能在「模型是 ONNX」和「模型是 Anime4K/最近邻」两种情况下用两套词汇报
/// 同一件事（后两条路留在宿主里，仍然报旧码）。所以含义相同的翻过去：算不出来
/// （模型/运行库/预算/后端）⇒ `INFERENCE_UNAVAILABLE`；这一页的字节不对 ⇒
/// `INVALID_RESPONSE`。compute 侧多出来的那几种（排队满、超时、worker 丢了/忙）旧词汇
/// 里没有对应的词，原样报出来，它们是**暂态**。
///
/// 码必须是 `&'static str`（`DomainError` 的字段就是这个类型），而 worker 报回来的码是
/// 运行期才知道的字符串，所以这里只认**一张写死的表**：表外的码不硬编一个出来，而是翻成
/// `COMPUTE_INTERNAL` 并把原码写进文案里——日志里看得见，前端拿到的仍然是一个登记过的码。
/// 旧词汇里没有对应词、但前端登记过、而且**暂态**（过一会儿重来有意义）的几个码。
/// 它们说的是旧代码里根本没有过的几件事，所以不硬塞进旧词汇。
const TRANSIENT_CODES: [&str; 6] = [
    "COMPUTE_QUEUE_FULL",
    "COMPUTE_TIMEOUT",
    "COMPUTE_WORKER_LOST",
    "COMPUTE_WORKER_BUSY",
    "COMPUTE_ARTIFACT_INVALID",
    "COMPUTE_INTERNAL",
];

fn failure(code: String) -> ProxyError {
    // 第一遍：旧词汇里有对应词的就翻过去（同一条命令不许两套词）。
    let legacy = match code.as_str() {
        "COMPUTE_RESOURCE_LIMIT" | "GPU_BACKEND_UNAVAILABLE" | "GPU_OUTPUT_INVALID"
        | "COMPUTE_MODEL_UNAVAILABLE" | "COMPUTE_UNAVAILABLE" | "COMPUTE_WORKER_UNAVAILABLE" => {
            Some("INFERENCE_UNAVAILABLE")
        }
        "COMPUTE_INPUT_INVALID" | "COMPUTE_BAD_REQUEST" | "COMPUTE_PROTOCOL_MISMATCH"
        | "COMPUTE_ARTIFACT_REJECTED" => Some("INVALID_RESPONSE"),
        "COMPUTE_CANCELLED" => Some("INFERENCE_CANCELLED"),
        _ => None,
    };
    let (mapped, retryable) = if let Some(word) = legacy {
        (word, false)
    } else if let Some(known) = TRANSIENT_CODES
        .iter()
        .find(|known| **known == code.as_str())
    {
        // 认得的暂态码：原样报出来（都是静态字符串，不需要在运行期造 `&'static str`）。
        (*known, true)
    } else {
        // 表外的码：不硬编一个出来。`retryable = false` 是因为不知道重试有没有意义
        // ——拿不准时重试只会把一个确定的失败变成循环。
        ("COMPUTE_INTERNAL", false)
    };
    // 报出来的是**翻译后**的码，写进文案的是**worker 自报**的原码：翻译不该顺手把
    // 证据丢掉（前端只认前者，日志要看得见后者）。
    let message = match mapped == code.as_str() {
        true => format!("计算进程没能交出这一页（{code}）"),
        false => format!("计算进程没能交出这一页（{code} ⇒ {mapped}）"),
    };
    ProxyError {
        code: mapped,
        message,
        retryable,
    }
}

/// 这一页是什么格式，只按**内容**认（`image` 解出来也是按内容认的，两处口径必须一样）。
/// 扩展名只进相对路径，给人和日志看。
///
/// `sniff_image_mime` 的第一个参数是「调用方声明的 MIME」：这里没有声明，传空串
/// 就是纯粹按内容嗅探——缓存里交出来的字节本来也不带声明。
fn extension_for(bytes: &[u8]) -> &'static str {
    match crate::cache::sniff_image_mime("", bytes).as_deref() {
        Some("image/jpeg") => "jpg",
        Some("image/webp") => "webp",
        Some("image/gif") => "gif",
        _ => "png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧词汇里有词的翻过去；旧词汇里没词但前端登记过的原样报，并标成可重试。
    #[test]
    fn a_failure_code_is_translated_only_when_the_legacy_vocabulary_has_a_word_for_it() {
        let cases = [
            ("COMPUTE_RESOURCE_LIMIT", "INFERENCE_UNAVAILABLE", false),
            ("GPU_BACKEND_UNAVAILABLE", "INFERENCE_UNAVAILABLE", false),
            ("GPU_OUTPUT_INVALID", "INFERENCE_UNAVAILABLE", false),
            ("COMPUTE_MODEL_UNAVAILABLE", "INFERENCE_UNAVAILABLE", false),
            ("COMPUTE_INPUT_INVALID", "INVALID_RESPONSE", false),
            ("COMPUTE_BAD_REQUEST", "INVALID_RESPONSE", false),
            ("COMPUTE_ARTIFACT_REJECTED", "INVALID_RESPONSE", false),
            ("COMPUTE_CANCELLED", "INFERENCE_CANCELLED", false),
            ("COMPUTE_QUEUE_FULL", "COMPUTE_QUEUE_FULL", true),
            ("COMPUTE_TIMEOUT", "COMPUTE_TIMEOUT", true),
            ("COMPUTE_WORKER_LOST", "COMPUTE_WORKER_LOST", true),
            ("COMPUTE_WORKER_BUSY", "COMPUTE_WORKER_BUSY", true),
            ("COMPUTE_INTERNAL", "COMPUTE_INTERNAL", true),
            ("COMPUTE_ARTIFACT_INVALID", "COMPUTE_ARTIFACT_INVALID", true),
        ];
        for (incoming, expected_code, expected_retryable) in cases {
            let error = failure(incoming.to_string());
            assert_eq!(error.code, expected_code, "码翻译错了：{incoming}");
            assert_eq!(
                error.retryable, expected_retryable,
                "重试语义错了：{incoming}"
            );
            // 翻译过的码要把原码留在文案里；没翻译的就不必重复一遍。
            let carries_original = error.message.contains(incoming);
            assert!(carries_original, "文案里丢了原码：{}", error.message);
        }
    }

    /// 没见过的码不许编成「看着像旧词汇」的东西；但原码必须留在文案里，
    /// 否则日志里再也查不到它到底是什么。
    #[test]
    fn an_unknown_code_is_not_invented_into_something_familiar() {
        let error = failure("COMPUTE_SOMETHING_NEW".to_string());
        assert_eq!(error.code, "COMPUTE_INTERNAL");
        assert!(!error.retryable, "说不清能不能重试时不许说能");
        assert!(
            error.message.contains("COMPUTE_SOMETHING_NEW"),
            "原码得留在文案里：{}",
            error.message
        );
    }

    /// 扩展名只按内容认：一段真文件头就够，字节本身用不着能解码。
    #[test]
    fn the_extension_follows_the_bytes_not_the_caller() {
        assert_eq!(extension_for(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a]), "png");
        assert_eq!(extension_for(&[0xff, 0xd8, 0xff, 0xe0]), "jpg");
        assert_eq!(extension_for(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "webp");
        assert_eq!(extension_for(b"GIF89a"), "gif");
        // 什么都不认识的字节：给个 PNG 当兜底，反正 worker 是按内容解码的，
        // 认不出来的时候会以「输入坏了」告终——那与扩展名叫什么无关。
        assert_eq!(extension_for(&[0x00, 0x01, 0x02, 0x03]), "png");
    }
}
