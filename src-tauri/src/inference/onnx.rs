//! ONNX Runtime backing for the upscaler.
//!
//! The tiling pipeline in `upscale.rs` already handles cropping, padding,
//! reassembly and the pixel budget; this is only the part that puts one tile
//! through a model. Super-resolution models take NCHW float RGB in [0, 1] and
//! have no notion of an alpha channel, so alpha is carried across separately by
//! the same nearest-neighbour scaler that stands in when no model is installed.

use std::path::Path;
use std::sync::Mutex;

use super::upscale::UpscaleEngine;
use super::{cpu_scale_rgba, InferenceError};

/// A loaded ONNX super-resolution model.
///
/// `Session::run` needs `&mut`, and `UpscaleEngine::upscale_tile` takes `&self`
/// because the pipeline holds the engine for the whole image — hence the mutex.
/// It is uncontended in practice: one page is upscaled at a time.
pub struct OnnxEngine {
    session: Mutex<ort::session::Session>,
    scale: u32,
    max_pixels: usize,
    /// Smallest edge the graph accepts, in source pixels. Real-CUGAN reflects 18
    /// px inside the graph and refuses an edge below 20, while the tiler happily
    /// hands it a 9 px strip at the right edge of a page; below this the tile is
    /// grown (edge-replicated) and the answer cropped back.
    min_input_edge: u32,
}

impl OnnxEngine {
    /// Opens `model_path`, which must be the `.onnx` file itself.
    ///
    /// `scale` comes from the installed model's manifest rather than from the
    /// graph: an ONNX output shape is usually dynamic, so the file cannot be
    /// asked how much bigger it makes things. `min_input_edge` comes from there
    /// too, for the same reason: only the manifest knows what the graph's own
    /// padding needs.
    pub fn open(
        model_path: &Path,
        scale: u32,
        max_pixels: usize,
        min_input_edge: u32,
    ) -> Result<Self, InferenceError> {
        if scale == 0 {
            return Err(InferenceError::InvalidManifest(
                "model scale must be at least 1".into(),
            ));
        }
        let session = ort::session::Session::builder()
            .and_then(|mut builder| builder.commit_from_file(model_path))
            .map_err(|error| {
                InferenceError::InvalidInput(format!("ONNX session failed: {error}"))
            })?;
        Ok(Self {
            session: Mutex::new(session),
            scale,
            max_pixels,
            min_input_edge: min_input_edge.max(1),
        })
    }
}

/// RGBA bytes to the NCHW float RGB layout every super-resolution model expects.
fn rgba_to_nchw(rgba: &[u8], width: u32, height: u32) -> Vec<f32> {
    let pixels = width as usize * height as usize;
    let mut planar = vec![0_f32; pixels * 3];
    for channel in 0..3 {
        let plane = &mut planar[channel * pixels..(channel + 1) * pixels];
        for (index, slot) in plane.iter_mut().enumerate() {
            *slot = f32::from(rgba[index * 4 + channel]) / 255.0;
        }
    }
    planar
}

/// Grows an RGBA tile to `width`×`height` by repeating its last row/column.
///
/// Replication rather than reflection: this is a size floor, not a border
/// treatment, and the model does its own reflect padding once the tile is big
/// enough. Replication is also the only mode that works for a one-pixel edge.
fn pad_rgba_edges(
    rgba: &[u8],
    from_width: u32,
    from_height: u32,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height {
        let source_y = y.min(from_height - 1);
        for x in 0..width {
            let source_x = x.min(from_width - 1);
            let index = ((source_y * from_width + source_x) as usize) * 4;
            out.extend_from_slice(&rgba[index..index + 4]);
        }
    }
    out
}

/// Writes the model's NCHW float RGB output over the RGB channels of `rgba`,
/// leaving its alpha alone.
///
/// The plane's own width and height come separately from the destination's: when
/// the engine had to grow the input, the model answers for the grown tile and
/// only the part that belongs to the original one is copied.
fn nchw_over_rgba(
    planar: &[f32],
    plane_width: usize,
    plane_height: usize,
    width: usize,
    height: usize,
    rgba: &mut [u8],
) {
    let plane = plane_width * plane_height;
    for channel in 0..3 {
        let values = &planar[channel * plane..(channel + 1) * plane];
        for row in 0..height {
            for column in 0..width {
                // Models can and do overshoot the nominal [0, 1] range at edges.
                let value = values[row * plane_width + column];
                rgba[(row * width + column) * 4 + channel] =
                    (value * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

impl UpscaleEngine for OnnxEngine {
    fn scale(&self) -> u32 {
        self.scale
    }

    fn upscale_tile(
        &self,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, InferenceError> {
        if rgba.len() != width as usize * height as usize * 4 {
            return Err(InferenceError::InvalidInput(
                "RGBA tile dimensions do not match".into(),
            ));
        }
        // The nearest-neighbour result is both the alpha carrier and the shape
        // the caller expects back, so a model that answers with the wrong size
        // cannot produce a mismatched buffer.
        let mut output = cpu_scale_rgba(rgba, width, height, self.scale, self.max_pixels)?.rgba;

        let (input_width, input_height) = (
            width.max(self.min_input_edge),
            height.max(self.min_input_edge),
        );
        let grown;
        let source = if (input_width, input_height) == (width, height) {
            rgba
        } else {
            grown = pad_rgba_edges(rgba, width, height, input_width, input_height);
            &grown[..]
        };

        let input = ort::value::Tensor::from_array((
            vec![
                1_i64,
                3,
                i64::from(input_height),
                i64::from(input_width),
            ],
            rgba_to_nchw(source, input_width, input_height),
        ))
        .map_err(|error| InferenceError::InvalidInput(format!("ONNX input failed: {error}")))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| InferenceError::InvalidInput("ONNX session lock poisoned".into()))?;
        let outputs = session
            .run(ort::inputs![input])
            .map_err(|error| InferenceError::InvalidInput(format!("ONNX run failed: {error}")))?;
        let (shape, values) = outputs[0].try_extract_tensor::<f32>().map_err(|error| {
            InferenceError::InvalidInput(format!("ONNX output failed: {error}"))
        })?;

        let expected = [
            1_i64,
            3,
            i64::from(input_height) * i64::from(self.scale),
            i64::from(input_width) * i64::from(self.scale),
        ];
        if shape.as_ref() != expected {
            // Almost always a manifest whose `scale` does not match the model, or
            // a graph that does not preserve the size it was handed.
            return Err(InferenceError::InvalidManifest(format!(
                "ONNX output shape {shape:?} does not match the declared x{} scale",
                self.scale
            )));
        }
        nchw_over_rgba(
            values,
            (input_width * self.scale) as usize,
            (input_height * self.scale) as usize,
            (width * self.scale) as usize,
            (height * self.scale) as usize,
            &mut output,
        );
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_round_trips_through_the_planar_layout() {
        // One pixel per channel plus an alpha the model never sees.
        let rgba = vec![10, 20, 30, 40, 200, 210, 220, 230];
        let planar = rgba_to_nchw(&rgba, 2, 1);
        // Planar means all reds, then all greens, then all blues.
        assert_eq!(
            planar,
            vec![
                10.0 / 255.0,
                200.0 / 255.0,
                20.0 / 255.0,
                210.0 / 255.0,
                30.0 / 255.0,
                220.0 / 255.0
            ]
        );

        let mut restored = vec![0, 0, 0, 40, 0, 0, 0, 230];
        nchw_over_rgba(&planar, 2, 1, 2, 1, &mut restored);
        assert_eq!(
            restored, rgba,
            "alpha must survive a round trip the model cannot see"
        );
    }

    #[test]
    fn a_grown_plane_is_cropped_to_the_tile_that_asked_for_it() {
        // The model answered for a 2x2 input (the engine grew a 1x1 tile); only
        // the top-left pixel belongs in the buffer. Reading the planes with the
        // destination's width instead of the plane's own would pull the wrong
        // channel out — 0.5 instead of 0.1 in red.
        let planar = vec![
            0.1_f32, 0.2, 0.3, 0.4, // red
            0.5, 0.6, 0.7, 0.8, // green
            0.9, 1.0, 0.0, 0.0, // blue
        ];
        let mut rgba = vec![0, 0, 0, 255];
        nchw_over_rgba(&planar, 2, 2, 1, 1, &mut rgba);
        assert_eq!(
            rgba,
            vec![
                (0.1_f32 * 255.0).round() as u8,
                (0.5_f32 * 255.0).round() as u8,
                (0.9_f32 * 255.0).round() as u8,
                255,
            ]
        );
    }

    #[test]
    fn padding_a_tile_repeats_its_last_row_and_column() {
        // 2x2 with distinct corners, grown to 3x3.
        let rgba = vec![
            1, 1, 1, 9, 2, 2, 2, 9, //
            3, 3, 3, 9, 4, 4, 4, 9,
        ];
        let padded = pad_rgba_edges(&rgba, 2, 2, 3, 3);
        let pixel = |x: usize, y: usize| padded[(y * 3 + x) * 4];
        assert_eq!((pixel(0, 0), pixel(1, 0), pixel(2, 0)), (1, 2, 2));
        assert_eq!((pixel(0, 1), pixel(1, 1), pixel(2, 1)), (3, 4, 4));
        assert_eq!((pixel(0, 2), pixel(1, 2), pixel(2, 2)), (3, 4, 4));
    }

    #[test]
    fn out_of_range_model_output_is_clamped_not_wrapped() {
        // Super-resolution models overshoot at high-contrast edges. Casting a
        // negative or >1 float straight to u8 wraps around and speckles the page.
        let planar = vec![-0.4_f32, 1.6, 0.5, 0.5, 0.5, 0.5];
        let mut rgba = vec![0, 0, 0, 255, 0, 0, 0, 255];
        nchw_over_rgba(&planar, 2, 1, 2, 1, &mut rgba);
        assert_eq!(rgba[0], 0);
        assert_eq!(rgba[4], 255);
    }

    #[test]
    fn a_zero_scale_manifest_is_rejected_before_the_model_is_opened() {
        let error = match OnnxEngine::open(Path::new("does-not-exist.onnx"), 0, 1_000, 1) {
            Ok(_) => panic!("a zero scale must not open a session"),
            Err(error) => error,
        };
        assert!(matches!(error, InferenceError::InvalidManifest(_)));
    }

    /// A gradient tile whose red rises left to right and green top to bottom, both
    /// spanning the full range so a wrap-around or a channel swap is visible.
    fn gradient_rgba(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let red = (x * 255 / (width - 1).max(1)) as u8;
                let green = (y * 255 / (height - 1).max(1)) as u8;
                rgba.extend_from_slice(&[red, green, 128, 200]);
            }
        }
        rgba
    }

    /// One hosted model, run for real: size, channel order and alpha are all
    /// checked, so a bad export cannot reach the release.
    ///
    /// 本文件其它测试都是在验证我自己的布局假设自洽；这一组是唯一能证明这些假设与
    /// 真实的图一致的检查——一个转置的、或 channels-last 的模型能通过其它所有测试，
    /// 却输出垃圾。
    fn assert_model_upscales(model: &std::path::Path, scale: u32, min_input_edge: u32) {
        let engine = match OnnxEngine::open(model, scale, 64_000_000, min_input_edge) {
            Ok(engine) => engine,
            Err(error) => panic!("opening {} failed: {error:?}", model.display()),
        };
        let (width, height) = (72_u32, 64_u32);
        let rgba = gradient_rgba(width, height);

        let output = match engine.upscale_tile(&rgba, width, height) {
            Ok(output) => output,
            Err(error) => panic!("running {} failed: {error:?}", model.display()),
        };
        assert_eq!(
            output.len(),
            (width * scale * height * scale * 4) as usize,
            "{} returned the wrong size",
            model.display()
        );
        // Alpha is carried by the fallback scaler, not the model.
        assert!(output.chunks_exact(4).all(|pixel| pixel[3] == 200));
        // The model must have written something other than the nearest-neighbour
        // input it was handed; identical output means the run was a no-op.
        let nearest = crate::inference::cpu_scale_rgba(&rgba, width, height, scale, 64_000_000)
            .expect("nearest-neighbour reference")
            .rgba;
        assert_ne!(
            output, nearest,
            "{} matched plain upscaling exactly",
            model.display()
        );
        // Red still rises left to right in the enlarged tile, so the channels did
        // not come back permuted.
        let stride = (width * scale) as usize * 4;
        let row = (height * scale / 2) as usize * stride;
        assert!(
            output[row] < output[row + stride - 4],
            "{} no longer increases along x",
            model.display()
        );
    }

    /// The hosted models, as the published catalog declares them, run for real.
    /// Scale and the minimum tile edge are read from the catalog fixture rather
    /// than repeated here: the file the app downloads against is the file this
    /// test trusts. The fixtures are the very bytes uploaded to the model
    /// repository, kept out of git under `docs/models/` — the loop skips them when
    /// they are absent (CI has no 100 MB of ONNX), so locally is where this test
    /// earns its keep.
    #[test]
    fn the_hosted_upscale_models_upscale_a_tile() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/models");
        let Ok(bytes) = std::fs::read(directory.join("upscale-manifest.json")) else {
            eprintln!("skipping: no catalog fixture");
            return;
        };
        let catalog: crate::model_release::UpscaleCatalog =
            serde_json::from_slice(&bytes).expect("catalog fixture is valid JSON");
        for id in crate::model_release::HOSTED_UPSCALE_MODEL_IDS {
            let hosted = catalog
                .models
                .iter()
                .find(|model| model.id == *id)
                .unwrap_or_else(|| panic!("{id} is no longer in the published catalog"));
            let model = directory.join(format!("{id}.onnx"));
            if !model.exists() {
                eprintln!("skipping: {} is not present", model.display());
                continue;
            }
            assert_model_upscales(&model, hosted.scale, hosted.min_input_edge.unwrap_or(1));
        }
    }

    /// A tile thinner than the graph's floor is grown and cropped, not refused.
    /// The tiler really does hand out 9 px strips at a page's right edge, and
    /// Real-CUGAN's 18 px reflect padding cannot run on one.
    #[test]
    fn a_tile_below_the_models_floor_is_grown_and_cropped() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/models");
        let model = directory.join("realcugan-2x-conservative.onnx");
        if !model.exists() {
            eprintln!("skipping: {} is not present", model.display());
            return;
        }
        let floor = 20;
        let engine = OnnxEngine::open(&model, 2, 64_000_000, floor).expect("engine");
        // Without the floor this exact call is what a page edge produces today:
        // ONNX Runtime answers "Pad reflect: pre-pad (18) exceeds maximum allowed
        // (7)". The engine has to absorb it and still answer 2x.
        for (width, height) in [(9_u32, 9_u32), (9, 64), (64, 9), (3, 3)] {
            let rgba = gradient_rgba(width, height);
            let output = engine
                .upscale_tile(&rgba, width, height)
                .unwrap_or_else(|error| panic!("{width}x{height} tile: {error:?}"));
            assert_eq!(output.len(), (width * 2 * height * 2 * 4) as usize, "{width}x{height}");
            assert!(output.chunks_exact(4).all(|pixel| pixel[3] == 200));
        }
        // And with no floor declared, the same strip is left exactly as it was:
        // the growth is what makes the model usable, not something the model does.
        let unpadded = OnnxEngine::open(&model, 2, 64_000_000, 1).expect("engine");
        assert!(unpadded.upscale_tile(&gradient_rgba(9, 9), 9, 9).is_err());
    }

    /// The whole tiling pipeline over a page whose width leaves a strip the model
    /// cannot take on its own. 129 px at tile 128 / margin 8 leaves 9 px in the
    /// last column, which is where a Real-CUGAN page would fail to render before
    /// the engine grew it.
    #[test]
    fn a_page_whose_edge_strip_is_too_thin_still_upscales() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/models");
        let model = directory.join("realcugan-2x-conservative.onnx");
        if !model.exists() {
            eprintln!("skipping: {} is not present", model.display());
            return;
        }
        let (width, height) = (129_u32, 137_u32);
        let planned = crate::inference::upscale::plan_tiles(
            width,
            height,
            crate::inference::upscale::DEFAULT_TILE_SIZE,
            crate::inference::upscale::DEFAULT_TILE_PADDING,
        );
        assert!(
            planned
                .iter()
                .any(|tile| tile.padded_width < 20 || tile.padded_height < 20),
            "this page no longer plans a thin strip, so the test proves nothing"
        );

        let engine = OnnxEngine::open(&model, 2, 64_000_000, 20).expect("engine");
        let rgba = gradient_rgba(width, height);
        let options = crate::inference::upscale::UpscaleOptions {
            max_pixels: 64_000_000,
            ..crate::inference::upscale::UpscaleOptions::default()
        };
        let started = std::time::Instant::now();
        let upscaled =
            crate::inference::upscale::upscale_rgba(&engine, &rgba, width, height, options)
                .expect("upscale a whole page");
        eprintln!(
            "129x137 through {} tiles in {:?}",
            upscaled.tiles,
            started.elapsed()
        );
        assert_eq!((upscaled.width, upscaled.height), (258, 274));
        assert!(upscaled.rgba.chunks_exact(4).all(|pixel| pixel[3] == 200));
        // The page really was upscaled, not passed through.
        let nearest = crate::inference::cpu_scale_rgba(&rgba, width, height, 2, 64_000_000)
            .expect("nearest")
            .rgba;
        assert_ne!(upscaled.rgba, nearest);
    }
}
