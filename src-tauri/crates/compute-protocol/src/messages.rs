//! 消息集合与校验（docs/71 §6.2–§6.4）。
//!
//! 三类校验都在这里：**版本**（major 不符立即拒绝）、**字段**（`deny_unknown_fields`
//! 加顶层重复键检查）、**取值**（有限浮点、有界 scale/tile/layer/线程/期限）。
//! 还有 epoch：宿主换了 worker 之后，旧进程迟到的消息必须被忽略，而不是被当成
//! 当前任务的状态（docs/71 §6.5「晚到的 cancel/completed、重复 frame、旧 epoch
//! 事件均不得再次发布」）。

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::frame::MAX_FRAME_BYTES;

/// 协议 major 版本。
pub const PROTOCOL_MAJOR: u32 = 1;

/// 这份发行版里 worker 用来**计算**的那条运行库的标签（`ort-api` + ORT 自己的 API
/// 小版本，与 `compute_core::runtime::runtime_label` 同一个形状）。
///
/// 为什么这个串住在协议里、而不是各自去问链着的运行库：宿主**不再链 ONNX Runtime**
/// （docs/71 §11 Task 8 的出口条件、§4「Windows 宿主不链接 ORT/NGX」），所以它这一侧
/// `runtime_label()` 只会答 `"no-runtime"`；而派生产物的缓存身份必须说出**真正算它的**
/// 那条运行库（§11 Task 5 第 6 条），那个答案只存在于 worker 的构建里。宿主与 worker
/// 都链这份协议，所以这个「两边的共同事实」写在这里，与 `PROTOCOL_MAJOR` 同一类。
///
/// 手写的号会忘（`runtime_label` 当初不用手写常量正是这个理由），所以忘记不再是静默的：
/// worker 启动时拿自己的 `runtime_label()` 与它比对，对不上就拒跑
/// （`runtime_label_mismatch`），派生产物不会被按错误的版本号记进账。
#[cfg(not(target_os = "android"))]
pub const WORKER_RUNTIME_LABEL: &str = "ort-api27";
#[cfg(target_os = "android")]
pub const WORKER_RUNTIME_LABEL: &str = "ort-api27+ncnn-20260113-rgb128-v1";

/// 产物**不是算出来的**、而是原样交回时那一阶段报的引擎名。
///
/// 为什么它属于协议层：宿主按这个名字决定要不要把这份产物当「算过的」收下并落缓存
/// （DLSSNR 那两处 PASSTHROUGH：评估两次都与输入逐像素相同，见
/// `yomika_compute_core::dlssnr::filter::PASSTHROUGH`）。worker 报的与宿主认的必须是
/// 同一个字面量——各写一份，漂了不会报错，只会把「没算过」记成「算过了」。
pub const PASSTHROUGH_ENGINE_ID: &str = "passthrough";

/// DLSSNR 这一档的引擎名（握手报的 `BuildInfo.engines` 里那一项，也是产物报告里
/// `EngineReport.id` 那一项）。
///
/// 为什么它属于协议层：宿主**只能**从 worker 的 `BuildInfo.engines` 知道「这个进程认不认得
/// DLSSNR」（宿主自己有没有 NGX 垫片是另一回事，见 8-g④-b2），而 worker 那边这份表由
/// `onnx_engines()` 拼出来。worker 报的与宿主认的必须是同一个字面量——各写一份，漂了不会
/// 报错，只会让设置页把「其实能跑」说成「跑不了」（`status_with` 在 `core_available=false`
/// 时整组收起来），或者反过来把开关放给一台跑不起来的机器。
pub const DLSSNR_ENGINE_ID: &str = "dlssnr";

/// 内置超分链那一档的引擎名（握手报的 `BuildInfo.engines` 里那一项，也是产物报告里
/// `EngineReport.id` 那一项）。
///
/// 为什么它属于协议层：这一档**没有模型文件**，宿主交过去的只有一句身份
/// （`BuiltinChainGrant`：名字 + 版本），worker 拿它在自己编着的那份着色器里再解析一次。
/// 于是「宿主报的名字」与「worker 认的名字」必须是同一个字面量——各写一份，漂了不会报错，
/// 只会让产物报告把「链算出来的」说成别的引擎算的（宿主的诊断与缓存修订都按这个名字走）。
///
/// 第 30 轮之前这一档根本交不出去：`inference/anime4k.rs` 只编在宿主里，worker 的构建
/// 没有它，所以宿主只能当场拒（`COMPUTE_BAD_REQUEST`）。解析器与两个执行体搬进
/// `yomika-compute-core` 之后，两边编的是同一份，这一档才成为一条正常的来路。
pub const ANIME4K_ENGINE_ID: &str = "anime4k";

/// 计算进程在 staging 下给自己建的那棵暂存子树的目录名。
///
/// 为什么它属于协议层：**两边都要认得这个字面量**。worker 拿它当 NGX 的数据目录（那
/// 一百多 MB 的片段就落在它里面，见 `worker/src/dlssnr.rs` 的 `data_dir`），宿主拿它在
/// 会话收摊时把这棵子树收回去（`sweep_staging` 只认这个已知名字，别的子目录一律不碰）。
/// 各写一份，漂了不会报错，只会让那份片段永远攒在暂存目录里——按内容寻址不串味，但
/// 换一次片段就多留一份，谁也不会去清。
pub const SCRATCH_DIR_NAME: &str = "dlssnr-ngx";

const MAX_ID_BYTES: usize = 128;
const MAX_HASH_BYTES: usize = 128;
const MAX_MIME_BYTES: usize = 64;
const MAX_RELATIVE_NAME_BYTES: usize = 128;

/// 授权输入相对路径的上限。与 `yomika-compute-core::inputs` 的同一个上限对齐
/// （协议 crate 不能反过来依赖核心 crate，所以这里是各写一份）。协议只做形状
/// 校验，真正的路径解析在 worker 侧。
const MAX_INPUT_PATH_BYTES: usize = 200;
const MAX_PIPELINE_STAGES: usize = 8;
const MAX_FEATURES: usize = 64;
const MAX_MESSAGE_BYTES: usize = 512;
/// 输入文件上限：一张 100 MP 的 PNG 也就 ~100 MB，1 GiB 已经是宽容的护栏。
const MAX_INPUT_BYTES: u64 = 1024 * 1024 * 1024;
/// 单任务期限上限（10 分钟）。worker 侧还有更细的 stage 预算，这里是信封级的。
const MAX_DEADLINE_MS: u64 = 600_000;
const MAX_PIXELS: u64 = 256_000_000;
const MAX_OUTPUT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_INTRA_THREADS: u32 = 64;
/// 超分的 scale 只有 1–4；tile 是 0（自动）或 >= 32。
const MAX_SCALE: u32 = 4;
/// 模型能给的最小边长上限：与宿主侧模型清单的校验同一个数（`min_input_edge`）。
const MAX_MIN_INPUT_EDGE: u32 = 4096;
const MIN_TILE: u32 = 32;
const MAX_TILE: u32 = 4096;
const MAX_LAYERS: u32 = 5;
const MAX_DIMENSION: u32 = 65_536;
/// 一次 `release_idle` 最多能报回几份工作区。缓存是按「这一代用过的尺寸/变体」分格的，
/// 一台机器上不会上千；给一个上界是为了让界面上的数字不可能离谱到没人发现。
const MAX_RELEASED_WORKSPACES: u32 = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    /// JSON 本身不合法，或结构不符（未知字段、缺字段、类型不对、数值溢出）。
    Malformed(String),
    /// 顶层出现重复键：`serde_json` 的 map 会静默取最后一个，必须自己拦。
    DuplicateField(String),
    /// 没有 `protocolVersion`。
    MissingVersion,
    /// major 版本不认识。
    UnknownVersion { found: u64 },
    /// 没有 `type`。
    MissingType,
    /// `type` 不在消息集合里。
    UnknownType(String),
    /// 取值越界或非法（NaN/Inf 也走这里）。
    OutOfRange { field: String, detail: String },
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(detail) => write!(formatter, "malformed message: {detail}"),
            Self::DuplicateField(field) => write!(formatter, "duplicate field `{field}`"),
            Self::MissingVersion => formatter.write_str("message has no protocolVersion"),
            Self::UnknownVersion { found } => write!(
                formatter,
                "protocol version {found} is not supported (this build speaks {PROTOCOL_MAJOR})"
            ),
            Self::MissingType => formatter.write_str("message has no type"),
            Self::UnknownType(kind) => write!(formatter, "unknown message type `{kind}`"),
            Self::OutOfRange { field, detail } => {
                write!(formatter, "field `{field}` is out of range: {detail}")
            }
        }
    }
}

impl ProtocolError {
    /// 这一条错是不是「对面说的是另一个大版本」（Task 10 第 2 条）。
    ///
    /// 宿主对它的处置与「帧坏了」不一样：对面是另一份构建，拒跑一次、把状态说清楚就行，
    /// 不该按崩溃重试三遍再熔断——那样每次装错包都要先赔三次重启和 14 秒退避，用户看到的
    /// 还是「计算进程坏了」而不是「这份 worker 不是给这个宿主编的」。
    pub fn is_version_mismatch(&self) -> bool {
        matches!(self, Self::UnknownVersion { .. })
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Foreground,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnginePolicy {
    /// 由引擎自己按可用性选，回退要有报告。
    Auto,
    Cpu,
    /// 明确要 GPU：拿不到就是失败，不许悄悄用 CPU 顶（docs/71 §5.1/§12.1）。
    Gpu,
}

impl EnginePolicy {
    /// 线上的短名（与 serde 的 `lowercase` 一致）。宿主与 worker 都拿它拼会话缓存键、
    /// 填报告：同一条政策在三处各写一份拼法，迟早会有一处写歪。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::Gpu => "gpu",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Precision {
    Fp32,
    Fp16,
    Int8,
}

/// 引擎换运行库的那一段交代：想要谁、实际用了谁、为什么没用上。
///
/// 它**只**在真的回退时出现（`requested != used`）：没有回退就没有这一段，免得把
/// 「本来就想用 CPU」也写成一次退让。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineFallback {
    /// 平台偏好里想要的那条运行库 id（`directml` / `coreml` / `nnapi` / `cpu`）。
    pub requested: String,
    /// 实际用上的那条。
    pub used: String,
    /// 给用户看的原因（探针的实测结论、或「这条构建里没有」）。
    pub reason: String,
}

/// 引擎自报的执行信息（docs/71 §6.4）。宿主不采信它当「成功」的证据，只当元数据；
/// 真正的证据是 artifact 的内容与宿主自己的对照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineReport {
    pub id: String,
    pub version: String,
    pub precision: Precision,
    pub device_id: String,
    /// 这一阶段被问的是哪条政策（分工里 `enginePolicy`）。
    ///
    /// 可选：老 worker 不发这个字段。给消息加可选字段是既有做法（见
    /// [`PipelineStage::model`]），所以新老两侧都能好好说话。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<EnginePolicy>,
    /// 只有真回退时才有；见 [`EngineFallback`]。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<EngineFallback>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildInfo {
    pub version: String,
    pub runtimes: Vec<String>,
    pub engines: Vec<String>,
    pub model_formats: Vec<String>,
    /// worker 自己那一份构建戳（Task 10 第 2 条：「主 exe 与 worker 构建戳一致」）。
    ///
    /// 默认空串是**给老 worker 留的位置**：这个字段是新加的，旧的 worker 不会报它，
    /// 那正好说明对面是旧包——宿主把「一个字都不报」判成不配，而不是判成没事。
    #[serde(default)]
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunInput {
    pub input_id: String,
    pub content_hash: String,
    pub byte_length: u64,
    /// 这次运行要读的那张图，相对 worker 的**输入根**（docs/71 §7.1）。宿主把
    /// 它 pin 住之后给出这份只读授权；没有授权就没有路径，需要像素的引擎自己
    /// 回 `COMPUTE_INPUT_INVALID`。老客户端不发这个字段，所以它是可选的。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
}

/// 宿主授权的一份**只读文件**：相对 worker 的输入根（docs/71 §7.1）。
///
/// 页面的源图与模型文件走同一条通道：worker 只有一条被允许读用户数据与模型的路，
/// 它拿着相对路径自己解析、自己复核长度与 hash。宿主在 run 里写的只是**待核对的
/// 声明**，不是信任（§7.2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantedFile {
    pub relative_path: String,
    pub content_hash: String,
    pub byte_length: u64,
}

/// 一个 DLSSNR 阶段要用的**两样东西**：片段 DLL 的字节，与那一套参数（docs/106）。
///
/// 为什么片段也走授权通道、而不是让 worker 去数据目录里找：Task 8 的出口条件要求
/// 宿主不留 NGX 资源，而 NGX 只按**固定文件名**（`nvngx_dlssnr.dll`）在搜索路径里找
/// 片段——它不能从「内容寻址的名字」里认出一份片段。所以宿主交过来的是**字节**，
/// 由 worker 按 NGX 的规矩落成 `dlssnr/nvngx_dlssnr.dll`。为什么不是帧里的一段自由
/// 文本：协议层的帧上限是 64 KiB，而这一份是 165 MB 上下（§5.4 的同一个理由）。
///
/// 参数为什么也是一份文件、而不是塞进阶段的一个结构体：它是**核心**的类型
/// （`yomika_compute_core::dlssnr::DlssnrSettings`），而协议层刻意不依赖核心
/// （见 crate 的 doc：只依赖 serde）。写成文件仍然是按内容寻址 + 有 hash 可复核，
/// 与模型、与页面走的是同一条通道。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DlssnrGrant {
    /// 片段 DLL 的字节（`nvngx_dlssnr.dll`）。worker 按 NGX 要的真名落盘。
    pub feature: GrantedFile,
    /// 这一套参数（`DlssnrSettings` 的 JSON）。层数与每一层的数值都由核心那边
    /// `normalized()` 收过范围，worker 只按它跑。
    pub settings: GrantedFile,
}

/// 宿主内置的**超分链**（Anime4K 那三档）交给 worker 的声明：**没有文件**。
///
/// 为什么不像 ONNX 那样给一份 `GrantedFile`：这条链不是权重文件，而是编进宿主与 worker
/// **两个二进制**里的着色器程序（`resources/anime4k/*.glsl`，`core::anime4k`）。既然两边
/// 都有，交过去的就只能是**身份**——链的名字与版本；worker 拿着这个名字在自己那一份里再
/// 解析一次（`preset_by_id`），版本对不上就报 `COMPUTE_MODEL_UNAVAILABLE`：宿主与 worker
/// 的着色器不是同一份时，用户看到的会是一张按别的算法算出来的图，那比报错糟得多
/// （与 §7.2「宿主写的只是声明」同一条规矩）。
///
/// 为什么也带 `scale`：链的倍率是**链自己**的事实（Anime4K 的 x2 卷积决定），宿主写在
/// `stage.scale` 里只是它的说法；worker 两边比一下，不一致就是请求坏了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuiltinChainGrant {
    /// 链的名字（`anime4k` / `anime4k-hq` / `anime4k-ultra`）。
    pub chain_id: String,
    /// 链的版本（着色器改了就要换它：缓存身份与「两边是不是同一份」都挂在它上面）。
    pub version: String,
    pub scale: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineStage {
    pub stage_id: String,
    pub model_spec_id: String,
    pub engine_policy: EnginePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layers: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_id: Option<String>,
    /// 这一阶段要用的**模型文件**：宿主把 `modelSpecId` 解析成一份已经放进输入根的
    /// 只读授权之后填在这里。不填 = 这一阶段不需要模型（echo 引擎这类）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<GrantedFile>,
    /// 这一阶段是 **DLSSNR** 阶段时要填的两样东西。与 `model` 相互排斥：这一阶段的输入
    /// 是页面本身，同一页没法既按 DLSSNR 的一层参数重绘、又拿去当超分的输入。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dlssnr: Option<DlssnrGrant>,
    /// 这一阶段要跑**宿主内置的超分链**（Anime4K）时要填的声明。与前四样相互排斥：
    /// 它同样是一种「拿这一页算出另一页」的授权，只是那份算法在**两个二进制的代码里**，
    /// 不在模型目录里——所以它没有文件，只有名字与版本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<BuiltinChainGrant>,
    /// 模型能接受的最小边长（源像素）：低于它的分块由引擎自己垫大、算完再裁回来。
    /// Real-CUGAN 图内 reflect 18 px，把 9 px 的页边条喂进去会直接失败；默认 1
    /// 就是「照分块规划的原样交给它」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_input_edge: Option<u32>,
    /// 交出去的图**最多**是源图的这么多倍：模型原生倍率比它大时按 Lanczos3 缩下来。
    /// 不填 = 原样交出模型算出来的尺寸。
    ///
    /// 这条由宿主（产品策略）决定，不由 worker 猜：x4 模型的 5600×8000 是 180 MB
    /// RGBA、编码出来又是几十 MB，而阅读器画的槽位最多就是页的两三倍——所以
    /// 「缩到多少」必须在**编码之前**落地，也就是必须过这条参数（docs/71 §5.3）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_scale: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budgets {
    pub max_pixels: u64,
    pub max_output_bytes: u64,
    pub intra_threads: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub job_id: String,
    pub generation: u64,
    pub input: RunInput,
    pub pipeline: Vec<PipelineStage>,
    pub output_grant_id: String,
    pub priority: Priority,
    pub deadline_ms: u64,
    pub budgets: Budgets,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactReady {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub job_id: String,
    pub generation: u64,
    pub stage_id: String,
    pub artifact_id: String,
    pub output_grant_id: String,
    pub relative_name: String,
    pub content_hash: String,
    pub mime: String,
    pub byte_length: u64,
    pub width: u32,
    pub height: u32,
    pub engine: EngineReport,
    pub pipeline_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub build: BuildInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloAck {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub features: Vec<String>,
    pub max_frame_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobRef {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub job_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageProgress {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub job_id: String,
    pub generation: u64,
    pub stage_id: String,
    /// 0–100，有限值；worker 的进度只是提示，宿主不据此判成功。
    pub percent: f32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageStarted {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub job_id: String,
    pub generation: u64,
    pub stage_id: String,
    pub stage_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpochOnly {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ping {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub nonce: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRef {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub job_id: String,
    pub artifact_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `release_idle` 的结果：这一代 worker **实际**交回了几份缓存工作区。
///
/// 为什么不复用 `Released(JobRef)`：那条是「额度已收回」的回执，载体是跑过的最后一个
/// 任务，形状里没有数字；而「交回了几份」是宿主唯一能让用户看见的**实测**结果
/// （docs/71 §8.4 要求交回之后 private commit 回落）。两者回答的是两个问题，
/// 硬塞进一条消息只会让其中一格的取值靠猜。
///
/// 一个任务都没跑过时也要发这一条：`count = 0` 与「没回话」在宿主那边必须能分开。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacesReleased {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failed {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub worker_epoch: String,
    pub job_id: String,
    pub generation: u64,
    pub code: String,
    pub message: String,
}

/// 全部消息。序列化时用 `Message::encode`，反序列化用 [`parse`]（不直接用 serde，
/// 因为版本与重复键要在结构反序列化**之前**判定）。
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Hello(Hello),
    HelloAck(HelloAck),
    Run(Run),
    Accepted(JobRef),
    StageStarted(StageStarted),
    Progress(StageProgress),
    ArtifactReady(ArtifactReady),
    ArtifactAck(ArtifactRef),
    ArtifactRejected(ArtifactRef),
    Completed(JobRef),
    Cancelled(JobRef),
    Failed(Failed),
    Released(JobRef),
    ReleaseIdle(EpochOnly),
    /// worker 对 `release_idle` 的**结果**（交回了几份工作区）。与 `Released` 并列而不是
    /// 替代它：一条是「谁把额度还回来了」，一条是「还回来几份」。
    WorkspacesReleased(WorkspacesReleased),
    Cancel(JobRef),
    Ping(Ping),
    Pong(Ping),
    Shutdown(EpochOnly),
}

impl Message {
    /// 日志/指标用的类型名，与 wire 上的 `type` 一致。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Hello(_) => "hello",
            Self::HelloAck(_) => "hello_ack",
            Self::Run(_) => "run",
            Self::Accepted(_) => "accepted",
            Self::StageStarted(_) => "stage_started",
            Self::Progress(_) => "progress",
            Self::ArtifactReady(_) => "artifact_ready",
            Self::ArtifactAck(_) => "artifact_ack",
            Self::ArtifactRejected(_) => "artifact_rejected",
            Self::Completed(_) => "completed",
            Self::Cancelled(_) => "cancelled",
            Self::Failed(_) => "failed",
            Self::Released(_) => "released",
            Self::ReleaseIdle(_) => "release_idle",
            Self::WorkspacesReleased(_) => "workspaces_released",
            Self::Cancel(_) => "cancel",
            Self::Ping(_) => "ping",
            Self::Pong(_) => "pong",
            Self::Shutdown(_) => "shutdown",
        }
    }

    /// 这条消息属于哪个 worker epoch。
    pub fn epoch(&self) -> &str {
        match self {
            Self::Hello(message) => &message.worker_epoch,
            Self::HelloAck(message) => &message.worker_epoch,
            Self::Run(message) => &message.worker_epoch,
            Self::Accepted(message)
            | Self::Completed(message)
            | Self::Cancelled(message)
            | Self::Released(message)
            | Self::Cancel(message) => &message.worker_epoch,
            Self::StageStarted(message) => &message.worker_epoch,
            Self::Progress(message) => &message.worker_epoch,
            Self::ArtifactReady(message) => &message.worker_epoch,
            Self::ArtifactAck(message) | Self::ArtifactRejected(message) => &message.worker_epoch,
            Self::Failed(message) => &message.worker_epoch,
            Self::WorkspacesReleased(message) => &message.worker_epoch,
            Self::ReleaseIdle(message) | Self::Shutdown(message) => &message.worker_epoch,
            Self::Ping(message) | Self::Pong(message) => &message.worker_epoch,
        }
    }

    /// 是不是终结状态：宿主只允许对终结消息做一次终态转换。
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed(_) | Self::Cancelled(_) | Self::Failed(_)
        )
    }

    /// 这条消息是否属于给定的 worker epoch。宿主换过 worker 之后，旧进程迟到的
    /// 消息一律不得再影响当前任务（docs/71 §6.5）。
    pub fn matches_epoch(&self, expected: &str) -> bool {
        self.epoch() == expected
    }
}

/// 反序列化一条消息。
///
/// 顺序是刻意的：先解决**信封**（顶层重复键、`protocolVersion`、`type`），再交给
/// 具体类型，最后做取值校验。版本不对就没有必要去猜正文的形状。
pub fn parse(body: &[u8]) -> Result<Message, ProtocolError> {
    let UniqueObject(mut map) = parse_unique_object(body)?;

    let version = match map.get("protocolVersion") {
        None => return Err(ProtocolError::MissingVersion),
        Some(serde_json::Value::Number(number)) => number.as_u64().ok_or_else(|| {
            ProtocolError::Malformed("protocolVersion must be a non-negative integer".into())
        })?,
        Some(_) => {
            return Err(ProtocolError::Malformed(
                "protocolVersion must be a non-negative integer".into(),
            ))
        }
    };
    if version != u64::from(PROTOCOL_MAJOR) {
        return Err(ProtocolError::UnknownVersion { found: version });
    }

    let kind = match map.get("type") {
        None => return Err(ProtocolError::MissingType),
        Some(serde_json::Value::String(kind)) => kind.clone(),
        Some(_) => return Err(ProtocolError::Malformed("type must be a string".into())),
    };

    // `type` 是信封字段，不属于任何一条消息的正文。`deny_unknown_fields` 会把它
    // 当未知字段拒掉，所以摘下来再交给具体类型。
    map.remove("type");
    let value = serde_json::Value::Object(map);

    let message = match kind.as_str() {
        "hello" => Message::Hello(from_value(value)?),
        "hello_ack" => Message::HelloAck(from_value(value)?),
        "run" => Message::Run(from_value(value)?),
        "accepted" => Message::Accepted(from_value(value)?),
        "stage_started" => Message::StageStarted(from_value(value)?),
        "progress" => Message::Progress(from_value(value)?),
        "artifact_ready" => Message::ArtifactReady(from_value(value)?),
        "artifact_ack" => Message::ArtifactAck(from_value(value)?),
        "artifact_rejected" => Message::ArtifactRejected(from_value(value)?),
        "completed" => Message::Completed(from_value(value)?),
        "cancelled" => Message::Cancelled(from_value(value)?),
        "failed" => Message::Failed(from_value(value)?),
        "released" => Message::Released(from_value(value)?),
        "release_idle" => Message::ReleaseIdle(from_value(value)?),
        "workspaces_released" => Message::WorkspacesReleased(from_value(value)?),
        "cancel" => Message::Cancel(from_value(value)?),
        "ping" => Message::Ping(from_value(value)?),
        "pong" => Message::Pong(from_value(value)?),
        "shutdown" => Message::Shutdown(from_value(value)?),
        other => return Err(ProtocolError::UnknownType(other.to_string())),
    };
    message.validate()?;
    Ok(message)
}

/// 顶层对象，**键必须唯一**。
///
/// `serde_json` 的 map 会把重复键静默收敛成最后一个，于是「哪一份设置生效」就
/// 由文本顺序决定——对一份要落盘、要重放的配置来说这是不可接受的，所以在结构
/// 反序列化之前先自己走一遍 `MapAccess` 查重。
struct UniqueObject(serde_json::Map<String, serde_json::Value>);

/// `UniqueObject` 查重失败时用的标记。走 `serde::de::Error::custom` 只能拿到
/// 一个字符串，`serde_json` 又可能给它接上位置后缀，所以这里只认前缀。
const DUPLICATE_KEY_MARK: &str = "duplicate json key `";

fn parse_unique_object(body: &[u8]) -> Result<UniqueObject, ProtocolError> {
    match serde_json::from_slice::<UniqueObject>(body) {
        Ok(unique) => Ok(unique),
        Err(error) => {
            let text = error.to_string();
            if let Some(start) = text.find(DUPLICATE_KEY_MARK) {
                let rest = &text[start + DUPLICATE_KEY_MARK.len()..];
                let field = rest.split('`').next().unwrap_or_default().to_string();
                return Err(ProtocolError::DuplicateField(field));
            }
            Err(ProtocolError::Malformed(text))
        }
    }
}

impl<'de> Deserialize<'de> for UniqueObject {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct UniqueVisitor;

        impl<'de> serde::de::Visitor<'de> for UniqueVisitor {
            type Value = UniqueObject;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object whose keys are unique")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut access: A,
            ) -> Result<Self::Value, A::Error> {
                let mut map = serde_json::Map::new();
                while let Some(key) = access.next_key::<String>()? {
                    if map.contains_key(&key) {
                        return Err(serde::de::Error::custom(format!(
                            "{DUPLICATE_KEY_MARK}{key}`"
                        )));
                    }
                    let value = access.next_value::<serde_json::Value>()?;
                    map.insert(key, value);
                }
                Ok(UniqueObject(map))
            }
        }

        deserializer.deserialize_map(UniqueVisitor)
    }
}

fn from_value<T: serde::de::DeserializeOwned>(
    value: serde_json::Value,
) -> Result<T, ProtocolError> {
    serde_json::from_value(value).map_err(|error| ProtocolError::Malformed(error.to_string()))
}

impl Message {
    /// 取值校验。NaN/Inf 与越界数值都在这里被拒（docs/71 §6.2）。
    fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Hello(message) => {
                epoch(&message.worker_epoch)?;
                build_info(&message.build)
            }
            Self::HelloAck(message) => {
                epoch(&message.worker_epoch)?;
                bounded(
                    "maxFrameBytes",
                    u64::from(message.max_frame_bytes),
                    1,
                    MAX_FRAME_BYTES as u64,
                )?;
                if message.features.len() > MAX_FEATURES {
                    return Err(out_of_range(
                        "features",
                        format!("at most {MAX_FEATURES} entries, got {}", message.features.len()),
                    ));
                }
                for feature in &message.features {
                    text("features", feature, MAX_ID_BYTES)?;
                }
                Ok(())
            }
            Self::Run(message) => message.validate(),
            Self::Accepted(message)
            | Self::Completed(message)
            | Self::Cancelled(message)
            | Self::Released(message)
            | Self::Cancel(message) => job_ref(message),
            Self::StageStarted(message) => {
                job_ref_parts(&message.worker_epoch, &message.job_id, message.generation)?;
                id("stageId", &message.stage_id)?;
                bounded(
                    "stageIndex",
                    u64::from(message.stage_index),
                    0,
                    MAX_PIPELINE_STAGES as u64,
                )
            }
            Self::Progress(message) => {
                job_ref_parts(&message.worker_epoch, &message.job_id, message.generation)?;
                id("stageId", &message.stage_id)?;
                finite_percent("percent", message.percent)
            }
            Self::ArtifactReady(message) => message.validate(),
            Self::ArtifactAck(message) | Self::ArtifactRejected(message) => {
                epoch(&message.worker_epoch)?;
                id("jobId", &message.job_id)?;
                id("artifactId", &message.artifact_id)?;
                if let Some(reason) = &message.reason {
                    text("reason", reason, MAX_MESSAGE_BYTES)?;
                }
                Ok(())
            }
            Self::Failed(message) => {
                job_ref_parts(&message.worker_epoch, &message.job_id, message.generation)?;
                id("code", &message.code)?;
                text("message", &message.message, MAX_MESSAGE_BYTES)
            }
            Self::ReleaseIdle(message) | Self::Shutdown(message) => epoch(&message.worker_epoch),
            Self::WorkspacesReleased(message) => {
                epoch(&message.worker_epoch)?;
                // 一台机器的缓存工作区是「一人一份」的量级；上千只可能是对面在编，或者
                // 我们这一侧的记账坏了。有这个上界，界面上的数字与内存曲线才对得上。
                bounded(
                    "count",
                    u64::from(message.count),
                    0,
                    u64::from(MAX_RELEASED_WORKSPACES),
                )
            }
            Self::Ping(message) | Self::Pong(message) => epoch(&message.worker_epoch),
        }
    }
}

/// 校验一条已经构造好的消息。`parse` 之外还有这条入口，因为 worker 内部组帧
/// 之前要自查，而那时并没有经过 JSON 反序列化。
pub fn validate_message(message: &Message) -> Result<(), ProtocolError> {
    message.validate()
}

impl Run {
    fn validate(&self) -> Result<(), ProtocolError> {
        job_ref_parts(&self.worker_epoch, &self.job_id, self.generation)?;
        id("input.inputId", &self.input.input_id)?;
        text("input.contentHash", &self.input.content_hash, MAX_HASH_BYTES)?;
        bounded("input.byteLength", self.input.byte_length, 1, MAX_INPUT_BYTES)?;
        if let Some(relative) = &self.input.relative_path {
            relative_input_path("input.relativePath", relative)?;
        }
        if self.pipeline.is_empty() {
            return Err(out_of_range("pipeline", "must have at least one stage"));
        }
        if self.pipeline.len() > MAX_PIPELINE_STAGES {
            return Err(out_of_range(
                "pipeline",
                format!("at most {MAX_PIPELINE_STAGES} stages, got {}", self.pipeline.len()),
            ));
        }
        for stage in &self.pipeline {
            stage.validate()?;
        }
        id("outputGrantId", &self.output_grant_id)?;
        bounded("deadlineMs", self.deadline_ms, 1, MAX_DEADLINE_MS)?;
        self.budgets.validate()
    }
}

impl PipelineStage {
    fn validate(&self) -> Result<(), ProtocolError> {
        id("stageId", &self.stage_id)?;
        id("modelSpecId", &self.model_spec_id)?;
        if let Some(scale) = self.scale {
            bounded("scale", u64::from(scale), 1, u64::from(MAX_SCALE))?;
        }
        if let Some(tile) = self.tile {
            // 0 是「自动」，其余必须 >= 32：再小内核会自己越界。
            if tile != 0 && !(MIN_TILE..=MAX_TILE).contains(&tile) {
                return Err(out_of_range(
                    "tile",
                    format!("must be 0 (auto) or {MIN_TILE}..={MAX_TILE}, got {tile}"),
                ));
            }
        }
        if let Some(layers) = self.layers {
            bounded("layers", u64::from(layers), 1, u64::from(MAX_LAYERS))?;
        }
        if let Some(settings) = &self.settings_id {
            id("settingsId", settings)?;
        }
        if let Some(model) = &self.model {
            granted_file("model", model)?;
        }
        // 两样都给 = 一次说不清的请求：这个阶段的输入是页面本身，引擎没法同时按
        // 「拿模型把图变形」和「按 DLSSNR 的一层参数重绘」两种解码方式来用它。
        // 这条判的是**三样里恰有一份**：多一份就必有一份是摆设，
        // 而「哪一份是摆设」worker 只能猜——猜错的那一种会变成一张看起来对、其实
        // 没按用户要求处理过的图（DLSSNR 的输入要求与超分模型正好不兼容）。
        let grants = u8::from(self.model.is_some())
            + u8::from(self.dlssnr.is_some())
            + u8::from(self.builtin.is_some());
        if grants > 1 {
            return Err(out_of_range(
                "builtin",
                "a stage carries exactly one of a model, a dlssnr grant, or a builtin chain grant",
            ));
        }
        if let Some(dlssnr) = &self.dlssnr {
            granted_file("dlssnr.feature", &dlssnr.feature)?;
            granted_file("dlssnr.settings", &dlssnr.settings)?;
        }
        if let Some(builtin) = &self.builtin {
            // 名字与版本都按 id 收：它们是**标识**，不是自由文本（版本里出现空白或控制
            // 字符只可能是谁拼错了，而拼错的版本号在 worker 那边会变成一句「两边不是同一
            // 份」——那句话说不出到底哪儿错了）。
            id("builtin.chainId", &builtin.chain_id)?;
            id("builtin.version", &builtin.version)?;
            bounded("builtin.scale", u64::from(builtin.scale), 1, u64::from(MAX_SCALE))?;
        }
        if let Some(edge) = self.min_input_edge {
            bounded(
                "minInputEdge",
                u64::from(edge),
                1,
                u64::from(MAX_MIN_INPUT_EDGE),
            )?;
        }
        if let Some(scale) = self.output_scale {
            // 与 `scale` 同一个上限：比模型原生倍率更大的缩小倍率没有意义。
            bounded("outputScale", u64::from(scale), 1, u64::from(MAX_SCALE))?;
        }
        Ok(())
    }
}

impl Budgets {
    fn validate(&self) -> Result<(), ProtocolError> {
        bounded("maxPixels", self.max_pixels, 1, MAX_PIXELS)?;
        bounded("maxOutputBytes", self.max_output_bytes, 1, MAX_OUTPUT_BYTES)?;
        bounded(
            "intraThreads",
            u64::from(self.intra_threads),
            1,
            u64::from(MAX_INTRA_THREADS),
        )
    }
}

impl ArtifactReady {
    fn validate(&self) -> Result<(), ProtocolError> {
        job_ref_parts(&self.worker_epoch, &self.job_id, self.generation)?;
        id("stageId", &self.stage_id)?;
        id("artifactId", &self.artifact_id)?;
        id("outputGrantId", &self.output_grant_id)?;
        artifact_name("relativeName", &self.relative_name)?;
        text("contentHash", &self.content_hash, MAX_HASH_BYTES)?;
        text("mime", &self.mime, MAX_MIME_BYTES)?;
        bounded("byteLength", self.byte_length, 1, MAX_OUTPUT_BYTES)?;
        bounded("width", u64::from(self.width), 1, u64::from(MAX_DIMENSION))?;
        bounded("height", u64::from(self.height), 1, u64::from(MAX_DIMENSION))?;
        self.engine.validate()?;
        id("pipelineRevision", &self.pipeline_revision)
    }
}

impl EngineReport {
    fn validate(&self) -> Result<(), ProtocolError> {
        id("engine.id", &self.id)?;
        text("engine.version", &self.version, MAX_ID_BYTES)?;
        id("engine.deviceId", &self.device_id)?;
        if let Some(fallback) = &self.fallback {
            // 交代要么一句不说，要么把「想要谁、用了谁、为什么」说全：只说半句的
            // 交代比没有更坏——界面会据此告诉用户「已经在用显卡了」。
            id("engine.fallback.requested", &fallback.requested)?;
            id("engine.fallback.used", &fallback.used)?;
            text("engine.fallback.reason", &fallback.reason, MAX_ID_BYTES)?;
            if fallback.requested == fallback.used {
                return Err(out_of_range(
                    "engine.fallback.used",
                    format!(
                        "same as requested `{}`: a fallback that did not fall back",
                        fallback.used
                    ),
                ));
            }
        }
        Ok(())
    }
}

fn build_info(build: &BuildInfo) -> Result<(), ProtocolError> {
    text("build.version", &build.version, MAX_ID_BYTES)?;
    for (field, list) in [
        ("build.runtimes", &build.runtimes),
        ("build.engines", &build.engines),
        ("build.modelFormats", &build.model_formats),
    ] {
        if list.len() > MAX_FEATURES {
            return Err(out_of_range(
                field,
                format!("at most {MAX_FEATURES} entries, got {}", list.len()),
            ));
        }
        for entry in list {
            text(field, entry, MAX_ID_BYTES)?;
        }
    }
    Ok(())
}

fn job_ref(message: &JobRef) -> Result<(), ProtocolError> {
    job_ref_parts(&message.worker_epoch, &message.job_id, message.generation)
}

fn job_ref_parts(worker_epoch: &str, job_id: &str, generation: u64) -> Result<(), ProtocolError> {
    epoch(worker_epoch)?;
    id("jobId", job_id)?;
    // generation 从 1 开始：0 意味着「没带代次」，那正是必须被拒的模糊状态。
    bounded("generation", generation, 1, u64::MAX)
}

fn epoch(value: &str) -> Result<(), ProtocolError> {
    id("workerEpoch", value)
}

fn id(field: &str, value: &str) -> Result<(), ProtocolError> {
    text(field, value, MAX_ID_BYTES)
}

fn text(field: &str, value: &str, max: usize) -> Result<(), ProtocolError> {
    if value.is_empty() {
        return Err(out_of_range(field, "must not be empty"));
    }
    if value.len() > max {
        return Err(out_of_range(
            field,
            format!("must be at most {max} bytes, got {}", value.len()),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(out_of_range(field, "must not contain control characters"));
    }
    Ok(())
}

fn bounded(field: &str, value: u64, min: u64, max: u64) -> Result<(), ProtocolError> {
    if value < min || value > max {
        return Err(out_of_range(
            field,
            format!("must be {min}..={max}, got {value}"),
        ));
    }
    Ok(())
}

fn finite_percent(field: &str, value: f32) -> Result<(), ProtocolError> {
    // NaN 与 Inf 都要拒：它们会一路过掉 `<= 100` 之外的比较，然后毁掉进度条与
    // 剩余的预算计算。
    if !value.is_finite() || !(0.0..=100.0).contains(&value) {
        return Err(out_of_range(
            field,
            format!("must be a finite 0..=100 value, got {value}"),
        ));
    }
    Ok(())
}

/// 产物文件名：worker 只给文件名，宿主把它拼进 grant 目录。所以这里必须挡住
/// 分隔符与 `..`，否则 worker 就有了一次任意的写路径（docs/71 §7.2）。
fn artifact_name(field: &str, value: &str) -> Result<(), ProtocolError> {
    text(field, value, MAX_RELATIVE_NAME_BYTES)?;
    if value == "." || value == ".." {
        return Err(out_of_range(field, "must be a file name, not a directory"));
    }
    if value.contains(['/', '\\']) {
        return Err(out_of_range(field, "must not contain a path separator"));
    }
    Ok(())
}

/// 授权输入相对路径（docs/71 §7.1）。这里只挡「形状明确不对」的：绝对路径、
/// 盘符或备用数据流的冒号。`.`/`..`/段尾空格点/重解析点这些要落到文件系统上才
/// 判得准，是 worker 侧 `resolve_granted` 的活（§7.2：不能只做字符串判断）。
fn relative_input_path(field: &str, value: &str) -> Result<(), ProtocolError> {
    text(field, value, MAX_INPUT_PATH_BYTES)?;
    if value.starts_with(['/', '\\']) {
        return Err(out_of_range(field, "must be relative to the input root"));
    }
    if value.contains(':') {
        return Err(out_of_range(
            field,
            "must not contain a drive letter or an alternate data stream",
        ));
    }
    Ok(())
}

fn out_of_range(field: &str, detail: impl Into<String>) -> ProtocolError {
    ProtocolError::OutOfRange {
        field: field.to_string(),
        detail: detail.into(),
    }
}

/// 复核一份只读授权的三栏。抽出来是因为现在有四份（模型 + 检测集 + 两份修补模型），
/// 而「哪一栏漏了检查」这种事一旦靠人抄，就一定会漏（docs/91）。
fn granted_file(field: &str, file: &GrantedFile) -> Result<(), ProtocolError> {
    relative_input_path(&format!("{field}.relativePath"), &file.relative_path)?;
    text(&format!("{field}.contentHash"), &file.content_hash, MAX_HASH_BYTES)?;
    bounded(
        &format!("{field}.byteLength"),
        file.byte_length,
        1,
        MAX_INPUT_BYTES,
    )
}

/// 序列化一条消息（供 `write_frame` 使用）。
pub fn encode(message: &Message) -> Result<String, ProtocolError> {
    let value = match message {
        Message::Hello(message) => tagged("hello", message),
        Message::HelloAck(message) => tagged("hello_ack", message),
        Message::Run(message) => tagged("run", message),
        Message::Accepted(message) => tagged("accepted", message),
        Message::StageStarted(message) => tagged("stage_started", message),
        Message::Progress(message) => tagged("progress", message),
        Message::ArtifactReady(message) => tagged("artifact_ready", message),
        Message::ArtifactAck(message) => tagged("artifact_ack", message),
        Message::ArtifactRejected(message) => tagged("artifact_rejected", message),
        Message::Completed(message) => tagged("completed", message),
        Message::Cancelled(message) => tagged("cancelled", message),
        Message::Failed(message) => tagged("failed", message),
        Message::Released(message) => tagged("released", message),
        Message::ReleaseIdle(message) => tagged("release_idle", message),
        Message::WorkspacesReleased(message) => tagged("workspaces_released", message),
        Message::Cancel(message) => tagged("cancel", message),
        Message::Ping(message) => tagged("ping", message),
        Message::Pong(message) => tagged("pong", message),
        Message::Shutdown(message) => tagged("shutdown", message),
    };
    serde_json::to_string(&value).map_err(|error| ProtocolError::Malformed(error.to_string()))
}

fn tagged<T: Serialize>(kind: &str, body: &T) -> serde_json::Value {
    let mut value = serde_json::to_value(body).unwrap_or(serde_json::Value::Null);
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("type".into(), serde_json::Value::String(kind.into()));
    }
    value
}
