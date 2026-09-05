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
    if region.x >= image_width || region.y >= image_height {
        return Err(InferenceError::InvalidInput("region starts outside the page".into()));
    }
    let longest = region.width.max(region.height);
    let wanted = ((f64::from(longest) * 1.5).round() as u32).max(INPAINT_WINDOW_MIN);
    let side = wanted.min(image_width.min(image_height));

    let center_x = region.x + region.width / 2;
    let center_y = region.y + region.height / 2;
    let x = center_x.saturating_sub(side / 2).min(image_width - side);
    let y = center_y.saturating_sub(side / 2).min(image_height - side);
    Ok(CropWindow { x, y, width: side, height: side })
}

/// The inpainting graph's own input side, which is also the floor on a window: a
/// smaller crop would be upscaled into the model rather than downscaled, inventing
/// detail before the model has seen anything.
const INPAINT_WINDOW_MIN: u32 = 256;

/// Copies a window out of an RGBA page.
pub fn crop_rgba(
    rgba: &[u8],
    image_width: u32,
    image_height: u32,
    window: &CropWindow,
) -> Result<Vec<u8>, InferenceError> {
    if rgba.len() != image_width as usize * image_height as usize * 4 {
        return Err(InferenceError::InvalidInput("RGBA page dimensions do not match".into()));
    }
    if window.x + window.width > image_width || window.y + window.height > image_height {
        return Err(InferenceError::InvalidInput("crop window leaves the page".into()));
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
        return Err(InferenceError::InvalidInput("RGBA page dimensions do not match".into()));
    }
    let pixels = window.width as usize * window.height as usize;
    if patch.len() != pixels * 4 {
        return Err(InferenceError::InvalidInput("patch dimensions do not match the window".into()));
    }
    if mask.len() != pixels {
        return Err(InferenceError::InvalidInput("mask dimensions do not match the window".into()));
    }
    if window.x + window.width > image_width || window.y + window.height > image_height {
        return Err(InferenceError::InvalidInput("crop window leaves the page".into()));
    }
    let mut written = 0;
    for row in 0..window.height as usize {
        for column in 0..window.width as usize {
            let index = row * window.width as usize + column;
            if mask[index] == 0 {
                continue;
            }
            let target = ((window.y as usize + row) * image_width as usize + window.x as usize + column) * 4;
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

/// Turns a detector's per-pixel confidence over the crop into the byte mask
/// `paste_masked_rgba` takes, and reports whether anything survived the
/// threshold. A mask that selects nothing means the region was a false positive,
/// and pasting it would be a no-op that still cost a model run.
pub fn threshold_mask(scores: &[f32], threshold: f32) -> (Vec<u8>, usize) {
    let mut selected = 0;
    let mask = scores
        .iter()
        .map(|score| {
            if score.is_finite() && *score >= threshold {
                selected += 1;
                1
            } else {
                0
            }
        })
        .collect();
    (mask, selected)
}

/// Runs the whole pipeline over one page, in place, and reports how many regions
/// it filled.
///
/// One region at a time, and a region whose mask survives thresholding at all: a
/// detection is only worth a model run if it actually claims pixels. The detector
/// is opened once per page and the two inpainting models lazily, because a page
/// with only bars should not pay to load the mosaic model.
pub fn decensor_page(
    bundle: &DecensorBundle,
    rgba: &mut [u8],
    width: u32,
    height: u32,
) -> Result<usize, InferenceError> {
    use super::detect::DetectorEngine;
    use super::inpaint::InpaintEngine;

    let detector = DetectorEngine::open(&bundle.detector)?;
    let regions = detector.detect(rgba, width, height)?;
    if regions.is_empty() {
        return Ok(0);
    }
    let mut bar: Option<InpaintEngine> = None;
    let mut mosaic: Option<InpaintEngine> = None;
    let mut filled = 0;
    for detection in &regions {
        let window = inpaint_window(&detection.region, width, height)?;
        let censored = detection.mask_in_window(&window);
        if censored.iter().all(|&value| value == 0) {
            continue;
        }
        let engine = match detection.region.kind {
            CensorKind::Bar => {
                if bar.is_none() {
                    bar = Some(InpaintEngine::open(&bundle.bar, CensorKind::Bar)?);
                }
                bar.as_ref()
            }
            CensorKind::Mosaic => {
                if mosaic.is_none() {
                    mosaic = Some(InpaintEngine::open(&bundle.mosaic, CensorKind::Mosaic)?);
                }
                mosaic.as_ref()
            }
        };
        let Some(engine) = engine else { continue };
        let crop = crop_rgba(rgba, width, height, &window)?;
        let patch = engine.inpaint(&crop, window.width, window.height, &censored)?;
        // Only the censored pixels are the model's; the context it was given stays
        // the artwork it already was.
        if paste_masked_rgba(rgba, width, height, &window, &patch, &censored)? > 0 {
            filled += 1;
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        CensorRegion { x, y, width, height, kind: CensorKind::Mosaic }
    }

    #[test]
    fn a_window_is_square_and_gives_the_model_context_around_the_damage() {
        // 1.5x the longer side, but never below the graph's own 256.
        let window = inpaint_window(&region(400, 400, 200, 120), 2000, 2000).expect("window");
        assert_eq!((window.width, window.height), (300, 300));
        // Centred on the detection: centre 500,460 minus half the side.
        assert_eq!((window.x, window.y), (350, 310));

        let small = inpaint_window(&region(400, 400, 20, 20), 2000, 2000).expect("window");
        assert_eq!((small.width, small.height), (256, 256), "a tiny box still gets the graph's own side");
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
        assert!(window.x + window.width <= 1000, "window {window:?} leaves the page");
        assert!(window.y + window.height <= 1200, "window {window:?} leaves the page");
    }

    #[test]
    fn a_page_smaller_than_the_graph_gives_a_window_of_the_whole_page() {
        // The shorter side is the ceiling, so the window cannot exceed the page.
        let window = inpaint_window(&region(0, 0, 3, 3), 200, 120).expect("window");
        assert_eq!(window, CropWindow { x: 0, y: 0, width: 120, height: 120 });
    }

    #[test]
    fn an_empty_or_off_page_region_is_rejected() {
        assert!(inpaint_window(&region(0, 0, 0, 10), 100, 100).is_err());
        assert!(inpaint_window(&region(100, 0, 10, 10), 100, 100).is_err());
        assert!(inpaint_window(&region(0, 0, 10, 10), 0, 100).is_err());
    }

    #[test]
    fn cropping_reads_the_window_rows_and_nothing_else() {
        // 3x2 page, one distinct value per pixel in the red channel.
        let mut page = Vec::new();
        for index in 0..6_u8 {
            page.extend_from_slice(&[index * 10, 0, 0, 255]);
        }
        let crop = crop_rgba(&page, 3, 2, &CropWindow { x: 1, y: 0, width: 2, height: 2 }).expect("crop");
        assert_eq!(crop.chunks_exact(4).map(|pixel| pixel[0]).collect::<Vec<_>>(), vec![10, 20, 40, 50]);
    }

    #[test]
    fn pasting_only_touches_the_masked_pixels_and_leaves_alpha_alone() {
        let mut page = vec![0_u8; 3 * 2 * 4];
        for pixel in page.chunks_exact_mut(4) {
            pixel[3] = 128;
        }
        let window = CropWindow { x: 1, y: 0, width: 2, height: 2 };
        let patch = vec![
            9, 9, 9, 255, 8, 8, 8, 255,
            7, 7, 7, 255, 6, 6, 6, 255,
        ];
        // Only the patch's top-right and bottom-left pixels are the model's.
        let mask = vec![0, 1, 1, 0];
        let written = paste_masked_rgba(&mut page, 3, 2, &window, &patch, &mask).expect("paste");
        assert_eq!(written, 2);

        let reds: Vec<u8> = page.chunks_exact(4).map(|pixel| pixel[0]).collect();
        assert_eq!(reds, vec![0, 0, 8, 0, 7, 0]);
        assert!(page.chunks_exact(4).all(|pixel| pixel[3] == 128), "alpha must survive the paste");
    }

    #[test]
    fn a_mismatched_patch_or_mask_is_rejected_rather_than_pasted_short() {
        let mut page = vec![0_u8; 4 * 4 * 4];
        let window = CropWindow { x: 0, y: 0, width: 2, height: 2 };
        assert!(paste_masked_rgba(&mut page, 4, 4, &window, &vec![0; 8], &vec![1; 4]).is_err());
        assert!(paste_masked_rgba(&mut page, 4, 4, &window, &vec![0; 16], &vec![1; 3]).is_err());
        let off_page = CropWindow { x: 3, y: 3, width: 2, height: 2 };
        assert!(paste_masked_rgba(&mut page, 4, 4, &off_page, &vec![0; 16], &vec![1; 4]).is_err());
    }

    #[test]
    fn thresholding_reports_an_empty_mask_instead_of_selecting_nothing_silently() {
        let (mask, selected) = threshold_mask(&[0.1, 0.9, f32::NAN, 0.5], 0.5);
        assert_eq!(mask, vec![0, 1, 0, 1]);
        assert_eq!(selected, 2);

        let (_, none) = threshold_mask(&[0.1, 0.2], 0.5);
        assert_eq!(none, 0, "a region that selects nothing must be reported, not pasted");
    }
}
