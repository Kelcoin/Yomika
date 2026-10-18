//! 真超分引擎（docs/71 §11 Task 7-b-ii）：解一张授权图 → 算出放大图 → 编码写回 staging。
//!
//! 这个模块只做**IO 与编排**，一条算法都不自己实现：
//!
//! 1. 读哪张图由执行器决定（它已经按 run 的声明复核过长度与 hash）；
//! 2. 用哪个模型由 `stage.model` 授权，worker 自己再解析一次、再复核一次——宿主写在 run
//!    里的只是声明，不是信任（§7.1/§7.2）；
//! 3. 解码/编码用宿主同一个 `image` 版本（同一张图进、同一张图出，两边不许漂）；
//! 4. 分块、预算、取消、`Pad` 这些都在 [`yomika_compute_core::upscale`] 与
//!    [`yomika_compute_core::onnx`] 里，宿主那条老路径用的是同一份代码。
//!
//! 放大器有两类，协议里各占一栏（互斥，见 `Stage::validate`）：
//!
//! * `model`：模型目录里的一份 ONNX。文件由宿主内容寻址地摆进输入根，这里再核一遍
//!   长度与哈希（**这是信任边界**：宿主说它是谁不算数，读出来的字节才算数）。
//! * `builtin`：编在两个二进制里的内置链（Anime4K）。**没有文件可核**——交过来的只有
//!   名字与版本，因为宿主与 worker 各自编着同一份钉住的 GLSL。所以这里要核的是**身份**：
//!   预设表里得真有这个 id、版本得对得上、倍率得和阶段声明一致；对不上就报
//!   `COMPUTE_MODEL_UNAVAILABLE`（两边构建不一致，重试好不了）。
//!
//! 引擎的政策边界也在这里落地：`Auto` 允许「探针不过就退 CPU」（并留日志），
//! `Gpu` 是**承诺**——拿不到 GPU、或这个模型在这条运行库上实测不通过，就是失败，
//! 决不许悄悄用 CPU 顶上（§5.1/§12.1）。内置链那条来路对这条政策是同一个意思：
//! 显卡可用就走显卡（wgpu 计算管道），不可用才退 CPU 解释器，且只许在 `Auto`/`Cpu` 下退。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use yomika_compute_core::anime4k::{self, Anime4kEngine};
use yomika_compute_core::engine::ValidationVerdict;
use yomika_compute_core::fit;
use yomika_compute_core::inputs;
use yomika_compute_core::onnx::{validate_runtime_cached, OnnxEngine};
use yomika_compute_core::runtime::{self, RuntimeId};
use yomika_compute_core::resources;
use yomika_compute_core::upscale::{
    self, UpscaleEngine as UpscaleEngineTrait, UpscaleOptions,
};
use yomika_compute_protocol::messages::{
    BuiltinChainGrant, EngineFallback, EnginePolicy, EngineReport, Precision, ANIME4K_ENGINE_ID,
};

use crate::engine::{Engine, StageError, StageOutput, StageRequest};
use crate::stage_io::{
    check_cancelled, device_id, encode_png, fallback_of, probe_dimensions, to_stage_error, ENGINE_ID,
    GPU_BACKEND_UNAVAILABLE_CODE, GPU_OUTPUT_INVALID_CODE, MODEL_UNAVAILABLE_CODE,
    RESOURCE_LIMIT_CODE,
};

/// 只留一份会话：worker 一次只跑一个重算（宿主调度器就是单许可），而模型是几十 MB、
/// 开一次要几百毫秒——每个阶段重开一次是纯浪费。键里带模型路径（内容寻址，模型换了
/// 路径就换）、scale、预算、最小边与政策，所以「换了任何一个参数就该换一份会话」是被
/// 强制出来的，不是靠记性。
pub struct UpscaleEngine {
    /// worker 唯一允许读文件的根：模型与页面都从这里解析（§7.1 的同一条边界）。
    input_root: PathBuf,
    session: Mutex<Option<CachedSession>>,
    /// 内置链（Anime4K）那一份引擎也缓存。与 ONNX 会话分开两格是因为它们的键与寿命
    /// 都不一样：ONNX 那句是「哪份模型 + 哪条运行库」，这句是「哪条链 + 哪条政策」，
    /// 而且它**不带任何模型文件**（内容寻址那套对它没有意义）。
    builtin: Mutex<Option<CachedBuiltin>>,
}

/// 两条来路（ONNX 会话与内置链）在下面合流成同一种东西：一个能跑分块的引擎。它要被塞进
/// `Mutex` 里跟着 worker 的线程走动，所以 trait 对象上得带 `Send + Sync`——核心的
/// [`UpscaleEngineTrait`] 本身没有这两个约束（CPU 解释器与单线程调用方不需要它们）。
type AnyEngine = Arc<dyn UpscaleEngineTrait + Send + Sync>;

/// 内置链那份引擎 + 它自报的身份（显卡句柄或 `cpu`）与回退交代。
///
/// 为什么连身份一起缓存：同一份引擎第二次被用上时，报告里说的话必须与第一次一致
/// （与 [`CachedSession::fallback`] 同一条理由）——否则同一页在两份产物里会写两种
/// 「谁算的」，而宿主按这份报告记账。
struct CachedBuiltin {
    key: String,
    engine: AnyEngine,
    device: String,
    fallback: Option<EngineFallback>,
}

/// 内置链那一档开出来的引擎：交回三件事，都是报告要用的。
struct OpenedBuiltin {
    engine: AnyEngine,
    device: String,
    fallback: Option<EngineFallback>,
}

struct CachedSession {
    key: String,
    engine: Arc<OnnxEngine>,
    /// 开这份会话时留下的回退交代（没有回退就是 `None`）。它跟会话一起缓存：同一份
    /// 会话第二次被用上时，报告里说的话必须与第一次一致。
    fallback: Option<EngineFallback>,
}

impl UpscaleEngine {
    pub fn new(input_root: PathBuf) -> Self {
        Self {
            input_root,
            session: Mutex::new(None),
            builtin: Mutex::new(None),
        }
    }

    /// 内置链那一档：把「名字 + 版本」变成一份真能跑的引擎。
    ///
    /// 交过来的是一句**身份**，不是文件——所以这里没有哈希可核，能核的是这条身份在这一份
    /// 构建里成不成立：预设表里有没有这个名字、版本是不是同一份着色器、倍率和阶段声明
    /// 一不一致。三件里任何一件对不上都报 `COMPUTE_MODEL_UNAVAILABLE` 并且**不许退让**：
    /// 两边编着不同的链时，悄悄用这一份去算等于把另一条链的产物贴上一个不是它的名字。
    ///
    /// 政策落地与 ONNX 那条同一个意思：`Gpu` 是承诺（拿不到显卡就是失败），`Auto` 允许退
    /// CPU 解释器并留下交代，`Cpu` 本来就只要 CPU。
    fn open_builtin(
        &self,
        chain: &BuiltinChainGrant,
        policy: EnginePolicy,
        scale: u32,
    ) -> Result<OpenedBuiltin, StageError> {
        let unknown = |detail: String| StageError::failed(MODEL_UNAVAILABLE_CODE, detail);
        let Some(preset) = anime4k::preset_by_id(&chain.chain_id) else {
            return Err(unknown(format!(
                "这一份构建里没有内置超分链 {}：宿主与 worker 的构建不是同一份",
                chain.chain_id
            )));
        };
        if preset.version != chain.version {
            return Err(unknown(format!(
                "内置超分链 {} 的版本对不上：宿主说的是 {}，这一份里编的是 {}",
                chain.chain_id, chain.version, preset.version
            )));
        }
        if preset.scale != scale {
            return Err(unknown(format!(
                "内置超分链 {} 的倍率对不上：阶段声明 x{scale}，这条链是 x{}",
                chain.chain_id, preset.scale
            )));
        }

        let key = format!("{}:{}:{scale}:{}", chain.chain_id, chain.version, policy.as_str());
        let mut slot = self.builtin.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(cached) = slot.as_ref() {
            if cached.key == key {
                return Ok(OpenedBuiltin {
                    engine: Arc::clone(&cached.engine),
                    device: cached.device.clone(),
                    fallback: cached.fallback.clone(),
                });
            }
        }

        // 显卡那条路先试。它拿到的是一个**共享**的设备（引擎库自己只建一次），
        // 所以「试一次」的代价是编译这条链的管道，不是重新起一遍显卡上下文。
        let mut fell_back = None;
        if policy != EnginePolicy::Cpu {
            match anime4k::gpu::Anime4kGpuEngine::open(preset) {
                Ok(engine) => {
                    let device = anime4k::gpu::adapter_description()
                        .unwrap_or_else(|_| anime4k::gpu::ENGINE_LABEL.to_string());
                    let opened = OpenedBuiltin {
                        engine: Arc::new(engine),
                        device,
                        fallback: None,
                    };
                    *slot = Some(CachedBuiltin {
                        key,
                        engine: Arc::clone(&opened.engine),
                        device: opened.device.clone(),
                        fallback: None,
                    });
                    return Ok(opened);
                }
                Err(error) => {
                    // `Gpu` 是承诺：这条链没跑上显卡就是失败，不许拿 CPU 顶上充数。
                    if policy == EnginePolicy::Gpu {
                        return Err(StageError::failed(
                            GPU_BACKEND_UNAVAILABLE_CODE,
                            format!("内置超分链 {} 没能用上显卡：{error}", chain.chain_id),
                        ));
                    }
                    fell_back = Some(EngineFallback {
                        requested: anime4k::gpu::ENGINE_LABEL.to_string(),
                        used: RuntimeId::Cpu.as_str().to_string(),
                        reason: format!("显卡这条路走不通：{error}"),
                    });
                }
            }
        }

        // CPU 解释器：这一份永远在（它就是参考实现），也是 `Cpu` 与显卡不可用时的落点。
        let engine = Anime4kEngine::open(preset).map_err(to_stage_error)?;
        let opened = OpenedBuiltin {
            engine: Arc::new(engine),
            device: RuntimeId::Cpu.as_str().to_string(),
            fallback: fell_back,
        };
        *slot = Some(CachedBuiltin {
            key,
            engine: Arc::clone(&opened.engine),
            device: opened.device.clone(),
            fallback: opened.fallback.clone(),
        });
        Ok(opened)
    }

    /// 拿一份能跑 `stage` 的会话：命中就复用，没命中就按政策开一份新的。
    /// 回头的第二项是「想要谁 / 用了谁 / 为什么」——它要一路走到 artifact 的报告里。
    fn open_for(
        &self,
        path: &Path,
        policy: EnginePolicy,
        scale: u32,
        max_pixels: usize,
        min_input_edge: u32,
        model_label: &str,
    ) -> Result<(Arc<OnnxEngine>, Option<EngineFallback>), StageError> {
        let key = format!(
            "{model_label}:{scale}:{max_pixels}:{min_input_edge}:{}",
            policy.as_str()
        );
        // 中毒的锁不该让整个 worker 报废：会话本身没有跨线程不变量，丢了重开一份更省事。
        let mut slot = self.session.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(cached) = slot.as_ref() {
            if cached.key == key {
                return Ok((Arc::clone(&cached.engine), cached.fallback.clone()));
            }
        }
        let (engine, fallback) = match policy {
            EnginePolicy::Cpu => (
                OnnxEngine::open_with_runtime(path, RuntimeId::Cpu, scale, max_pixels, min_input_edge)
                    .map_err(to_stage_error)?,
                // 本来就要 CPU：这不是回退，没什么可交代的。
                None,
            ),
            // 首选运行库 + 实测探针（结论按内容指纹记账，同一份模型不重探），
            // 探针不过就退 CPU 并把原因交出来（核心的 `open_choice`）。
            EnginePolicy::Auto => {
                let (engine, choice) = OnnxEngine::open_choice(path, scale, max_pixels, min_input_edge)
                    .map_err(to_stage_error)?;
                (engine, fallback_of(&choice))
            }
            // 承诺：要么真用上 GPU，要么失败。这里从来没有「回退」这一项。
            EnginePolicy::Gpu => (
                open_forced_gpu(path, scale, max_pixels, min_input_edge)?,
                None,
            ),
        };
        let engine = Arc::new(engine);
        *slot = Some(CachedSession {
            key,
            engine: Arc::clone(&engine),
            fallback: fallback.clone(),
        });
        Ok((engine, fallback))
    }

    /// 丢掉缓存的那份 ONNX 会话（§12.4「idle30 秒释放模型/workspace」），返回交回了几份。
    ///
    /// **丢的是会话，不是「下次不用模型」**：ONNX 会话里是几十 MB 的权重和运行库的
    /// 分配器状态，用户只是切走两分钟，留着它就是在占着上次那页的内存；下一件任务
    /// 按同一个键重新开一份就是了（`on_release` 与 `cached` 的区别只在这句话上）。
    ///
    /// 返回 0 是「缓存里本来就没有会话」，不是「交不出去」——两者在宿主那边必须能分开。
    pub fn release_cached_session(&self) -> u32 {
        let mut slot = self.session.lock().unwrap_or_else(|error| error.into_inner());
        let dropped = u32::from(slot.take().is_some());
        // 内置链那一份一起丢：同一条「idle 30 秒释放」的规矩，而且它比 ONNX 会话更能攒
        // ——显卡上那条链的管道与像素池都还挂在共享设备上。
        let mut builtin = self.builtin.lock().unwrap_or_else(|error| error.into_inner());
        dropped + u32::from(builtin.take().is_some())
    }
}

impl Engine for UpscaleEngine {
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError> {
        let stage = request.stage;
        // 放大器两栏任选其一（协议保证互斥，见 `Stage::validate`）：模型文件，或者内置链
        // 的一句身份。两栏都空才是错——那时真的不知道用什么去放大。
        let builtin = stage.builtin.as_ref();
        let model = stage.model.as_ref();
        if builtin.is_none() && model.is_none() {
            return Err(StageError::input_invalid(
                "这一阶段既没有模型授权也没有内置链：不知道用哪个引擎放大",
            ));
        }
        let input = request
            .input
            .ok_or_else(|| StageError::input_invalid("这一阶段没有输入：不知道放大哪张图"))?;
        let scale = stage
            .scale
            .ok_or_else(|| StageError::input_invalid("这一阶段没有声明 scale"))?;
        if scale == 0 {
            return Err(StageError::input_invalid("scale 不能是 0"));
        }
        let max_pixels = usize::try_from(request.run.budgets.max_pixels).unwrap_or(usize::MAX);
        let min_input_edge = stage.min_input_edge.unwrap_or(1).max(1);
        check_cancelled(request.cancel)?;
        (request.progress)(2);

        // 1. 解码。先只读文件头问一声有多大：一次授权最多 1 GiB，而 1 GiB 的 PNG 解出来
        //    可以是几十 GB RAM——预算必须在**分配像素之前**拦，不能等解完再算。
        let source = std::fs::read(input.path())
            .map_err(|error| StageError::input_invalid(format!("读不到这一阶段的输入：{error}")))?;
        let (probe_width, probe_height) = probe_dimensions(&source)?;
        let delivery_scale = stage.output_scale.unwrap_or(scale).min(scale).max(1);
        let source_pixels = u64::from(probe_width).saturating_mul(u64::from(probe_height));
        // Keep the decode guard: preprocessing cannot rescue an allocation that
        // is already too large to decode. Only the delivery projection adapts.
        if source_pixels > request.run.budgets.max_pixels {
            return Err(StageError::failed(
                RESOURCE_LIMIT_CODE,
                format!(
                    "源图 {probe_width}×{probe_height} 超出解码预算的 {} 像素",
                    request.run.budgets.max_pixels
                ),
            ));
        }
        let decoded = image::load_from_memory(&source)
            .map_err(|error| StageError::input_invalid(format!("解不开这张图：{error}")))?;
        let rgba = fit::fit_processing_input(decoded.into_rgba8(), delivery_scale, request.run.budgets.max_pixels)
            .ok_or_else(|| StageError::failed(RESOURCE_LIMIT_CODE, "预算装不下一张最小输出"))?;
        let (width, height) = (rgba.width(), rgba.height());
        if width == 0 || height == 0 || rgba.as_raw().len() != (width as usize) * (height as usize) * 4
        {
            return Err(StageError::input_invalid("解出来的画布是空的"));
        }
        (request.progress)(10);

        // 2. 放大器。两条来路在这里合流成同一个东西——一份 `UpscaleEngine` 加一段要写进
        //    产物报告的身份。合流之后再往下走，分块、预算、取消、缩放、编码都只有一份实现。
        //
        //    * 模型那条：同一个输入根、同一套复核。宿主声明的 hash/长度对不上就不算。
        //    * 内置链那条：没有文件，核的是身份（名字、版本、倍率），见 `open_builtin`。
        let (engine, engine_id, engine_version, device, fallback): (
            Arc<dyn UpscaleEngineTrait>,
            &'static str,
            String,
            String,
            Option<EngineFallback>,
        ) = if let Some(chain) = builtin {
            let opened = self.open_builtin(chain, stage.engine_policy, scale)?;
            (
                opened.engine,
                ANIME4K_ENGINE_ID,
                format!("{}/{}", chain.chain_id, chain.version),
                opened.device,
                opened.fallback,
            )
        } else {
            let grant = model.expect("上面已经判过：两栏不会都空");
            let model_path = inputs::resolve_granted(&self.input_root, &grant.relative_path)
                .map_err(|error| StageError::failed(error.code(), error.message()))?;
            inputs::verify_file(&model_path, &grant.content_hash, grant.byte_length)
                .map_err(|error| StageError::failed(error.code(), error.message()))?;
            let (onnx, fallback) = self.open_for(
                &model_path,
                stage.engine_policy,
                scale,
                max_pixels,
                min_input_edge,
                &grant.relative_path,
            )?;
            let device = device_id(onnx.runtime());
            (
                onnx as Arc<dyn UpscaleEngineTrait>,
                ENGINE_ID,
                runtime::runtime_label(),
                device,
                fallback,
            )
        };
        check_cancelled(request.cancel)?;
        (request.progress)(30);

        // 3. 算。分块规划、预算（按输出像素）、每块前看取消牌都在核心的 `upscale` 里。
        let tile = stage.tile.unwrap_or(0);
        let gpu_memory = if engine_id == ENGINE_ID && device == "gpu:0" {
            #[cfg(windows)]
            { yomika_compute_core::dlssnr::gpu::video_memory_for_device_index(0).map(|m| resources::GpuMemory { budget_bytes: m.budget_bytes, used_bytes: m.used_bytes }) }
            #[cfg(not(windows))]
            { None }
        } else if engine_id == ANIME4K_ENGINE_ID && device != RuntimeId::Cpu.as_str() {
            anime4k::gpu::video_memory()
        } else { None };
        let fixed = engine.fixed_input_size();
        let padding = upscale::DEFAULT_TILE_PADDING.max(engine.tile_padding());
        let adaptive = resources::auto_tile_size(gpu_memory, scale, padding, min_input_edge, fixed);
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let adaptive = adaptive.min(resources::mobile_tile_edge_for_pixel_budget(request.run.budgets.max_pixels)).max(min_input_edge);
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let tile = tile.min(adaptive);
        let options = UpscaleOptions {
            output_scale: Some(delivery_scale),
            tile_size: if tile == 0 { adaptive } else { fixed.map(|_| tile.min(adaptive)).unwrap_or(tile) },
            tile_sleep_ms: 0,
            tile_padding: padding,
            max_pixels,
            cancel: Some(request.cancel.clone()),
            ..UpscaleOptions::default()
        };
        let upscaled = upscale::upscale_rgba_with_allocation_recovery(engine.as_ref(), rgba.as_raw(), width, height, options, min_input_edge)
            .map_err(to_stage_error)?;
        check_cancelled(request.cancel)?;
        (request.progress)(85);

        // 3.5 「交出去多大」由宿主声明（`stage.output_scale`）：模型原生倍率比它大时
        //     现在就缩下来。**必须在编码之前**——x4 的 5600×8000 是 180 MB RGBA，
        //     编码出来的 PNG 又是几十 MB，而宿主只要 2 倍的那一份，晚一步做就是把这
        //     两笔内存连同编码时间白花掉（docs/71 §5.3）。缩放本身在核心的 `fit` 里，
        //     宿主那条内联路径（Anime4K / 最近邻）用的是同一份实现。
        let (final_rgba, final_width, final_height) = match stage.output_scale {
            Some(cap) => fit::fit_rgba_scale(
                upscaled.rgba,
                upscaled.width,
                upscaled.height,
                width,
                height,
                cap,
            ),
            None => (upscaled.rgba, upscaled.width, upscaled.height),
        };

        // 4. 编码成 PNG：无损、带 alpha，解回来就是刚算出来的像素（宿主因此可以自己
        //    对照一遍，不必信 worker 报的尺寸）。
        let encoded = encode_png(&final_rgba, final_width, final_height)?;
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

        Ok(StageOutput {
            relative_name: name,
            mime: "image/png".to_string(),
            byte_length: written.byte_length,
            width: final_width,
            height: final_height,
            content_hash: written.content_hash,
            engine: EngineReport {
                id: engine_id.to_string(),
                version: engine_version,
                precision: Precision::Fp32,
                device_id: device,
                // 报告里必须留下「问的是哪条政策」，否则界面无法把「我要显卡但没给上」
                // 与「本来就跑 CPU」分开。
                policy: Some(stage.engine_policy),
                fallback,
            },
        })
    }
}

/// `Gpu` = 承诺。没有硬件运行库、或这份模型在它上面实测不通过，都是失败。
fn open_forced_gpu(
    path: &Path,
    scale: u32,
    max_pixels: usize,
    min_input_edge: u32,
) -> Result<OnnxEngine, StageError> {
    let runtime = runtime::available_runtimes()
        .into_iter()
        .find(|id| id.proves_gpu_execution())
        .ok_or_else(|| {
            StageError::failed(
                GPU_BACKEND_UNAVAILABLE_CODE,
                "没有可证明 GPU 执行的运行库；NNAPI/CoreML 硬件加速请使用自动模式",
            )
        })?;
    match validate_runtime_cached(path, runtime, scale, min_input_edge) {
        // 探针说「算得对」才允许开 —— 与首选路径同一个判据，只是这里不许退让。
        ValidationVerdict::Passed => {}
        verdict => {
            return Err(StageError::failed(
                GPU_OUTPUT_INVALID_CODE,
                format!(
                    "{} 在这份模型上没通过探针：{verdict:?}",
                    runtime.as_str()
                ),
            ))
        }
    }
    OnnxEngine::open_with_runtime(path, runtime, scale, max_pixels, min_input_edge)
        .map_err(to_stage_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yomika_compute_core::onnx::RuntimeChoice;

    #[test]
    fn oversized_delivery_is_preprocessed_and_reaches_the_real_engine() {
        use crate::engine::{StageInput, StageSink};
        use yomika_compute_core::cancel::CancelToken;
        use yomika_compute_protocol::messages::{Budgets, PipelineStage, Priority, Run, RunInput};
        let root = std::env::temp_dir().join(format!("yomika-adaptive-input-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("input.png");
        image::RgbaImage::from_pixel(20, 10, image::Rgba([90, 50, 20, 255])).save(&path).unwrap();
        let preset = anime4k::preset_by_id("anime4k").unwrap();
        let stage = PipelineStage {
            stage_id: "adaptive".into(), model_spec_id: "anime4k".into(),
            engine_policy: EnginePolicy::Cpu, scale: Some(2), output_scale: Some(2),
            tile: Some(32), layers: None, settings_id: None, model: None, dlssnr: None,
            builtin: Some(BuiltinChainGrant { chain_id: preset.id.into(), version: preset.version.into(), scale: 2 }),
            min_input_edge: None,
        };
        let run = Run {
            protocol_version: yomika_compute_protocol::PROTOCOL_MAJOR, worker_epoch: "epoch".into(),
            job_id: "job".into(), generation: 1,
            input: RunInput { input_id: "input".into(), content_hash: "0".repeat(64), byte_length: 1, relative_path: None },
            pipeline: vec![stage.clone()], output_grant_id: "grant".into(), priority: Priority::Foreground,
            deadline_ms: 60000, budgets: Budgets { max_pixels: 200, max_output_bytes: 1000000, intra_threads: 1 },
        };
        let input = StageInput::Granted { relative: "input.png".into(), path };
        let sink = StageSink::new(&root);
        let cancel = CancelToken::none();
        let engine = UpscaleEngine::new(root.clone());
        let output = engine.execute(StageRequest { run: &run, stage: &stage, input: Some(&input), cancel: &cancel, sink: &sink, progress: &|_| {} }).unwrap();
        assert_eq!((output.width, output.height), (20, 10));
        assert_eq!(output.engine.id, ANIME4K_ENGINE_ID);
        let decoded = image::open(root.join(&output.relative_name)).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (20, 10));
        // A second upscale in a chain must independently fit the previous output.
        let previous = StageInput::Previous { relative: output.relative_name.clone(), path: root.join(output.relative_name) };
        let mut next = stage.clone();
        next.stage_id = "adaptive-next".into();
        let second = engine.execute(StageRequest { run: &run, stage: &next, input: Some(&previous), cancel: &cancel, sink: &sink, progress: &|_| {} }).unwrap();
        assert_eq!((second.width, second.height), (20, 10));
        let mut too_small = run.clone();
        too_small.budgets.max_pixels = 199;
        let refused = engine.execute(StageRequest { run: &too_small, stage: &stage, input: Some(&input), cancel: &cancel, sink: &sink, progress: &|_| {} });
        assert_eq!(refused.err().unwrap().code, RESOURCE_LIMIT_CODE, "source decode ceiling remains enforced");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 「点的是显卡、跑的是 CPU」这句话要么别说，要说就得说全：谁被换掉了、换成了谁、
    /// 为什么。
    ///
    /// 后一半同样是这条用例在看的：**没回退就不许交代一条回退**。凭空造出来的那条
    /// `requested == used`，会被协议的 `validate` 当成错误（`engine.fallback.used`
    /// 越界）——所以它不是「多一句话」，而是一份会被拒收的假账。
    #[test]
    fn a_fallback_is_reported_with_who_was_replaced_and_why() {
        let fell_back = RuntimeChoice {
            requested: RuntimeId::DirectMl,
            used: RuntimeId::Cpu,
            verdict: ValidationVerdict::NotTested,
        };
        let fallback = fallback_of(&fell_back).expect("退了 CPU 就得交代");
        assert_eq!(fallback.requested, "directml");
        assert_eq!(fallback.used, "cpu");
        assert!(
            fallback.reason.contains("不可用"),
            "原因要能看：{}",
            fallback.reason
        );

        let stayed = RuntimeChoice {
            requested: RuntimeId::DirectMl,
            used: RuntimeId::DirectMl,
            verdict: ValidationVerdict::Passed,
        };
        assert!(
            fallback_of(&stayed).is_none(),
            "没回退就不许交代一条回退"
        );
    }

    /// 内置链那一档只认**这一份构建里编着的那条链**。
    ///
    /// 交过来的是一句身份（名字 + 版本 + 倍率），没有文件可以按哈希核——所以「宿主与 worker
    /// 是不是同一份链」只能靠这三件对上。任何一件对不上都必须当场报
    /// `COMPUTE_MODEL_UNAVAILABLE` 并且**不许退让**：拿这一份去算，等于把别的链的产物贴上
    /// 这条链的名字（版本就是「着色器换过没有」的那枚戳，见 `Anime4kPreset::version`）。
    ///
    /// 变异检查：把 `open_builtin` 里版本那一段判断删掉，这一条会红（错的版本被混过去）；
    /// 名字与倍率那两段同理。
    #[test]
    fn a_builtin_chain_is_only_recognised_in_the_version_this_build_ships() {
        let preset = anime4k::preset_by_id("anime4k-hq").expect("这一份里编着这条链");
        let engine = UpscaleEngine::new(PathBuf::from("不读盘的输入根"));
        // `OpenedBuiltin` 里的引擎是 trait 对象（没有 `Debug`），所以这里不用 `expect_err`。
        let refuse = |chain: &BuiltinChainGrant, scale: u32| -> StageError {
            match engine.open_builtin(chain, EnginePolicy::Cpu, scale) {
                Ok(_) => panic!("这一份不该认这条身份：{chain:?}"),
                Err(error) => error,
            }
        };

        let unknown = BuiltinChainGrant {
            chain_id: "anime4k-from-the-future".to_string(),
            version: preset.version.to_string(),
            scale: preset.scale,
        };
        let error = refuse(&unknown, preset.scale);
        assert_eq!(error.code, MODEL_UNAVAILABLE_CODE);
        assert!(
            error.message.contains("anime4k-from-the-future"),
            "拒绝的话里必须出现那个名字：{}",
            error.message
        );

        let next_version = format!("{}-next", preset.version);
        let wrong_version = BuiltinChainGrant {
            chain_id: preset.id.to_string(),
            version: next_version.clone(),
            scale: preset.scale,
        };
        let error = refuse(&wrong_version, preset.scale);
        assert_eq!(error.code, MODEL_UNAVAILABLE_CODE);
        assert!(
            error.message.contains(&next_version),
            "拒绝的话里必须出现对不上的那个版本：{}",
            error.message
        );

        let wrong_scale = BuiltinChainGrant {
            chain_id: preset.id.to_string(),
            version: preset.version.to_string(),
            scale: preset.scale + 1,
        };
        let error = refuse(&wrong_scale, preset.scale + 1);
        assert_eq!(error.code, MODEL_UNAVAILABLE_CODE);
    }

    /// 认得的身份要真的开得出来。`Cpu` 政策走核心里的 CPU 解释器——这一条不需要显卡，
    /// 所以它在任何机器上都跑；显卡那条路由核心的 parity 用例（真显卡上逐像素比对）管。
    #[test]
    fn the_builtin_chain_this_build_ships_opens_on_the_cpu_policy() {
        let preset = anime4k::preset_by_id("anime4k").expect("这一份里编着这条链");
        let engine = UpscaleEngine::new(PathBuf::from("不读盘的输入根"));
        let chain = BuiltinChainGrant {
            chain_id: preset.id.to_string(),
            version: preset.version.to_string(),
            scale: preset.scale,
        };
        let opened = engine
            .open_builtin(&chain, EnginePolicy::Cpu, preset.scale)
            .expect("自己编着的链该开得出来");
        assert!(
            opened.fallback.is_none(),
            "点名 CPU 时不存在回退这回事：{:?}",
            opened.fallback
        );
        assert_eq!(opened.device, RuntimeId::Cpu.as_str());
        assert_eq!(opened.engine.scale(), preset.scale, "倍率由预设说了算");

        // 同一个身份第二次要命中缓存：不然每一页都会重编一遍着色器。
        let again = engine
            .open_builtin(&chain, EnginePolicy::Cpu, preset.scale)
            .expect("第二次也该开得出来");
        assert_eq!(again.device, opened.device);
        assert!(Arc::ptr_eq(&again.engine, &opened.engine), "第二次该复用同一份引擎");
    }
}
