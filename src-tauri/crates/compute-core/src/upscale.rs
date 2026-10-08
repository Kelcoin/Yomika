//! 分块放大的管道：分块规划、裁剪、回贴、预算与取消点。
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
//! it (planning, cropping, budget checks, pacing, cancel) is engine-independent
//! and tested here. 这一层现在住在计算核心里（docs/71 §11 Task 2）：它只认
//! RGBA 缓冲、规模、预算和一张取消牌，不认 ORT、不认 Tauri、也不认数据库，
//! 所以将来可以直接放进 worker 进程。

use crate::cancel::CancelToken;
use crate::cpu_scale::cpu_scale_rgba;
use crate::error::ComputeError;

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
) -> Result<(), ComputeError> {
    let (offset_x, offset_y) = tile.crop_offset();
    let tile_width = tile.padded_width * scale;
    let tile_height = tile.padded_height * scale;
    if upscaled.len() != tile_width as usize * tile_height as usize * 4 {
        return Err(ComputeError::InvalidInput(
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
    fn upscale_tile(&self, rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, ComputeError>;
}

/// 共享的引擎也能直接当引擎用：调用方把 `Arc<OnnxEngine>` 塞进
/// `Box<dyn UpscaleEngine>` 时不必再包一层。
///
/// 这个 blanket impl 只能写在 trait 所在的 crate 里（宿主那边写就是孤儿规则
/// E0117，因为 `Arc` 也是外部的）——所以 ONNX 会话的共享类型只要能自己实现
/// [`UpscaleEngine`]，Arc 这一格就自动成立。
impl<T: UpscaleEngine + ?Sized> UpscaleEngine for std::sync::Arc<T> {
    fn scale(&self) -> u32 {
        (**self).scale()
    }

    fn tile_padding(&self) -> u32 {
        (**self).tile_padding()
    }

    fn upscale_tile(&self, rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, ComputeError> {
        (**self).upscale_tile(rgba, width, height)
    }
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
    ) -> Result<Vec<u8>, ComputeError> {
        cpu_scale_rgba(rgba, width, height, self.scale, self.max_pixels).map(|output| output.rgba)
    }
}

#[derive(Debug, Clone)]
pub struct UpscaleOptions {
    pub tile_size: u32,
    pub tile_padding: u32,
    /// Pause between tiles, as in the fork's `tileSleepMs`: keeps a phone from
    /// thermal-throttling through a long chapter.
    pub tile_sleep_ms: u64,
    pub max_pixels: usize,
    /// 取消牌：每块之间查一次。切页之后没必要把剩下的几百块跑完——全局只允许
    /// 一件重活，跑完的那些块用户根本看不到。
    pub cancel: Option<CancelToken>,
}

impl Default for UpscaleOptions {
    fn default() -> Self {
        Self {
            tile_size: DEFAULT_TILE_SIZE,
            tile_padding: DEFAULT_TILE_PADDING,
            tile_sleep_ms: 0,
            max_pixels: 64_000_000,
            cancel: None,
        }
    }
}

impl UpscaleOptions {
    /// 任务被取消时返回 `Cancelled`。
    fn check_cancelled(&self) -> Result<(), ComputeError> {
        if let Some(token) = &self.cancel {
            // 取消点返回的是 `Cancelled`；`From` 把它翻成计算错误，调用方只认识一套。
            token.check()?;
        }
        Ok(())
    }
}

#[derive(Debug)]
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
) -> Result<UpscaledImage, ComputeError> {
    let scale = engine.scale();
    if width == 0 || height == 0 || scale == 0 || source.len() != width as usize * height as usize * 4
    {
        return Err(ComputeError::InvalidInput(
            "RGBA buffer dimensions do not match".into(),
        ));
    }
    let output_width = width.checked_mul(scale);
    let output_height = height.checked_mul(scale);
    let (output_width, output_height) = match (output_width, output_height) {
        (Some(w), Some(h)) => (w, h),
        _ => {
            return Err(ComputeError::PixelBudgetExceeded {
                pixels: usize::MAX,
                max_pixels: options.max_pixels,
            })
        }
    };
    let pixels = output_width as usize * output_height as usize;
    if pixels > options.max_pixels {
        return Err(ComputeError::PixelBudgetExceeded {
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
        options.check_cancelled()?;
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
