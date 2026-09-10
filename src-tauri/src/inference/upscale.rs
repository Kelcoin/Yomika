//! Tiled upscaling pipeline.
//!
//! Ported from the mihon upscale fork (`docs/mihon_img_upscale-master`), whose
//! ncnn upscalers all run on fixed-size tiles with a padding margin and a
//! per-tile pause: `tileSize` (128 by default), `jobs`, `precision` and
//! `tileSleepMs` in `util/waifu2x/Waifu2x.kt`. Tiling keeps peak memory bounded
//! on a phone, and the padding keeps tile seams out of the output — each tile is
//! inferred with a margin, and the margin is cropped away when the tile is
//! written back.
//!
//! The tensor execution itself sits behind [`UpscaleEngine`]; everything around
//! it (planning, cropping, budget checks, pacing) is engine-independent and
//! tested here.

use crate::inference::{cpu_scale_rgba, InferenceError};

pub const DEFAULT_TILE_SIZE: u32 = 128;
pub const DEFAULT_TILE_PADDING: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tile {
    /// Region handed to the engine, padding included.
    pub padded_x: u32,
    pub padded_y: u32,
    pub padded_width: u32,
    pub padded_height: u32,
    /// The part of that region that belongs in the output, in source pixels.
    pub inner_x: u32,
    pub inner_y: u32,
    pub inner_width: u32,
    pub inner_height: u32,
}

impl Tile {
    /// Offset of the kept region inside the padded region.
    pub fn crop_offset(&self) -> (u32, u32) {
        (self.inner_x - self.padded_x, self.inner_y - self.padded_y)
    }
}

/// Splits an image into padded tiles. A tile never leaves the image, so edge
/// tiles carry less padding instead of being mirrored.
pub fn plan_tiles(width: u32, height: u32, tile_size: u32, padding: u32) -> Vec<Tile> {
    let tile_size = tile_size.max(1);
    let mut tiles = Vec::new();
    let mut y = 0;
    while y < height {
        let inner_height = tile_size.min(height - y);
        let mut x = 0;
        while x < width {
            let inner_width = tile_size.min(width - x);
            let padded_x = x.saturating_sub(padding);
            let padded_y = y.saturating_sub(padding);
            tiles.push(Tile {
                padded_x,
                padded_y,
                padded_width: (x + inner_width + padding).min(width) - padded_x,
                padded_height: (y + inner_height + padding).min(height) - padded_y,
                inner_x: x,
                inner_y: y,
                inner_width,
                inner_height,
            });
            x += inner_width;
        }
        y += inner_height;
    }
    tiles
}

pub fn crop_rgba(
    source: &[u8],
    width: u32,
    x: u32,
    y: u32,
    tile_width: u32,
    tile_height: u32,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(tile_width as usize * tile_height as usize * 4);
    for row in 0..tile_height {
        let start = ((y + row) as usize * width as usize + x as usize) * 4;
        out.extend_from_slice(&source[start..start + tile_width as usize * 4]);
    }
    out
}

/// Writes an upscaled tile into the destination, dropping the padding margin.
pub fn blit_tile(
    destination: &mut [u8],
    destination_width: u32,
    tile: &Tile,
    scale: u32,
    upscaled: &[u8],
) -> Result<(), InferenceError> {
    let (offset_x, offset_y) = tile.crop_offset();
    let tile_width = tile.padded_width * scale;
    let tile_height = tile.padded_height * scale;
    if upscaled.len() != tile_width as usize * tile_height as usize * 4 {
        return Err(InferenceError::InvalidInput(
            "upscaled tile does not match its padded size".into(),
        ));
    }
    let keep_width = tile.inner_width * scale;
    for row in 0..tile.inner_height * scale {
        let source_index =
            (((offset_y * scale + row) * tile_width + offset_x * scale) as usize) * 4;
        let destination_index = (((tile.inner_y * scale + row) * destination_width
            + tile.inner_x * scale) as usize)
            * 4;
        destination[destination_index..destination_index + keep_width as usize * 4]
            .copy_from_slice(&upscaled[source_index..source_index + keep_width as usize * 4]);
    }
    Ok(())
}

/// One upscaling backend. An ONNX Runtime session plugs in here: the pipeline
/// below never needs to know which engine it is talking to.
pub trait UpscaleEngine {
    fn scale(&self) -> u32;
    /// How far past a tile's edge the engine reads, in source pixels. The tiler
    /// keeps this much margin around every tile and crops it away again, so an
    /// engine whose kernel reaches further than the default has to say so or its
    /// tiles will show their edges.
    fn tile_padding(&self) -> u32 {
        DEFAULT_TILE_PADDING
    }
    /// Upscales one RGBA tile. `rgba` is `width * height * 4` bytes and the
    /// result must be `width * scale * height * scale * 4`.
    fn upscale_tile(&self, rgba: &[u8], width: u32, height: u32)
        -> Result<Vec<u8>, InferenceError>;
}

/// Model-free engine used when no model is installed, and as the reference
/// implementation the tiling tests run against.
pub struct NearestNeighbourEngine {
    pub scale: u32,
    pub max_pixels: usize,
}

impl UpscaleEngine for NearestNeighbourEngine {
    fn scale(&self) -> u32 {
        self.scale
    }

    fn upscale_tile(
        &self,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, InferenceError> {
        cpu_scale_rgba(rgba, width, height, self.scale, self.max_pixels).map(|output| output.rgba)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct UpscaleOptions {
    pub tile_size: u32,
    pub tile_padding: u32,
    /// Pause between tiles, as in the fork's `tileSleepMs`: keeps a phone from
    /// thermal-throttling through a long chapter.
    pub tile_sleep_ms: u64,
    pub max_pixels: usize,
}

impl Default for UpscaleOptions {
    fn default() -> Self {
        Self {
            tile_size: DEFAULT_TILE_SIZE,
            tile_padding: DEFAULT_TILE_PADDING,
            tile_sleep_ms: 0,
            max_pixels: 64_000_000,
        }
    }
}

pub struct UpscaledImage {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub tiles: usize,
}

/// Runs an engine over an image tile by tile and reassembles the result.
pub fn upscale_rgba(
    engine: &dyn UpscaleEngine,
    source: &[u8],
    width: u32,
    height: u32,
    options: UpscaleOptions,
) -> Result<UpscaledImage, InferenceError> {
    let scale = engine.scale();
    if width == 0
        || height == 0
        || scale == 0
        || source.len() != width as usize * height as usize * 4
    {
        return Err(InferenceError::InvalidInput(
            "RGBA buffer dimensions do not match".into(),
        ));
    }
    let output_width = width.checked_mul(scale);
    let output_height = height.checked_mul(scale);
    let (output_width, output_height) = match (output_width, output_height) {
        (Some(w), Some(h)) => (w, h),
        _ => {
            return Err(InferenceError::PixelBudgetExceeded {
                pixels: usize::MAX,
                max_pixels: options.max_pixels,
            })
        }
    };
    let pixels = output_width as usize * output_height as usize;
    if pixels > options.max_pixels {
        return Err(InferenceError::PixelBudgetExceeded {
            pixels,
            max_pixels: options.max_pixels,
        });
    }

    // The engine's own reach is a floor: a caller asking for less padding than
    // the kernel needs would get seams, not a faster result.
    let tiles = plan_tiles(
        width,
        height,
        options.tile_size,
        options.tile_padding.max(engine.tile_padding()),
    );
    let mut destination = vec![0_u8; pixels * 4];
    for tile in &tiles {
        let input = crop_rgba(
            source,
            width,
            tile.padded_x,
            tile.padded_y,
            tile.padded_width,
            tile.padded_height,
        );
        let upscaled = engine.upscale_tile(&input, tile.padded_width, tile.padded_height)?;
        blit_tile(&mut destination, output_width, tile, scale, &upscaled)?;
        if options.tile_sleep_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(options.tile_sleep_ms));
        }
    }
    Ok(UpscaledImage {
        rgba: destination,
        width: output_width,
        height: output_height,
        tiles: tiles.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                rgba.extend_from_slice(&[
                    (x % 256) as u8,
                    (y % 256) as u8,
                    ((x + y) % 256) as u8,
                    255,
                ]);
            }
        }
        rgba
    }

    #[test]
    fn tiles_cover_the_image_exactly_once() {
        let tiles = plan_tiles(300, 200, 128, 8);
        assert_eq!(tiles.len(), 6, "3 columns x 2 rows");
        let covered: u32 = tiles
            .iter()
            .map(|tile| tile.inner_width * tile.inner_height)
            .sum();
        assert_eq!(covered, 300 * 200);
        for tile in &tiles {
            // The padded region contains the kept region and stays inside the image.
            assert!(tile.padded_x <= tile.inner_x && tile.padded_y <= tile.inner_y);
            assert!(tile.padded_x + tile.padded_width <= 300);
            assert!(tile.padded_y + tile.padded_height <= 200);
            assert!(tile.inner_x + tile.inner_width <= tile.padded_x + tile.padded_width);
        }
    }

    #[test]
    fn interior_tiles_carry_padding_on_every_side() {
        let tiles = plan_tiles(300, 300, 100, 10);
        let interior = tiles
            .iter()
            .find(|tile| tile.inner_x == 100 && tile.inner_y == 100)
            .expect("interior tile");
        assert_eq!(interior.crop_offset(), (10, 10));
        assert_eq!((interior.padded_width, interior.padded_height), (120, 120));

        let corner = tiles
            .iter()
            .find(|tile| tile.inner_x == 0 && tile.inner_y == 0)
            .expect("corner tile");
        assert_eq!(
            corner.crop_offset(),
            (0, 0),
            "an edge tile is not padded outward"
        );
        assert_eq!((corner.padded_width, corner.padded_height), (110, 110));
    }

    #[test]
    fn a_single_tile_covers_a_small_image() {
        let tiles = plan_tiles(64, 32, 128, 8);
        assert_eq!(tiles.len(), 1);
        assert_eq!((tiles[0].padded_width, tiles[0].padded_height), (64, 32));
    }

    #[test]
    fn tiled_upscaling_matches_the_untiled_result() {
        // The point of the padding is that seams do not appear: tiling must be
        // invisible in the output.
        let source = gradient(70, 50);
        let engine = NearestNeighbourEngine {
            scale: 2,
            max_pixels: 64_000_000,
        };
        let whole = cpu_scale_rgba(&source, 70, 50, 2, 64_000_000).expect("reference");

        for tile_size in [8, 16, 32, 128] {
            let tiled = upscale_rgba(
                &engine,
                &source,
                70,
                50,
                UpscaleOptions {
                    tile_size,
                    tile_padding: 4,
                    ..UpscaleOptions::default()
                },
            )
            .expect("tiled upscale");
            assert_eq!((tiled.width, tiled.height), (whole.width, whole.height));
            assert_eq!(
                tiled.rgba, whole.rgba,
                "tile size {tile_size} produced seams"
            );
        }
    }

    #[test]
    fn upscaling_refuses_a_mismatched_buffer_or_an_oversized_result() {
        let engine = NearestNeighbourEngine {
            scale: 4,
            max_pixels: 1_000,
        };
        assert!(matches!(
            upscale_rgba(&engine, &[0, 0, 0, 255], 2, 2, UpscaleOptions::default()),
            Err(InferenceError::InvalidInput(_)),
        ));
        assert!(matches!(
            upscale_rgba(
                &engine,
                &gradient(40, 40),
                40,
                40,
                UpscaleOptions {
                    max_pixels: 1_000,
                    ..UpscaleOptions::default()
                }
            ),
            Err(InferenceError::PixelBudgetExceeded { .. }),
        ));
    }

    #[test]
    fn blitting_rejects_a_tile_the_engine_sized_wrongly() {
        let tile = plan_tiles(32, 32, 32, 0)[0];
        let mut destination = vec![0_u8; 64 * 64 * 4];
        assert!(matches!(
            blit_tile(&mut destination, 64, &tile, 2, &[0_u8; 16]),
            Err(InferenceError::InvalidInput(_)),
        ));
    }
}
