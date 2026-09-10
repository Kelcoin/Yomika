//! DeepCreamPy inpainting, the stage that fills a censored region.
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
//! Both models run on CPU, deliberately. Upstream pins them because they produce
//! non-finite values under CUDA 12 / cuDNN 9 — a compatibility constraint, not a
//! performance choice, so it is copied rather than reasoned away. The detector and
//! the ESRGAN stage are free to use an accelerator.

use std::path::Path;
use std::sync::Mutex;

use super::decensor::CensorKind;
use super::InferenceError;

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

impl InpaintEngine {
    pub fn open(model_path: &Path, kind: CensorKind) -> Result<Self, InferenceError> {
        let open = || -> Result<ort::session::Session, String> {
            let mut builder =
                ort::session::Session::builder().map_err(|error| error.to_string())?;
            // Pinned to CPU on purpose — see the module comment.
            builder = builder
                .with_execution_providers([ort::ep::CPU::default().build()])
                .map_err(|error| error.to_string())?;
            builder
                .commit_from_file(model_path)
                .map_err(|error| error.to_string())
        };
        let session = open().map_err(|error| {
            InferenceError::InvalidInput(format!("inpainting session failed: {error}"))
        })?;
        Ok(Self {
            session: Mutex::new(session),
            kind,
        })
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
    ) -> Result<Vec<u8>, InferenceError> {
        let pixels = width as usize * height as usize;
        if width == 0 || height == 0 || rgba.len() != pixels * 4 {
            return Err(InferenceError::InvalidInput(
                "RGBA crop dimensions do not match".into(),
            ));
        }
        if censored.len() != pixels {
            return Err(InferenceError::InvalidInput(
                "mask dimensions do not match the crop".into(),
            ));
        }

        let side = INPAINT_SIDE;
        let source = image::RgbaImage::from_raw(width, height, rgba.to_vec())
            .ok_or_else(|| InferenceError::InvalidInput("RGBA crop is not a valid image".into()))?;
        let mask = image::GrayImage::from_raw(width, height, censored.to_vec())
            .ok_or_else(|| InferenceError::InvalidInput("mask is not a valid image".into()))?;
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
                InferenceError::InvalidInput(format!("inpainting input failed: {error}"))
            })?;
        // The graph takes the image twice: once as the generator's input and once as
        // the source of the pixels it composites back unchanged.
        let image_again =
            ort::value::Tensor::from_array((shape.clone(), image_values)).map_err(|error| {
                InferenceError::InvalidInput(format!("inpainting input failed: {error}"))
            })?;
        let mask_input = ort::value::Tensor::from_array((shape, known_tensor(&censored_small)))
            .map_err(|error| {
                InferenceError::InvalidInput(format!("inpainting mask failed: {error}"))
            })?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| InferenceError::InvalidInput("inpainting session lock poisoned".into()))?;
        let outputs = session
            .run(ort::inputs![
                IMAGE_INPUT => image_input,
                IMAGE_INPUT_AGAIN => image_again,
                MASK_INPUT => mask_input,
            ])
            .map_err(|error| {
                InferenceError::InvalidInput(format!("inpainting run failed: {error}"))
            })?;
        let (out_shape, values) = outputs[OUTPUT]
            .try_extract_tensor::<f32>()
            .map_err(|error| {
                InferenceError::InvalidInput(format!("inpainting output failed: {error}"))
            })?;
        let expected = [1_i64, i64::from(side), i64::from(side), 3];
        if out_shape.as_ref() != expected {
            return Err(InferenceError::InvalidManifest(format!(
                "inpainting output shape {out_shape:?} is not {expected:?}"
            )));
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
    /// skips rather than failing for the wrong reason.
    #[test]
    fn the_real_model_fills_the_censored_area_and_leaves_the_rest_alone() {
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/Aletheia-Lens/_internal/models/deepcreampy/bar.onnx");
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
}
