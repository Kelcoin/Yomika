//! 去码管道留在宿主这一侧的东西：模型包（四件套）的发现与安装。
//!
//! 会话（检测器 + 两份修补执行体）**不在这边了**：它们跟着页面那条来路一起搬进
//! worker（`worker/src/decensor.rs`，docs/94），宿主这边连「开一台 240 MB 的检测器」
//! 这件事都没有了——去码是 Task 8 出口「宿主无 ORT」最后松开的那一格。
//!
//! 几何与合成——一个检测框怎么长成一扇方形窗口、一扇窗口的结果怎么只贴回被遮的
//! 像素——已经搬进 [`yomika_compute_core::decensor`]（docs/71 §11 Task 8 的
//! 「core decensor」）。理由和 Task 2 抽超分管道一样，但更硬：worker 要真跑修补
//! 阶段，而 worker 链接不了宿主的任何东西（docs/71 §5.2）。这一份只留**与宿主的
//! 模型目录、会话驻留有关**的部分，其余靠再导出保持 `inference::decensor::*` 这些
//! 路径不变——调用点（`inference.rs`）因此一行都不用改。
//!
//! 为什么几何必须只有一份：`validate_detection`（一个框算不算合法）与
//! `inpaint_window`（上下文取多大）是一页上几十个框的判据，宿主今天、worker 明天
//! 各写一遍，就会在某一次改动之后开始对不上，而这种对不上表现为「某些页面去码坏
//! 了」——正是最难查、也最像模型问题的那一类。

use super::InferenceError;

// 运行时的再导出：`crop_rgba`/`inpaint_window` 这些现在是核心管道内部的东西，宿主
// 只在测试里点名，但路径保持与核心一致，方便回溯定义在哪。
#[allow(unused_imports)]
pub use yomika_compute_core::decensor::{
    crop_rgba, inpaint_detections, inpaint_window, paste_masked_rgba, validate_detection,
    window_inside_page, CensorKind, CensorRegion, CropWindow, Detection,
};

/// The four model files a de-censoring bundle is made of, laid out the way
/// Aletheia-Lens ships them so an existing install can be zipped up as-is.
///
/// A bundle is recognised by its shape rather than by a manifest field: it *is*
/// these files, and a directory holding them is not an upscaler no matter what
/// its manifest claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecensorBundle {
    /// Mask R-CNN, finds the censored regions.
    pub detector: std::path::PathBuf,
    /// DeepCreamPy, fills solid bars.
    pub bar: std::path::PathBuf,
    /// DeepCreamPy, fills pixelated blocks.
    pub mosaic: std::path::PathBuf,
    /// ESRGAN, used inside the mosaic path.
    pub esrgan: std::path::PathBuf,
}

const DETECTOR_RELATIVE: [&str; 2] = ["mrcnn", "weights.onnx"];
const BAR_RELATIVE: [&str; 2] = ["deepcreampy", "bar.onnx"];
const MOSAIC_RELATIVE: [&str; 2] = ["deepcreampy", "mosaic.onnx"];
const ESRGAN_RELATIVE: [&str; 2] = ["esrgan", "4x-Fatal-Pixels.onnx"];

/// The bundle inside an installed model directory, if all four files are there.
///
/// All four or none: a partial bundle would fail part-way through a page and
/// leave it half de-censored, which is worse than declining the whole thing.
pub fn bundle_in(install_root: &std::path::Path) -> Option<DecensorBundle> {
    let resolve = |parts: [&str; 2]| {
        let path = install_root.join(parts[0]).join(parts[1]);
        path.is_file().then_some(path)
    };
    Some(DecensorBundle {
        detector: resolve(DETECTOR_RELATIVE)?,
        bar: resolve(BAR_RELATIVE)?,
        mosaic: resolve(MOSAIC_RELATIVE)?,
        esrgan: resolve(ESRGAN_RELATIVE)?,
    })
}

/// Copies a de-censoring bundle out of an existing Aletheia-Lens install.
///
/// The bundle is 337 MB — a quarter of a gigabyte of it is the detector alone —
/// so it cannot travel the way an upscaling model does. `install_model_archive`
/// takes a ZIP in memory, which would mean pushing all of it through IPC; and
/// putting it in the repository would put it in every clone, for ever. Copying
/// from a directory the user already has is the one route that costs nothing but
/// disk.
///
/// The source is recognised by its shape, through `bundle_in`: four files in the
/// layout Aletheia-Lens ships. A directory that does not have all four is not a
/// bundle, whatever it is named — the same all-or-nothing rule as everywhere else
/// here, because a partial bundle fails part-way through a page.
pub fn install_bundle_from(
    source: &std::path::Path,
    staging: &std::path::Path,
    install: &std::path::Path,
) -> Result<(), InferenceError> {
    let Some(bundle) = bundle_in(source) else {
        return Err(InferenceError::InvalidInput(
            "该目录不是完整的去码模型包：需要 mrcnn/weights.onnx、deepcreampy/bar.onnx、deepcreampy/mosaic.onnx 与 esrgan/4x-Fatal-Pixels.onnx".into(),
        ));
    };
    if install.exists() {
        return Err(InferenceError::InvalidInput(
            "该版本的去码模型包已安装".into(),
        ));
    }
    let _ = std::fs::remove_dir_all(staging);
    let files: [(&std::path::Path, [&str; 2]); 4] = [
        (bundle.detector.as_path(), DETECTOR_RELATIVE),
        (bundle.bar.as_path(), BAR_RELATIVE),
        (bundle.mosaic.as_path(), MOSAIC_RELATIVE),
        (bundle.esrgan.as_path(), ESRGAN_RELATIVE),
    ];
    let copy = || -> Result<(), InferenceError> {
        for (from, parts) in files {
            let target = staging.join(parts[0]).join(parts[1]);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    InferenceError::InvalidInput(format!("创建目录失败：{error}"))
                })?;
            }
            std::fs::copy(from, &target).map_err(|error| {
                InferenceError::InvalidInput(format!("复制 {} 失败：{error}", parts[1]))
            })?;
            // ESRGAN keeps its weights in a sibling `.onnx.data`, and the two have
            // to stay in the same directory or the session cannot open.
            let sidecar = from.with_extension("onnx.data");
            if sidecar.is_file() {
                std::fs::copy(&sidecar, target.with_extension("onnx.data")).map_err(|error| {
                    InferenceError::InvalidInput(format!("复制外置权重失败：{error}"))
                })?;
            }
        }
        Ok(())
    };
    if let Err(error) = copy() {
        let _ = std::fs::remove_dir_all(staging);
        return Err(error);
    }
    if let Some(parent) = install.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| InferenceError::InvalidInput(format!("创建目录失败：{error}")))?;
    }
    // The staged copy only becomes an install once every file is there, so a
    // half-copied bundle is never offered as a choice.
    std::fs::rename(staging, install)
        .map_err(|error| InferenceError::InvalidInput(format!("安装去码模型包失败：{error}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只有一份几何：宿主这一侧点名的每个东西都必须**就是**核心那一个。
    ///
    /// 这是搬家之后唯一能防住「悄悄长回一份本地副本」的断言。两份实现的字段、错误
    /// 类型与签名在类型系统里完全一样，调用结果在正常输入上也一样，所以能区分的只有
    /// 两样东西：函数的**地址**（`fn_addr_eq`，证明是同一份代码而不是碰巧同结果），
    /// 和类型的**完整名字**（证明 `Detection` 这些形状没有在宿主里被重新声明）。
    ///
    /// 为什么值得单独钉一条：worker 下一段要跑同一套几何，两边一旦分叉，症状是「某些
    /// 页面的去码窗口偏了」——最像模型问题、最不该靠人眼发现的那一类。
    #[test]
    fn the_geometry_the_host_runs_is_the_cores_geometry() {
        use std::ptr::fn_addr_eq;
        assert!(fn_addr_eq(
            inpaint_window
                as fn(&CensorRegion, u32, u32) -> Result<CropWindow, InferenceError>,
            yomika_compute_core::decensor::inpaint_window
                as fn(&CensorRegion, u32, u32) -> Result<CropWindow, InferenceError>,
        ));
        assert!(fn_addr_eq(
            validate_detection as fn(&Detection, u32, u32) -> Result<(), InferenceError>,
            yomika_compute_core::decensor::validate_detection
                as fn(&Detection, u32, u32) -> Result<(), InferenceError>,
        ));
        assert!(fn_addr_eq(
            crop_rgba as fn(&[u8], u32, u32, &CropWindow) -> Result<Vec<u8>, InferenceError>,
            yomika_compute_core::decensor::crop_rgba
                as fn(&[u8], u32, u32, &CropWindow) -> Result<Vec<u8>, InferenceError>,
        ));
        assert!(fn_addr_eq(
            paste_masked_rgba
                as fn(&mut [u8], u32, u32, &CropWindow, &[u8], &[u8]) -> Result<usize, InferenceError>,
            yomika_compute_core::decensor::paste_masked_rgba
                as fn(&mut [u8], u32, u32, &CropWindow, &[u8], &[u8]) -> Result<usize, InferenceError>,
        ));
        assert!(fn_addr_eq(
            window_inside_page as fn(&CropWindow, u32, u32) -> bool,
            yomika_compute_core::decensor::window_inside_page as fn(&CropWindow, u32, u32) -> bool,
        ));
        assert!(fn_addr_eq(
            Detection::mask_in_window as fn(&Detection, &CropWindow) -> Vec<u8>,
            yomika_compute_core::decensor::Detection::mask_in_window
                as fn(&Detection, &CropWindow) -> Vec<u8>,
        ));

        assert_eq!(
            std::any::type_name::<Detection>(),
            "yomika_compute_core::decensor::Detection",
            "检测器交出去的形状必须就是核心那一个，不能在 detect.rs 里重新声明"
        );
        assert_eq!(
            std::any::type_name::<CensorRegion>(),
            "yomika_compute_core::decensor::CensorRegion"
        );
        assert_eq!(
            std::any::type_name::<CropWindow>(),
            "yomika_compute_core::decensor::CropWindow"
        );
        assert_eq!(
            std::any::type_name::<CensorKind>(),
            "yomika_compute_core::decensor::CensorKind"
        );
        assert_eq!(
            std::any::type_name::<super::super::inpaint::InpaintEngine>(),
            "yomika_compute_core::inpaint::InpaintEngine",
            "修补执行体也必须就是核心那一个（宿主的 inpaint.rs 只剩再导出）"
        );
    }

    #[test]
    fn installing_a_bundle_copies_all_four_files_and_the_external_weights() {
        // 337 MB cannot travel as bytes through IPC, and putting it in the
        // repository would put it in every clone for ever, so the install is a
        // copy out of a directory the user already has.
        let base = std::env::temp_dir().join("yomika-decensor-install");
        let _ = std::fs::remove_dir_all(&base);
        let source = base.join("source");
        for part in ["mrcnn", "deepcreampy", "esrgan"] {
            std::fs::create_dir_all(source.join(part)).unwrap();
        }
        std::fs::write(source.join("mrcnn").join("weights.onnx"), b"detector").unwrap();
        std::fs::write(source.join("deepcreampy").join("bar.onnx"), b"bar").unwrap();
        std::fs::write(source.join("deepcreampy").join("mosaic.onnx"), b"mosaic").unwrap();
        std::fs::write(
            source.join("esrgan").join("4x-Fatal-Pixels.onnx"),
            b"esrgan",
        )
        .unwrap();
        // ESRGAN keeps its weights beside the graph; a session cannot open without.
        std::fs::write(
            source.join("esrgan").join("4x-Fatal-Pixels.onnx.data"),
            b"weights",
        )
        .unwrap();

        let staging = base.join(".1.installing");
        let install = base.join("1");
        install_bundle_from(&source, &staging, &install).expect("install");

        assert!(
            bundle_in(&install).is_some(),
            "the copy has to be a bundle in its own right"
        );
        assert_eq!(
            std::fs::read(install.join("esrgan").join("4x-Fatal-Pixels.onnx.data")).unwrap(),
            b"weights"
        );
        assert!(
            !staging.exists(),
            "the staging directory is renamed, not left behind"
        );

        // Installing twice is refused rather than half-overwriting a live bundle.
        assert!(install_bundle_from(&source, &staging, &install).is_err());

        // A directory missing one of the four is not a bundle, whatever it is named.
        let partial = base.join("partial");
        std::fs::create_dir_all(partial.join("mrcnn")).unwrap();
        std::fs::write(partial.join("mrcnn").join("weights.onnx"), b"detector").unwrap();
        assert!(
            install_bundle_from(&partial, &base.join(".2.installing"), &base.join("2")).is_err()
        );

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_bundle_is_all_four_files_or_nothing() {
        let base = std::env::temp_dir().join("yomika-decensor-bundle");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("mrcnn")).unwrap();
        std::fs::create_dir_all(base.join("deepcreampy")).unwrap();
        std::fs::create_dir_all(base.join("esrgan")).unwrap();
        std::fs::write(base.join("mrcnn").join("weights.onnx"), b"x").unwrap();
        std::fs::write(base.join("deepcreampy").join("bar.onnx"), b"x").unwrap();
        std::fs::write(base.join("deepcreampy").join("mosaic.onnx"), b"x").unwrap();

        // Three of four is not a bundle: a page half de-censored is worse than one
        // the app declined to touch.
        assert_eq!(bundle_in(&base), None);

        std::fs::write(base.join("esrgan").join("4x-Fatal-Pixels.onnx"), b"x").unwrap();
        let bundle = bundle_in(&base).expect("bundle");
        assert!(bundle.detector.ends_with("weights.onnx"));
        assert!(bundle.mosaic.ends_with("mosaic.onnx"));
        assert_eq!(bundle_in(&base.join("elsewhere")), None);
        std::fs::remove_dir_all(base).unwrap();
    }
}
