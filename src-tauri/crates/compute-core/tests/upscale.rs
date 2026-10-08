//! 分块放大管道的断言（从 `src-tauri/src/inference/upscale.rs` 的 `mod tests`
//! 迁移，未删改；只是错误类型从宿主的 `InferenceError` 换成了核心的
//! `ComputeError`，取消那一格从裸 `Arc<AtomicBool>` 换成了 `CancelToken`）。
//!
//! 这里没有模型：全部用 [`NearestNeighbourEngine`] 当参照实现。真正要护的是
//! 「分块不可见」——接缝一旦露出来，页面上就是一条条直线。

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use yomika_compute_core::cancel::CancelToken;
use yomika_compute_core::cpu_scale::cpu_scale_rgba;
use yomika_compute_core::error::ComputeError;
use yomika_compute_core::upscale::{
    blit_tile, plan_tiles, upscale_rgba, NearestNeighbourEngine, UpscaleEngine, UpscaleOptions,
};

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
        Err(ComputeError::InvalidInput(_)),
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
        Err(ComputeError::PixelBudgetExceeded { .. }),
    ));
}

#[test]
fn blitting_rejects_a_tile_the_engine_sized_wrongly() {
    let tile = plan_tiles(32, 32, 32, 0)[0];
    let mut destination = vec![0_u8; 64 * 64 * 4];
    assert!(matches!(
        blit_tile(&mut destination, 64, &tile, 2, &[0_u8; 16]),
        Err(ComputeError::InvalidInput(_)),
    ));
}

/// 共享的引擎必须还能当引擎用：宿主把 `Arc<OnnxEngine>` 直接放进
/// `Box<dyn UpscaleEngine>`（会话要跨块复用，每块重新加载模型是不可接受的）。
/// 这个 blanket impl 只能长在定义 trait 的 crate 里，所以它在这里被钉住。
#[test]
fn a_shared_engine_is_still_an_engine() {
    let engine = Arc::new(NearestNeighbourEngine {
        scale: 2,
        max_pixels: 64_000_000,
    });
    let shared: Box<dyn UpscaleEngine> = Box::new(Arc::clone(&engine));
    assert_eq!(shared.scale(), 2);
    let source = gradient(4, 4);
    let direct = engine.upscale_tile(&source, 4, 4).expect("direct");
    let through_arc = shared.upscale_tile(&source, 4, 4).expect("through the Arc");
    assert_eq!(direct, through_arc);
    assert_eq!(engine.tile_padding(), shared.tile_padding());
}

/// 取消点是块与块之间：切页之后剩下的块不再跑。这里用一个会数自己被打了几次
/// 的引擎——一页 4K 图有几百块，跑完它们要几分钟，而用户已经翻到下一页了。
#[test]
fn a_cancelled_task_stops_between_tiles() {
    struct Counting {
        scale: u32,
        calls: Arc<AtomicUsize>,
        cancel: Arc<AtomicBool>,
    }
    impl UpscaleEngine for Counting {
        fn scale(&self) -> u32 {
            self.scale
        }
        fn upscale_tile(
            &self,
            _rgba: &[u8],
            width: u32,
            height: u32,
        ) -> Result<Vec<u8>, ComputeError> {
            let call = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
            // 第三块跑完之后用户切页。
            if call == 3 {
                self.cancel.store(true, Ordering::Relaxed);
            }
            Ok(vec![
                0_u8;
                (width * self.scale * height * self.scale * 4) as usize
            ])
        }
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = Counting {
        scale: 2,
        calls: Arc::clone(&calls),
        cancel: Arc::clone(&cancel),
    };
    let error = upscale_rgba(
        &engine,
        &gradient(64, 64),
        64,
        64,
        UpscaleOptions {
            tile_size: 16,
            tile_padding: 0,
            cancel: Some(CancelToken::watch(Arc::clone(&cancel))),
            ..UpscaleOptions::default()
        },
    )
    .expect_err("cancel must surface as Cancelled");
    assert_eq!(error, ComputeError::Cancelled);
    assert_eq!(
        calls.load(Ordering::Relaxed),
        3,
        "the fourth tile must not start"
    );
}
