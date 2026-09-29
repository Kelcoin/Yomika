//! Region geometry and compositing for the de-censoring pipeline.
//!
//! The pipeline is: a detector finds censored regions, an inpainting model fills
//! one region at a time, and each filled patch goes back into the page. This
//! module is the part that has nothing to do with any particular model — how a
//! detection becomes a crop, and how a crop's result is written back — kept
//! separate because it is where the off-by-one and seam bugs live, and because it
//! can be tested without a 340 MB model on disk.

use super::InferenceError;

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

/// What kind of censoring a detection is. The two inpainting models are trained
/// on different damage, so the kind decides which one runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CensorKind {
    /// Solid bars laid over the image.
    Bar,
    /// Pixelated blocks.
    Mosaic,
}

/// A censored area of the page, in page pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CensorRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub kind: CensorKind,
}

/// A crop the inpainting model can be handed, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CropWindow {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Grows a detection into the square window the inpainting model is handed.
///
/// Upstream's rule, and the parts of it that matter: the window is **square**
/// because the graph is square, and feeding it a rectangle stretched to 256x256
/// would hand the model geometry it was never trained on. It is `1.5x` the longer
/// side so there is real context around the damage to work from, never smaller
/// than the graph's own 256, and never larger than the page's shorter side. It is
/// centred on the detection and then translated back inside the page rather than
/// clipped, because clipping would make it non-square again.
///
/// The detection has to be **inside** the page, all four edges of it: a box whose
/// far edge runs past the page is a corrupt detection, and translating it back
/// inside would turn it into a plausible-looking window around the wrong pixels.
/// Every coordinate here is calculated with checked arithmetic — a width of
/// `u32::MAX` used to wrap in release builds and produce a window that looked
/// legal.
pub fn inpaint_window(
    region: &CensorRegion,
    image_width: u32,
    image_height: u32,
) -> Result<CropWindow, InferenceError> {
    if image_width == 0 || image_height == 0 {
        return Err(InferenceError::InvalidInput("page has no pixels".into()));
    }
    if region.width == 0 || region.height == 0 {
        return Err(InferenceError::InvalidInput("region has no pixels".into()));
    }
    let right = region
        .x
        .checked_add(region.width)
        .ok_or_else(|| InferenceError::InvalidInput("region width overflows".into()))?;
    let bottom = region
        .y
        .checked_add(region.height)
        .ok_or_else(|| InferenceError::InvalidInput("region height overflows".into()))?;
    if right > image_width || bottom > image_height {
        return Err(InferenceError::InvalidInput(format!(
            "region {}x{}+{}+{} leaves the {image_width}x{image_height} page",
            region.width, region.height, region.x, region.y
        )));
    }
    let longest = region.width.max(region.height);
    let wanted = ((f64::from(longest) * 1.5).round() as u32).max(INPAINT_WINDOW_MIN);
    let side = wanted.min(image_width.min(image_height));

    let center_x = region
        .x
        .checked_add(region.width / 2)
        .ok_or_else(|| InferenceError::InvalidInput("region width overflows".into()))?;
    let center_y = region
        .y
        .checked_add(region.height / 2)
        .ok_or_else(|| InferenceError::InvalidInput("region height overflows".into()))?;
    let x = center_x.saturating_sub(side / 2).min(image_width - side);
    let y = center_y.saturating_sub(side / 2).min(image_height - side);
    Ok(CropWindow {
        x,
        y,
        width: side,
        height: side,
    })
}

/// The inpainting graph's own input side, which is also the floor on a window: a
/// smaller crop would be upscaled into the model rather than downscaled, inventing
/// detail before the model has seen anything.
const INPAINT_WINDOW_MIN: u32 = 256;

/// Whether a window lies inside a page of this size, without any coordinate
/// arithmetic that can wrap.
pub fn window_inside_page(window: &CropWindow, image_width: u32, image_height: u32) -> bool {
    window
        .x
        .checked_add(window.width)
        .is_some_and(|right| right <= image_width)
        && window
            .y
            .checked_add(window.height)
            .is_some_and(|bottom| bottom <= image_height)
}

/// Copies a window out of an RGBA page.
pub fn crop_rgba(
    rgba: &[u8],
    image_width: u32,
    image_height: u32,
    window: &CropWindow,
) -> Result<Vec<u8>, InferenceError> {
    if rgba.len() != image_width as usize * image_height as usize * 4 {
        return Err(InferenceError::InvalidInput(
            "RGBA page dimensions do not match".into(),
        ));
    }
    if !window_inside_page(window, image_width, image_height) {
        return Err(InferenceError::InvalidInput(
            "crop window leaves the page".into(),
        ));
    }
    let mut crop = Vec::with_capacity(window.width as usize * window.height as usize * 4);
    for row in 0..window.height {
        let start = ((window.y + row) as usize * image_width as usize + window.x as usize) * 4;
        crop.extend_from_slice(&rgba[start..start + window.width as usize * 4]);
    }
    Ok(crop)
}

/// Writes a filled patch back into the page, but only where `mask` says the pixel
/// was censored.
///
/// Pasting the whole patch would replace real artwork with the model's guess at it
/// — the context the model was given exists to inform the fill, not to be
/// overwritten by it. `mask` is one byte per patch pixel: non-zero means the model
/// owns that pixel.
pub fn paste_masked_rgba(
    page: &mut [u8],
    image_width: u32,
    image_height: u32,
    window: &CropWindow,
    patch: &[u8],
    mask: &[u8],
) -> Result<usize, InferenceError> {
    if page.len() != image_width as usize * image_height as usize * 4 {
        return Err(InferenceError::InvalidInput(
            "RGBA page dimensions do not match".into(),
        ));
    }
    let pixels = window.width as usize * window.height as usize;
    if patch.len() != pixels * 4 {
        return Err(InferenceError::InvalidInput(
            "patch dimensions do not match the window".into(),
        ));
    }
    if mask.len() != pixels {
        return Err(InferenceError::InvalidInput(
            "mask dimensions do not match the window".into(),
        ));
    }
    if !window_inside_page(window, image_width, image_height) {
        return Err(InferenceError::InvalidInput(
            "crop window leaves the page".into(),
        ));
    }
    let mut written = 0;
    for row in 0..window.height as usize {
        for column in 0..window.width as usize {
            let index = row * window.width as usize + column;
            if mask[index] == 0 {
                continue;
            }
            let target =
                ((window.y as usize + row) * image_width as usize + window.x as usize + column) * 4;
            // Alpha stays the page's: an inpainting model has no opinion about it,
            // and a transparent page pixel must not become opaque.
            page[target] = patch[index * 4];
            page[target + 1] = patch[index * 4 + 1];
            page[target + 2] = patch[index * 4 + 2];
            written += 1;
        }
    }
    Ok(written)
}

/// The three sessions of one bundle, opened once and shared by every page.
///
/// Opening the detector is not a small cost: it is a 240 MB graph, and
/// `decensor_page` used to open a fresh one for every page — so turning
/// de-censoring on meant loading and initialising that much ONNX per page turn,
/// which is most of what made it feel unusable. Nothing about the graphs is
/// per-page, so nothing about them needs to be rebuilt per page.
///
/// The two inpainting sessions stay lazy: a page with only bars should not pay to
/// load the mosaic model, and an archive with no mosaics never will.
pub struct DecensorEngines {
    detector: super::detect::DetectorEngine,
    bar: std::sync::OnceLock<super::inpaint::InpaintEngine>,
    mosaic: std::sync::OnceLock<super::inpaint::InpaintEngine>,
    bundle: DecensorBundle,
}

impl DecensorEngines {
    pub fn open(bundle: &DecensorBundle) -> Result<Self, InferenceError> {
        Ok(Self {
            detector: super::detect::DetectorEngine::open(&bundle.detector)?,
            bar: std::sync::OnceLock::new(),
            mosaic: std::sync::OnceLock::new(),
            bundle: bundle.clone(),
        })
    }

    fn inpainter(
        &self,
        kind: CensorKind,
    ) -> Result<&super::inpaint::InpaintEngine, InferenceError> {
        let (slot, path) = match kind {
            CensorKind::Bar => (&self.bar, &self.bundle.bar),
            CensorKind::Mosaic => (&self.mosaic, &self.bundle.mosaic),
        };
        if let Some(engine) = slot.get() {
            return Ok(engine);
        }
        let engine = super::inpaint::InpaintEngine::open(path, kind)?;
        // A race only means the loser's session is dropped; both are equivalent.
        let _ = slot.set(engine);
        slot.get()
            .ok_or_else(|| InferenceError::InvalidInput("inpainting session unavailable".into()))
    }
}

/// Runs the whole pipeline over one page, in place, and reports how many regions
/// it filled.
///
/// One region at a time, and a region whose mask survives thresholding at all: a
/// detection is only worth a model run if it actually claims pixels.
pub fn decensor_page(
    engines: &DecensorEngines,
    rgba: &mut [u8],
    width: u32,
    height: u32,
    cancel: &super::cancel::CancelToken,
) -> Result<usize, InferenceError> {
    cancel.check()?;
    let regions = engines.detector.detect(rgba, width, height)?;
    cancel.check()?;
    inpaint_detections(
        rgba,
        width,
        height,
        &regions,
        cancel,
        |kind, crop, window, censored| {
            engines
                .inpainter(kind)?
                .inpaint(crop, window.width, window.height, censored)
        },
    )
}

fn inpaint_detections(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    regions: &[super::detect::Detection],
    cancel: &super::cancel::CancelToken,
    mut inpaint: impl FnMut(CensorKind, &[u8], &CropWindow, &[u8]) -> Result<Vec<u8>, InferenceError>,
) -> Result<usize, InferenceError> {
    if regions.is_empty() {
        return Ok(0);
    }
    let original = rgba.to_vec();
    let mut filled = 0;
    for detection in regions {
        // 一个检测框一次模型运行，一页可能有几十个：取消点在框与框之间，切页
        // 之后不会先把剩下十几个框跑完。
        cancel.check()?;
        // Every detection is validated before anything is allocated from it: an
        // out-of-page box, an overflowing coordinate or a mask that does not match
        // its own box is a corrupt detection, not a slightly-off one.
        validate_detection(detection, width, height)?;
        let window = inpaint_window(&detection.region, width, height)?;
        let censored = detection.mask_in_window(&window);
        if censored.iter().all(|&value| value == 0) {
            continue;
        }
        // Upstream crops the original page with a union mask, so nearby damage
        // and earlier model predictions cannot be mistaken for known artwork.
        let mut context_mask = censored.clone();
        for neighbour in regions {
            if neighbour.region.kind != detection.region.kind || std::ptr::eq(neighbour, detection)
            {
                continue;
            }
            for (target, source) in context_mask
                .iter_mut()
                .zip(neighbour.mask_in_window(&window))
            {
                *target |= source;
            }
        }
        let crop = crop_rgba(&original, width, height, &window)?;
        let patch = inpaint(detection.region.kind, &crop, &window, &context_mask)?;
        // Only the censored pixels are the model's; the context it was given stays
        // the artwork it already was.
        if paste_masked_rgba(rgba, width, height, &window, &patch, &censored)? > 0 {
            filled += 1;
        }
    }
    Ok(filled)
}

/// The checks a detection has to pass before its geometry is used for anything.
///
/// `decode_detections` already clamps what the model produced, so this is aimed at
/// the other producers — a corrupted response, a hand-built detection, a future
/// detector — where the box is the only thing between the pipeline and a wrong
/// window: `crop_rgba`'s own check cannot help, because the window it is handed
/// has already been translated back inside the page.
pub fn validate_detection(
    detection: &super::detect::Detection,
    image_width: u32,
    image_height: u32,
) -> Result<(), InferenceError> {
    let region = &detection.region;
    if region.width == 0 || region.height == 0 {
        return Err(InferenceError::InvalidInput("region has no pixels".into()));
    }
    let right = region
        .x
        .checked_add(region.width)
        .ok_or_else(|| InferenceError::InvalidInput("region width overflows".into()))?;
    let bottom = region
        .y
        .checked_add(region.height)
        .ok_or_else(|| InferenceError::InvalidInput("region height overflows".into()))?;
    if right > image_width || bottom > image_height {
        return Err(InferenceError::InvalidInput(format!(
            "region {}x{}+{}+{} leaves the {image_width}x{image_height} page",
            region.width, region.height, region.x, region.y
        )));
    }
    // The mask is one byte per box pixel; a shorter one would be read past its end
    // while projecting it into the window.
    let expected = region.width as usize * region.height as usize;
    if detection.mask.len() != expected || !detection.score.is_finite() {
        return Err(InferenceError::InvalidInput(format!(
            "detection mask is {} bytes, its box needs {expected}",
            detection.mask.len()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neighbouring_repairs_share_the_damage_mask_and_original_context() {
        let original = [100, 110, 120, 255].repeat(16);
        let mut page = original.clone();
        let detections: Vec<_> = [0, 2]
            .into_iter()
            .map(|x| super::super::detect::Detection {
                region: CensorRegion {
                    x,
                    y: 0,
                    width: 1,
                    height: 1,
                    kind: CensorKind::Bar,
                },
                score: 1.0,
                mask: vec![1],
            })
            .collect();
        let mut calls = 0;
        let count = inpaint_detections(
            &mut page,
            4,
            4,
            &detections,
            &super::super::cancel::CancelToken::none(),
            |_, crop, _, mask| {
                assert_eq!(
                    crop, original,
                    "generated pixels must never become input context"
                );
                assert_eq!(
                    mask.iter().filter(|&&value| value != 0).count(),
                    2,
                    "both damaged areas must be unknown"
                );
                calls += 1;
                Ok([200, 210, 220, 255].repeat(16))
            },
        )
        .unwrap();
        assert_eq!((count, calls), (2, 2));
        for index in 0..16 {
            let expected = if index == 0 || index == 2 {
                &[200, 210, 220, 255]
            } else {
                &[100, 110, 120, 255]
            };
            assert_eq!(&page[index * 4..index * 4 + 4], expected);
        }
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

    /// The real bundle, when it is on this machine: the detector session is opened
    /// once and reused, which is the whole point of holding it.
    ///
    /// A 240 MB graph opened per page was most of what made de-censoring unusable,
    /// and the fix is only observable as a timing: the second open of the same
    /// bundle must be far cheaper than the first, because it is not an open at all.
    #[test]
    fn opening_the_same_bundle_twice_reuses_its_sessions() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/Aletheia-Lens/_internal/models");
        let Some(bundle) = bundle_in(&root) else {
            eprintln!("skipping: {} is not present", root.display());
            return;
        };
        let started = std::time::Instant::now();
        let engines = DecensorEngines::open(&bundle).expect("first open");
        let cold = started.elapsed();

        // Same bundle, same sessions: `decensor_engines_for` hands back the Arc it
        // already holds, so this measures the lookup rather than the load.
        let started = std::time::Instant::now();
        let again = crate::inference::decensor_engines_for(&bundle).expect("cached open");
        let warm_first = started.elapsed();
        let started = std::time::Instant::now();
        let third = crate::inference::decensor_engines_for(&bundle).expect("cached again");
        let warm = started.elapsed();

        assert!(
            std::sync::Arc::ptr_eq(&again, &third),
            "the same sessions have to come back"
        );
        // An absolute bound rather than a ratio: ORT memory-maps the initialisers,
        // so a cold open can itself be quick, and a ratio would then be measuring
        // noise. A lookup that does not open anything is a hash lookup and an Arc
        // clone — microseconds. The bound is generous against the scheduler on
        // purpose: under load this box deschedules the test thread for tens of
        // milliseconds (27 ms measured once), while the open this is meant to rule
        // out takes ~660 ms here. Five milliseconds was tight enough to fail about
        // one run in six without anything being wrong.
        assert!(
            warm < std::time::Duration::from_millis(50),
            "a cached lookup took {warm:?}, so it is opening something (cold open was {cold:?}, first cached call {warm_first:?})",
        );
        drop(engines);
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

    fn region(x: u32, y: u32, width: u32, height: u32) -> CensorRegion {
        CensorRegion {
            x,
            y,
            width,
            height,
            kind: CensorKind::Mosaic,
        }
    }

    #[test]
    fn a_window_is_square_and_gives_the_model_context_around_the_damage() {
        // 1.5x the longer side, but never below the graph's own 256.
        let window = inpaint_window(&region(400, 400, 200, 120), 2000, 2000).expect("window");
        assert_eq!((window.width, window.height), (300, 300));
        // Centred on the detection: centre 500,460 minus half the side.
        assert_eq!((window.x, window.y), (350, 310));

        let small = inpaint_window(&region(400, 400, 20, 20), 2000, 2000).expect("window");
        assert_eq!(
            (small.width, small.height),
            (256, 256),
            "a tiny box still gets the graph's own side"
        );
    }

    #[test]
    fn a_window_stays_square_at_the_page_edge_rather_than_being_clipped() {
        // Hard against the corner: clipping would make it a rectangle, which the
        // square graph would then stretch.
        let window = inpaint_window(&region(0, 0, 40, 40), 1000, 1200).expect("window");
        assert_eq!((window.x, window.y), (0, 0));
        assert_eq!(window.width, window.height);

        let window = inpaint_window(&region(960, 1160, 40, 40), 1000, 1200).expect("window");
        assert_eq!(window.width, window.height);
        assert!(
            window.x + window.width <= 1000,
            "window {window:?} leaves the page"
        );
        assert!(
            window.y + window.height <= 1200,
            "window {window:?} leaves the page"
        );
    }

    #[test]
    fn a_page_smaller_than_the_graph_gives_a_window_of_the_whole_page() {
        // The shorter side is the ceiling, so the window cannot exceed the page.
        let window = inpaint_window(&region(0, 0, 3, 3), 200, 120).expect("window");
        assert_eq!(
            window,
            CropWindow {
                x: 0,
                y: 0,
                width: 120,
                height: 120
            }
        );
    }

    #[test]
    fn an_empty_or_off_page_region_is_rejected() {
        assert!(inpaint_window(&region(0, 0, 0, 10), 100, 100).is_err());
        assert!(inpaint_window(&region(100, 0, 10, 10), 100, 100).is_err());
        assert!(inpaint_window(&region(0, 0, 10, 10), 0, 100).is_err());
    }

    /// The far edge matters as much as the near one. A region whose right or bottom
    /// edge runs past the page used to be translated back inside and run as if it
    /// were a real detection — the inpainter then filled a window around the wrong
    /// pixels, which reads as "de-censoring ruined this page" rather than as an
    /// error anybody could find.
    #[test]
    fn a_region_has_to_fit_inside_the_page_on_both_edges() {
        // Exactly the right edge: legal.
        let edge = inpaint_window(&region(90, 90, 10, 10), 100, 100).expect("edge region");
        assert!(edge.x + edge.width <= 100 && edge.y + edge.height <= 100);

        // One pixel past it: not a clipped region, a rejected one.
        assert!(inpaint_window(&region(91, 90, 10, 10), 100, 100).is_err());
        assert!(inpaint_window(&region(90, 91, 10, 10), 100, 100).is_err());
        assert!(inpaint_window(&region(95, 0, 10, 10), 100, 100).is_err());
    }

    /// Coordinates are u32, so a corrupt detector value can overflow. Wrapping in
    /// release builds produced a window that passed every later check; in debug it
    /// panicked. Both are wrong: this is a rejected region.
    #[test]
    fn an_overflowing_region_is_rejected_rather_than_wrapped() {
        assert!(inpaint_window(&region(u32::MAX, 0, 10, 10), 100, 100).is_err());
        assert!(inpaint_window(&region(0, 0, u32::MAX, 10), 100, 100).is_err());
        assert!(inpaint_window(&region(0, 0, 10, u32::MAX), 100, 100).is_err());
        // The centre is computed from the same numbers and could overflow on its
        // own even when the box fits: x + width/2 with a huge x.
        assert!(inpaint_window(&region(u32::MAX - 1, 5, 4, 4), 100, 100).is_err());
    }

    /// A detection whose mask does not cover its own box used to be read past the
    /// end of its buffer while being projected into the window.
    #[test]
    fn a_detection_whose_mask_does_not_match_its_box_is_rejected() {
        let short = super::super::detect::Detection {
            region: region(0, 0, 2, 2),
            score: 1.0,
            mask: vec![1, 1, 1],
        };
        assert!(validate_detection(&short, 4, 4).is_err());
        let mismatched = super::super::detect::Detection {
            region: region(0, 0, 2, 2),
            score: 1.0,
            mask: vec![1, 1, 1, 1, 1],
        };
        assert!(validate_detection(&mismatched, 4, 4).is_err());
        let good = super::super::detect::Detection {
            region: region(0, 0, 2, 2),
            score: 1.0,
            mask: vec![1, 0, 0, 1],
        };
        assert!(validate_detection(&good, 4, 4).is_ok());
        // A non-finite score is a broken detection too: it says nothing about how
        // much the model believed this box.
        let not_a_number = super::super::detect::Detection {
            region: region(0, 0, 2, 2),
            score: f32::NAN,
            mask: vec![1, 0, 0, 1],
        };
        assert!(validate_detection(&not_a_number, 4, 4).is_err());
    }

    /// Cancelling has to stop the page's remaining regions: a page can hold dozens,
    /// and the global inference gate is held for as long as they run.
    #[test]
    fn a_cancelled_task_stops_between_regions() {
        let mut page = vec![0_u8; 64 * 64 * 4];
        let detections: Vec<_> = (0..4)
            .map(|index| super::super::detect::Detection {
                region: region(index * 8, 0, 4, 4),
                score: 1.0,
                mask: vec![1; 16],
            })
            .collect();
        let guard = super::super::cancel::begin(Some("decensor-cancel-test"));
        let cancel = guard.token();
        let mut runs = 0;
        let error = inpaint_detections(&mut page, 64, 64, &detections, &cancel, |_, _, window, _| {
            runs += 1;
            // 第二个框跑到一半时用户切了页。
            if runs == 2 {
                super::super::cancel::cancel("decensor-cancel-test");
            }
            Ok(vec![255, 0, 0, 255].repeat((window.width * window.height) as usize))
        })
        .expect_err("cancel must surface as Cancelled");
        assert_eq!(error, crate::inference::InferenceError::Cancelled);
        assert_eq!(runs, 2, "the third region must not start");
    }

    #[test]
    fn cropping_reads_the_window_rows_and_nothing_else() {
        // 3x2 page, one distinct value per pixel in the red channel.
        let mut page = Vec::new();
        for index in 0..6_u8 {
            page.extend_from_slice(&[index * 10, 0, 0, 255]);
        }
        let crop = crop_rgba(
            &page,
            3,
            2,
            &CropWindow {
                x: 1,
                y: 0,
                width: 2,
                height: 2,
            },
        )
        .expect("crop");
        assert_eq!(
            crop.chunks_exact(4)
                .map(|pixel| pixel[0])
                .collect::<Vec<_>>(),
            vec![10, 20, 40, 50]
        );
    }

    #[test]
    fn pasting_only_touches_the_masked_pixels_and_leaves_alpha_alone() {
        let mut page = vec![0_u8; 3 * 2 * 4];
        for pixel in page.chunks_exact_mut(4) {
            pixel[3] = 128;
        }
        let window = CropWindow {
            x: 1,
            y: 0,
            width: 2,
            height: 2,
        };
        let patch = vec![9, 9, 9, 255, 8, 8, 8, 255, 7, 7, 7, 255, 6, 6, 6, 255];
        // Only the patch's top-right and bottom-left pixels are the model's.
        let mask = vec![0, 1, 1, 0];
        let written = paste_masked_rgba(&mut page, 3, 2, &window, &patch, &mask).expect("paste");
        assert_eq!(written, 2);

        let reds: Vec<u8> = page.chunks_exact(4).map(|pixel| pixel[0]).collect();
        assert_eq!(reds, vec![0, 0, 8, 0, 7, 0]);
        assert!(
            page.chunks_exact(4).all(|pixel| pixel[3] == 128),
            "alpha must survive the paste"
        );
    }

    #[test]
    fn a_mismatched_patch_or_mask_is_rejected_rather_than_pasted_short() {
        let mut page = vec![0_u8; 4 * 4 * 4];
        let window = CropWindow {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        };
        assert!(paste_masked_rgba(&mut page, 4, 4, &window, &vec![0; 8], &vec![1; 4]).is_err());
        assert!(paste_masked_rgba(&mut page, 4, 4, &window, &vec![0; 16], &vec![1; 3]).is_err());
        let off_page = CropWindow {
            x: 3,
            y: 3,
            width: 2,
            height: 2,
        };
        assert!(paste_masked_rgba(&mut page, 4, 4, &off_page, &vec![0; 16], &vec![1; 4]).is_err());
    }
}
