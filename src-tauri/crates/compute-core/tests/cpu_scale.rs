//! 最近邻兜底的断言（从 `src-tauri/src/inference.rs` 的 `mod tests` 迁移，未删改）。
//!
//! 这两条护的是同一件事的两面：放大必须保持四角像素（一张图缩小再看就知道有没
//! 有对齐错位），以及坏缓冲/超预算要在分配内存之前被拒。

use yomika_compute_core::cpu_scale::{cpu_scale_rgba, CpuRgbaOutput};
use yomika_compute_core::error::ComputeError;

#[test]
fn cpu_fallback_scales_rgba_pixels_and_preserves_corners() {
    let source = vec![
        255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ];
    let output: CpuRgbaOutput = cpu_scale_rgba(&source, 2, 2, 2, 64).expect("scaled image");
    assert_eq!(output.width, 4);
    assert_eq!(output.height, 4);
    assert_eq!(&output.rgba[..4], &[255, 0, 0, 255]);
    assert_eq!(&output.rgba[12..16], &[0, 255, 0, 255]);
    assert_eq!(&output.rgba[48..52], &[0, 0, 255, 255]);
    assert_eq!(&output.rgba[60..64], &[255, 255, 255, 255]);
}

#[test]
fn cpu_fallback_rejects_bad_buffer_and_pixel_budget() {
    assert!(matches!(
        cpu_scale_rgba(&[0; 3], 1, 1, 1, 4),
        Err(ComputeError::InvalidInput(_))
    ));
    // 4 字节的 1x1 图放大 3 倍 = 9 像素 > 预算 4：必须在分配之前就拒。
    assert!(matches!(
        cpu_scale_rgba(&[0; 4], 1, 1, 3, 4),
        Err(ComputeError::PixelBudgetExceeded { .. })
    ));
}
