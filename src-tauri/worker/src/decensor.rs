//! 真去码（检测 + 修补）引擎（docs/71 §11 Task 8-b / 8-e）：解授权 → 检测 → 逐框修补 → 编码写回。
//!
//! 与 [`crate::upscale`] 是同一族执行体、同一套边界：
//!
//! 1. 读哪张图由执行器决定（`run.input`，它已经按声明复核过长度与 hash）；
//! 2. 用哪三份模型由 `stage.decensor` 授权，worker 自己再解析一次、再复核一次——宿主写
//!    在 run 里的只是声明，不是信任（§7.1/§7.2）。三份与页面走**同一条**只读输入通道：
//!    协议帧只有 64 KiB，254 MB 的检测器与两份 14 MB 的修补图都不可能躺在 run 里；
//! 3. **检测在这一层**（8-e 从宿主搬进来的）：那份 Mask R-CNN 会话是 Task 8 出口条件
//!    （「宿主无 ORT 资源」）里最重的一项。掩膜因此不再过协议——它由这一页的像素算出来，
//!    算它的就是这一步，中间没有第二个人需要看见它（`docs/94`）；
//! 4. 几何（一框变一扇窗口、同类的上下文掩膜、只把被遮的像素贴回去、每框前看取消牌）
//!    全在 [`yomika_compute_core::decensor`] 里——宿主那条老路径用的是同一份判据；
//! 5. 真正跑图的是 [`yomika_compute_core::inpaint`]，它也要过探针：**实测通过**才允许
//!    用硬件运行库，否则退 CPU 并把「想要谁、用了谁、为什么」带回产物报告。
//!
//! 只开真的会用到的会话：一页可能只有横条、也可能两种混着，而按框选模型意味着另一份
//! 几十 MB 的会话不该被白开一次。检测器按包指纹驻留（[`CachedDetector`]），翻页时不必
//! 每页重开一次 254 MB。
//!
//! 检测出 0 个框**不是错误**，也不是「跳过」：原样编码这一页交出去，报告里记 CPU。它是
//! 一个结论（这一页没有要补的东西），而一个「什么都没做」的成功答复与它长得一模一样，
//! 所以两者必须在产物上分得开——产物在，报告说 CPU；产物在，报告说运行库与回退，就是
//! 真补过。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use yomika_compute_core::decensor::{self, CensorKind};
use yomika_compute_core::detect::DetectorEngine;
use yomika_compute_core::engine::ValidationVerdict;
use yomika_compute_core::error::ComputeError;
use yomika_compute_core::inpaint::{self, InpaintEngine};
use yomika_compute_core::inputs;
use yomika_compute_core::onnx::RuntimeChoice;
use yomika_compute_core::runtime::{self, RuntimeId};
use yomika_compute_protocol::messages::{
    EngineFallback, EnginePolicy, EngineReport, GrantedFile, Precision,
};

use crate::engine::{Engine, StageError, StageOutput, StageRequest};
use crate::stage_io::{
    check_cancelled, device_id, encode_png, fallback_of, probe_dimensions, to_stage_error, ENGINE_ID,
    GPU_BACKEND_UNAVAILABLE_CODE, GPU_OUTPUT_INVALID_CODE, RESOURCE_LIMIT_CODE,
};

/// 检测器开不起来、或者跑不起来。它是**环境**的问题，不是这一页的问题：同一份授权在别的
/// 机器上可能就跑得动（模型文件被换过、运行库坏了）。
///
/// 用 `COMPUTE_INTERNAL` 是与宿主那条老路径（检测还在宿主时）同一句话：那时检测失败报的
/// 就是它。前端那张码表里已经有这个码。
const DETECTOR_FAILED_CODE: &str = "COMPUTE_INTERNAL";

/// 一份驻留的检测会话：哪份图、以及会话本身。
///
/// 没有回退交代这一栏：检测的运行库是常量（`DETECTOR_RUNTIME`），没有「想要谁、用了谁」
/// 这回事。
struct CachedDetector {
    /// 授权的 `relative_path` + `content_hash`。任何一个变了就是另一份会话。
    key: String,
    engine: Arc<DetectorEngine>,
}

/// 一份驻留的修补会话：哪份图、开的谁、以及当时留下的回退交代。
struct CachedInpaint {
    /// 授权的 `relative_path` + `content_hash` + 政策。任何一个变了就是另一份会话。
    key: String,
    engine: Arc<InpaintEngine>,
    runtime: RuntimeId,
    /// 开这份会话时留下的回退交代（没有回退就是 `None`）。它跟会话一起缓存：同一份
    /// 会话第二次被用上时，报告里说的话必须与第一次一致。
    fallback: Option<EngineFallback>,
}

/// 修补执行体：一个输入根 + 三个会话位（检测器、横条、马赛克）。
///
/// 两份修补会话而不是一份：一个阶段里的框允许两种混着出现，而模型是**按框**选的。分开存
/// 也让「这一页只用到了马赛克」这件事真的省下一次装载，而不是名义上省。
pub struct DecensorEngine {
    /// worker 唯一允许读文件的根：模型、页面都从这里解析（§7.1 的同一条边界）。
    input_root: PathBuf,
    detector: Mutex<Option<CachedDetector>>,
    bar: Mutex<Option<CachedInpaint>>,
    mosaic: Mutex<Option<CachedInpaint>>,
}

impl DecensorEngine {
    pub fn new(input_root: PathBuf) -> Self {
        Self {
            input_root,
            detector: Mutex::new(None),
            bar: Mutex::new(None),
            mosaic: Mutex::new(None),
        }
    }

    fn slot(&self, kind: CensorKind) -> &Mutex<Option<CachedInpaint>> {
        match kind {
            CensorKind::Bar => &self.bar,
            CensorKind::Mosaic => &self.mosaic,
        }
    }

    /// 丢掉三个会话位里缓存着的引擎（§12.4「idle30 秒释放模型/workspace」），
    /// 返回交回了几份（0–3）。
    ///
    /// 三份都是**整份模型**：检测器那份是 MRCNN，两份修补分别是 bar 与 mosaic。用户切走
    /// 两分钟不该让这三份权重一直挂在这个进程里；下一件任务按同一套键重新开。
    /// 「交回 0 份」= 缓存里本来就空的，与「交不出去」不是一件事。
    pub fn release_cached_engines(&self) -> u32 {
        let mut handed_back = 0;
        // 中毒的锁不该让整条回收路报废：里面那件东西没有跨线程不变量（`detector_for`
        // 与 `inpaint_for` 都这么写），丢了它本身就是要做的事。
        if self
            .detector
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .is_some()
        {
            handed_back += 1;
        }
        for slot in [&self.bar, &self.mosaic] {
            if slot
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
                .is_some()
            {
                handed_back += 1;
            }
        }
        handed_back
    }

    /// 解析并复核一份授权文件（模型都走这一条）。
    ///
    /// 复核失败用的是 `inputs::verify_file` 自己的错误码与消息——「宿主说的和盘上的
    /// 不是一份」这件事必须原样透传，不许在这里换一句话说。
    fn resolve_granted(&self, grant: &GrantedFile) -> Result<PathBuf, StageError> {
        let path = inputs::resolve_granted(&self.input_root, &grant.relative_path)
            .map_err(|error| StageError::failed(error.code(), error.message()))?;
        inputs::verify_file(&path, &grant.content_hash, grant.byte_length)
            .map_err(|error| StageError::failed(error.code(), error.message()))?;
        Ok(path)
    }

    /// 拿一份能找框的检测会话：命中就复用，没命中就按授权开一份。
    ///
    /// 检测**总是**跑在 CPU 上：`DetectorEngine::open` 里没有「换一条运行库试试」的余地
    /// （`DETECTOR_RUNTIME` 是个常量），因为同一张图在 DirectML 上会给出不同的框，而检测
    /// 算错的症状是「这一页没有要补的框」——一个看起来完全正常的答复（docs/93）。
    fn detector_for(&self, grant: &GrantedFile) -> Result<Arc<DetectorEngine>, StageError> {
        let key = format!("{}:{}", grant.relative_path, grant.content_hash);
        let mut cached = self
            .detector
            .lock()
            .map_err(|_| StageError::failed(RESOURCE_LIMIT_CODE, "检测会话缓存锁坏了"))?;
        if let Some(cached) = cached.as_ref().filter(|cached| cached.key == key) {
            return Ok(Arc::clone(&cached.engine));
        }
        let path = self.resolve_granted(grant)?;
        let engine = Arc::new(DetectorEngine::open(&path).map_err(|error| {
            StageError::failed(DETECTOR_FAILED_CODE, format!("打不开检测器：{error}"))
        })?);
        *cached = Some(CachedDetector {
            key,
            engine: Arc::clone(&engine),
        });
        Ok(engine)
    }

    /// 拿一份能补这类框的会话：命中就复用，没命中就按政策开一份新的。
    ///
    /// 回头的三项都会进产物报告：会话本身、它实际跑在谁上面、以及有没有回退。
    fn open_for(
        &self,
        kind: CensorKind,
        grant: &GrantedFile,
        policy: EnginePolicy,
    ) -> Result<(Arc<InpaintEngine>, RuntimeId, Option<EngineFallback>), StageError> {
        let key = format!(
            "{}:{}:{}",
            grant.relative_path,
            grant.content_hash,
            policy.as_str()
        );
        let slot = self.slot(kind);
        let mut cached = slot
            .lock()
            .map_err(|_| StageError::failed(RESOURCE_LIMIT_CODE, "会话缓存锁坏了"))?;
        if let Some(cached) = cached.as_ref().filter(|cached| cached.key == key) {
            return Ok((
                Arc::clone(&cached.engine),
                cached.runtime,
                cached.fallback.clone(),
            ));
        }
        let path = self.resolve_granted(grant)?;
        let (engine, choice) = match policy {
            // 点的是 CPU：不探针，直接 CPU（与超分那边同一个判据——探针是拿来判「硬件
            // 算得对不对」的，参照实现不参与）。
            EnginePolicy::Cpu => (
                InpaintEngine::open_with_runtime(&path, kind, RuntimeId::Cpu)
                    .map_err(to_stage_error)?,
                RuntimeChoice {
                    requested: RuntimeId::Cpu,
                    used: RuntimeId::Cpu,
                    verdict: ValidationVerdict::Passed,
                },
            ),
            // 自动：探针过了就用硬件，没过就退 CPU——而且退得有交代。
            EnginePolicy::Auto => InpaintEngine::open_choice(&path, kind).map_err(to_stage_error)?,
            // 点的是 GPU：拿不到、或这份图在它上面没通过探针，都是失败，不许悄悄退。
            EnginePolicy::Gpu => open_forced_gpu(&path, kind)?,
        };
        let fallback = fallback_of(&choice);
        let runtime = choice.used;
        let engine = Arc::new(engine);
        *cached = Some(CachedInpaint {
            key,
            engine: Arc::clone(&engine),
            runtime,
            fallback: fallback.clone(),
        });
        Ok((engine, runtime, fallback))
    }
}

impl Engine for DecensorEngine {
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError> {
        let stage = request.stage;
        let grant = stage
            .decensor
            .as_ref()
            .ok_or_else(|| StageError::input_invalid("这一阶段没有去码授权：不知道用哪些模型"))?;
        if stage.model.is_some() {
            // 两条授权同时出现只有一个含义：有一个阶段被拼错了。协议层也拒（`decensor`
            // 与 `model` 不许同时出现），这里再拦一次是因为「拼错的请求」不该靠一层校验。
            return Err(StageError::input_invalid(
                "这一阶段同时带了模型与去码授权：不知道该走哪条路",
            ));
        }
        let input = request
            .input
            .ok_or_else(|| StageError::input_invalid("这一阶段没有输入：不知道补哪一页"))?;
        check_cancelled(request.cancel)?;
        (request.progress)(2);

        // 1. 页面：先只读文件头问一声有多大。修补不改尺寸，所以「源图放不进预算」就是
        //    这次任务做不成——不是等解完像素再发现（与超分那边同一条理由）。
        let source = std::fs::read(input.path())
            .map_err(|error| StageError::input_invalid(format!("读不到这一阶段的输入：{error}")))?;
        let (probe_width, probe_height) = probe_dimensions(&source)?;
        let source_pixels =
            u64::from(probe_width).saturating_mul(u64::from(probe_height));
        if source_pixels > request.run.budgets.max_pixels {
            return Err(StageError::failed(
                RESOURCE_LIMIT_CODE,
                format!(
                    "页面 {probe_width}×{probe_height} 超出这次预算的 {} 像素",
                    request.run.budgets.max_pixels
                ),
            ));
        }
        let decoded = image::load_from_memory(&source)
            .map_err(|error| StageError::input_invalid(format!("解不开这张图：{error}")))?;
        let (width, height) = (decoded.width(), decoded.height());
        let mut rgba = decoded.into_rgba8().into_raw();
        if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
            return Err(StageError::input_invalid("解出来的画布是空的"));
        }
        (request.progress)(10);

        // 2. 检测：这一页要补哪些框。宿主那把 254 MB 的检测器会话已经不在那儿了（8-e），
        //    所以这一步是 worker 自己的活；检测总是 CPU（见 `DETECTOR_RUNTIME`）。
        //
        //    检测不到框**不是错误**：这一页没有要补的东西，下面那条修补循环一次都不会进，
        //    这一页原样编码交出去。它必须交出去——调用方要知道「这一页已经是干净的」。
        let detector = self.detector_for(&grant.detector)?;
        check_cancelled(request.cancel)?;
        let detections = detector
            .detect(&rgba, width, height)
            .map_err(|error| StageError::failed(DETECTOR_FAILED_CODE, format!("检测这一页失败了：{error}")))?;
        (request.progress)(20);

        // 3. 只开真的会用到的模型。
        let used = |kind: CensorKind| detections.iter().any(|d| d.region.kind == kind);
        let bar = if used(CensorKind::Bar) {
            Some(self.open_for(CensorKind::Bar, &grant.bar, stage.engine_policy)?)
        } else {
            None
        };
        let mosaic = if used(CensorKind::Mosaic) {
            Some(self.open_for(CensorKind::Mosaic, &grant.mosaic, stage.engine_policy)?)
        } else {
            None
        };
        check_cancelled(request.cancel)?;
        (request.progress)(30);

        // 4. 逐框修补。几何、上下文掩膜、只贴回被遮像素、以及每框前的取消牌都在核心。
        //    它自己也逐框复核（`inpaint_detections` 的第一步就是 `validate_detection`），
        //    所以这里不再提前过一遍——那个循环只省下一次装载，而现在检测器是刚跑完的、
        //    框是它自己夹进页面的。
        let filled = decensor::inpaint_detections(
            &mut rgba,
            width,
            height,
            &detections,
            request.cancel,
            |kind, crop, window, censored| {
                let session = match kind {
                    CensorKind::Bar => bar.as_ref(),
                    CensorKind::Mosaic => mosaic.as_ref(),
                };
                let session = session.ok_or_else(|| {
                    ComputeError::InvalidInput(format!("没有为 {kind:?} 这类框打开会话"))
                })?;
                session.0.inpaint(crop, window.width, window.height, censored)
            },
        )
        .map_err(to_stage_error)?;
        (request.progress)(85);

        // 5. 编码成 PNG：尺寸**不变**（去码不是放大），所以宿主拿到手的那份还能盖回原来
        //    那一页的位置上。
        let encoded = encode_png(&rgba, width, height)?;
        if encoded.len() as u64 > request.run.budgets.max_output_bytes {
            return Err(StageError::failed(
                RESOURCE_LIMIT_CODE,
                format!(
                    "产物 {} 字节超出这次预算的 {} 字节",
                    encoded.len(),
                    request.run.budgets.max_output_bytes
                ),
            ));
        }
        let name = format!("{}.png", stage.stage_id);
        let written = request.sink.write(&name, &encoded)?;
        (request.progress)(100);

        // 报告里那一格交代：用了谁、开在什么上、有没有回退。两份会话只留一条交代是这份
        // 协议目前的形状（`EngineReport` 只有一个 `fallback`）——两种框都出现过、又有
        // 一方退了 CPU 时，这里报的是**先被用到的那一方**。这一条记在 docs/91 的欠账里。
        //
        // 一个框都没检测到时两份会话都是 `None`，这里落到 CPU：那是**事实**（跑过的只有
        // CPU 上的检测器），也是「这一页没补过」与「补过」在报告上唯一分得开的地方。
        let (runtime, fallback) = bar
            .as_ref()
            .map(|(_, runtime, fallback)| (*runtime, fallback.clone()))
            .or_else(|| {
                mosaic
                    .as_ref()
                    .map(|(_, runtime, fallback)| (*runtime, fallback.clone()))
            })
            .unwrap_or((RuntimeId::Cpu, None));
        // 有框但一个都没贴回去（掩膜全是 0，或者框被核心判成越界而跳过）时 `filled` 是 0。
        // 那不是这次交付的失败面——交给调用方的是一个尺寸不变的产物——但它是唯一一条
        // 「检测说有、修补说没有」的线索，所以留在日志里而不是丢掉。
        if filled == 0 && !detections.is_empty() {
            eprintln!(
                "[decensor] 检测到 {} 个框，没有一个被补上（stage {}）",
                detections.len(),
                stage.stage_id
            );
        }
        Ok(StageOutput {
            relative_name: name,
            mime: "image/png".to_string(),
            byte_length: written.byte_length,
            width,
            height,
            content_hash: written.content_hash,
            engine: EngineReport {
                id: ENGINE_ID.to_string(),
                version: runtime::runtime_label(),
                precision: Precision::Fp32,
                device_id: device_id(runtime),
                policy: Some(stage.engine_policy),
                fallback,
            },
        })
    }
}

/// `Gpu` = 承诺。没有硬件运行库、或这份修补图在它上面实测不通过，都是失败。
///
/// 与超分那份是同一个判据（`inpaint::validate_runtime_cached` 就是修补版的探针），
/// 只是这里不许退让：点的是显卡，跑的就必须是显卡。
fn open_forced_gpu(
    path: &Path,
    kind: CensorKind,
) -> Result<(InpaintEngine, RuntimeChoice), StageError> {
    let runtime = runtime::available_runtimes()
        .into_iter()
        .find(|id| id.is_hardware_accelerated())
        .ok_or_else(|| {
            StageError::failed(
                GPU_BACKEND_UNAVAILABLE_CODE,
                "这份构建里没有可用的 GPU 运行库",
            )
        })?;
    match inpaint::validate_runtime_cached(path, kind, runtime) {
        ValidationVerdict::Passed => {}
        verdict => {
            return Err(StageError::failed(
                GPU_OUTPUT_INVALID_CODE,
                format!(
                    "{} 在这份修补图上没通过探针：{verdict:?}",
                    runtime.as_str()
                ),
            ))
        }
    }
    let engine = InpaintEngine::open_with_runtime(path, kind, runtime).map_err(to_stage_error)?;
    Ok((
        engine,
        RuntimeChoice {
            requested: runtime,
            used: runtime,
            verdict: ValidationVerdict::Passed,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use yomika_compute_core::cancel::CancelToken;
    use yomika_compute_protocol::messages::{Budgets, PipelineStage, Priority, Run, RunInput};

    /// 一个「拼错了」的阶段：没有去码授权。引擎不许把它当成「没什么可补，直接原样
    /// 交回去」——那是一份看起来成功的产物，而它什么都没做。
    fn request<'a>(
        stage: &'a PipelineStage,
        run: &'a Run,
        sink: &'a crate::engine::StageSink<'a>,
        cancel: &'a CancelToken,
    ) -> StageRequest<'a> {
        StageRequest {
            run,
            stage,
            input: None,
            cancel,
            sink,
            progress: &|_percent| {},
        }
    }

    fn run() -> Run {
        Run {
            protocol_version: yomika_compute_protocol::messages::PROTOCOL_MAJOR,
            worker_epoch: "epoch-1".to_string(),
            job_id: "job-1".to_string(),
            generation: 1,
            input: RunInput {
                input_id: "input-1".to_string(),
                content_hash: "0".repeat(64),
                byte_length: 1024,
                relative_path: None,
            },
            pipeline: Vec::new(),
            output_grant_id: "grant-1".to_string(),
            priority: Priority::Foreground,
            deadline_ms: 60_000,
            budgets: Budgets {
                max_pixels: 64_000_000,
                max_output_bytes: 1_073_741_824,
                intra_threads: 2,
            },
        }
    }

    #[test]
    fn a_stage_without_a_decensor_grant_is_refused() {
        let root = std::env::temp_dir().join("yomika-decensor-unit");
        std::fs::create_dir_all(&root).expect("建临时目录");
        let sink = crate::engine::StageSink::new(&root);
        let cancel = CancelToken::none();
        let run = run();
        let stage = PipelineStage {
            stage_id: "decensor".to_string(),
            model_spec_id: "deepcreampy".to_string(),
            engine_policy: EnginePolicy::Auto,
            scale: None,
            tile: None,
            layers: None,
            settings_id: None,
            model: None,
            decensor: None,
            dlssnr: None,
            min_input_edge: None,
            output_scale: None,
        };
        let error = match DecensorEngine::new(root.clone()).execute(request(&stage, &run, &sink, &cancel))
        {
            Err(error) => error,
            Ok(_) => panic!("没有授权还被跑成功了：产物会是一张什么都没补的图"),
        };
        assert!(
            error.message.contains("没有去码授权"),
            "该说的是「不知道用哪些模型」，实际是：{}",
            error.message
        );
    }

    #[test]
    fn a_stage_that_carries_two_kinds_of_grant_at_once_is_refused() {
        use yomika_compute_protocol::messages::{DecensorGrant, GrantedFile};
        let file = |name: &str| GrantedFile {
            relative_path: name.to_string(),
            content_hash: "a".repeat(64),
            byte_length: 11,
        };
        let root = std::env::temp_dir().join("yomika-decensor-unit");
        std::fs::create_dir_all(&root).expect("建临时目录");
        let sink = crate::engine::StageSink::new(&root);
        let cancel = CancelToken::none();
        let run = run();
        let stage = PipelineStage {
            stage_id: "decensor".to_string(),
            model_spec_id: "deepcreampy".to_string(),
            engine_policy: EnginePolicy::Auto,
            scale: None,
            tile: None,
            layers: None,
            settings_id: None,
            // 一份模型 + 一份去码授权：两条路都说得通，所以只能拒——猜错了就是拿错模型
            // 去补一页，而产物看起来完全正常。
            model: Some(file("model.onnx")),
            decensor: Some(DecensorGrant {
                detector: file("weights.onnx"),
                bar: file("bar.onnx"),
                mosaic: file("mosaic.onnx"),
            }),
            dlssnr: None,
            min_input_edge: None,
            output_scale: None,
        };
        let error = match DecensorEngine::new(root.clone()).execute(request(&stage, &run, &sink, &cancel))
        {
            Err(error) => error,
            Ok(_) => panic!("两条授权同时出现还被跑成功了：跑的是哪条路全凭猜"),
        };
        assert!(
            error.message.contains("同时带了模型与去码授权"),
            "该说的是两条路分不清，实际是：{}",
            error.message
        );
    }
}
