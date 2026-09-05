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
}

impl OnnxEngine {
    /// Opens `model_path`, which must be the `.onnx` file itself.
    ///
    /// `scale` comes from the installed model's manifest rather than from the
    /// graph: an ONNX output shape is usually dynamic, so the file cannot be
    /// asked how much bigger it makes things.
    pub fn open(model_path: &Path, scale: u32, max_pixels: usize) -> Result<Self, InferenceError> {
        if scale == 0 {
            return Err(InferenceError::InvalidManifest("model scale must be at least 1".into()));
        }
        let session = ort::session::Session::builder()
            .and_then(|mut builder| builder.commit_from_file(model_path))
            .map_err(|error| InferenceError::InvalidInput(format!("ONNX session failed: {error}")))?;
        Ok(Self { session: Mutex::new(session), scale, max_pixels })
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

/// Writes the model's NCHW float RGB output over the RGB channels of `rgba`,
/// leaving its alpha alone.
fn nchw_over_rgba(planar: &[f32], rgba: &mut [u8]) {
    let pixels = rgba.len() / 4;
    for channel in 0..3 {
        let plane = &planar[channel * pixels..(channel + 1) * pixels];
        for (index, value) in plane.iter().enumerate() {
            // Models can and do overshoot the nominal [0, 1] range at edges.
            rgba[index * 4 + channel] = (value * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
}

impl UpscaleEngine for OnnxEngine {
    fn scale(&self) -> u32 {
        self.scale
    }

    fn upscale_tile(&self, rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, InferenceError> {
        if rgba.len() != width as usize * height as usize * 4 {
            return Err(InferenceError::InvalidInput("RGBA tile dimensions do not match".into()));
        }
        // The nearest-neighbour result is both the alpha carrier and the shape
        // the caller expects back, so a model that answers with the wrong size
        // cannot produce a mismatched buffer.
        let mut output = cpu_scale_rgba(rgba, width, height, self.scale, self.max_pixels)?.rgba;

        let input = ort::value::Tensor::from_array((
            vec![1_i64, 3, i64::from(height), i64::from(width)],
            rgba_to_nchw(rgba, width, height),
        ))
        .map_err(|error| InferenceError::InvalidInput(format!("ONNX input failed: {error}")))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| InferenceError::InvalidInput("ONNX session lock poisoned".into()))?;
        let outputs = session
            .run(ort::inputs![input])
            .map_err(|error| InferenceError::InvalidInput(format!("ONNX run failed: {error}")))?;
        let (shape, values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| InferenceError::InvalidInput(format!("ONNX output failed: {error}")))?;

        let expected = [
            1_i64,
            3,
            i64::from(height) * i64::from(self.scale),
            i64::from(width) * i64::from(self.scale),
        ];
        if shape.as_ref() != expected {
            // Almost always a manifest whose `scale` does not match the model.
            return Err(InferenceError::InvalidManifest(format!(
                "ONNX output shape {shape:?} does not match the declared x{} scale",
                self.scale
            )));
        }
        nchw_over_rgba(values, &mut output);
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
        assert_eq!(planar, vec![10.0 / 255.0, 200.0 / 255.0, 20.0 / 255.0, 210.0 / 255.0, 30.0 / 255.0, 220.0 / 255.0]);

        let mut restored = vec![0, 0, 0, 40, 0, 0, 0, 230];
        nchw_over_rgba(&planar, &mut restored);
        assert_eq!(restored, rgba, "alpha must survive a round trip the model cannot see");
    }

    #[test]
    fn out_of_range_model_output_is_clamped_not_wrapped() {
        // Super-resolution models overshoot at high-contrast edges. Casting a
        // negative or >1 float straight to u8 wraps around and speckles the page.
        let planar = vec![-0.4_f32, 1.6, 0.5, 0.5, 0.5, 0.5];
        let mut rgba = vec![0, 0, 0, 255, 0, 0, 0, 255];
        nchw_over_rgba(&planar, &mut rgba);
        assert_eq!(rgba[0], 0);
        assert_eq!(rgba[4], 255);
    }

    #[test]
    fn a_zero_scale_manifest_is_rejected_before_the_model_is_opened() {
        let error = match OnnxEngine::open(Path::new("does-not-exist.onnx"), 0, 1_000) {
            Ok(_) => panic!("a zero scale must not open a session"),
            Err(error) => error,
        };
        assert!(matches!(error, InferenceError::InvalidManifest(_)));
    }
}
