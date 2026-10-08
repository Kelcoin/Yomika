//! 把模型算出来的大图缩到**交出去**的尺寸。
//!
//! 这条规则原来只写在宿主的 `inference.rs` 里。Task 7-b 把超分搬进 worker 之后，
//! 「交出去多大」必须由 worker 在**编码之前**执行（x4 的 5600×8000 是 180 MB RGBA，
//! 编码出来又是几十 MB，而阅读器的槽位最多是页的两三倍），于是同一件事有了两个
//! 执行者。把它放在核心、由两边调同一份，才不会出现「宿主按 2 倍缓存、worker 交出
//! 4 倍」这种谁都不认的产物（MEMORY 三十二：搬进核心的验收标准是同一组行为被另一条
//! 路径复现，不是宿主那边的测试还绿着）。
//!
//! 这里**只**是机制：缩到几倍是调用方给的参数，产品常数留在宿主（`ENHANCED_OUTPUT_SCALE`）。

/// 把 `rgba` 从 `width × height` 缩到 `source_width × source_height` 的
/// `max_scale` 倍；本来就**不大**于那个尺寸时原样返回。
///
/// 取 `Vec` 而不是 `&[u8]` 是有意的（原来在宿主里就是这样）：`RgbaImage::from_raw`
/// 之后原来那份缓冲要活到缩放结束，而 25 MP 的模型输出是 256 MB——引用版本为了保证
/// 借用关系会先 `to_vec()` 复制一份，等于同一张图在内存里躺两份。移动进来就只有一份。
pub fn fit_rgba_scale(
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    source_width: u32,
    source_height: u32,
    max_scale: u32,
) -> (Vec<u8>, u32, u32) {
    let target_width = source_width.saturating_mul(max_scale);
    let target_height = source_height.saturating_mul(max_scale);
    if width <= target_width || height <= target_height || target_width == 0 || target_height == 0 {
        return (rgba, width, height);
    }
    // `RgbaImage::from_raw` 拒绝比 `width * height * 4` 短的缓冲（乘积溢出 usize 也拒绝），
    // 与下面这条检查是同一个判据——所以过了它的缓冲一定被接受，没过的一定原样退回。
    let fits = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .is_some_and(|min_len| min_len <= rgba.len());
    if !fits {
        return (rgba, width, height);
    }
    let image = image::RgbaImage::from_raw(width, height, rgba)
        .expect("缓冲刚刚按 width * height * 4 检查过");
    // 下采样用 Lanczos3：模型的时间花在恢复边缘上，box 滤镜会把它当场还回去。
    let resized = image::imageops::resize(
        &image,
        target_width,
        target_height,
        image::imageops::FilterType::Lanczos3,
    );
    (resized.into_raw(), target_width, target_height)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一张四角颜色不同的方图：缩放之后还能认出「这是同一张图、只是小了」。
    fn quadrants(size: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((size as usize) * (size as usize) * 4);
        for y in 0..size {
            for x in 0..size {
                let left = x < size / 2;
                let top = y < size / 2;
                let (r, g, b) = match (top, left) {
                    (true, true) => (255, 0, 0),
                    (true, false) => (0, 255, 0),
                    (false, true) => (0, 0, 255),
                    (false, false) => (255, 255, 0),
                };
                rgba.extend_from_slice(&[r, g, b, 255]);
            }
        }
        rgba
    }

    #[test]
    fn a_four_times_output_is_brought_down_to_the_asked_scale() {
        let source = quadrants(4);
        let quadrupled = quadrants(16);
        let (fitted, width, height) = fit_rgba_scale(quadrupled, 16, 16, 4, 4, 2);
        assert_eq!((width, height), (8, 8), "x4 的模型输出按 2 倍交出");
        assert_eq!(fitted.len(), 8 * 8 * 4);
        // 缩出来的图还要是**这张图**：左上角仍然是红的。
        assert_eq!(&fitted[..4], &[255, 0, 0, 255], "左上角还是原来的颜色");
        assert_ne!(fitted, source, "缩到 2 倍，不是退回原图");
    }

    #[test]
    fn anything_already_at_or_below_the_scale_is_handed_back_untouched() {
        let doubled = quadrants(8);
        let (same, width, height) = fit_rgba_scale(doubled.clone(), 8, 8, 4, 4, 2);
        assert_eq!((width, height), (8, 8));
        assert_eq!(same, doubled, "正好 2 倍就是它本身，一个字节都不动");
    }

    #[test]
    fn a_buffer_that_is_too_short_for_its_size_is_returned_as_is() {
        // 不是「先崩一下」：缓冲与尺寸对不上时原样退回，交给上层按尺寸去做它自己的判断。
        let short = vec![0u8; 16];
        let (same, width, height) = fit_rgba_scale(short.clone(), 16, 16, 4, 4, 2);
        assert_eq!((width, height), (16, 16));
        assert_eq!(same, short);
    }

    #[test]
    fn a_zero_sized_source_is_not_a_target() {
        let (same, width, height) = fit_rgba_scale(vec![1, 2, 3, 4], 1, 1, 0, 0, 2);
        assert_eq!((width, height), (1, 1));
        assert_eq!(same, vec![1, 2, 3, 4]);
    }
}
