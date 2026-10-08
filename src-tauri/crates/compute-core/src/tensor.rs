//! 张量布局的几个纯函数：RGBA ↔ NCHW、边缘复制、输出回写。
//!
//! 这些是超分辨率推理里**唯一与具体运行库无关**的部分——哪家 provider、哪个
//! 进程、哪个平台都这么换算。所以它们住在计算核心里（docs/71 §11 Task 2），
//! 宿主与将来的 worker 用同一份实现；一旦这里算错，两边会一起错，不会出现
//! 「宿主正常、worker 花屏」这种只能靠肉眼发现的分歧。
//!
//! 会话、模型文件、provider 都不在这里：那些才是隔离边界要管的东西。

/// RGBA bytes to the NCHW float RGB layout every super-resolution model expects.
///
/// 超分模型只吃三通道浮点，alpha 由调用方自己保留（模型看不见它）。
pub fn rgba_to_nchw(rgba: &[u8], width: u32, height: u32) -> Vec<f32> {
    let pixels = width as usize * height as usize;
    let mut planar = vec![0_f32; pixels * 3];
    for channel in 0..3 {
        let plane = &mut planar[channel * pixels..(channel + 1) * pixels];
        for (index, slot) in plane.iter_mut().enumerate() {
            *slot = f32::from(rgba[index * 4 + channel]) / 255.0;
        }
    }
    planar
}

/// Grows an RGBA tile to `width`×`height` by repeating its last row/column.
///
/// Replication rather than reflection: this is a size floor, not a border
/// treatment, and the model does its own reflect padding once the tile is big
/// enough. Replication is also the only mode that works for a one-pixel edge.
pub fn pad_rgba_edges(
    rgba: &[u8],
    from_width: u32,
    from_height: u32,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height {
        let source_y = y.min(from_height - 1);
        for x in 0..width {
            let source_x = x.min(from_width - 1);
            let index = ((source_y * from_width + source_x) as usize) * 4;
            out.extend_from_slice(&rgba[index..index + 4]);
        }
    }
    out
}

/// Writes the model's NCHW float RGB output over the RGB channels of `rgba`,
/// leaving its alpha alone.
///
/// The plane's own width and height come separately from the destination's: when
/// the engine had to grow the input, the model answers for the grown tile and
/// only the part that belongs to the original one is copied.
pub fn nchw_over_rgba(
    planar: &[f32],
    plane_width: usize,
    plane_height: usize,
    width: usize,
    height: usize,
    rgba: &mut [u8],
) {
    let plane = plane_width * plane_height;
    for channel in 0..3 {
        let values = &planar[channel * plane..(channel + 1) * plane];
        for row in 0..height {
            for column in 0..width {
                // Models can and do overshoot the nominal [0, 1] range at edges.
                let value = values[row * plane_width + column];
                rgba[(row * width + column) * 4 + channel] =
                    (value * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}
