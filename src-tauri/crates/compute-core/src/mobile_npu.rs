//! LiteRT compiles verified NHWC companions on the device (Qualcomm / MediaTek).
//! Compiled files are private to the model, runtime, device build and shape.
use crate::{
    error::ComputeError,
    tensor::{nchw_over_rgba, pad_rgba_edges},
    upscale::UpscaleEngine,
};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::Path,
    sync::Mutex,
};

pub const ENGINE_ID: &str = "litert-npu";
pub const VERSION: &str = "litert-2.3.2-qnn2.51-nhwc256-v2";
unsafe extern "C" {
    fn yomika_litert_open(
        model: *const c_char,
        cache: *const c_char,
        libraries: *const c_char,
        scale: i32,
        cpu_test: bool,
    ) -> *mut c_void;
    fn yomika_litert_run(handle: *mut c_void, input: *const f32, output: *mut f32) -> i32;
    fn yomika_litert_close(handle: *mut c_void);
    fn yomika_litert_error() -> *const c_char;
    fn yomika_native_directory() -> *const c_char;
    fn yomika_npu_vendor() -> *const c_char;
    fn yomika_device_fingerprint() -> *const c_char;
}
struct Handle(*mut c_void);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { yomika_litert_close(self.0) }
    }
}
pub struct NpuEngine {
    handle: Mutex<Handle>,
    scale: u32,
    max_pixels: usize,
}
fn error() -> ComputeError {
    ComputeError::InvalidInput(
        unsafe { CStr::from_ptr(yomika_litert_error()) }
            .to_string_lossy()
            .into_owned(),
    )
}
fn cpath(path: &Path) -> Result<CString, ComputeError> {
    CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| ComputeError::InvalidInput("invalid NPU path".into()))
}
impl NpuEngine {
    pub fn open(path: &Path, scale: u32, max_pixels: usize) -> Result<Self, ComputeError> {
        let vendor = unsafe { CStr::from_ptr(yomika_npu_vendor()) }.to_string_lossy();
        if vendor.is_empty() {
            return Err(ComputeError::InvalidInput("No supported NPU driver".into()));
        }
        let fingerprint = unsafe { CStr::from_ptr(yomika_device_fingerprint()) }.to_bytes();
        let bytes = std::fs::read(path).map_err(|e| ComputeError::InvalidInput(e.to_string()))?;
        let mut identity = blake3::Hasher::new();
        identity.update(&bytes);
        identity.update(fingerprint);
        identity.update(VERSION.as_bytes());
        identity.update(&scale.to_le_bytes());
        let cache = crate::runtime::profile_directory()
            .join("compiled-models")
            .join(identity.finalize().to_hex().as_str());
        std::fs::create_dir_all(&cache).map_err(|e| ComputeError::InvalidInput(e.to_string()))?;
        // A failed native compile is expensive. Retry only after a day, or after
        // model/runtime/OS changes (a different identity), never on every page.
        let failed = cache.join("failed.txt");
        if failed
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() < 86400)
        {
            return Err(ComputeError::InvalidInput(
                "NPU preparation previously failed; using fallback".into(),
            ));
        }
        // LiteRT chooses the first dispatch plugin in a directory, so vendors
        // must never share a discovery directory (even on the same APK).
        let plugins = cache.join("plugins");
        std::fs::create_dir_all(&plugins).map_err(|e| ComputeError::InvalidInput(e.to_string()))?;
        let native = std::path::PathBuf::from(
            unsafe { CStr::from_ptr(yomika_native_directory()) }
                .to_string_lossy()
                .as_ref(),
        );
        for kind in ["CompilerPlugin", "Dispatch"] {
            let name = format!("libLiteRt{kind}_{vendor}.so");
            let link = plugins.join(&name);
            let target = native.join(&name);
            // Android installs updates into a new /data/app/... directory.
            // Cached symlinks must be refreshed even when their target vanished.
            if std::fs::read_link(&link).ok().as_ref() != Some(&target) {
                if std::fs::symlink_metadata(&link).is_ok() {
                    std::fs::remove_file(&link)
                        .map_err(|e| ComputeError::InvalidInput(e.to_string()))?;
                }
                std::os::unix::fs::symlink(target, link)
                    .map_err(|e| ComputeError::InvalidInput(e.to_string()))?;
            }
        }
        let handle = unsafe {
            yomika_litert_open(
                cpath(path)?.as_ptr(),
                cpath(&cache)?.as_ptr(),
                cpath(&plugins)?.as_ptr(),
                scale as i32,
                false,
            )
        };
        if handle.is_null() {
            let failure = error();
            let _ = std::fs::write(failed, failure.to_string());
            return Err(failure);
        }
        let engine = Self {
            handle: Mutex::new(Handle(handle)),
            scale,
            max_pixels,
        };
        // Delegation alone does not prove the graph can run. Exercise it before
        // publishing readiness; failures preserve the ONNX/Vulkan fallback.
        let probe: Vec<u8> = (0..256 * 256)
            .flat_map(|i| {
                [
                    ((i * 7) % 251) as u8,
                    ((i * 13) % 251) as u8,
                    ((i * 17) % 251) as u8,
                    255,
                ]
            })
            .collect();
        let actual = match engine.upscale_tile(&probe, 256, 256) {
            Ok(output) => output,
            Err(failure) => {
                let _ = std::fs::write(failed, failure.to_string());
                return Err(failure);
            }
        };
        if !cache.join("ready.txt").is_file() {
            let cpu = unsafe {
                yomika_litert_open(
                    cpath(path)?.as_ptr(),
                    cpath(&cache)?.as_ptr(),
                    cpath(&plugins)?.as_ptr(),
                    scale as i32,
                    true,
                )
            };
            if cpu.is_null() {
                let failure = error();
                let _ = std::fs::write(failed, failure.to_string());
                return Err(failure);
            }
            let reference = Self {
                handle: Mutex::new(Handle(cpu)),
                scale,
                max_pixels,
            };
            let expected = match reference.upscale_tile(&probe, 256, 256) {
                Ok(output) => output,
                Err(failure) => {
                    let _ = std::fs::write(failed, failure.to_string());
                    return Err(failure);
                }
            };
            let mean = actual
                .iter()
                .zip(&expected)
                .map(|(a, b)| f64::from(a.abs_diff(*b)))
                .sum::<f64>()
                / actual.len() as f64
                / 255.0;
            if mean > 0.02 {
                let failure = ComputeError::InvalidInput(format!(
                    "NPU validation differs from CPU: MAE={mean}"
                ));
                let _ = std::fs::write(failed, failure.to_string());
                return Err(failure);
            }
        }
        let _ = std::fs::remove_file(failed);
        let _ = std::fs::write(cache.join("ready.txt"), VERSION);
        Ok(engine)
    }
}
impl UpscaleEngine for NpuEngine {
    fn scale(&self) -> u32 {
        self.scale
    }
    fn fixed_input_size(&self) -> Option<(u32, u32)> {
        Some((256, 256))
    }
    fn tile_padding(&self) -> u32 {
        16
    }
    fn upscale_tile(&self, rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, ComputeError> {
        if w == 0 || h == 0 || w > 256 || h > 256 || rgba.len() != w as usize * h as usize * 4 {
            return Err(ComputeError::InvalidInput(
                "invalid NPU tile dimensions".into(),
            ));
        }
        let grown = pad_rgba_edges(rgba, w, h, 256, 256);
        let input: Vec<f32> = grown
            .chunks_exact(4)
            .flat_map(|p| p[..3].iter().map(|&v| v as f32 / 255.0))
            .collect();
        let edge = (256 * self.scale) as usize;
        let mut nhwc = vec![0f32; edge * edge * 3];
        let handle = self.handle.lock().map_err(|_| ComputeError::CacheBusy)?;
        if unsafe { yomika_litert_run(handle.0, input.as_ptr(), nhwc.as_mut_ptr()) } != 0 {
            return Err(error());
        }
        drop(handle);
        let mut nchw = vec![0f32; nhwc.len()];
        for (i, pixel) in nhwc.chunks_exact(3).enumerate() {
            for c in 0..3 {
                nchw[c * edge * edge + i] = pixel[c];
            }
        }
        let mut out =
            crate::cpu_scale::cpu_scale_rgba(rgba, w, h, self.scale, self.max_pixels)?.rgba;
        nchw_over_rgba(
            &nchw,
            edge,
            edge,
            (w * self.scale) as usize,
            (h * self.scale) as usize,
            &mut out,
        );
        Ok(out)
    }
}
