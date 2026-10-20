//! Content-addressed Android Vulkan variants of the shipped ONNX models.
//! Never select a different model merely because its display name matches.
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub onnx_sha256: String,
    pub param_sha256: String,
    pub weights_sha256: String,
    pub edge: u32,
    pub scale: u32,
}
pub fn models() -> Vec<Model> {
    serde_json::from_str(include_str!("../resources/ncnn/models.json"))
        .expect("embedded model manifest")
}
pub fn matching_model(digest: &str, scale: u32) -> Option<Model> {
    models()
        .into_iter()
        .find(|m| m.onnx_sha256 == digest && m.scale == scale)
}
#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn variants_match_exact_weights_and_scale_only() {
        let m = &models()[0];
        assert!(matching_model(&m.onnx_sha256, 2).is_some());
        assert!(matching_model(&m.onnx_sha256, 4).is_none());
        assert!(matching_model(&"0".repeat(64), 2).is_none());
    }
    #[test]
    fn converted_assets_are_verified() {
        for m in models() {
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/ncnn");
            assert_eq!(
                format!(
                    "{:x}",
                    Sha256::digest(std::fs::read(dir.join(format!("{}.param", m.id))).unwrap())
                ),
                m.param_sha256
            );
            assert_eq!(
                format!(
                    "{:x}",
                    Sha256::digest(std::fs::read(dir.join(format!("{}.bin", m.id))).unwrap())
                ),
                m.weights_sha256
            );
        }
    }
}

pub const ENGINE_ID: &str = "ncnn-vulkan";
pub const VERSION: &str = "ncnn-20260113-rgb128-v1";

#[cfg(all(target_os = "android", feature = "ncnn-vulkan"))]
mod native {
    use super::*;
    use crate::tensor::{nchw_over_rgba, pad_rgba_edges, preserve_neutral_chroma, rgba_to_nchw};
    use crate::{error::ComputeError, upscale::UpscaleEngine};
    use sha2::{Digest, Sha256};
    use std::io::Read;
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        path::Path,
        sync::Mutex,
    };
    unsafe extern "C" {
        fn yomika_ncnn_error() -> *const c_char;
        fn yomika_ncnn_device() -> *const c_char;
        fn yomika_ncnn_open(param: *const c_char, weights: *const u8) -> *mut c_void;
        fn yomika_ncnn_run(handle: *mut c_void, input: *const f32, output: *mut f32) -> i32;
        fn yomika_ncnn_close(handle: *mut c_void);
    }
    struct Handle(*mut c_void);
    // The handle is owned, and every access (including destruction) is exclusive.
    unsafe impl Send for Handle {}
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { yomika_ncnn_close(self.0) }
        }
    }
    pub struct NcnnEngine {
        handle: Mutex<Handle>,
        pub device: String,
        max_pixels: usize,
    }
    fn error() -> ComputeError {
        ComputeError::InvalidInput(
            unsafe { CStr::from_ptr(yomika_ncnn_error()) }
                .to_string_lossy()
                .into_owned(),
        )
    }
    // ncnn memory-model loading requires aligned, lifetime-stable weight bytes.
    #[repr(align(16))]
    struct Aligned<const N: usize>([u8; N]);
    macro_rules! assets {
        ($name:literal) => {{
            static WEIGHTS: Aligned<
                { include_bytes!(concat!("../resources/ncnn/", $name, ".bin")).len() },
            > = Aligned(*include_bytes!(concat!(
                "../resources/ncnn/",
                $name,
                ".bin"
            )));
            (
                include_str!(concat!("../resources/ncnn/", $name, ".param")),
                &WEIGHTS.0[..],
            )
        }};
    }
    pub fn device_description() -> Option<String> {
        let device = unsafe { yomika_ncnn_device() };
        (!device.is_null()).then(|| {
            format!(
                "vulkan:{}",
                unsafe { CStr::from_ptr(device) }.to_string_lossy()
            )
        })
    }
    impl NcnnEngine {
        /// None means this exact ONNX has no verified conversion; ORT remains available.
        pub fn open(
            path: &Path,
            scale: u32,
            max_pixels: usize,
        ) -> Result<Option<Self>, ComputeError> {
            let mut file =
                std::fs::File::open(path).map_err(|e| ComputeError::InvalidInput(e.to_string()))?;
            let mut hash = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let n = file
                    .read(&mut buffer)
                    .map_err(|e| ComputeError::InvalidInput(e.to_string()))?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
            let Some(m) = matching_model(&format!("{:x}", hash.finalize()), scale) else {
                return Ok(None);
            };
            let (param, weights) = match m.id.as_str() {
                "waifu2x-upconv7" => assets!("waifu2x-upconv7"),
                "realcugan-2x-denoise3x" => assets!("realcugan-2x-denoise3x"),
                "realcugan-2x-conservative" => assets!("realcugan-2x-conservative"),
                _ => return Ok(None),
            };
            let device = device_description()
                .ok_or_else(|| ComputeError::InvalidInput("No physical Vulkan GPU".into()))?;
            let param = CString::new(param).map_err(|_| {
                ComputeError::InvalidManifest("embedded ncnn parameter contains NUL".into())
            })?;
            let handle = unsafe { yomika_ncnn_open(param.as_ptr(), weights.as_ptr()) };
            if handle.is_null() {
                return Err(error());
            }
            eprintln!("yomika: {} model={} device={}", VERSION, m.id, device);
            Ok(Some(Self {
                handle: Mutex::new(Handle(handle)),
                device,
                max_pixels,
            }))
        }
    }
    impl UpscaleEngine for NcnnEngine {
        fn scale(&self) -> u32 {
            2
        }
        fn fixed_input_size(&self) -> Option<(u32, u32)> {
            Some((128, 128))
        }
        fn upscale_tile(&self, rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, ComputeError> {
            if w == 0 || h == 0 || w > 128 || h > 128 || rgba.len() != w as usize * h as usize * 4 {
                return Err(ComputeError::InvalidInput(
                    "invalid Vulkan tile shape".into(),
                ));
            }
            let mut out = crate::cpu_scale::cpu_scale_rgba(rgba, w, h, 2, self.max_pixels)?.rgba;
            let grown = pad_rgba_edges(rgba, w, h, 128, 128);
            let input = rgba_to_nchw(&grown, 128, 128);
            let mut output = vec![0f32; 3 * 256 * 256];
            let handle = self.handle.lock().map_err(|_| ComputeError::CacheBusy)?;
            if unsafe { yomika_ncnn_run(handle.0, input.as_ptr(), output.as_mut_ptr()) } != 0 {
                return Err(error());
            }
            drop(handle);
            nchw_over_rgba(
                &output,
                256,
                256,
                (w * 2) as usize,
                (h * 2) as usize,
                &mut out,
            );
            preserve_neutral_chroma(rgba, w, h, 2, &mut out);
            Ok(out)
        }
    }
}
#[cfg(all(target_os = "android", feature = "ncnn-vulkan"))]
pub use native::{device_description, NcnnEngine};
