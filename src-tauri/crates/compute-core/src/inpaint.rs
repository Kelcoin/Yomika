//! DeepCreamPy inpainting，填被遮区域的那一阶段。
//!
//! 这一份是从宿主的 `src/inference/inpaint.rs` 搬过来的（docs/71 §11 Task 8 的
//! 「core decensor」那一格）：worker 要跑修补就必须能链接到它，而 worker 链接不了
//! 宿主。搬运时张量约定、重采样方向（进去 Nearest、回来 CatmullRom）、mask 的反向
//! 约定、以及「alpha 永远是页面的」都没有改一个字；只换了错误类型（核心的
//! [`ComputeError`]）与会话来源（`crate::runtime::open_preferred`，与宿主原来的
//! `inference::session::open` 是同一个函数）。
//!
//! 这个模块**要** `ort`（和 `crate::onnx` 一样门在 feature 后面）：它整个就是「一次
//! 模型运行」。
//!
//! Contract of the exported graphs (`bar.onnx`, `mosaic.onnx`), which is not
//! guessable from the file name:
//!
//! - Three inputs, all `f32` NHWC `[1, 256, 256, 3]`, statically shaped, fetched
//!   and fed **by name** because ONNX does not promise input or output order.
//!   `Placeholder:0` and `Placeholder_1:0` take the *same* image; `Placeholder_2:0`
//!   takes the mask.
//! - The mask marks **known** pixels with 1 and the area to synthesise with 0 —
//!   the opposite of how a censor mask is naturally written. The graph composites
//!   internally: `out = clip(G(image, mask), -1, 1) · (1 - mask) + Placeholder_1 · mask`,
//!   so known pixels come back as they were handed in, and only the zeroed area is
//!   invented. That property is what the real-model test checks.
//! - Pixels are `[-1, 1]`: `[0, 1] · 2 - 1`. In the bar case the censored pixels
//!   are blanked first, so they arrive as -1 rather than as the bar's colour.
//!
//! Windows uses DirectML with CPU operator/session fallback. The upstream CUDA
//! NaN constraint is CUDA/cuDNN-specific, not evidence against DirectML. Reject
//! non-finite outputs instead of silently turning them into black pixels.

use std::path::Path;
use std::sync::Mutex;

use crate::decensor::CensorKind;
use crate::engine::{outputs_agree, ValidationVerdict, PROBE_MEAN_ABS_TOLERANCE};
use crate::error::ComputeError;
use crate::inputs::file_fingerprint;
use crate::onnx::RuntimeChoice;
use crate::probe::{self, ProbeKey, ProbeKind};
use crate::runtime::{
    available_runtimes, open_preferred, open_session, platform_preference, RuntimeId,
};

/// The graph's input side. Not a tunable: the export declares it statically.
pub const INPAINT_SIDE: u32 = 256;

const IMAGE_INPUT: &str = "Placeholder:0";
const IMAGE_INPUT_AGAIN: &str = "Placeholder_1:0";
const MASK_INPUT: &str = "Placeholder_2:0";
const OUTPUT: &str = "add:0";

pub struct InpaintEngine {
    session: Mutex<ort::session::Session>,
    kind: CensorKind,
}

/// The `[-1, 1]` NHWC image tensor, with the censored pixels blanked for bars.
///
/// Blanking matters: a bar is opaque paint, and handing the model the bar's own
/// colour as context biases the fill towards it. A mosaic still carries the
/// original colours, so it is left alone.
fn image_tensor(rgb256: &[u8], censored256: &[u8], kind: CensorKind) -> Vec<f32> {
    let pixels = censored256.len();
    let mut values = Vec::with_capacity(pixels * 3);
    for index in 0..pixels {
        let blank = kind == CensorKind::Bar && censored256[index] != 0;
        for channel in 0..3 {
            let level = if blank {
                0.0
            } else {
                f32::from(rgb256[index * 3 + channel]) / 255.0
            };
            values.push(level * 2.0 - 1.0);
        }
    }
    values
}

/// The mask tensor: 1 where the pixel is known, 0 where the model must invent,
/// replicated across all three channels because the graph concatenates it onto
/// the image as three planes.
fn known_tensor(censored256: &[u8]) -> Vec<f32> {
    let mut values = Vec::with_capacity(censored256.len() * 3);
    for &censored in censored256 {
        let known = if censored != 0 { 0.0 } else { 1.0 };
        values.extend_from_slice(&[known, known, known]);
    }
    values
}

/// `[-1, 1]` back to bytes. Upstream casts without clamping; the graph's own clip
/// makes that safe for the generated area, but a clamp costs nothing and keeps a
/// non-finite value from wrapping into a bright speckle.
fn denormalise(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .map(|value| {
            if !value.is_finite() {
                return 0;
            }
            (((value + 1.0) / 2.0) * 255.0).round().clamp(0.0, 255.0) as u8
        })
        .collect()
}

/// 探针用的那张合成图：一片梯度，正中被遮掉四分之一。
///
/// 为什么是梯度而不是纯色：纯色图上「算错了」常常与「算对了」差不出一个读数（卷积
/// 的边界条件在常数上不可见），而梯度把每个像素都变成一次可比的读数。为什么正中要
/// 有一块遮罩：没有它，图的「修补」那一半一次都不会被走过，探针就只探了个恒等映射。
fn probe_crop() -> (Vec<u8>, Vec<u8>) {
    let side = INPAINT_SIDE as usize;
    let mut rgba = vec![0_u8; side * side * 4];
    let mut censored = vec![0_u8; side * side];
    for y in 0..side {
        for x in 0..side {
            let at = (y * side + x) * 4;
            rgba[at] = ((x * 255) / (side - 1)) as u8;
            rgba[at + 1] = ((y * 255) / (side - 1)) as u8;
            rgba[at + 2] = 128;
            rgba[at + 3] = 255;
        }
    }
    for y in (side / 4)..(side * 3 / 4) {
        for x in (side / 4)..(side * 3 / 4) {
            censored[y * side + x] = 1;
        }
    }
    (rgba, censored)
}

/// 探针的一次真跑：同一套张量构造、同样按名字喂进去的三路输入，交出原始 f32 输出。
///
/// 这里没有另写一套「探针专用」的张量代码：`image_tensor`/`known_tensor` 就是生产的
/// 那两个函数，形状、输入名、`OUTPUT` 也取自同一批常量。探针与生产的差别只有**输入
/// 数据**与**后处理**（这里不做反归一化，因为比的是 `[-1,1]` 上的原始数值，量化成字节
/// 会把 1/255 的差异抹平成一个「通过」）。
fn run_once(model_path: &Path, kind: CensorKind, runtime: RuntimeId) -> Result<Vec<f32>, String> {
    probe::note_probe_opened();
    let (rgba, censored) = probe_crop();
    let mut rgb = Vec::with_capacity(censored.len() * 3);
    for pixel in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[0..3]);
    }
    let shape = vec![1_i64, i64::from(INPAINT_SIDE), i64::from(INPAINT_SIDE), 3];
    let image_values = image_tensor(&rgb, &censored, kind);
    let image_input = ort::value::Tensor::from_array((shape.clone(), image_values.clone()))
        .map_err(|error| error.to_string())?;
    let image_again = ort::value::Tensor::from_array((shape.clone(), image_values))
        .map_err(|error| error.to_string())?;
    let mask_input = ort::value::Tensor::from_array((shape, known_tensor(&censored)))
        .map_err(|error| error.to_string())?;
    let mut session = open_session(model_path, runtime).map_err(|error| error.to_string())?;
    let outputs = session
        .run(ort::inputs![
            IMAGE_INPUT => image_input,
            IMAGE_INPUT_AGAIN => image_again,
            MASK_INPUT => mask_input,
        ])
        .map_err(|error| error.to_string())?;
    let (out_shape, values) = outputs[OUTPUT]
        .try_extract_tensor::<f32>()
        .map_err(|error| error.to_string())?;
    let expected = [1_i64, i64::from(INPAINT_SIDE), i64::from(INPAINT_SIDE), 3];
    if out_shape.as_ref() != expected {
        return Err(format!(
            "{} answered with shape {out_shape:?}, expected {expected:?}",
            runtime.as_str()
        ));
    }
    Ok(values.to_vec())
}

/// 两份原始输出的平均绝对差。判据本身在 [`outputs_agree`] 里，这个数只是为了让交代
/// 里写得出「差多少」——用户看到的是这个数。
fn mean_abs_difference(actual: &[f32], expected: &[f32]) -> f64 {
    let pairs = actual.len().min(expected.len());
    if pairs == 0 {
        return f64::INFINITY;
    }
    let total: f64 = actual
        .iter()
        .zip(expected)
        .map(|(left, right)| (*left - *right).abs() as f64)
        .sum();
    total / pairs as f64
}

/// 让一份合成图同时过 `runtime` 与 CPU，比两份原始输出。
///
/// 为什么修补也要探针：`open_preferred` 只能证明「会话注册成功、图跑得出数」，而
/// Task 1 的实测已经证明「跑得出数」不是证据（Real-CUGAN 在 DirectML 上形状完全合法、
/// 数值全错）。修补图的缺陷面**不同**——产品真正装的那四份图里没有负垫边 `Pad`
/// （`docs/91` 第 4 节、探针 `docs/Aletheia-Lens/_internal/models` 的实测）——但「不同」
/// 不等于「没有」，所以这里探的就是生产真走的那条路。
pub fn validate_runtime(
    model_path: &Path,
    kind: CensorKind,
    runtime: RuntimeId,
) -> ValidationVerdict {
    if runtime == RuntimeId::Cpu {
        // 它就是参照实现，没什么可测的（与 `crate::onnx::validate_runtime` 同一条判据）。
        return ValidationVerdict::Passed;
    }
    let actual = match run_once(model_path, kind, runtime) {
        Ok(values) => values,
        Err(reason) => return ValidationVerdict::Failed { reason },
    };
    let expected = match run_once(model_path, kind, RuntimeId::Cpu) {
        Ok(values) => values,
        Err(reason) => {
            // 连参照实现都说不出话，那这条运行库的结论无从谈起——不通过，而且是
            // 因为「没法比」，不是因为它算得对。
            return ValidationVerdict::Failed {
                reason: format!("CPU 参照没跑成：{reason}"),
            }
        }
    };
    if outputs_agree(&actual, &expected) {
        return ValidationVerdict::Passed;
    }
    ValidationVerdict::Failed {
        reason: format!(
            "mean {:.9} > {PROBE_MEAN_ABS_TOLERANCE} over {} values",
            mean_abs_difference(&actual, &expected),
            actual.len()
        ),
    }
}

/// 带记账的 [`validate_runtime`]：同一份字节 + 同一条运行库只真探一次。
///
/// 键里的 `scale` 记 `1`、`min_input_edge` 记 [`INPAINT_SIDE`]：修补图没有倍率，但这两栏
/// 仍然是问题的一部分（换一张要求别的边长的图就是另一个问题），而
/// [`ProbeKind::Inpaint`] 那一位把这条记账与超分那条彻底分开——同一份文件被两类探针问过
/// 时，命中的必须是各自那一条。
pub fn validate_runtime_cached(
    model_path: &Path,
    kind: CensorKind,
    runtime: RuntimeId,
) -> ValidationVerdict {
    if runtime == RuntimeId::Cpu {
        return ValidationVerdict::Passed;
    }
    let Ok((byte_length, content_hash)) = file_fingerprint(model_path) else {
        // 指纹读不出来就不记账：没有内容可以指认，硬记一条只会把「这个路径当时的样子」
        // 当成「这份模型的样子」（理由与 `crate::onnx` 那份相同）。
        return validate_runtime(model_path, kind, runtime);
    };
    let key = ProbeKey {
        content_hash,
        byte_length,
        kind: ProbeKind::Inpaint,
        runtime,
        scale: 1,
        min_input_edge: INPAINT_SIDE,
    };
    if let Some(record) = probe::recall(&key) {
        return record.verdict;
    }
    let before = probe::probes_opened();
    let verdict = validate_runtime(model_path, kind, runtime);
    probe::remember(key, verdict.clone(), probe::probes_opened() - before);
    verdict
}

impl InpaintEngine {
    /// 首选运行库开会话、注册失败退回 CPU（`runtime::open_preferred` 就是宿主与
    /// worker 共用的那一条策略）。
    ///
    /// 这条**不**跑实测探针、也不交回交代，宿主里既有的调用点用的就是它。要交代的那条
    /// 路是 [`Self::open_choice`]：它先问 [`validate_runtime_cached`]，探针不过就换 CPU，
    /// 并把「想要谁、用了谁、为什么」带回去（worker 的修补阶段必须走那一条）。
    pub fn open(model_path: &Path, kind: CensorKind) -> Result<Self, ComputeError> {
        let session = open_preferred(model_path)
            .map_err(|error| ComputeError::InvalidInput(format!("inpainting session failed: {error}")))?;
        Ok(Self {
            session: Mutex::new(session),
            kind,
        })
    }

    /// 用**指定**的运行库打开，不换也不回退。调用方要自己确保这条运行库对这份模型实测
    /// 通过（[`validate_runtime`]）——「点的是显卡、跑的是 CPU」正是这轮要消灭的那类谎话。
    pub fn open_with_runtime(
        model_path: &Path,
        kind: CensorKind,
        runtime: RuntimeId,
    ) -> Result<Self, ComputeError> {
        let session = open_session(model_path, runtime).map_err(|error| {
            ComputeError::InvalidInput(format!("inpainting session on {} failed: {error}", runtime.as_str()))
        })?;
        Ok(Self {
            session: Mutex::new(session),
            kind,
        })
    }

    /// 先实测再决定用谁的那条路：探针过了就用硬件运行库，没过就换 CPU，并把结论交回去。
    ///
    /// 与 `OnnxEngine::open_choice` 是同一条策略、同一套 [`RuntimeChoice`] 词汇，所以
    /// worker 里超分与修补两个阶段对「谁在算」的交代是同一句话。
    pub fn open_choice(
        model_path: &Path,
        kind: CensorKind,
    ) -> Result<(Self, RuntimeChoice), ComputeError> {
        let requested = *platform_preference().first().unwrap_or(&RuntimeId::Cpu);
        let candidate = available_runtimes()
            .into_iter()
            .find(|runtime| runtime.is_hardware_accelerated());
        let (used, verdict) = match candidate {
            Some(runtime) => match validate_runtime_cached(model_path, kind, runtime) {
                ValidationVerdict::Passed => (runtime, ValidationVerdict::Passed),
                verdict => {
                    eprintln!(
                        "yomika: inpaint {} provider={} 实测不通过（{verdict:?}）；改用 CPU 参照",
                        model_path.display(),
                        runtime.as_str()
                    );
                    (RuntimeId::Cpu, verdict)
                }
            },
            // 这份构建/这台机器连一条硬件运行库都没有：没得问，也就没得测。
            None => (RuntimeId::Cpu, ValidationVerdict::NotTested),
        };
        let engine = Self::open_with_runtime(model_path, kind, used)?;
        Ok((
            engine,
            RuntimeChoice {
                requested,
                used,
                verdict,
            },
        ))
    }

    /// Fills the censored pixels of one RGBA crop, returning an RGBA patch of the
    /// same size.
    ///
    /// `censored` is one byte per crop pixel, non-zero where the pixel is censored
    /// — the same convention `paste_masked_rgba` takes, and the inverse of the
    /// tensor the graph wants. The inversion happens here, once.
    pub fn inpaint(
        &self,
        rgba: &[u8],
        width: u32,
        height: u32,
        censored: &[u8],
    ) -> Result<Vec<u8>, ComputeError> {
        let pixels = width as usize * height as usize;
        if width == 0 || height == 0 || rgba.len() != pixels * 4 {
            return Err(ComputeError::InvalidInput(
                "RGBA crop dimensions do not match".into(),
            ));
        }
        if censored.len() != pixels {
            return Err(ComputeError::InvalidInput(
                "mask dimensions do not match the crop".into(),
            ));
        }

        let side = INPAINT_SIDE;
        let source = image::RgbaImage::from_raw(width, height, rgba.to_vec())
            .ok_or_else(|| ComputeError::InvalidInput("RGBA crop is not a valid image".into()))?;
        let mask = image::GrayImage::from_raw(width, height, censored.to_vec())
            .ok_or_else(|| ComputeError::InvalidInput("mask is not a valid image".into()))?;
        // Nearest for both, as upstream does: the mask must stay a hard 0/1 after
        // resizing, and interpolating it would smear the boundary into values that
        // are neither known nor unknown.
        let small =
            image::imageops::resize(&source, side, side, image::imageops::FilterType::Nearest);
        let small_mask =
            image::imageops::resize(&mask, side, side, image::imageops::FilterType::Nearest);

        let small_pixels = (side * side) as usize;
        let mut rgb = Vec::with_capacity(small_pixels * 3);
        for pixel in small.pixels() {
            rgb.extend_from_slice(&[pixel[0], pixel[1], pixel[2]]);
        }
        let censored_small = small_mask.into_raw();

        let shape = vec![1_i64, i64::from(side), i64::from(side), 3];
        let image_values = image_tensor(&rgb, &censored_small, self.kind);
        let image_input = ort::value::Tensor::from_array((shape.clone(), image_values.clone()))
            .map_err(|error| {
                ComputeError::InvalidInput(format!("inpainting input failed: {error}"))
            })?;
        // The graph takes the image twice: once as the generator's input and once as
        // the source of the pixels it composites back unchanged.
        let image_again =
            ort::value::Tensor::from_array((shape.clone(), image_values)).map_err(|error| {
                ComputeError::InvalidInput(format!("inpainting input failed: {error}"))
            })?;
        let mask_input = ort::value::Tensor::from_array((shape, known_tensor(&censored_small)))
            .map_err(|error| {
                ComputeError::InvalidInput(format!("inpainting mask failed: {error}"))
            })?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| ComputeError::InvalidInput("inpainting session lock poisoned".into()))?;
        let outputs = session
            .run(ort::inputs![
                IMAGE_INPUT => image_input,
                IMAGE_INPUT_AGAIN => image_again,
                MASK_INPUT => mask_input,
            ])
            .map_err(|error| {
                ComputeError::InvalidInput(format!("inpainting run failed: {error}"))
            })?;
        let (out_shape, values) = outputs[OUTPUT]
            .try_extract_tensor::<f32>()
            .map_err(|error| {
                ComputeError::InvalidInput(format!("inpainting output failed: {error}"))
            })?;
        let expected = [1_i64, i64::from(side), i64::from(side), 3];
        if out_shape.as_ref() != expected {
            return Err(ComputeError::InvalidManifest(format!(
                "inpainting output shape {out_shape:?} is not {expected:?}"
            )));
        }

        if values.iter().any(|value| !value.is_finite()) {
            return Err(ComputeError::InvalidInput(
                "inpainting returned non-finite pixels".into(),
            ));
        }
        let bytes = denormalise(values);
        let mut filled = image::RgbaImage::new(side, side);
        for (index, pixel) in filled.pixels_mut().enumerate() {
            *pixel = image::Rgba([
                bytes[index * 3],
                bytes[index * 3 + 1],
                bytes[index * 3 + 2],
                255,
            ]);
        }
        // Bicubic on the way back out, nearest on the way in: the same asymmetry
        // upstream has, and the right one — a synthesised patch should not come back
        // blocky, while a mask must not be interpolated at all.
        let restored = image::imageops::resize(
            &filled,
            width,
            height,
            image::imageops::FilterType::CatmullRom,
        );
        let mut patch = restored.into_raw();
        // Alpha is the page's, never the model's.
        for index in 0..pixels {
            patch[index * 4 + 3] = rgba[index * 4 + 3];
        }
        Ok(patch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mask_tensor_marks_known_pixels_not_censored_ones() {
        // The inversion is the single easiest thing to get backwards here, and
        // getting it backwards regenerates the artwork and preserves the censor.
        let known = known_tensor(&[0, 1]);
        assert_eq!(known, vec![1.0, 1.0, 1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn a_bar_blanks_its_censored_pixels_and_a_mosaic_keeps_them() {
        // Two pixels: white, then mid grey which is the censored one.
        let rgb = [255, 255, 255, 128, 128, 128];
        let censored = [0, 1];

        let bar = image_tensor(&rgb, &censored, CensorKind::Bar);
        assert_eq!(&bar[0..3], &[1.0, 1.0, 1.0], "a known white pixel is +1");
        assert_eq!(
            &bar[3..6],
            &[-1.0, -1.0, -1.0],
            "a bar's own colour must not be context"
        );

        let mosaic = image_tensor(&rgb, &censored, CensorKind::Mosaic);
        assert!(
            (mosaic[3] - (128.0 / 255.0 * 2.0 - 1.0)).abs() < 1e-6,
            "a mosaic still carries colour"
        );
    }

    #[test]
    fn denormalising_clamps_and_drops_non_finite_values() {
        // The graph clips its own output, but a NaN cast straight to u8 is a bright
        // speckle in the middle of a page.
        assert_eq!(denormalise(&[-1.0, 0.0, 1.0]), vec![0, 128, 255]);
        assert_eq!(
            denormalise(&[-3.0, 3.0, f32::NAN, f32::INFINITY]),
            vec![0, 255, 0, 0]
        );
    }

    /// The real model, when it is on this machine.
    ///
    /// Every other test here checks my assumptions against themselves. This is the
    /// only one that checks them against the graph: the mask convention, the
    /// `[-1, 1]` range and the three-input shape would all pass the unit tests while
    /// producing garbage. It leans on a property of the export — known pixels are
    /// composited straight through from the second image input — so an inverted mask
    /// fails it loudly rather than quietly returning a plausible-looking page.
    ///
    /// `docs/` is gitignored, so the file is absent on a fresh clone and the test
    /// skips rather than failing for the wrong reason. The path is relative to this
    /// crate's manifest (`src-tauri/crates/compute-core`), not the host's.
    #[test]
    fn the_real_model_fills_the_censored_area_and_leaves_the_rest_alone() {
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../../docs/Aletheia-Lens/_internal/models/deepcreampy/bar.onnx",
        );
        if !model.exists() {
            eprintln!("skipping: {} is not present", model.display());
            return;
        }
        let engine = match InpaintEngine::open(&model, CensorKind::Bar) {
            Ok(engine) => engine,
            Err(error) => panic!("opening the inpainting model failed: {error:?}"),
        };

        // Exactly the graph's input side, so nothing is resampled and a preserved
        // pixel can be compared byte for byte.
        let side = INPAINT_SIDE;
        let mut rgba = Vec::with_capacity((side * side * 4) as usize);
        for y in 0..side {
            for x in 0..side {
                rgba.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 96, 200]);
            }
        }
        // A square of censoring in the middle, nowhere near the edges.
        let mut censored = vec![0_u8; (side * side) as usize];
        for y in 96..160 {
            for x in 96..160 {
                censored[(y * side + x) as usize] = 1;
            }
        }

        let patch = match engine.inpaint(&rgba, side, side, &censored) {
            Ok(patch) => patch,
            Err(error) => panic!("running the inpainting model failed: {error:?}"),
        };
        assert_eq!(patch.len(), rgba.len());
        assert!(
            patch.chunks_exact(4).all(|pixel| pixel[3] == 200),
            "alpha must be the page's"
        );

        // Known pixels are composited straight through, so only the [-1, 1] byte
        // round trip may move them.
        let mut worst_known = 0_i32;
        let mut changed_censored = 0;
        for index in 0..(side * side) as usize {
            let difference = (0..3)
                .map(|channel| {
                    (i32::from(patch[index * 4 + channel]) - i32::from(rgba[index * 4 + channel]))
                        .abs()
                })
                .max()
                .unwrap_or(0);
            if censored[index] == 0 {
                worst_known = worst_known.max(difference);
            } else if difference > 8 {
                changed_censored += 1;
            }
        }
        assert!(
            worst_known <= 2,
            "a known pixel moved by {worst_known}: the mask is inverted or the range is wrong"
        );
        assert!(
            changed_censored > 1_000,
            "only {changed_censored} censored pixels changed: the model filled nothing",
        );
    }

    #[test]
    fn the_probe_input_is_a_gradient_with_a_censored_centre() {
        let (rgba, censored) = probe_crop();
        let side = INPAINT_SIDE as usize;
        assert_eq!(rgba.len(), side * side * 4);
        assert_eq!(censored.len(), side * side);

        // 梯度：左右、上下都不一样。常数图是个陷阱——卷积的边界条件在常数上不可见，
        // 于是「算错了」和「算对了」差不出一个读数，探针会形同虚设。
        // 横的是红、竖的是绿，所以两条方向要各读各的通道：只读红的话「竖着是不是
        // 真的在变」根本看不出来（这正是我第一版断言的错）。
        let red = |x: usize, y: usize| rgba[(y * side + x) * 4];
        let green = |x: usize, y: usize| rgba[(y * side + x) * 4 + 1];
        assert_eq!(red(0, 0), 0);
        assert_eq!(red(side - 1, 0), 255, "右边该比左边亮到顶");
        assert!(red(side - 1, 0) > red(side / 2, 0));
        assert_eq!(green(0, 0), 0);
        assert_eq!(green(0, side - 1), 255, "下边该比上边亮到顶");
        assert!(green(0, side - 1) > green(0, side / 2));

        // 被遮的必须是正中那四分之一，而且一个贴边像素都不许有：生产里交给模型的
        // 窗口永远是 `inpaint_window` 提回页内的那一个，贴边的遮罩会让探针走的
        // 边界条件与那条路不是同一件事。
        assert_eq!(censored[(side / 2) * side + side / 2], 1);
        assert_eq!(censored[0], 0);
        assert_eq!(censored[side - 1], 0);
        assert_eq!(
            censored.iter().filter(|flag| **flag != 0).count(),
            (side / 2) * (side / 2),
            "被遮的面积变了：换一块遮罩就是换了一个问题"
        );
    }

    #[test]
    fn the_cpu_reference_is_never_probed_and_costs_nothing() {
        // 连文件都不必有：CPU 就是参照实现，问它「算得对不对」是自问自答，而每一次
        // 自问自答都会在账上加一次「真开过会话」。
        let missing = Path::new("no-such-inpaint-model.onnx");
        let before = probe::probes_opened();
        let verdict = validate_runtime_cached(missing, CensorKind::Bar, RuntimeId::Cpu);
        assert_eq!(verdict, ValidationVerdict::Passed);
        assert_eq!(probe::probes_opened(), before, "参照实现不该被探针计数");
    }

    #[test]
    fn a_model_that_cannot_be_opened_is_a_failure_and_never_a_pass() {
        // 「打不开」与「算得对」是两件事，这条钉住前者不会滑成后者——一个永远通过的
        // 探针比没有探针更糟，因为它会替一份跑不动的图背书。用两条真实的硬件运行库
        // 去开一份不存在的文件：无论这台机器有没有显卡，会话都开不起来。
        let missing = Path::new("no-such-inpaint-model.onnx");
        for runtime in [RuntimeId::DirectMl, RuntimeId::Nnapi] {
            match validate_runtime(missing, CensorKind::Bar, runtime) {
                ValidationVerdict::Failed { .. } => {}
                other => panic!("{runtime:?} 开不起来的模型给的是 {other:?}"),
            }
        }
    }

    /// 有显卡可问时：修补图的实测结论真的来自一次真跑，而且第二问不再开会话。
    ///
    /// 结论是「过」还是「不过」由探针自己跟 CPU 参照比出来，这条测试**不**假定哪一个
    /// ——它钉的是「结论来自实测、并且被复用」。要真的硬件运行库：不带 `directml` 的
    /// 构建里它编译不进来（也就没证据）。
    #[cfg(all(windows, feature = "directml"))]
    #[test]
    fn a_probed_inpaint_model_remembers_its_verdict_and_does_not_open_a_second_session() {
        let _guard = probe::test_lock();
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../../docs/Aletheia-Lens/_internal/models/deepcreampy/bar.onnx",
        );
        if !model.is_file() {
            eprintln!("skipping: {} is not present", model.display());
            return;
        }
        let Some(runtime) = available_runtimes()
            .into_iter()
            .find(|runtime| runtime.is_hardware_accelerated())
        else {
            eprintln!("skipping: 这份构建没有硬件运行库");
            return;
        };
        probe::forget_all();
        let before = probe::probes_opened();
        let first = validate_runtime_cached(&model, CensorKind::Bar, runtime);
        let after_first = probe::probes_opened();
        eprintln!(
            "修补图 bar.onnx 在 {runtime:?} 上的实测结论 = {first:?}（真开了 {} 次会话）",
            after_first - before
        );
        assert!(after_first > before, "第一问必须真的探过，不然这条测试什么都没证明");

        let second = validate_runtime_cached(&model, CensorKind::Bar, runtime);
        assert_eq!(second, first, "同一个问题必须给同一个结论");
        assert_eq!(probe::probes_opened(), after_first, "同一份字节问第二遍不该再开会话");

        // 同一个指纹、同样两条参数，只把「哪一类问题」换掉：那是另一个问题，不许命中
        // 超分那条记账（反之亦然——两类的输入张量形状根本不是一回事）。
        let (byte_length, content_hash) = file_fingerprint(&model).expect("fingerprint");
        let upscale_shaped = ProbeKey {
            content_hash,
            byte_length,
            kind: ProbeKind::Upscale,
            runtime,
            scale: 1,
            min_input_edge: INPAINT_SIDE,
        };
        assert!(
            probe::recall(&upscale_shaped).is_none(),
            "两类探针共用了一条记账"
        );
        probe::forget_all();
    }
}
