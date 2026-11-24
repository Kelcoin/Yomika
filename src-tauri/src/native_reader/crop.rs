use std::io::{Read, Seek};
use std::time::Instant;

use image::{GenericImageView, ImageFormat, ImageReader};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::compute::leases::{ComputedImageLease, LeaseSpec, ReaderFile};
use crate::compute::ComputeHandle;
use crate::db::Database;
use crate::domain::result::CommandResult;

fn margin(limit: u32, mut edge_line: impl FnMut(u32) -> Option<bool>) -> u32 {
    let Some(color) = edge_line(0) else {
        return 0;
    };
    // Skip an ambiguous margin that takes up a large part of the picture.
    (1..=limit)
        .find(|&index| edge_line(index) != Some(color))
        .unwrap_or(0)
}

fn line_color(mut pixels: impl Iterator<Item = image::Rgba<u8>>) -> Option<bool> {
    fn color(pixel: image::Rgba<u8>) -> Option<bool> {
        let [r, g, b, alpha] = pixel.0;
        if alpha != 255 {
            return None;
        }
        if r.max(g).max(b) <= 24 {
            Some(false)
        } else if r.min(g).min(b) >= 231 {
            Some(true)
        } else {
            None
        }
    }
    let first = color(pixels.next()?)?;
    pixels
        .all(|pixel| color(pixel) == Some(first))
        .then_some(first)
}

fn crop_bounds(image: &image::DynamicImage) -> Option<(u32, u32, u32, u32)> {
    let (width, height) = image.dimensions();
    let row = |y| line_color((0..width).map(|x| image.get_pixel(x, y)));
    let top = margin(height / 5, row);
    let bottom = margin(height / 5, |offset| row(height - 1 - offset));
    let column = |x| line_color((top..height - bottom).map(|y| image.get_pixel(x, y)));
    let left = margin(width / 5, column);
    let right = margin(width / 5, |offset| column(width - 1 - offset));
    (left | top | right | bottom != 0).then_some((
        left,
        top,
        width - left - right,
        height - top - bottom,
    ))
}

#[derive(Clone, Copy, serde::Deserialize, serde::Serialize)]
pub(crate) struct CropInsets {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl CropInsets {
    fn bounds(self, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
        if ![self.left, self.top, self.right, self.bottom]
            .into_iter()
            .all(|edge| (0.0..=0.2).contains(&edge))
        {
            return None;
        }
        let pixels = |edge: f64, size: u32| (edge * f64::from(size)).round() as u32;
        let left = pixels(self.left, width);
        let top = pixels(self.top, height);
        let right = pixels(self.right, width);
        let bottom = pixels(self.bottom, height);
        (left | top | right | bottom != 0).then_some((
            left,
            top,
            width - left - right,
            height - top - bottom,
        ))
    }
}

#[derive(serde::Serialize)]
pub(crate) struct ReaderCropResult {
    lease: ComputedImageLease,
    insets: CropInsets,
}

fn crop_file(
    file: ReaderFile,
    cache_dir: &std::path::Path,
    reference: Option<CropInsets>,
) -> Option<(std::fs::File, u32, u32, u64, CropInsets)> {
    const MAX_PIXELS: u64 = 48_000_000;
    const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
    // Bound image memory across retained readers as well as within each reader.
    static DECODER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _decoder = DECODER.lock().ok()?;
    let bytes = {
        let mut source = file.lock().ok()?;
        let (_, width, height) = super::static_reader_file_info(&source)?;
        if u64::from(width) * u64::from(height) > MAX_PIXELS
            || source.metadata().ok()?.len() > MAX_INPUT_BYTES
        {
            return None;
        }
        source.rewind().ok()?;
        let mut bytes = Vec::new();
        (&mut *source)
            .take(MAX_INPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_INPUT_BYTES {
            return None;
        }
        bytes
    };
    let image = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let (source_width, source_height) = image.dimensions();
    let (x, y, width, height) = match reference {
        Some(reference) => reference.bounds(source_width, source_height)?,
        None => crop_bounds(&image)?,
    };
    let insets = CropInsets {
        left: f64::from(x) / f64::from(source_width),
        top: f64::from(y) / f64::from(source_height),
        right: f64::from(source_width - x - width) / f64::from(source_width),
        bottom: f64::from(source_height - y - height) / f64::from(source_height),
    };
    std::fs::create_dir_all(cache_dir).ok()?;
    let mut output = tempfile::tempfile_in(cache_dir).ok()?;
    image
        .crop_imm(x, y, width, height)
        .write_to(&mut output, ImageFormat::Png)
        .ok()?;
    let byte_length = output.metadata().ok()?.len();
    output.rewind().ok()?;
    Some((output, width, height, byte_length, insets))
}

#[tauri::command]
pub(crate) async fn reader_crop_borders(
    lease_id: String,
    session: u32,
    page: i32,
    reference: Option<CropInsets>,
    app: AppHandle,
    webview: WebviewWindow,
    compute: State<'_, ComputeHandle>,
    database: State<'_, Database>,
) -> Result<CommandResult<Option<ReaderCropResult>>, String> {
    let label = webview.label();
    let leases = compute.leases();
    let now = Instant::now();
    let Some((file, _)) = leases.reader_files(&lease_id, None, label, session, page, now) else {
        return Ok(CommandResult::success(None));
    };
    let Ok(cache_dir) = app.path().app_cache_dir() else {
        return Ok(CommandResult::success(None));
    };
    let Some((file, width, height, byte_length, insets)) =
        tauri::async_runtime::spawn_blocking(move || crop_file(file, &cache_dir, reference))
            .await
            .ok()
            .flatten()
    else {
        return Ok(CommandResult::success(None));
    };
    let now = Instant::now();
    let Ok((source, _)) = leases.view_with_file(&lease_id, label, now) else {
        return Ok(CommandResult::success(None));
    };
    let revision = format!(
        "crop-v1:{}:{:.8}:{:.8}:{:.8}:{:.8}",
        source.pipeline_revision, insets.left, insets.top, insets.right, insets.bottom
    );
    let acquired = leases.acquire_file(
        LeaseSpec {
            artifact_id: revision.clone(),
            job_id: "reader-crop".into(),
            path: Default::default(),
            cache_relative: None,
            mime: "image/png".into(),
            byte_length,
            width,
            height,
            pipeline_revision: revision,
            webview_label: label.into(),
        },
        file,
        Some((session, i64::from(page) - 1)),
        now,
    );
    Ok(CommandResult::success(acquired.ok().map(|acquired| {
        crate::compute::commands::unpin_leases(&database, &acquired.expired);
        ReaderCropResult {
            lease: acquired.lease,
            insets,
        }
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    #[test]
    fn crops_light_and_dark_margins_without_cutting_ink_at_an_edge() {
        for edge in [5, 250] {
            let mut pixels = RgbImage::from_pixel(60, 80, Rgb([edge; 3]));
            for y in 6..72 {
                for x in 4..55 {
                    pixels.put_pixel(x, y, Rgb([105, 100, 95]));
                }
            }
            assert_eq!(
                crop_bounds(&DynamicImage::from(pixels.clone())),
                Some((4, 6, 51, 66))
            );
            pixels.put_pixel(20, 0, Rgb([105, 100, 95]));
            assert_eq!(crop_bounds(&DynamicImage::from(pixels)).unwrap().1, 0);
        }
    }

    #[test]
    fn preserves_a_uniform_page_and_a_page_without_a_margin() {
        for color in [0, 100, 255] {
            let image = RgbImage::from_pixel(60, 80, Rgb([color; 3]));
            assert_eq!(crop_bounds(&DynamicImage::from(image)), None);
        }
    }

    #[test]
    fn crops_leased_files_and_reuses_the_original_insets_on_an_upscale() {
        use std::sync::{Arc, Mutex};
        let dir = tempfile::tempdir().unwrap();
        let source = |pixels: RgbImage| {
            let mut file = tempfile::tempfile_in(dir.path()).unwrap();
            DynamicImage::from(pixels)
                .write_to(&mut file, ImageFormat::Png)
                .unwrap();
            Arc::new(Mutex::new(file))
        };
        let mut pixels = RgbImage::from_pixel(60, 80, Rgb([250; 3]));
        for y in 6..72 {
            for x in 4..55 {
                pixels.put_pixel(x, y, Rgb([100; 3]));
            }
        }
        let (file, width, height, _, insets) = crop_file(source(pixels), dir.path(), None).unwrap();
        assert_eq!((width, height), (51, 66));
        assert_eq!(
            super::super::static_reader_file_info(&file),
            Some(("image/png", 51, 66))
        );
        // Simulate a new rendition whose tones changed enough to defeat margin detection.
        let processed = RgbImage::from_pixel(120, 160, Rgb([90; 3]));
        let (_, width, height, _, _) =
            crop_file(source(processed), dir.path(), Some(insets)).unwrap();
        assert_eq!((width, height), (102, 132));
    }
}
