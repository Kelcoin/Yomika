//! 去码的**几何与合成**：一个检测框怎么变成一个方窗口、一扇窗口的结果怎么贴回页面。
//!
//! 这一份是从宿主的 `src/inference/decensor.rs` 搬过来的（docs/71 §11 Task 8 的
//! 「core decensor」那一格）：管道是「检测器找出被遮区域 → 修补模型一次填一个 →
//! 贴回页面」，其中**与任何具体模型无关**的那一半必须住在核心，因为 worker 要跑它
//! 而 worker 链接不了宿主的任何东西（docs/71 §5.2）。
//!
//! 搬运时一行算法都没改，只换了三处：错误类型换成核心的 [`ComputeError`]（宿主的
//! `InferenceError` 本来就是它的别名）、`Detection` 从 `inference/detect.rs` 搬到这里
//! （它是纯数据 + 一次投影）、以及测试跟着代码走。所以「哪些是模板、哪些是模型输出」
//! 这件事只有一份判据。
//!
//! 住在核心的**不是**这两份会话本体：检测器在 [`crate::detect`]（8-d 搬进来的，同一份
//! 代码，只有开会话那一层门 `ort`），修补模型在 [`crate::inpaint`]（已经在核心，只是要
//! `ort` feature）。第 19 轮（8-e）之后检测与修补都在 worker 里跑，宿主手里没有这两样。

use crate::cancel::CancelToken;
use crate::error::ComputeError;

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

/// One censored region the detector is confident about.
///
/// 它是检测器交给修补阶段的唯一形状——所以它住在核心：worker 要解析同一份东西，
/// 而「一个框算不算合法」这件事不允许两边各写一遍。
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub region: CensorRegion,
    pub score: f32,
    /// Binary mask over the region's own box, one byte per pixel, non-zero where
    /// the pixel is censored.
    pub mask: Vec<u8>,
}

impl Detection {
    /// The mask projected into a crop window, which is the coordinate space the
    /// inpainting stage works in. Pixels of the window outside this detection's
    /// box are not censored, so they stay zero.
    ///
    /// The mask is expected to hold one byte per box pixel, and
    /// [`validate_detection`] is what checks that before a page runs. The reads
    /// here stay in bounds regardless: a short mask must not read past its end and
    /// take the process down in the middle of a page.
    pub fn mask_in_window(&self, window: &CropWindow) -> Vec<u8> {
        let mut projected = vec![0_u8; window.width as usize * window.height as usize];
        for row in 0..self.region.height {
            let page_y = self.region.y + row;
            if page_y < window.y || page_y >= window.y + window.height {
                continue;
            }
            for column in 0..self.region.width {
                let page_x = self.region.x + column;
                if page_x < window.x || page_x >= window.x + window.width {
                    continue;
                }
                let source = (row * self.region.width + column) as usize;
                if self.mask.get(source).copied().unwrap_or(0) == 0 {
                    continue;
                }
                let target = (page_y - window.y) as usize * window.width as usize
                    + (page_x - window.x) as usize;
                projected[target] = 1;
            }
        }
        projected
    }
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
) -> Result<CropWindow, ComputeError> {
    if image_width == 0 || image_height == 0 {
        return Err(ComputeError::InvalidInput("page has no pixels".into()));
    }
    if region.width == 0 || region.height == 0 {
        return Err(ComputeError::InvalidInput("region has no pixels".into()));
    }
    let right = region
        .x
        .checked_add(region.width)
        .ok_or_else(|| ComputeError::InvalidInput("region width overflows".into()))?;
    let bottom = region
        .y
        .checked_add(region.height)
        .ok_or_else(|| ComputeError::InvalidInput("region height overflows".into()))?;
    if right > image_width || bottom > image_height {
        return Err(ComputeError::InvalidInput(format!(
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
        .ok_or_else(|| ComputeError::InvalidInput("region width overflows".into()))?;
    let center_y = region
        .y
        .checked_add(region.height / 2)
        .ok_or_else(|| ComputeError::InvalidInput("region height overflows".into()))?;
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
) -> Result<Vec<u8>, ComputeError> {
    if rgba.len() != image_width as usize * image_height as usize * 4 {
        return Err(ComputeError::InvalidInput(
            "RGBA page dimensions do not match".into(),
        ));
    }
    if !window_inside_page(window, image_width, image_height) {
        return Err(ComputeError::InvalidInput(
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
) -> Result<usize, ComputeError> {
    if page.len() != image_width as usize * image_height as usize * 4 {
        return Err(ComputeError::InvalidInput(
            "RGBA page dimensions do not match".into(),
        ));
    }
    let pixels = window.width as usize * window.height as usize;
    if patch.len() != pixels * 4 {
        return Err(ComputeError::InvalidInput(
            "patch dimensions do not match the window".into(),
        ));
    }
    if mask.len() != pixels {
        return Err(ComputeError::InvalidInput(
            "mask dimensions do not match the window".into(),
        ));
    }
    if !window_inside_page(window, image_width, image_height) {
        return Err(ComputeError::InvalidInput(
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

/// 一页上所有检测框的修补总流程：框一个接一个地跑，只有被遮像素归模型。
///
/// 它不认识任何模型——只拿一个 `inpaint` 闭包，让调用方决定用哪个会话（现在只有 worker 会
/// 传一份进来，`worker/src/decensor.rs`；宿主自己那层驻留会话已随 8-g③-iii 拆掉）。这正是它
/// 住核心的理由：「一个框变成一扇窗口、窗口的结果只贴回被遮的像素」这件事只该有一份判据。
///
/// 取消点在**框与框之间**：一页可能有几十个框，切页之后不该先把剩下十几个跑完。
pub fn inpaint_detections(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    regions: &[Detection],
    cancel: &CancelToken,
    mut inpaint: impl FnMut(CensorKind, &[u8], &CropWindow, &[u8]) -> Result<Vec<u8>, ComputeError>,
) -> Result<usize, ComputeError> {
    if regions.is_empty() {
        return Ok(0);
    }
    let original = rgba.to_vec();
    let mut filled = 0;
    for detection in regions {
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
/// 宿主的 `inference::detect::decode_detections` 已经把模型吐出来的东西夹进页面，
/// so this is aimed at the other producers —— 一份损坏的检测集、一只手工搭出来的框、
/// 将来的另一个检测器 —— where the box is the only thing between the pipeline and a
/// wrong window: `crop_rgba`'s own check cannot help, because the window it is handed
/// has already been translated back inside the page.
pub fn validate_detection(
    detection: &Detection,
    image_width: u32,
    image_height: u32,
) -> Result<(), ComputeError> {
    let region = &detection.region;
    if region.width == 0 || region.height == 0 {
        return Err(ComputeError::InvalidInput("region has no pixels".into()));
    }
    let right = region
        .x
        .checked_add(region.width)
        .ok_or_else(|| ComputeError::InvalidInput("region width overflows".into()))?;
    let bottom = region
        .y
        .checked_add(region.height)
        .ok_or_else(|| ComputeError::InvalidInput("region height overflows".into()))?;
    if right > image_width || bottom > image_height {
        return Err(ComputeError::InvalidInput(format!(
            "region {}x{}+{}+{} leaves the {image_width}x{image_height} page",
            region.width, region.height, region.x, region.y
        )));
    }
    // The mask is one byte per box pixel; a shorter one would be read past its end
    // while projecting it into the window.
    let expected = region.width as usize * region.height as usize;
    if detection.mask.len() != expected || !detection.score.is_finite() {
        return Err(ComputeError::InvalidInput(format!(
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
            .map(|x| Detection {
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
            &CancelToken::none(),
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
        let short = Detection {
            region: region(0, 0, 2, 2),
            score: 1.0,
            mask: vec![1, 1, 1],
        };
        assert!(validate_detection(&short, 4, 4).is_err());
        let mismatched = Detection {
            region: region(0, 0, 2, 2),
            score: 1.0,
            mask: vec![1, 1, 1, 1, 1],
        };
        assert!(validate_detection(&mismatched, 4, 4).is_err());
        let good = Detection {
            region: region(0, 0, 2, 2),
            score: 1.0,
            mask: vec![1, 0, 0, 1],
        };
        assert!(validate_detection(&good, 4, 4).is_ok());
        // A non-finite score is a broken detection too: it says nothing about how
        // much the model believed this box.
        let not_a_number = Detection {
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
            .map(|index| Detection {
                region: region(index * 8, 0, 4, 4),
                score: 1.0,
                mask: vec![1; 16],
            })
            .collect();
        let guard = crate::cancel::begin(Some("decensor-cancel-test"));
        let cancel = guard.token();
        let mut runs = 0;
        let error = inpaint_detections(&mut page, 64, 64, &detections, &cancel, |_, _, window, _| {
            runs += 1;
            // 第二个框跑到一半时用户切了页。
            if runs == 2 {
                crate::cancel::cancel("decensor-cancel-test");
            }
            Ok(vec![255, 0, 0, 255].repeat((window.width * window.height) as usize))
        })
        .expect_err("cancel must surface as Cancelled");
        assert_eq!(error, ComputeError::Cancelled);
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
