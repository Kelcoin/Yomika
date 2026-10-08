//! 按阶段的形状分派到真正的执行体（docs/71 §11 Task 8-b）。
//!
//! `--engine onnx` 只有一条：这份构建里所有 ONNX 执行体。**分派看的是授权长什么样**，
//! 不看模型名、也不看阶段叫什么：
//!
//! - 带 `stage.dlssnr`（片段 + 一套参数）⇒ DLSSNR（[`DlssnrEngine`]）；
//! - 带一页**会动**的图（GIF / APNG / 动画 WebP）⇒ 原样交回，哪个引擎都不进（§7.6）；
//! - 带 `stage.decensor`（检测器 + 两份修补图）⇒ 去码（[`DecensorEngine`]）；
//! - 不带 ⇒ 超分（[`UpscaleEngine`]），也就是 7-b-ii 接进来的那条路。
//!
//! 为什么 DLSSNR 排在「动不动」**前面**：那条规则是给只能吃一帧的引擎写的，而 DLSSNR
//! 是**逐帧**处理再编回 APNG 的（`dlssnr::animation::apply_dlssnr`）。排后面不会报错——
//! 用户开着 DLSSNR 翻一页动图，看到的还是原图，界面上没有一处说得出为什么——所以顺序在
//! 这里是一条有后果的纪律，`pipeline.rs` 的 `mod tests` 专门有一条用例钉住它。
//!
//! 为什么不按模型名分：名字是宿主的词汇，worker 不该靠「认出 realcugan 三个字」来决定
//! 拿哪份授权去跑——那是一条会随宿主改名而悄悄失效的判据（`manager.rs` 里对
//! `WorkerEngine` 的注释也是这个意思：不猜）。
//!
//! 为什么「动不动」这一问落在这里、而不是各自落进那两个引擎里：这是**只吃一帧的两个
//! 引擎共有的**第一条判断，而它的后果一样——超分与去码都只会拿动图的第一帧当输入，
//! 用户看到的就是「这张图的动画没了」。写两份的代价不是重复，是分叉：将来谁在去码那边
//! 补一句、超分那边忘一句，症状只在其中一条路上出现。判定本身只有一份实现
//! （`yomika_compute_core::image_kind`），宿主与 worker 共用。DLSSNR 不吃这条规则，
//! 所以它排在上面那条判断之前。

use crate::decensor::DecensorEngine;
use crate::engine::{Engine, StageError, StageOutput, StageRequest};
use crate::stage_io::{check_cancelled, probe_dimensions, PASSTHROUGH_ENGINE_ID};
use crate::upscale::UpscaleEngine;
use yomika_compute_core::image_kind::{animated_kind, canvas_size};
use yomika_compute_protocol::messages::{EngineReport, Precision};

pub struct PipelineEngine {
    upscale: UpscaleEngine,
    decensor: DecensorEngine,
    #[cfg(windows)]
    dlssnr: crate::dlssnr::DlssnrEngine,
}

impl PipelineEngine {
    pub fn new(input_root: std::path::PathBuf) -> Self {
        Self {
            upscale: UpscaleEngine::new(input_root.clone()),
            decensor: DecensorEngine::new(input_root.clone()),
            #[cfg(windows)]
            dlssnr: crate::dlssnr::DlssnrEngine::new(input_root),
        }
    }
}

impl Engine for PipelineEngine {
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError> {
        // DLSSNR 先看：它自己那条动图路是逐帧的，不是「原样交回」。
        #[cfg(windows)]
        if request.stage.dlssnr.is_some() {
            return self.dlssnr.execute(request);
        }
        if let Some(handed_back) = pass_through_animated(&request)? {
            return Ok(handed_back);
        }
        if request.stage.decensor.is_some() {
            return self.decensor.execute(request);
        }
        self.upscale.execute(request)
    }

    /// 交回这个进程里为跑模型占着的缓存（§12.4「idle30 秒释放模型/workspace」）。
    ///
    /// 两处各答自己交回了几份：放大会话（0–1）、修补的三个会话位（0–3）。NGX 那边**不在这里**
    /// ——片段与它建起来的上下文归 `dlssnr/device.rs` 的 `static CONTEXT` 所有，卸掉安装件会
    /// 留下一个悬空上下文（8-h⑤ 的决定）；NGX 能交的是**工作区**，由 `release_workspaces()`
    /// 那条进程级的钩子单独收（它还兼着集成测试用的环境变量）。两条加起来才是宿主看到的数。
    fn release_cached_models(&self) -> u32 {
        self.upscale.release_cached_session() + self.decensor.release_cached_engines()
    }
}

/// 这一页是动图就原样交回，静态就 `Ok(None)` 交给下面的引擎。
///
/// 「原样」是逐字节的：只换产物名的后缀、mime 按真实容器报，不解码、不开会话、不重编码。
/// 交回的产物照样要过宿主那一关（`ArtifactReady` 带着 sha256 与长度，宿主按它校验、发布），
/// 所以这里省掉的是计算，不是证据。
///
/// 代价说明白：静态那一页会在这里多读一遍源字节（引擎进去还要再读一遍）。换来的是这条
/// 判定不受任何「只读头 N 字节」的截断口径影响——GIF 要数完整条块链才知道是不是两帧以上。
fn pass_through_animated(request: &StageRequest<'_>) -> Result<Option<StageOutput>, StageError> {
    // 没有输入不是这一步要回答的问题：留给引擎去报，它们各自的文案更准。
    let Some(input) = request.input else {
        return Ok(None);
    };
    let source = std::fs::read(input.path())
        .map_err(|error| StageError::input_invalid(format!("读不到这一阶段的输入：{error}")))?;
    let Some(kind) = animated_kind(&source) else {
        return Ok(None);
    };
    // 尺寸取自容器头：worker 这份 `image` 只留了 jpeg / png / webp 解码器（§5.3），
    // 问它 GIF 的尺寸问不出来。而且画布才对——APNG 的第一帧可以比画布小。
    let (width, height) = match canvas_size(&source) {
        Some(size) => size,
        // 头读得出来、画布读不出来（构造得古怪）：退回解码器问一次。
        None => probe_dimensions(&source)?,
    };
    check_cancelled(request.cancel)?;
    let name = format!("{}.{}", request.stage.stage_id, kind.extension());
    let written = request.sink.write(&name, &source)?;
    (request.progress)(100);
    Ok(Some(StageOutput {
        relative_name: name,
        mime: kind.mime().to_string(),
        byte_length: written.byte_length,
        width,
        height,
        content_hash: written.content_hash,
        engine: EngineReport {
            id: PASSTHROUGH_ENGINE_ID.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            precision: Precision::Fp32,
            // 一件计算都没做，所以设备的答案只能是「没有设备」。
            device_id: "cpu".to_string(),
            policy: Some(request.stage.engine_policy),
            // 没请求过运行库，也就无所谓回退。
            fallback: None,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::StageInput;
    use yomika_compute_core::cancel::CancelToken;
    use yomika_compute_core::runtime::{directml_is_compiled_in, platform_preference};
    use yomika_compute_protocol::messages::{
        Budgets, DlssnrGrant, EnginePolicy, GrantedFile, PipelineStage, Priority, Run, RunInput,
        PROTOCOL_MAJOR,
    };

    /// 一份真的动图（核心那三种容器里最小的一个）。
    const ANIMATED_GIF: &[u8] =
        include_bytes!("../../crates/compute-core/src/dlssnr/testdata/animated.gif");

    /// 一份**不是**参数文件的字节：DLSSNR 引擎解析它时会拒，而拒绝发生在落片段之前。
    const BAD_SETTINGS: &[u8] = b"not a settings document at all";

    /// 动图遇上 DLSSNR 不许被「动图原样交回」那条规则吃掉。
    ///
    /// 两个只能吃一帧的引擎（超分、去码）在动图上一律原样交回；DLSSNR 是**逐帧**处理再
    /// 编回 APNG 的（`dlssnr::animation::apply_dlssnr`），所以在它面前那条规则不成立。
    /// 顺序错了不会报错——用户开着 DLSSNR 翻一页动图，看到的还是原图，界面上没有任何
    /// 一处说得出为什么——所以判据必须是「有没有走到 DLSSNR 引擎」。
    ///
    /// 怎么在不碰显卡、不装那份 165 MB 片段的前提下判出来：参数给一份**不是 JSON** 的，
    /// DLSSNR 引擎在落片段之前就会拒它（`DlssnrEngine::execute` 的顺序），于是这条用例
    /// 拿到的那句错就是「请求真的走去了哪里」的证据。
    #[test]
    fn an_animated_page_reaches_the_dlssnr_engine_instead_of_being_handed_back() {
        let root = std::env::temp_dir().join("yomika-pipeline-dlssnr");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("staging")).expect("建临时目录");
        let page_path = root.join("ab/page.gif");
        std::fs::create_dir_all(page_path.parent().expect("父目录")).expect("建输入根的父目录");
        std::fs::write(&page_path, ANIMATED_GIF).expect("摆一页进去");
        let input = StageInput::Granted {
            relative: "ab/page.gif".to_string(),
            path: page_path,
        };
        let settings = root.join("ab/settings.json");
        std::fs::write(&settings, BAD_SETTINGS).expect("摆一份坏参数进去");
        let grant = DlssnrGrant {
            feature: GrantedFile {
                relative_path: "ab/feature.dll".to_string(),
                content_hash: blake3::hash(b"never opened").to_hex().to_string(),
                byte_length: 12,
            },
            settings: GrantedFile {
                relative_path: "ab/settings.json".to_string(),
                content_hash: blake3::hash(BAD_SETTINGS).to_hex().to_string(),
                byte_length: BAD_SETTINGS.len() as u64,
            },
        };
        let staging = root.join("staging");
        let sink = crate::engine::StageSink::new(&staging);
        let cancel = CancelToken::none();
        let run = run();
        let with_dlssnr = stage(Some(grant));
        let engine = PipelineEngine::new(root.clone());
        let error = match engine.execute(request(&with_dlssnr, &run, &input, &sink, &cancel)) {
            Err(error) => error,
            Ok(_) => panic!("参数不是 JSON 却被交出去了：这一步根本没走到 DLSSNR 引擎"),
        };
        assert!(
            error.message.contains("DLSSNR 参数读不出来"),
            "该走 DLSSNR 引擎，实际报的是：{}",
            error.message
        );

        // 同一条动图、没有 DLSSNR 授权 ⇒ 照旧原样交回：改的是「谁先看」，不是规则本身。
        let handed_back = engine
            .execute(request(&stage(None), &run, &input, &sink, &cancel))
            .expect("动图该原样交回");
        assert_eq!(handed_back.engine.id, PASSTHROUGH_ENGINE_ID);
        assert_eq!(
            handed_back.content_hash,
            blake3::hash(ANIMATED_GIF).to_hex().to_string(),
            "原样交回必须是逐字节的"
        );
    }

    /// 闲置交回：手上一份模型都没有的时候要老实答 0，而且连着问两次还是 0。
    ///
    /// 「交回 0 份」与「交不出来」（没实现、或根本没走到引擎）在宿主那边必须能分开，
    /// 所以这条判据量的是**同一台真引擎**在空缓存下连着问两次的回答：0、0。第二轮是幂等
    /// 那一半——一条每拍都问一次的调用路径（宿主 200 ms 的控制拍）不该因为第二次问就红。
    #[test]
    fn an_engine_with_nothing_cached_hands_back_zero_and_says_so_twice() {
        let root = std::env::temp_dir().join("yomika-pipeline-release");
        let engine = PipelineEngine::new(root);
        assert_eq!(engine.release_cached_models(), 0, "没跑过模型的引擎该老实答 0");
        assert_eq!(
            engine.release_cached_models(),
            0,
            "交回是幂等的：缓存本来空的，再问一次还是 0"
        );
        // echo 引擎走 trait 的默认实现：它不加载模型，「交回 0 份」是一句实话而不是偷懒。
        assert_eq!(
            crate::engine::EchoEngine::default().release_cached_models(),
            0,
            "不跑模型的引擎不该交回任何一份"
        );
    }

    fn stage(dlssnr: Option<DlssnrGrant>) -> PipelineStage {
        PipelineStage {
            stage_id: "s0".to_string(),
            model_spec_id: "dlssnr".to_string(),
            engine_policy: EnginePolicy::Gpu,
            scale: None,
            tile: None,
            layers: None,
            settings_id: None,
            model: None,
            decensor: None,
            dlssnr,
            min_input_edge: None,
            output_scale: None,
        }
    }

    fn request<'a>(
        stage: &'a PipelineStage,
        run: &'a Run,
        input: &'a StageInput,
        sink: &'a crate::engine::StageSink<'a>,
        cancel: &'a CancelToken,
    ) -> StageRequest<'a> {
        StageRequest {
            run,
            stage,
            input: Some(input),
            cancel,
            sink,
            progress: &|_percent| {},
        }
    }

    fn run() -> Run {
        Run {
            protocol_version: PROTOCOL_MAJOR,
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

    /// 这份 worker 构建必须带着 GPU 那条运行库（docs/81 记下的欠账，Task 8-b 关掉它）。
    ///
    /// 问的是**构建**，不是硬件：`directml_is_compiled_in()` 由 compute-core 被编译时的
    /// feature 决定，所以没有显卡的机器上这条照样有意义（设备在不在由探针回答，见
    /// `inpaint::validate_runtime` / `onnx::validate_runtime`）。
    ///
    /// 为什么值得一颗钉子：`worker/Cargo.toml` 只开 `cpu` 时，`available_runtimes()` 里
    /// 只有 `[Cpu]`，于是 `Auto` 与 `Cpu` 是同一条路——产品把重算搬进 worker 的全部意义里
    /// 就包括让它在显卡上跑（docs/71 §5.1），而这样的退化**没有任何测试会红**：任务照样
    /// 完成、产物照样正确，只是慢。将来谁把这条依赖改回去，必须红在这里。
    #[cfg(windows)]
    #[test]
    fn the_windows_worker_is_built_with_the_gpu_runtime() {
        eprintln!(
            "worker 的运行库偏好 = {:?}，这份构建里 DirectML 编进来了吗 = {}",
            platform_preference(),
            directml_is_compiled_in()
        );
        assert!(
            directml_is_compiled_in(),
            "Windows 上的 worker 必须带 DirectML：宿主的 onnxruntime.dll / DirectML.dll 就摆在同一个目录里，\
             而缺了它 worker 就只是个 CPU 进程，`Auto` 与 `Cpu` 会变成同一条路（docs/81 的欠账）"
        );
    }
}
