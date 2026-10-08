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
//! 引擎的政策边界也在这里落地：`Auto` 允许「探针不过就退 CPU」（并留日志），
//! `Gpu` 是**承诺**——拿不到 GPU、或这个模型在这条运行库上实测不通过，就是失败，
//! 决不许悄悄用 CPU 顶上（§5.1/§12.1）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use yomika_compute_core::engine::ValidationVerdict;
use yomika_compute_core::fit;
use yomika_compute_core::inputs;
use yomika_compute_core::onnx::{validate_runtime_cached, OnnxEngine};
use yomika_compute_core::runtime::{self, RuntimeId};
use yomika_compute_core::upscale::{self, UpscaleOptions, DEFAULT_TILE_SIZE};
use yomika_compute_protocol::messages::{EngineFallback, EnginePolicy, EngineReport, Precision};

use crate::engine::{Engine, StageError, StageOutput, StageRequest};
use crate::stage_io::{
    check_cancelled, device_id, encode_png, fallback_of, probe_dimensions, to_stage_error, ENGINE_ID,
    GPU_BACKEND_UNAVAILABLE_CODE, GPU_OUTPUT_INVALID_CODE, RESOURCE_LIMIT_CODE,
};

/// 只留一份会话：worker 一次只跑一个重算（宿主调度器就是单许可），而模型是几十 MB、
/// 开一次要几百毫秒——每个阶段重开一次是纯浪费。键里带模型路径（内容寻址，模型换了
/// 路径就换）、scale、预算、最小边与政策，所以「换了任何一个参数就该换一份会话」是被
/// 强制出来的，不是靠记性。
pub struct UpscaleEngine {
    /// worker 唯一允许读文件的根：模型与页面都从这里解析（§7.1 的同一条边界）。
    input_root: PathBuf,
    session: Mutex<Option<CachedSession>>,
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
        }
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
        u32::from(slot.take().is_some())
    }
}

impl Engine for UpscaleEngine {
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError> {
        let stage = request.stage;
        let model = stage
            .model
            .as_ref()
            .ok_or_else(|| StageError::input_invalid("这一阶段没有模型授权：不知道用哪个模型"))?;
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
        let allowed_source = (request.run.budgets.max_pixels / u64::from(scale).pow(2)).max(1);
        let source_pixels = u64::from(probe_width).saturating_mul(u64::from(probe_height));
        if source_pixels > allowed_source {
            return Err(StageError::failed(
                RESOURCE_LIMIT_CODE,
                format!(
                    "源图 {probe_width}×{probe_height} 超出这次预算：x{scale} 之后放不进 {} 像素",
                    request.run.budgets.max_pixels
                ),
            ));
        }
        let decoded = image::load_from_memory(&source)
            .map_err(|error| StageError::input_invalid(format!("解不开这张图：{error}")))?;
        let rgba = decoded.to_rgba8();
        let (width, height) = (rgba.width(), rgba.height());
        if width == 0 || height == 0 || rgba.as_raw().len() != (width as usize) * (height as usize) * 4
        {
            return Err(StageError::input_invalid("解出来的画布是空的"));
        }
        (request.progress)(10);

        // 2. 模型：同一个输入根、同一套复核。宿主声明的 hash/长度对不上就不算。
        let model_path = inputs::resolve_granted(&self.input_root, &model.relative_path)
            .map_err(|error| StageError::failed(error.code(), error.message()))?;
        inputs::verify_file(&model_path, &model.content_hash, model.byte_length)
            .map_err(|error| StageError::failed(error.code(), error.message()))?;
        let (engine, fallback) = self.open_for(
            &model_path,
            stage.engine_policy,
            scale,
            max_pixels,
            min_input_edge,
            &model.relative_path,
        )?;
        check_cancelled(request.cancel)?;
        (request.progress)(30);

        // 3. 算。分块规划、预算（按输出像素）、每块前看取消牌都在核心的 `upscale` 里。
        let tile = stage.tile.unwrap_or(0);
        let options = UpscaleOptions {
            tile_size: if tile == 0 { DEFAULT_TILE_SIZE } else { tile },
            tile_sleep_ms: 0,
            max_pixels,
            cancel: Some(request.cancel.clone()),
            ..UpscaleOptions::default()
        };
        let upscaled = upscale::upscale_rgba(engine.as_ref(), rgba.as_raw(), width, height, options)
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
                id: ENGINE_ID.to_string(),
                version: runtime::runtime_label(),
                precision: Precision::Fp32,
                device_id: device_id(engine.runtime()),
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
        .find(|id| id.is_hardware_accelerated())
        .ok_or_else(|| {
            StageError::failed(
                GPU_BACKEND_UNAVAILABLE_CODE,
                "这份构建里没有可用的 GPU 运行库",
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
}
