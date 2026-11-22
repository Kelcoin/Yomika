//! 两个引擎共用的一点点 IO 与错误词汇：认图的尺寸、编码 PNG、把核心的错误翻成协议
//! 的话、把回退交代拼出来。
//!
//! 这几件从 `upscale.rs` 里搬出来的：超分要用的正是这几
//! 件东西，而「同一张图进、同一张图出」只有在**两边真的是同一个函数**时才是被保证的
//! ——各写一份迟早会漂。这一条与宿主里「错一句话就换了一条口径」是同一个道理。

use std::io::Cursor;

use yomika_compute_core::cancel::CancelToken;
use yomika_compute_core::error::ComputeError;
use yomika_compute_core::onnx::RuntimeChoice;
use yomika_compute_core::runtime::RuntimeId;
use yomika_compute_protocol::messages::EngineFallback;

use crate::engine::{StageError, ARTIFACT_INVALID_CODE};

/// 预算不满足（输出像素或输出字节超了这次运行允许的量）：不是输入错，也不是算法错。
pub const RESOURCE_LIMIT_CODE: &str = "COMPUTE_RESOURCE_LIMIT";
/// 点了 GPU 但这台机器/这份构建没有可用的硬件运行库。
pub const GPU_BACKEND_UNAVAILABLE_CODE: &str = "GPU_BACKEND_UNAVAILABLE";
/// 点了 GPU，也有硬件运行库，但这份模型在它上面实测算错（例如 Real-CUGAN 的负垫边）。
pub const GPU_OUTPUT_INVALID_CODE: &str = "GPU_OUTPUT_INVALID";
/// 这一阶段要的放大器这一份构建里没有：模型文件不在输入根里/哈希对不上，或者内置链的
/// 名字与版本和这一份构建编着的对不上。**重试好不了**——要么用户在设置里换一档，要么
/// 两边构建必须一致（内置链是编进二进制的，没有「下载一下」这条出路）。
pub const MODEL_UNAVAILABLE_CODE: &str = "COMPUTE_MODEL_UNAVAILABLE";

/// 引擎自报的 id：宿主的诊断与缓存修订都按它认这一条路径。超分走的那条
/// `--engine onnx`（一份 ONNX 执行体）报的就是这个 id。
pub const ENGINE_ID: &str = "onnx";

/// 「这一页没算」自报的 id：动图被原样交回时用它（见 `pipeline.rs`）。
///
/// 为什么不开一个新码给它：产物是真的、来源也是真的，只是**没有计算**。报 `onnx` 会把
/// 「这份字节是原图」说成「这份字节是模型算出来的」——诊断与缓存修订都会照这个说法走。
///
/// 定义在协议层（第 30 轮，8-g④-a3 起）：宿主也要按这个名字决定「这份产物算不算数」，
/// 而两边的字面量必须是同一个（见 `yomika_compute_protocol::PASSTHROUGH_ENGINE_ID`）。
/// 这里原样再导出，让 worker 里已有的 `use crate::stage_io::PASSTHROUGH_ENGINE_ID` 照旧。
pub use yomika_compute_protocol::PASSTHROUGH_ENGINE_ID;

/// 只问文件头里的尺寸，不分配像素。
///
/// 一次授权最多 1 GiB，而 1 GiB 的 PNG 解出来可以是几十 GB RAM——预算必须在**分配像素
/// 之前**拦，不能等解完再算。
pub(crate) fn probe_dimensions(source: &[u8]) -> Result<(u32, u32), StageError> {
    image::ImageReader::new(Cursor::new(source))
        .with_guessed_format()
        .map_err(|error| StageError::input_invalid(format!("认不出这是什么图：{error}")))?
        .into_dimensions()
        .map_err(|error| StageError::input_invalid(format!("读不出这张图的尺寸：{error}")))
}

pub(crate) fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, StageError> {
    encode_png_with_icc(rgba, width, height, None)
}

pub(crate) fn encode_png_with_icc(
    rgba: &[u8], width: u32, height: u32, icc_profile: Option<Vec<u8>>,
) -> Result<Vec<u8>, StageError> {
    use image::ImageEncoder;
    let expected = (width as usize).checked_mul(height as usize).and_then(|pixels| pixels.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(rgba.len()) {
        return Err(StageError::failed(ARTIFACT_INVALID_CODE, "像素数与画布尺寸对不上"));
    }
    let mut encoded = Vec::new();
    // Borrow the finished pixels: cloning a 4000×5646 RGBA page here alone
    // adds 86 MiB to the mobile peak, with no benefit to the encoder.
    let mut encoder = image::codecs::png::PngEncoder::new(&mut encoded);
    if let Some(profile) = icc_profile {
        encoder.set_icc_profile(profile)
            .map_err(|error| StageError::failed(ARTIFACT_INVALID_CODE, format!("PNG 色彩配置写入失败：{error}")))?;
    }
    encoder.write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|error| StageError::failed(ARTIFACT_INVALID_CODE, format!("PNG 编码失败：{error}")))?;
    Ok(encoded)
}

/// 核心的错误词汇 → 协议的错误码。三处语义要分清：取消不是失败、预算是资源、其余都
/// 是「这次交上来的输入没法处理」。
pub(crate) fn to_stage_error(error: ComputeError) -> StageError {
    match error {
        ComputeError::Cancelled => StageError::cancelled(),
        ComputeError::PixelBudgetExceeded { .. } => {
            StageError::failed(RESOURCE_LIMIT_CODE, error.to_string())
        }
        ComputeError::InvalidInput(_) | ComputeError::InvalidManifest(_) => {
            StageError::input_invalid(error.to_string())
        }
        // 引擎是这里唯一开模型的一方，缓存争用不会走到这条；真到了也只是「这次算不成」。
        ComputeError::CacheBusy => StageError::failed(RESOURCE_LIMIT_CODE, error.to_string()),
    }
}

/// `device_id` 说的是**实际**跑在哪：报告里不许出现「选了显卡、跑在 CPU」。
pub(crate) fn device_id(runtime: RuntimeId) -> String {
    match runtime {
        RuntimeId::DirectMl => "gpu:0".to_string(),
        RuntimeId::Nnapi => "accelerator:nnapi:gpu-or-npu".to_string(),
        RuntimeId::CoreMl => "accelerator:coreml:cpu-and-gpu".to_string(),
        RuntimeId::Cpu => "cpu".to_string(),
    }
}

pub(crate) fn check_cancelled(cancel: &CancelToken) -> Result<(), StageError> {
    if cancel.cancelled() {
        Err(StageError::cancelled())
    } else {
        Ok(())
    }
}

/// 把核心的那份交代翻成协议里的那一段。没回退就什么都不说。
pub(crate) fn fallback_of(choice: &RuntimeChoice) -> Option<EngineFallback> {
    if !choice.fell_back() {
        return None;
    }
    Some(EngineFallback {
        requested: choice.requested.as_str().to_string(),
        used: choice.used.as_str().to_string(),
        // 回退了就一定有原因（`fallback_reason` 的类型是 Option，只是因为它对没有
        // 回退的那一侧没有话说）；真拿不到时也要给一句能看的，不能空着。
        reason: choice
            .fallback_reason()
            .unwrap_or("这套运行库没用上，改用 CPU")
            .to_string(),
    })
}

#[cfg(test)]
mod png_tests {
    use super::*;

    #[test]
    fn borrowed_png_preserves_rgb_and_partial_alpha() {
        let pixels = [255, 0, 31, 0, 17, 200, 90, 127, 0, 25, 255, 255];
        let encoded = encode_png(&pixels, 3, 1).unwrap();
        let decoded = image::load_from_memory(&encoded).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (3, 1));
        assert_eq!(decoded.as_raw().as_slice(), pixels);
    }

    #[test]
    fn malformed_rgba_is_rejected_before_the_encoder_can_panic() {
        for (pixels, width, height) in [(vec![0; 3], 1, 1), (vec![0; 5], 1, 1), (vec![], 0, 1)] {
            assert!(encode_png(&pixels, width, height).is_err());
        }
    }
}
