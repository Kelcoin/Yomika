//! 张量布局换算的断言（从 `src-tauri/src/inference/onnx.rs` 的 `mod tests`
//! 迁移，未删改）。
//!
//! 这几条护的是「肉眼才看得见」的那类错误：通道错位、alpha 被模型吃掉、模型在
//! 高对比边缘过冲时整幅图出现麻点。

use yomika_compute_core::tensor::{nchw_over_rgba, pad_rgba_edges, preserve_neutral_chroma, rgba_to_nchw};

#[test]
fn neutral_chroma_correction_preserves_detail_colour_edges_and_alpha() {
    let mut source = [80, 80, 80, 255].repeat(5);
    source[4..8].copy_from_slice(&[220, 10, 20, 128]);
    let mut output = [50, 90, 55, 77].repeat(20); // 5x1 at x2
    let before = output.clone();
    preserve_neutral_chroma(&source, 5, 1, 2, &mut output);
    // Colour and its adjacent source pixels retain the model's RGB output.
    assert_eq!(&output[..6 * 4], &before[..6 * 4]);
    for x in 6..10 {
        let pixel = &output[x * 4..x * 4 + 4];
        assert_eq!(pixel[0], pixel[1]);
        assert_eq!(pixel[1], pixel[2]);
        assert!((78..=80).contains(&pixel[0])); // output luma, not source brightness
        assert_eq!(pixel[3], 77);
    }
}

#[test]
fn rgba_round_trips_through_the_planar_layout() {
    // One pixel per channel plus an alpha the model never sees.
    let rgba = vec![10, 20, 30, 40, 200, 210, 220, 230];
    let planar = rgba_to_nchw(&rgba, 2, 1);
    // Planar means all reds, then all greens, then all blues.
    assert_eq!(
        planar,
        vec![
            10.0 / 255.0,
            200.0 / 255.0,
            20.0 / 255.0,
            210.0 / 255.0,
            30.0 / 255.0,
            220.0 / 255.0
        ]
    );

    let mut restored = vec![0, 0, 0, 40, 0, 0, 0, 230];
    nchw_over_rgba(&planar, 2, 1, 2, 1, &mut restored);
    assert_eq!(
        restored, rgba,
        "alpha must survive a round trip the model cannot see"
    );
}

#[test]
fn a_grown_plane_is_cropped_to_the_tile_that_asked_for_it() {
    // The model answered for a 2x2 input (the engine grew a 1x1 tile); only
    // the top-left pixel belongs in the buffer. Reading the planes with the
    // destination's width instead of the plane's own would pull the wrong
    // channel out — 0.5 instead of 0.1 in red.
    let planar = vec![
        0.1_f32, 0.2, 0.3, 0.4, // red
        0.5, 0.6, 0.7, 0.8, // green
        0.9, 1.0, 0.0, 0.0, // blue
    ];
    let mut rgba = vec![0, 0, 0, 255];
    nchw_over_rgba(&planar, 2, 2, 1, 1, &mut rgba);
    assert_eq!(
        rgba,
        vec![
            (0.1_f32 * 255.0).round() as u8,
            (0.5_f32 * 255.0).round() as u8,
            (0.9_f32 * 255.0).round() as u8,
            255,
        ]
    );
}

#[test]
fn padding_a_tile_repeats_its_last_row_and_column() {
    // 2x2 with distinct corners, grown to 3x3.
    let rgba = vec![
        1, 1, 1, 9, 2, 2, 2, 9, //
        3, 3, 3, 9, 4, 4, 4, 9,
    ];
    let padded = pad_rgba_edges(&rgba, 2, 2, 3, 3);
    let pixel = |x: usize, y: usize| padded[(y * 3 + x) * 4];
    assert_eq!((pixel(0, 0), pixel(1, 0), pixel(2, 0)), (1, 2, 2));
    assert_eq!((pixel(0, 1), pixel(1, 1), pixel(2, 1)), (3, 4, 4));
    assert_eq!((pixel(0, 2), pixel(1, 2), pixel(2, 2)), (3, 4, 4));
}

#[test]
fn out_of_range_model_output_is_clamped_not_wrapped() {
    // Super-resolution models overshoot at high-contrast edges. Casting a
    // negative or >1 float straight to u8 wraps around and speckles the page.
    let planar = vec![-0.4_f32, 1.6, 0.5, 0.5, 0.5, 0.5];
    let mut rgba = vec![0, 0, 0, 255, 0, 0, 0, 255];
    nchw_over_rgba(&planar, 2, 1, 2, 1, &mut rgba);
    assert_eq!(rgba[0], 0);
    assert_eq!(rgba[4], 255);
}
