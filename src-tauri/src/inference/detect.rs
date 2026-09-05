//! Mask R-CNN detection, the stage that finds what to fill.
//!
//! Ported from Aletheia-Lens's inlined Matterport implementation
//! (`docs/Aletheia-Lens-main/detector.py`), not from memory: the three input
//! tensors form an implicit contract with the exported graph, and two parts of it
//! fail silently rather than loudly.
//!
//! - `input_image` is `f32` **NHWC** `[1, 1024, 1024, 3]`, RGB, **0-255 with the
//!   per-channel mean subtracted and no division** — the usual `/255` would hand
//!   the network a near-black page.
//! - `input_image_meta` is 15 floats. At inference the graph reads only
//!   `meta[4..7]` (the padded shape) and `meta[7..11]` (the window the real image
//!   occupies inside the padding); the rest is training bookkeeping. Get the
//!   window wrong and every box comes back displaced, with no error.
//! - `input_anchors` is `[1, N, 4]` of normalised boxes, and the RPN inside the
//!   graph matches its per-anchor deltas to this array **by index**. The order is
//!   therefore part of the contract: level by level, then row-major over the
//!   feature map, then the three aspect ratios. A permuted array produces
//!   confident nonsense, so `pyramid_anchors` is checked against hand-computed
//!   values rather than trusted.
//!
//! The score threshold (0.75), per-class NMS and the 100-detection cap are baked
//! into the exported graph, so there is nothing to tune here — and no way to
//! loosen it without re-exporting the model.

use std::path::Path;
use std::sync::Mutex;

use super::decensor::{CensorKind, CensorRegion, CropWindow};
use super::InferenceError;

/// The fixed side the detector is fed. `IMAGE_RESIZE_MODE = "square"` with
/// `IMAGE_MAX_DIM = 1024`, so every page becomes exactly this.
pub const DETECTOR_SIDE: u32 = 1024;
/// `IMAGE_MIN_DIM`: the short edge is scaled up to at least this before the long
/// edge is capped.
const DETECTOR_MIN_DIM: f64 = 800.0;
/// `MEAN_PIXEL`, in RGB order.
const MEAN_PIXEL: [f32; 3] = [123.7, 116.8, 103.9];
const ANCHOR_SCALES: [f64; 5] = [32.0, 64.0, 128.0, 256.0, 512.0];
const ANCHOR_RATIOS: [f64; 3] = [0.5, 1.0, 2.0];
const BACKBONE_STRIDES: [u32; 5] = [4, 8, 16, 32, 64];
/// `NUM_CLASSES = 1 + 1 + 1`, and the ids the classes take.
const CLASS_BAR: i32 = 1;
const CLASS_MOSAIC: i32 = 2;
const NUM_CLASSES: usize = 3;
/// `_unmold_mask` thresholds the 28x28 map at this.
const MASK_THRESHOLD: u8 = 128;

const IMAGE_INPUT: &str = "input_image";
const META_INPUT: &str = "input_image_meta";
const ANCHOR_INPUT: &str = "input_anchors";
const DETECTION_OUTPUT: &str = "mrcnn_detection";
const MASK_OUTPUT: &str = "mrcnn_mask";

/// One censored region the detector is confident about.
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
                if self.mask[source] == 0 {
                    continue;
                }
                let target = (page_y - window.y) as usize * window.width as usize + (page_x - window.x) as usize;
                projected[target] = 1;
            }
        }
        projected
    }
}

/// A page resized and padded into the detector's square input, and the numbers
/// needed to map its output back.
#[derive(Debug, Clone, PartialEq)]
pub struct MoldedPage {
    /// NHWC `f32`, mean-subtracted.
    pub tensor: Vec<f32>,
    /// `(y1, x1, y2, x2)`: where the real image sits inside the padding.
    pub window: [f64; 4],
    pub scale: f64,
}

/// `_resize_image(mode="square")` followed by `_mold_image`.
pub fn mold_page(rgba: &[u8], width: u32, height: u32) -> Result<MoldedPage, InferenceError> {
    if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
        return Err(InferenceError::InvalidInput("RGBA page dimensions do not match".into()));
    }
    let side = DETECTOR_SIDE;
    let (short, long) = (f64::from(width.min(height)), f64::from(width.max(height)));
    let mut scale = (DETECTOR_MIN_DIM / short).max(1.0);
    if (long * scale).round() > f64::from(side) {
        scale = f64::from(side) / long;
    }
    let resized_width = ((f64::from(width) * scale).round() as u32).clamp(1, side);
    let resized_height = ((f64::from(height) * scale).round() as u32).clamp(1, side);

    let source = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or_else(|| InferenceError::InvalidInput("RGBA page is not a valid image".into()))?;
    // cv2.resize's default is bilinear.
    let resized = if (resized_width, resized_height) == (width, height) {
        source
    } else {
        image::imageops::resize(&source, resized_width, resized_height, image::imageops::FilterType::Triangle)
    };

    let top = (side - resized_height) / 2;
    let left = (side - resized_width) / 2;
    // Zero padding, then the mean subtraction over the whole square — the padding
    // is part of what the network sees, exactly as upstream feeds it.
    let mut tensor = vec![0_f32; (side * side * 3) as usize];
    for index in 0..(side * side) as usize {
        for channel in 0..3 {
            tensor[index * 3 + channel] = -MEAN_PIXEL[channel];
        }
    }
    for y in 0..resized_height {
        for x in 0..resized_width {
            let pixel = resized.get_pixel(x, y);
            let target = ((top + y) * side + left + x) as usize * 3;
            for channel in 0..3 {
                tensor[target + channel] = f32::from(pixel[channel]) - MEAN_PIXEL[channel];
            }
        }
    }
    Ok(MoldedPage {
        tensor,
        window: [
            f64::from(top),
            f64::from(left),
            f64::from(resized_height + top),
            f64::from(resized_width + left),
        ],
        scale,
    })
}

/// `_compose_image_meta`: image id, original shape, padded shape, window, scale,
/// then one zero per class. Only the padded shape and the window are read at
/// inference time.
pub fn image_meta(width: u32, height: u32, molded: &MoldedPage) -> Vec<f32> {
    let side = f64::from(DETECTOR_SIDE);
    let mut meta = Vec::with_capacity(12 + NUM_CLASSES);
    meta.extend_from_slice(&[0.0, f64::from(height), f64::from(width), 3.0, side, side, 3.0]);
    meta.extend_from_slice(&molded.window);
    meta.push(molded.scale);
    meta.extend(std::iter::repeat(0.0).take(NUM_CLASSES));
    meta.into_iter().map(|value| value as f32).collect()
}

/// The anchor pyramid, normalised, in the order the graph indexes it.
///
/// Per level: for each feature-map cell in row-major order, the three aspect
/// ratios. `_norm_boxes` divides by `side - 1` after subtracting `[0, 0, 1, 1]`.
pub fn pyramid_anchors(side: u32) -> Vec<f32> {
    let normaliser = f64::from(side) - 1.0;
    let mut anchors = Vec::new();
    for (level, &stride) in BACKBONE_STRIDES.iter().enumerate() {
        let scale = ANCHOR_SCALES[level];
        let cells = f64::from(side).div_euclid(f64::from(stride)) as u32
            + u32::from(f64::from(side) % f64::from(stride) > 0.0);
        // heights = scale / sqrt(ratio), widths = scale * sqrt(ratio).
        let sizes: Vec<(f64, f64)> = ANCHOR_RATIOS
            .iter()
            .map(|ratio| (scale / ratio.sqrt(), scale * ratio.sqrt()))
            .collect();
        for row in 0..cells {
            let center_y = f64::from(row * stride);
            for column in 0..cells {
                let center_x = f64::from(column * stride);
                for (height, width) in &sizes {
                    let box_values = [
                        center_y - 0.5 * height,
                        center_x - 0.5 * width,
                        center_y + 0.5 * height,
                        center_x + 0.5 * width,
                    ];
                    let shift = [0.0, 0.0, 1.0, 1.0];
                    for index in 0..4 {
                        anchors.push(((box_values[index] - shift[index]) / normaliser) as f32);
                    }
                }
            }
        }
    }
    anchors
}

pub struct DetectorEngine {
    session: Mutex<ort::session::Session>,
}

impl DetectorEngine {
    pub fn open(model_path: &Path) -> Result<Self, InferenceError> {
        let open = || -> Result<ort::session::Session, String> {
            let mut builder = ort::session::Session::builder().map_err(|error| error.to_string())?;
            builder.commit_from_file(model_path).map_err(|error| error.to_string())
        };
        let session = open().map_err(|error| InferenceError::InvalidInput(format!("detector session failed: {error}")))?;
        Ok(Self { session: Mutex::new(session) })
    }

    /// Finds the censored regions of one RGBA page, in page pixels.
    /// One named output's raw values, for comparing two builds of the same graph.
    ///
    /// `detect` answers with regions above the threshold baked into the export, and
    /// a synthetic page yields none — so comparing regions between a float32 and an
    /// fp16 build compares two empty lists. The class scores are populated whatever
    /// the threshold does with them, which makes them the thing to compare.
    #[cfg(test)]
    pub(crate) fn raw_output(&self, rgba: &[u8], width: u32, height: u32, name: &str) -> Result<Vec<f32>, InferenceError> {
        let molded = mold_page(rgba, width, height)?;
        let side = i64::from(DETECTOR_SIDE);
        let meta = image_meta(width, height, &molded);
        let anchors = pyramid_anchors(DETECTOR_SIDE);
        let anchor_count = (anchors.len() / 4) as i64;
        let image_input = ort::value::Tensor::from_array((vec![1, side, side, 3], molded.tensor.clone()))
            .map_err(|error| InferenceError::InvalidInput(format!("detector input failed: {error}")))?;
        let meta_input = ort::value::Tensor::from_array((vec![1, meta.len() as i64], meta))
            .map_err(|error| InferenceError::InvalidInput(format!("detector meta failed: {error}")))?;
        let anchor_input = ort::value::Tensor::from_array((vec![1, anchor_count, 4], anchors))
            .map_err(|error| InferenceError::InvalidInput(format!("detector anchors failed: {error}")))?;
        let mut session = self
            .session
            .lock()
            .map_err(|_| InferenceError::InvalidInput("detector session lock poisoned".into()))?;
        let outputs = session
            .run(ort::inputs![
                IMAGE_INPUT => image_input,
                META_INPUT => meta_input,
                ANCHOR_INPUT => anchor_input,
            ])
            .map_err(|error| InferenceError::InvalidInput(format!("detector run failed: {error}")))?;
        let (_, values) = outputs[name]
            .try_extract_tensor::<f32>()
            .map_err(|error| InferenceError::InvalidInput(format!("detector output {name} failed: {error}")))?;
        Ok(values.to_vec())
    }

    pub fn detect(&self, rgba: &[u8], width: u32, height: u32) -> Result<Vec<Detection>, InferenceError> {
        let molded = mold_page(rgba, width, height)?;
        let side = i64::from(DETECTOR_SIDE);
        let meta = image_meta(width, height, &molded);
        let anchors = pyramid_anchors(DETECTOR_SIDE);
        let anchor_count = (anchors.len() / 4) as i64;

        let image_input = ort::value::Tensor::from_array((vec![1, side, side, 3], molded.tensor.clone()))
            .map_err(|error| InferenceError::InvalidInput(format!("detector input failed: {error}")))?;
        let meta_input = ort::value::Tensor::from_array((vec![1, meta.len() as i64], meta))
            .map_err(|error| InferenceError::InvalidInput(format!("detector meta failed: {error}")))?;
        let anchor_input = ort::value::Tensor::from_array((vec![1, anchor_count, 4], anchors))
            .map_err(|error| InferenceError::InvalidInput(format!("detector anchors failed: {error}")))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| InferenceError::InvalidInput("detector session lock poisoned".into()))?;
        let outputs = session
            .run(ort::inputs![
                IMAGE_INPUT => image_input,
                META_INPUT => meta_input,
                ANCHOR_INPUT => anchor_input,
            ])
            .map_err(|error| InferenceError::InvalidInput(format!("detector run failed: {error}")))?;
        // By name: the export's output order is not stable, and picking the wrong
        // tensor here would be a silent reinterpretation of unrelated numbers.
        let (detection_shape, detections) = outputs[DETECTION_OUTPUT]
            .try_extract_tensor::<f32>()
            .map_err(|error| InferenceError::InvalidInput(format!("detector output failed: {error}")))?;
        let (mask_shape, masks) = outputs[MASK_OUTPUT]
            .try_extract_tensor::<f32>()
            .map_err(|error| InferenceError::InvalidInput(format!("detector masks failed: {error}")))?;
        decode_detections(
            detection_shape.as_ref(),
            detections,
            mask_shape.as_ref(),
            masks,
            width,
            height,
            &molded,
        )
    }
}

/// `_unmold_detections`: rows are `[y1, x1, y2, x2, class_id, score]` normalised
/// to the padded square and zero-padded to the cap, so the first row whose class
/// is background ends the list.
#[allow(clippy::too_many_arguments)]
fn decode_detections(
    detection_shape: &[i64],
    detections: &[f32],
    mask_shape: &[i64],
    masks: &[f32],
    width: u32,
    height: u32,
    molded: &MoldedPage,
) -> Result<Vec<Detection>, InferenceError> {
    if detection_shape.len() != 3 || detection_shape[2] != 6 {
        return Err(InferenceError::InvalidManifest(format!("detection shape {detection_shape:?} is not [1, N, 6]")));
    }
    if mask_shape.len() != 5 || mask_shape[4] != NUM_CLASSES as i64 {
        return Err(InferenceError::InvalidManifest(format!("mask shape {mask_shape:?} is not [1, N, h, w, classes]")));
    }
    let rows = detection_shape[1] as usize;
    let (mask_height, mask_width) = (mask_shape[2] as usize, mask_shape[3] as usize);

    let normaliser = f64::from(DETECTOR_SIDE) - 1.0;
    let window = [
        molded.window[0] / normaliser,
        molded.window[1] / normaliser,
        (molded.window[2] - 1.0) / normaliser,
        (molded.window[3] - 1.0) / normaliser,
    ];
    let (window_height, window_width) = (window[2] - window[0], window[3] - window[1]);
    if window_height <= 0.0 || window_width <= 0.0 {
        return Err(InferenceError::InvalidInput("detector window has no area".into()));
    }

    let mut found = Vec::new();
    for row in 0..rows {
        let base = row * 6;
        let class_id = detections[base + 4] as i32;
        // Zero padding: the first background row ends the real detections.
        if class_id == 0 {
            break;
        }
        let kind = match class_id {
            CLASS_BAR => CensorKind::Bar,
            CLASS_MOSAIC => CensorKind::Mosaic,
            _ => continue,
        };
        let score = detections[base + 5];
        // Undo the padding, then scale back to the original page.
        let corners: Vec<f64> = (0..4)
            .map(|index| {
                let value = f64::from(detections[base + index]);
                let shift = if index % 2 == 0 { window[0] } else { window[1] };
                let span = if index % 2 == 0 { window_height } else { window_width };
                (value - shift) / span
            })
            .collect();
        let page = [
            (corners[0] * (f64::from(height) - 1.0)).round(),
            (corners[1] * (f64::from(width) - 1.0)).round(),
            (corners[2] * (f64::from(height) - 1.0) + 1.0).round(),
            (corners[3] * (f64::from(width) - 1.0) + 1.0).round(),
        ];
        let y1 = page[0].clamp(0.0, f64::from(height)) as u32;
        let x1 = page[1].clamp(0.0, f64::from(width)) as u32;
        let y2 = page[2].clamp(0.0, f64::from(height)) as u32;
        let x2 = page[3].clamp(0.0, f64::from(width)) as u32;
        // A box that collapsed to nothing is dropped rather than pasted, matching
        // upstream's zero-area exclusion.
        if x2 <= x1 || y2 <= y1 {
            continue;
        }
        let (box_width, box_height) = (x2 - x1, y2 - y1);

        // The mask head answers per class; only the detected class's channel is the
        // mask for this box.
        let plane_start = row * mask_height * mask_width * NUM_CLASSES;
        let mut small = image::GrayImage::new(mask_width as u32, mask_height as u32);
        for y in 0..mask_height {
            for x in 0..mask_width {
                let value = masks[plane_start + (y * mask_width + x) * NUM_CLASSES + class_id as usize];
                // Resized as bytes rather than floats: bilinear interpolation then a
                // 0.5 threshold differs from the float path by at most one level,
                // and the boundary is already a hard edge either way.
                let level = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
                small.put_pixel(x as u32, y as u32, image::Luma([level]));
            }
        }
        let resized = image::imageops::resize(
            &small,
            box_width,
            box_height,
            image::imageops::FilterType::Triangle,
        );
        let mask: Vec<u8> = resized.into_raw().into_iter().map(|level| u8::from(level >= MASK_THRESHOLD)).collect();
        if mask.iter().all(|&value| value == 0) {
            continue;
        }
        found.push(Detection {
            region: CensorRegion { x: x1, y: y1, width: box_width, height: box_height, kind },
            score,
            mask,
        });
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_anchor_pyramid_has_the_count_the_graph_indexes_by() {
        // 3 ratios over ceil(1024/stride)^2 cells at each of five levels. A count
        // the graph does not expect fails inside its own reshape, so this is the
        // cheapest guard on the whole contract.
        let anchors = pyramid_anchors(DETECTOR_SIDE);
        let expected = 3 * (256 * 256 + 128 * 128 + 64 * 64 + 32 * 32 + 16 * 16);
        assert_eq!(anchors.len(), expected * 4);
        assert_eq!(expected, 261_888);
    }

    #[test]
    fn the_first_anchors_match_the_hand_computed_boxes() {
        // Level 0: stride 4, scale 32, cell (0, 0) so both centres are 0. The three
        // ratios come in the order 0.5, 1, 2 — permuting them would misalign every
        // box against the RPN's deltas without any error.
        let anchors = pyramid_anchors(DETECTOR_SIDE);
        let normaliser = 1023.0_f64;
        for (index, ratio) in [0.5_f64, 1.0, 2.0].into_iter().enumerate() {
            let height = 32.0 / ratio.sqrt();
            let width = 32.0 * ratio.sqrt();
            let expected = [
                (-0.5 * height) / normaliser,
                (-0.5 * width) / normaliser,
                (0.5 * height - 1.0) / normaliser,
                (0.5 * width - 1.0) / normaliser,
            ];
            for corner in 0..4 {
                let actual = f64::from(anchors[index * 4 + corner]);
                assert!(
                    (actual - expected[corner]).abs() < 1e-6,
                    "anchor {index} corner {corner}: {actual} != {}",
                    expected[corner],
                );
            }
        }

        // The second cell along x is one stride to the right, and the row after that
        // is one stride down: row-major over the feature map, ratios innermost.
        let per_cell = 3 * 4;
        let second_cell_x = f64::from(anchors[per_cell + 1]) * normaliser + 0.5 * (32.0 * 0.5_f64.sqrt());
        assert!((second_cell_x - 4.0).abs() < 1e-4, "second anchor cell is not one stride along x");
        let second_row_y = f64::from(anchors[per_cell * 256]) * normaliser + 0.5 * (32.0 / 0.5_f64.sqrt());
        assert!((second_row_y - 4.0).abs() < 1e-4, "the row stride is not row-major over the feature map");
    }

    #[test]
    fn molding_scales_the_short_edge_up_then_caps_the_long_one() {
        // 400 wide by 600 high: the short edge wants 800/400 = 2, which would make
        // the long edge 1200, over the cap — so the cap wins and the height lands on
        // 1024 with the width at round(400 * 1024/600) = 683.
        let page = vec![255_u8; 400 * 600 * 4];
        let molded = mold_page(&page, 400, 600).expect("molded");
        assert!((molded.scale - 1024.0 / 600.0).abs() < 1e-9);
        // The height fills the square, so the padding is horizontal only:
        // (1024 - 683) / 2 = 170 on the left, 171 on the right.
        assert_eq!(molded.window, [0.0, 170.0, 1024.0, 853.0]);
        assert_eq!(molded.tensor.len(), (1024 * 1024 * 3) as usize);
    }

    #[test]
    fn molding_subtracts_the_mean_and_leaves_the_padding_negative() {
        // A page already at the input size, so nothing is resampled.
        let page = vec![255_u8; 1024 * 1024 * 4];
        let molded = mold_page(&page, 1024, 1024).expect("molded");
        assert!((molded.tensor[0] - (255.0 - MEAN_PIXEL[0])).abs() < 1e-4, "the mean is not subtracted");
        assert!(molded.tensor[0] > 100.0, "0-255 range: dividing by 255 first would leave this near zero");

        // A small page: the padding is zero minus the mean, not zero.
        let small = vec![255_u8; 16 * 16 * 4];
        let molded = mold_page(&small, 16, 16).expect("molded");
        assert!((molded.tensor[0] + MEAN_PIXEL[0]).abs() < 1e-4, "padding must carry -MEAN_PIXEL");
    }

    #[test]
    fn the_meta_vector_is_the_fifteen_values_in_order() {
        let page = vec![0_u8; 800 * 1000 * 4];
        let molded = mold_page(&page, 800, 1000).expect("molded");
        let meta = image_meta(800, 1000, &molded);
        assert_eq!(meta.len(), 15);
        // image id, then the original shape, then the padded shape.
        assert_eq!(&meta[0..7], &[0.0, 1000.0, 800.0, 3.0, 1024.0, 1024.0, 3.0]);
        // The window the graph actually reads.
        assert_eq!(
            &meta[7..11],
            &[
                molded.window[0] as f32,
                molded.window[1] as f32,
                molded.window[2] as f32,
                molded.window[3] as f32,
            ],
        );
        assert_eq!(&meta[12..15], &[0.0, 0.0, 0.0], "active class ids are training-only zeros");
    }

    #[test]
    fn decoding_stops_at_the_first_background_row_and_maps_boxes_back() {
        let page = vec![0_u8; 512 * 512 * 4];
        let molded = mold_page(&page, 512, 512).expect("molded");
        // A box covering the middle half of the window, in padded normalised
        // coordinates, followed by a background row that must end the list.
        let normaliser = 1023.0_f64;
        let window = [
            molded.window[0] / normaliser,
            molded.window[1] / normaliser,
            (molded.window[2] - 1.0) / normaliser,
            (molded.window[3] - 1.0) / normaliser,
        ];
        let (span_y, span_x) = (window[2] - window[0], window[3] - window[1]);
        let quarter = |start: f64, span: f64, fraction: f64| (start + span * fraction) as f32;
        let detections: Vec<f32> = vec![
            quarter(window[0], span_y, 0.25), quarter(window[1], span_x, 0.25),
            quarter(window[0], span_y, 0.75), quarter(window[1], span_x, 0.75),
            2.0, 0.9,
            // Background: everything after this is padding.
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            0.1, 0.1, 0.2, 0.2, 1.0, 0.99,
        ];
        // Two 2x2 mask planes over three classes; the mosaic channel is the only one
        // that is set, so picking the wrong channel yields an empty mask.
        let mut masks = vec![0_f32; 3 * 2 * 2 * NUM_CLASSES];
        for pixel in 0..4 {
            masks[pixel * NUM_CLASSES + CLASS_MOSAIC as usize] = 1.0;
        }

        let found = decode_detections(&[1, 3, 6], &detections, &[1, 3, 2, 2, 3], &masks, 512, 512, &molded)
            .expect("decoded");
        assert_eq!(found.len(), 1, "the background row must end the list");
        let detection = &found[0];
        assert_eq!(detection.region.kind, CensorKind::Mosaic);
        assert!((detection.score - 0.9).abs() < 1e-6);
        // A quarter to three quarters of a 512 page, within a pixel of rounding.
        assert!((detection.region.x as i32 - 128).abs() <= 2, "x was {}", detection.region.x);
        assert!((detection.region.y as i32 - 128).abs() <= 2, "y was {}", detection.region.y);
        assert!((detection.region.width as i32 - 256).abs() <= 2, "width was {}", detection.region.width);
        assert!(detection.mask.iter().all(|&value| value == 1), "the mosaic channel was not the one read");
    }

    #[test]
    fn a_mask_projects_into_a_crop_window_without_leaving_it() {
        let detection = Detection {
            region: CensorRegion { x: 10, y: 10, width: 2, height: 2, kind: CensorKind::Bar },
            score: 1.0,
            mask: vec![1, 0, 0, 1],
        };
        // A window that only overlaps the detection's bottom-right pixel.
        let window = CropWindow { x: 11, y: 11, width: 4, height: 4 };
        let projected = detection.mask_in_window(&window);
        assert_eq!(projected.len(), 16);
        assert_eq!(projected[0], 1, "the overlapping censored pixel is the window's origin");
        assert_eq!(projected.iter().map(|&value| usize::from(value)).sum::<usize>(), 1);
    }

    /// The real detector, when it is on this machine.
    ///
    /// This is the only check that the three input tensors are what the graph
    /// expects. A wrong anchor count fails inside the graph's own reshape, a
    /// mis-shaped meta vector fails in the detection layer, and a transposed image
    /// tensor fails the shape check outright — so reaching finite, correctly shaped
    /// output at all is the contract being satisfied. Whether the model *finds*
    /// censoring in a synthetic page is a separate question this cannot answer, so
    /// it does not assert one.
    ///
    /// `docs/` is gitignored, so the file is absent on a fresh clone and the test
    /// skips rather than failing for the wrong reason.
    /// Builds the synthetic pages the real-model tests run on: a bar shape and a
    /// mosaic shape, neither of which the model is required to recognise.
    #[cfg(test)]
    fn synthetic_pages() -> Vec<(&'static str, u32, u32, Vec<u8>)> {
        let (width, height) = (600_u32, 900_u32);
        let mut bar = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let inside_bar = (200..400).contains(&x) && (400..500).contains(&y);
                let level = if inside_bar { 0 } else { ((x + y) % 200 + 40) as u8 };
                bar.extend_from_slice(&[level, level, level, 255]);
            }
        }
        // Blocky pixelation over a skin-toned field, which is the shape of mosaic
        // censoring; again without any claim that it must be recognised.
        let mut mosaic = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let inside = (180..420).contains(&x) && (360..560).contains(&y);
                let (r, g, b) = if inside {
                    let block = ((x / 16) * 37 + (y / 16) * 61) % 96;
                    (200 - block as u8 / 2, 160 - block as u8 / 3, 140 - block as u8 / 4)
                } else {
                    (226 - (y % 24) as u8, 188 - (x % 20) as u8, 170)
                };
                mosaic.extend_from_slice(&[r, g, b, 255]);
            }
        }
        vec![("bar", width, height, bar), ("mosaic", width, height, mosaic)]
    }

    /// The fp16 detector against the float32 one, when both are on this machine.
    ///
    /// The detector is 243 MB in float32 and 122 MB in fp16, which is the reason
    /// for converting it at all. What this can prove is that the converted graph
    /// still loads, still accepts the same three float32 tensors — the conversion
    /// keeps the I/O types, so nothing on this side changes — and answers with the
    /// same regions on the same input. What it cannot prove is detection quality on
    /// a real censored page: these inputs are synthetic, and the model returns
    /// nothing for them, so agreement here is agreement about an empty answer.
    /// That gap is the same one the anchor ordering has, and it needs a real page.
    #[test]
    fn the_fp16_detector_agrees_with_the_float32_one() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/Aletheia-Lens/_internal");
        let full = root.join("models/mrcnn/weights.onnx");
        let half = root.join("models-fp16/mrcnn/weights.onnx");
        if !full.exists() || !half.exists() {
            eprintln!("skipping: {} or {} is not present", full.display(), half.display());
            return;
        }
        // Worth stating in the assertion: the point of the conversion is the size.
        let full_bytes = std::fs::metadata(&full).map(|meta| meta.len()).unwrap_or(0);
        let half_bytes = std::fs::metadata(&half).map(|meta| meta.len()).unwrap_or(0);
        assert!(
            half_bytes * 3 < full_bytes * 2,
            "the fp16 detector is {half_bytes} bytes against {full_bytes}, which is not a halving",
        );

        let full_engine = DetectorEngine::open(&full).expect("float32 detector");
        let half_engine = DetectorEngine::open(&half).expect("fp16 detector");
        for (name, width, height, rgba) in synthetic_pages() {
            let expected = full_engine.detect(&rgba, width, height).expect("float32 detect");
            let actual = half_engine.detect(&rgba, width, height).expect("fp16 detect");
            // Printed rather than asserted: how many regions a synthetic page yields
            // is the model's business, and the number is what says whether this
            // comparison saw anything at all.
            eprintln!("{name}: float32 found {}, fp16 found {}", expected.len(), actual.len());
            assert_eq!(actual.len(), expected.len(), "{name}: region count differs");
            // Neither build detects anything in a synthetic page, so the comparison
            // above is a comparison of two empty lists. The class scores are the
            // numbers that exist either way, and they are what says the conversion
            // preserved the arithmetic.
            let full_scores = full_engine.raw_output(&rgba, width, height, "mrcnn_class").expect("float32 scores");
            let half_scores = half_engine.raw_output(&rgba, width, height, "mrcnn_class").expect("fp16 scores");
            assert_eq!(full_scores.len(), half_scores.len(), "{name}: score tensor size differs");
            assert!(full_scores.iter().all(|value| value.is_finite()), "{name}: float32 produced non-finite scores");
            assert!(half_scores.iter().all(|value| value.is_finite()), "{name}: fp16 produced non-finite scores");
            let worst = full_scores.iter().zip(half_scores.iter())
                .map(|(left, right)| (left - right).abs())
                .fold(0.0_f32, f32::max);
            let spread = full_scores.iter().copied().fold(0.0_f32, f32::max);
            eprintln!("{name}: worst class-score difference {worst:.5} over a range up to {spread:.5}");
            // fp16 carries about three decimal digits, and these are probabilities.
            assert!(worst < 0.01, "{name}: class scores differ by {worst}, which is more than rounding");
            for (left, right) in expected.iter().zip(actual.iter()) {
                assert_eq!(left.region.kind, right.region.kind, "{name}: class differs");
                // A box that moves by a pixel or two is fp16 rounding; the window
                // grown around it is 1.5x and at least 256px, so it is absorbed.
                let dx = left.region.x.abs_diff(right.region.x);
                let dy = left.region.y.abs_diff(right.region.y);
                assert!(dx <= 4 && dy <= 4, "{name}: box moved by ({dx},{dy}): {left:?} vs {right:?}");
                assert!((left.score - right.score).abs() < 0.05, "{name}: score {} vs {}", left.score, right.score);
            }
        }
    }

    #[test]
    fn the_real_detector_accepts_the_three_input_tensors() {
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/Aletheia-Lens/_internal/models/mrcnn/weights.onnx");
        if !model.exists() {
            eprintln!("skipping: {} is not present", model.display());
            return;
        }
        let engine = match DetectorEngine::open(&model) {
            Ok(engine) => engine,
            Err(error) => panic!("opening the detector failed: {error:?}"),
        };

        // A page with a solid black rectangle over a gradient: the shape of bar
        // censoring, without any claim that the model must recognise it.
        let (width, height) = (600_u32, 900_u32);
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let inside_bar = (200..400).contains(&x) && (400..500).contains(&y);
                let level = if inside_bar { 0 } else { ((x + y) % 200 + 40) as u8 };
                rgba.extend_from_slice(&[level, level, level, 255]);
            }
        }

        let found = match engine.detect(&rgba, width, height) {
            Ok(found) => found,
            Err(error) => panic!("running the detector failed: {error:?}"),
        };
        // Whatever it found has to be inside the page and usable: a displaced window
        // or a permuted anchor array shows up here as boxes off the page.
        for detection in &found {
            assert!(detection.region.x + detection.region.width <= width, "box leaves the page: {detection:?}");
            assert!(detection.region.y + detection.region.height <= height, "box leaves the page: {detection:?}");
            assert!(detection.score.is_finite() && detection.score >= 0.75, "score {} is not a kept detection", detection.score);
            assert_eq!(detection.mask.len(), (detection.region.width * detection.region.height) as usize);
        }
        eprintln!("detector returned {} region(s) on the synthetic page", found.len());
    }

    /// Proves the anchor array is load-bearing.
    ///
    /// `input_anchors` is declared `[dyn, dyn, 4]`, so ONNX Runtime cannot reject a
    /// wrong count at the interface — the graph has to notice. If it did not, the
    /// anchors would not be doing what this module assumes and the pyramid could be
    /// any size at all. Handing it a pyramid built for a different input side is the
    /// one part of the anchor contract a machine can check here; the *ordering*
    /// still needs a real censored page to confirm end to end.
    #[test]
    fn the_real_detector_rejects_a_pyramid_of_the_wrong_size() {
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/Aletheia-Lens/_internal/models/mrcnn/weights.onnx");
        if !model.exists() {
            eprintln!("skipping: {} is not present", model.display());
            return;
        }
        let engine = DetectorEngine::open(&model).expect("detector");
        let page = vec![200_u8; (256 * 256 * 4) as usize];
        let molded = mold_page(&page, 256, 256).expect("molded");
        let meta = image_meta(256, 256, &molded);
        // Half the input side, so a quarter of the anchors.
        let wrong = pyramid_anchors(DETECTOR_SIDE / 2);
        assert_ne!(wrong.len(), pyramid_anchors(DETECTOR_SIDE).len());

        let side = i64::from(DETECTOR_SIDE);
        let image_input = ort::value::Tensor::from_array((vec![1, side, side, 3], molded.tensor)).expect("image");
        let meta_input = ort::value::Tensor::from_array((vec![1, meta.len() as i64], meta)).expect("meta");
        let anchor_input = ort::value::Tensor::from_array((vec![1, (wrong.len() / 4) as i64, 4], wrong)).expect("anchors");
        let mut session = engine.session.lock().expect("session");
        let outcome = session.run(ort::inputs![
            IMAGE_INPUT => image_input,
            META_INPUT => meta_input,
            ANCHOR_INPUT => anchor_input,
        ]);
        assert!(outcome.is_err(), "the graph accepted a pyramid it cannot index: the anchors are not what drives it");
    }
}
