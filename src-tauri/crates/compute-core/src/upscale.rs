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

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    #[test]
    fn native_four_times_tiles_are_delivered_at_two_times_without_cascading() {
        struct NativeFour { calls: AtomicU32 }
        impl UpscaleEngine for NativeFour {
            fn scale(&self) -> u32 { 4 }
            fn upscale_tile(&self, rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, ComputeError> {
                self.calls.fetch_add(1, Ordering::Relaxed);
                Ok(cpu_scale_rgba(rgba, width, height, 4, 1024)?.rgba)
            }
        }
        let engine = NativeFour { calls: AtomicU32::new(0) };
        let result = upscale_rgba(&engine, &vec![120; 8 * 8 * 4], 8, 8,
            UpscaleOptions { output_scale: Some(2), max_pixels: 256, ..Default::default() }).unwrap();
        assert_eq!((result.width, result.height), (16, 16));
        assert_eq!(engine.calls.load(Ordering::Relaxed), 1);
        assert_eq!(result.rgba.len(), 16 * 16 * 4);
    }

    struct Global { limit: u32, calls: std::sync::Mutex<Vec<(u32,u32)>> }
    impl UpscaleEngine for Global {
        fn scale(&self) -> u32 { 1 }
        fn requires_whole_frame(&self) -> bool { true }
        fn upscale_tile(&self, rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, ComputeError> {
            self.calls.lock().unwrap().push((w,h));
            if w > self.limit { return Err(ComputeError::InvalidInput("E_OUTOFMEMORY".into())); }
            Ok(rgba.to_vec())
        }
    }
    #[test]
    fn global_statistics_never_split_even_during_allocation_recovery() {
        let engine = Global { limit: 64, calls: Default::default() };
        let source = vec![200;128*256*4];
        let result = upscale_rgba_with_allocation_recovery(&engine,&source,128,256,
            UpscaleOptions { tile_size: 256, ..Default::default() },1).unwrap();
        assert_eq!(result.tiles,1);
        assert_eq!((result.width,result.height),(128,256));
        assert!(result.rgba.iter().all(|v| *v==200));
        let calls = engine.calls.lock().unwrap();
        assert_eq!(calls.len(),3);
        assert!(calls.iter().all(|(w,h)| *h >= *w * 2));
        assert!(calls[2].0 < calls[1].0 && calls[1].0 < calls[0].0);
    }
    struct Limited { calls: AtomicU32, fail_above: u32, fixed: bool, message: &'static str }
    impl UpscaleEngine for Limited {
        fn scale(&self) -> u32 { 1 }
        fn fixed_input_size(&self) -> Option<(u32,u32)> { self.fixed.then_some((256,256)) }
        fn upscale_tile(&self, rgba: &[u8], width: u32, _: u32) -> Result<Vec<u8>, ComputeError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if width > self.fail_above { Err(ComputeError::InvalidInput(self.message.into())) }
            else { Ok(rgba.to_vec()) }
        }
    }
    #[test]
    fn recovered_tiles_keep_pixels_and_padding() {
        let engine = Limited { calls: AtomicU32::new(0), fail_above: 80, fixed: false, message: "E_OUTOFMEMORY" };
        let source: Vec<u8> = (0..128*128*4).map(|n| (n % 251) as u8).collect();
        let result = upscale_rgba_with_allocation_recovery(&engine, &source, 128,128,UpscaleOptions::default(),1).unwrap();
        assert_eq!(result.rgba, source);
        assert_eq!(result.tiles, 4);
        assert_eq!(engine.calls.load(Ordering::Relaxed), 5);
    }
    #[test]
    fn fixed_contract_and_device_errors_never_retry() {
        for (fixed,message) in [(true,"E_OUTOFMEMORY"),(false,"device removed")] {
            let engine = Limited { calls: AtomicU32::new(0), fail_above: 0, fixed, message };
            assert!(upscale_rgba_with_allocation_recovery(&engine,&vec![0;128*128*4],128,128,UpscaleOptions::default(),1).is_err());
            assert_eq!(engine.calls.load(Ordering::Relaxed),1);
        }
    }
    #[test]
    fn cancellation_prevents_initial_allocation_attempt() {
        let cancel = CancelToken::watch(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)));
        let engine = Limited { calls: AtomicU32::new(0), fail_above: 0, fixed: false, message: "E_OUTOFMEMORY" };
        let options = UpscaleOptions { cancel: Some(cancel), ..Default::default() };
        assert_eq!(upscale_rgba_with_allocation_recovery(&engine,&vec![0;128*128*4],128,128,options,1).unwrap_err(),ComputeError::Cancelled);
        assert_eq!(engine.calls.load(Ordering::Relaxed),0);
    }
}

/// Retry an entire frame only for identifiable native allocation failures.
/// Completed partial output is dropped before the smaller attempt, preserving seam padding.
pub fn upscale_rgba_with_allocation_recovery(
    engine: &dyn UpscaleEngine, source: &[u8], width: u32, height: u32,
    options: UpscaleOptions, min_edge: u32,
) -> Result<UpscaledImage, ComputeError> {
    upscale_rgba_with_recovery_progress(engine, source, width, height, options, min_edge, &|_, _| {})
}

pub fn upscale_rgba_with_recovery_progress(
    engine: &dyn UpscaleEngine, source: &[u8], width: u32, height: u32,
    mut options: UpscaleOptions, min_edge: u32, progress: &dyn Fn(usize, usize),
) -> Result<UpscaledImage, ComputeError> {
    let mut attempt = 0;
    loop {
        options.check_cancelled()?;
        match upscale_rgba_with_progress(engine, source, width, height, options.clone(), progress) {
            Ok(output) => return Ok(output),
            Err(error) => {
                let next = crate::resources::is_allocation_error(&error).then(||
                    crate::resources::next_tile_after_allocation_failure(options.tile_size, min_edge, engine.fixed_input_size().is_some(), attempt)
                ).flatten();
                let Some(next) = next else { return Err(error); };
                eprintln!("upscale allocation recovery: tile {} -> {next}", options.tile_size);
                options.tile_size = next;
                attempt += 1;
            }
        }
    }
}

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
    /// Spatial attention/pooling must see the entire page, not each tile's statistics.
    fn requires_whole_frame(&self) -> bool { false }
    /// Static NCHW input dimensions, with zero denoting a dynamic axis.
    /// The engine pads smaller boundary tiles to each fixed axis.
    fn fixed_input_size(&self) -> Option<(u32, u32)> { None }
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
    fn requires_whole_frame(&self) -> bool { (**self).requires_whole_frame() }
    fn fixed_input_size(&self) -> Option<(u32, u32)> { (**self).fixed_input_size() }
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
    /// Assemble directly at the requested delivery scale, keeping native-scale
    /// output only for the current padded tile.
    pub output_scale: Option<u32>,
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
            output_scale: None,
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
    upscale_rgba_with_progress(engine, source, width, height, options, &|_, _| {})
}

/// Report completed tiles, including zero before the first native inference.
pub fn upscale_rgba_with_progress(
    engine: &dyn UpscaleEngine, source: &[u8], width: u32, height: u32,
    options: UpscaleOptions, progress: &dyn Fn(usize, usize),
) -> Result<UpscaledImage, ComputeError> {
    let native_scale = engine.scale();
    let scale = options.output_scale.unwrap_or(native_scale).min(native_scale);
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

    if engine.requires_whole_frame() {
        options.check_cancelled()?;
        // tile_size is a working-area budget here, never permission to split a
        // non-local model. Keep aspect ratio, and restore delivery dimensions.
        let budget = u64::from(options.tile_size.max(1)).pow(2);
        let (mut w, mut h) = crate::fit::processing_dimensions(width, height, 1, budget)
            .ok_or_else(|| ComputeError::InvalidInput("empty whole-frame budget".into()))?;
        if let Some((fw, fh)) = engine.fixed_input_size() {
            let ratio = (if fw > 0 { f64::from(fw) / f64::from(w) } else { 1.0 })
                .min(if fh > 0 { f64::from(fh) / f64::from(h) } else { 1.0 }).min(1.0);
            w = (f64::from(w) * ratio).floor().max(1.0) as u32;
            h = (f64::from(h) * ratio).floor().max(1.0) as u32;
        }
        let input = if (w, h) == (width, height) { None } else {
            let view = image::RgbaImage::from_raw(width, height, source.to_vec())
                .expect("source dimensions checked above");
            Some(image::imageops::resize(&view, w, h, image::imageops::FilterType::Lanczos3))
        };
        progress(0, 1);
        let rgba = engine.upscale_tile(input.as_ref().map(|i| i.as_raw().as_slice()).unwrap_or(source), w, h)?;
        options.check_cancelled()?;
        let output = image::RgbaImage::from_raw(w * native_scale, h * native_scale, rgba)
            .ok_or_else(|| ComputeError::InvalidInput("engine frame output dimensions do not match".into()))?;
        let rgba = if output.dimensions() == (output_width, output_height) { output.into_raw() } else {
            image::imageops::resize(&output, output_width, output_height, image::imageops::FilterType::Lanczos3).into_raw()
        };
        options.check_cancelled()?;
        progress(1, 1);
        return Ok(UpscaledImage { rgba, width: output_width, height: output_height, tiles: 1 });
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
    progress(0, tiles.len());
    for (index, tile) in tiles.iter().enumerate() {
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
        options.check_cancelled()?;
        let expected_len = (tile.padded_width as usize).checked_mul(tile.padded_height as usize)
            .and_then(|n| n.checked_mul(native_scale as usize * native_scale as usize))
            .and_then(|n| n.checked_mul(4));
        if expected_len != Some(upscaled.len()) {
            return Err(ComputeError::InvalidInput("engine tile output dimensions do not match".into()));
        }
        let upscaled = if scale < native_scale {
            crate::fit::fit_rgba_scale(upscaled, tile.padded_width * native_scale,
                tile.padded_height * native_scale, tile.padded_width, tile.padded_height, scale).0
        } else { upscaled };
        blit_tile(&mut destination, output_width, tile, scale, &upscaled)?;
        progress(index + 1, tiles.len());
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
