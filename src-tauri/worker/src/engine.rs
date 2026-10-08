//! 引擎边界（docs/71 §5.1/§5.3）。
//!
//! 引擎只做算法：**不碰管道、不碰 Tauri、不自己拼路径**。它拿到已准备输入的位置、
//! 已校验的模型规格、预算与取消牌，把产物写进执行器给的 [`StageSink`]，回一份
//! **元数据**（谁算的、多大、什么 hash）——宿主只信元数据里它自己核对得上的部分。
//!
//! Task 3 起有 [`EchoEngine`]（不加载模型，协议/进程测试靠它）；Task 7-b-ii 起真超分在
//! [`crate::upscale`]，它实现的是同一个 trait。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use yomika_compute_core::cancel::CancelToken;
use yomika_compute_protocol::messages::{EngineReport, PipelineStage, Run};

/// 取消不是失败：宿主对这两者的处理完全不同（§6.3）。
pub const CANCELLED_CODE: &str = "COMPUTE_CANCELLED";
/// 产物名/元数据不合法。
pub const ARTIFACT_INVALID_CODE: &str = "COMPUTE_ARTIFACT_INVALID";

/// 与协议里的 `MAX_RELATIVE_NAME_BYTES` 同值：相对名是宿主与 worker 之间的窄接口，
/// 两边各自都要拦一遍（宿主不信 worker 声称的名字，worker 也不给宿主造穿越）。
const MAX_RELATIVE_NAME_BYTES: usize = 128;

/// 一个阶段的执行体。
pub trait Engine: Send + Sync + 'static {
    /// 跑一个阶段。超时/预算由上游（执行器与宿主）负责，引擎只负责在**能停的地方**
    /// 看取消牌，并把失败原因如实回上去。
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError>;

    /// 交回这一代进程里**为跑模型占着的原生内存**，返回交回了几份（没有可交的答 0）。
    ///
    /// 为什么默认实现是「答 0」而不是「什么都不做」：echo 引擎不加载任何模型，它交回 0 份
    /// 是**一句实话**——宿主那边「交回 0 份」与「没交回」是两个不同的回答（worker 的
    /// `lib.rs` 里那句注释），默认成 0 让不跑模型的引擎不必撒谎。真有缓存的引擎
    /// （[`crate::pipeline::PipelineEngine`]）必须自己实现它，否则宿主会收到一个假 0。
    fn release_cached_models(&self) -> u32 {
        0
    }
}

/// 毯子实现：`protocol::run` 对引擎类型泛型，而 `main` 要在启动时按 `--engine` 二选一
/// （echo / onnx），所以启动那一刻必须装箱。装箱只发生一次，阶段内部仍是静态分派。
impl<T: Engine + ?Sized> Engine for Box<T> {
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError> {
        (**self).execute(request)
    }

    fn release_cached_models(&self) -> u32 {
        (**self).release_cached_models()
    }
}

pub struct StageRequest<'a> {
    pub run: &'a Run,
    pub stage: &'a PipelineStage,
    /// 这一阶段要读的那张图。执行器算好并复核过之后才交过来（`None` = 这次运行没有
    /// 授权输入）。引擎不许自己拼路径，也不许去读别的地方。
    pub input: Option<&'a StageInput>,
    pub cancel: &'a CancelToken,
    /// 产物唯一允许落地的地方。
    pub sink: &'a StageSink<'a>,
    /// 0–100。执行器负责去重与限流，引擎只管报。
    pub progress: &'a (dyn Fn(u32) + Sync),
}

/// 一个阶段该读哪张图，由执行器判定（docs/71 §7.1：输入的解析与复核只有一处）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageInput {
    /// 宿主授权的只读输入：路径已经被 `resolve_granted` 关在输入根里，长度与 hash
    /// 也已经按 run 里声明的值复核过。
    Granted { relative: String, path: PathBuf },
    /// 上一阶段的产物：staging 根下的一个文件名（已经过 [`StageSink::is_safe_name`]）。
    Previous { relative: String, path: PathBuf },
}

impl StageInput {
    pub fn path(&self) -> &Path {
        match self {
            Self::Granted { path, .. } | Self::Previous { path, .. } => path,
        }
    }

    pub fn relative(&self) -> &str {
        match self {
            Self::Granted { relative, .. } | Self::Previous { relative, .. } => relative,
        }
    }

    /// 这份输入是不是宿主授权的原图（而不是上一阶段的产物）。
    pub fn is_granted(&self) -> bool {
        matches!(self, Self::Granted { .. })
    }
}

pub struct StageOutput {
    pub relative_name: String,
    pub mime: String,
    pub byte_length: u64,
    pub width: u32,
    pub height: u32,
    pub content_hash: String,
    pub engine: EngineReport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageError {
    pub code: String,
    pub message: String,
}

impl StageError {
    pub fn cancelled() -> Self {
        Self {
            code: CANCELLED_CODE.to_string(),
            message: "已取消".to_string(),
        }
    }

    pub fn failed(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.code == CANCELLED_CODE
    }

    /// 需要像素的引擎在拿不到（或看不懂）输入时该回的错误。错误码与宿主侧
    /// `yomika_compute_core::inputs` 是同一个常量，两边不会漂。
    pub fn input_invalid(message: impl Into<String>) -> Self {
        Self::failed(yomika_compute_core::inputs::INPUT_INVALID_CODE, message)
    }
}

/// 产物写入的**唯一**通道。名字在这里被校验，路径在这里被拼，product 先写 `.part`
/// 再 rename（§7.3 第 1 步：宿主看到的永远是一个完整文件）。
pub struct StageSink<'a> {
    root: &'a Path,
}

impl<'a> StageSink<'a> {
    pub fn new(root: &'a Path) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        self.root
    }

    /// 相对名只是一段文件名：不许目录、不许盘符、不许 `..`、不许控制字符。规则与
    /// 协议 `ArtifactReady.validate` 里的 `artifact_name` 一致，两边都要拦。
    pub fn is_safe_name(relative_name: &str) -> bool {
        !relative_name.is_empty()
            && relative_name.len() <= MAX_RELATIVE_NAME_BYTES
            && relative_name != "."
            && relative_name != ".."
            && !relative_name.contains('/')
            && !relative_name.contains('\\')
            && !relative_name.contains(':')
            && !relative_name.chars().any(char::is_control)
    }

    pub fn write(
        &self,
        relative_name: &str,
        bytes: &[u8],
    ) -> Result<WrittenArtifact, StageError> {
        if !Self::is_safe_name(relative_name) {
            return Err(StageError::failed(
                ARTIFACT_INVALID_CODE,
                format!("非法产物名 `{relative_name}`"),
            ));
        }
        let path: PathBuf = self.root.join(relative_name);
        if path.parent() != Some(self.root) {
            return Err(StageError::failed(
                ARTIFACT_INVALID_CODE,
                format!("产物名 `{relative_name}` 解析后不在 staging 里"),
            ));
        }
        let partial = self.root.join(format!("{relative_name}.part"));
        fs::write(&partial, bytes).map_err(|error| {
            StageError::failed(
                ARTIFACT_INVALID_CODE,
                format!("写 `{relative_name}` 失败：{error}"),
            )
        })?;
        fs::rename(&partial, &path).map_err(|error| {
            let _ = fs::remove_file(&partial);
            StageError::failed(
                ARTIFACT_INVALID_CODE,
                format!("把 `{relative_name}` 落定失败：{error}"),
            )
        })?;
        Ok(WrittenArtifact {
            byte_length: bytes.len() as u64,
            content_hash: blake3::hash(bytes).to_hex().to_string(),
        })
    }
}

pub struct WrittenArtifact {
    pub byte_length: u64,
    pub content_hash: String,
}

/// Task 3 的测试引擎：不加载任何模型，产出一段确定性的字节。
///
/// 它的存在价值是让「协议 + 执行器 + 产物落地」这条链在**没有 ONNX/Vulkan** 的
/// 情况下就能端到端跑通（§11 Task 3 第 ③ 条），而不是假装已经接上了超分。
///
/// `stage_delay` 是给宿主侧测试用的：让它「算」得久一点，才能测出「计算忙的时候控制面
/// 仍然有回应」和「合作取消 2 秒内生效」。生产路径上它恒为零（`main.rs` 只在
/// `YOMIKA_WORKER_TEST_DELAY_MS` 存在时才设，那个变量生产永远不设）。
pub struct EchoEngine {
    stage_delay: Duration,
    /// 测试用：故意**不看**取消牌，用来验证宿主的 2 秒宽限到点真的会收族。
    /// 生产路径恒为 false——真实引擎必须看牌（见 `pretend_to_compute`）。
    ignore_cancel: bool,
    /// 测试用：报告自称「这一页没算过」（`passthrough`）。
    ///
    /// 为什么非要有这条路：宿主按**引擎名**决定「这份产物算不算数」（算过的才写进产物
    /// 缓存），而真引擎只在「两次评估都与输入逐像素相同」时才这么报——那不是测试能稳定
    /// 造出来的局面。生产路径恒为 false（`main.rs` 只在 `YOMIKA_WORKER_TEST_PASSTHROUGH`
    /// 存在时才设）。
    claim_passthrough: bool,
}

impl Default for EchoEngine {
    fn default() -> Self {
        Self {
            stage_delay: Duration::ZERO,
            ignore_cancel: false,
            claim_passthrough: false,
        }
    }
}

impl EchoEngine {
    pub fn with_stage_delay(stage_delay: Duration) -> Self {
        Self {
            stage_delay,
            ignore_cancel: false,
            claim_passthrough: false,
        }
    }

    /// 测试用：让它耍赖不看取消牌（§8.2 的「合作取消没等到就收族」需要这个对手）。
    pub fn ignoring_cancel(mut self) -> Self {
        self.ignore_cancel = true;
        self
    }

    /// 测试用：让报告自称 `passthrough`（见 `claim_passthrough` 那一栏）。
    pub fn claiming_passthrough(mut self) -> Self {
        self.claim_passthrough = true;
        self
    }

    /// 假装在算：睡够 `stage_delay`，但每 20 ms 看一眼取消牌。
    ///
    /// 真实引擎也必须长这样——长任务只在**能停的地方**看牌子，宿主的 2 秒合作取消宽限
    /// 才有意义（§8.2）。
    fn pretend_to_compute(&self, cancel: &CancelToken) -> Result<(), StageError> {
        if self.ignore_cancel {
            std::thread::sleep(self.stage_delay);
            return Ok(());
        }
        let deadline = Instant::now() + self.stage_delay;
        loop {
            if cancel.cancelled() {
                return Err(StageError::cancelled());
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(());
            }
            std::thread::sleep((deadline - now).min(Duration::from_millis(20)));
        }
    }
}

impl Engine for EchoEngine {
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError> {
        (request.progress)(0);
        self.pretend_to_compute(request.cancel)?;
        // echo 不需要像素，但它把「这一阶段被交到手上的输入是谁」写进产物：宿主侧
        // 集成测试靠这一行证明输入真的从宿主摆到了引擎手边（不是只在执行器里核过）。
        let payload = format!(
            "echo stage={} job={} generation={} input={} granted={} scale={:?}\n",
            request.stage.stage_id,
            request.run.job_id,
            request.run.generation,
            request.run.input.input_id,
            request
                .input
                .map(|input| input.relative())
                .unwrap_or("none"),
            request.stage.scale
        )
        .into_bytes();
        if request.cancel.cancelled() {
            return Err(StageError::cancelled());
        }
        let written = request
            .sink
            .write(&format!("{}.bin", request.stage.stage_id), &payload)?;
        (request.progress)(100);
        Ok(StageOutput {
            relative_name: format!("{}.bin", request.stage.stage_id),
            mime: "application/octet-stream".to_string(),
            byte_length: written.byte_length,
            // echo 引擎没有真实几何：给个合法占位（协议要求 1..=65536），别让宿主
            // 因为这一栏把一帧正常的消息判成越界。真引擎填真尺寸。
            width: 64,
            height: 64,
            content_hash: written.content_hash,
            engine: EngineReport {
                id: if self.claim_passthrough {
                    yomika_compute_protocol::PASSTHROUGH_ENGINE_ID.to_string()
                } else {
                    "echo".to_string()
                },
                version: env!("CARGO_PKG_VERSION").to_string(),
                precision: yomika_compute_protocol::messages::Precision::Fp32,
                device_id: "cpu".to_string(),
                // echo 不挑运行库，但「这一阶段被问的是哪条政策」是请求里本来就有的
                // 信息：报告里少一栏，宿主那条链路（含契约测试）就分不清「没回退」与
                // 「没交代」。
                policy: Some(request.stage.engine_policy),
                fallback: None,
            },
        })
    }
}
