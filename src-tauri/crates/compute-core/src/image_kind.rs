//! 「这张图动不动、画布多大」——只看容器头，不解码像素。
//!
//! 为什么在核心而不是各自一份实现：同一条判定有两个消费者，宿主（缓存里那份动图不能再被
//! 当成静态页）与 worker（超分之前先认出这一页），而 worker 拿不到宿主那份代码
//! （docs/71 §5.2 的边界）。两边一旦分叉，同一张图会在宿主被当成动图、在 worker 被当成
//! 静态首帧——症状正是「超分之后动画没了」，也就是这条判定存在的理由。
//!
//! 为什么只看头几个字节：动图一旦进了超分 / DLSSNR，出来的就只有第一帧。判定必须
//! 发生在任何解码与模型解析**之前**，代价也必须只是读个头。
//!
//! 只认结构说得清的三类（GIF / APNG / 动画 WebP）。读不懂的一律当静态：把静态页误判成
//! 动图会让它彻底拿不到超分，比漏掉一张动图更糟。
//!
//! [`canvas_size`] 是给「动图原样交回」那条路用的：worker 的 `image` 只留了 jpeg / png /
//! webp 解码器（§5.3 有意如此），问它 GIF 的尺寸问不出来——而容器头自己写着画布大小。
//! 而且**画布**才是该报的尺寸：解码第一帧量到的是另一回事（APNG 的第一帧可以比画布小，
//! 动画 GIF 的每帧也可以只覆盖画布的一部分）。

/// 认得出「它真的会动」的三种容器。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnimatedKind {
    Gif,
    Apng,
    WebP,
}

impl AnimatedKind {
    /// 原样交回时报给宿主的 mime。
    ///
    /// APNG 报 `image/png` 而不是 `image/apng`：它就是一张 PNG（`acTL`/`fcTL` 是附加块），
    /// 宿主与渲染器都按 PNG 收它；报一个只有少数场合认得的名字，只会在「同一份字节两个
    /// 说法」上再开一处分叉。
    pub const fn mime(self) -> &'static str {
        match self {
            Self::Gif => "image/gif",
            Self::Apng => "image/png",
            Self::WebP => "image/webp",
        }
    }

    /// 交回原字节时产物名的后缀。
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Gif => "gif",
            Self::Apng => "png",
            Self::WebP => "webp",
        }
    }
}

/// 这一页动不动：动就给出是哪一类容器，认不出或只有一帧就是 `None`。
pub fn animated_kind(bytes: &[u8]) -> Option<AnimatedKind> {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return match gif_frame_count(bytes) {
            Some(frames) if frames >= 2 => Some(AnimatedKind::Gif),
            _ => None,
        };
    }
    if bytes.starts_with(&PNG_SIGNATURE) {
        return png_is_animated(bytes).then_some(AnimatedKind::Apng);
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return webp_is_animated(bytes).then_some(AnimatedKind::WebP);
    }
    None
}

/// [`animated_kind`] 的布尔问法（宿主那几处只要「要不要原样交回」）。
pub fn is_animated_image(bytes: &[u8]) -> bool {
    animated_kind(bytes).is_some()
}

/// 容器声明的画布大小（像素）。认不出的容器、读不下去的头一律 `None`。
///
/// 只给 [`animated_kind`] 认得的三类容器答案：其余格式要问解码器，而这一层的全部理由就是
/// 不碰解码器。
pub fn canvas_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return gif_canvas(bytes);
    }
    if bytes.starts_with(&PNG_SIGNATURE) {
        return png_canvas(bytes);
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return webp_canvas(bytes);
    }
    None
}

/// PNG 的 8 字节签名。
pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// GIF 逻辑屏幕描述符里的画布大小（6..10 字节，小端）。
fn gif_canvas(bytes: &[u8]) -> Option<(u32, u32)> {
    let width = u32::from(u16::from_le_bytes([*bytes.get(6)?, *bytes.get(7)?]));
    let height = u32::from(u16::from_le_bytes([*bytes.get(8)?, *bytes.get(9)?]));
    (width > 0 && height > 0).then_some((width, height))
}

/// PNG 的画布就是 `IHDR` 里那对数（`IHDR` 必须是第一个块，8 字节签名 + 8 字节块头之后）。
fn png_canvas(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

/// 动画 WebP 必然是「扩展格式」，而扩展格式的第一个 chunk 必须是 `VP8X`：画布大小就在
/// 它里面（24 位小端，存的是「减一」）。
fn webp_canvas(bytes: &[u8]) -> Option<(u32, u32)> {
    const VP8X_START: usize = 12;
    if bytes.get(VP8X_START..VP8X_START + 4)? != b"VP8X" {
        return None;
    }
    let canvas = bytes.get(VP8X_START + 12..VP8X_START + 15 + 3)?;
    let width = 1 + u32::from(canvas[0]) + (u32::from(canvas[1]) << 8) + (u32::from(canvas[2]) << 16);
    let height =
        1 + u32::from(canvas[3]) + (u32::from(canvas[4]) << 8) + (u32::from(canvas[5]) << 16);
    Some((width, height))
}

/// 走 GIF 容器结构数「图像描述符」（`0x2C`）的个数。读不下去（截断、越界、碰上不
/// 认识的块）时给 `None`——那样的字节不值得猜。
///
/// 为什么数描述符而不是问 `gif` crate：那个 crate 没有帧数 API，而动图 DLSSNR 要在动手
/// 之前拿帧数判预算（见 `src-tauri/src/dlssnr/animation.rs`）。
pub fn gif_frame_count(bytes: &[u8]) -> Option<usize> {
    // 头部 6 字节 + 逻辑屏幕描述符 7 字节。
    let mut cursor = 13usize;
    if bytes.len() < cursor {
        return None;
    }
    // packed 字节 bit7 是全局色表标志，表长 3 * 2^(n+1)。
    let packed = bytes[10];
    if packed & 0x80 != 0 {
        cursor = cursor.checked_add(3usize << ((packed & 0x07) + 1))?;
        if cursor > bytes.len() {
            return None;
        }
    }
    let mut frames = 0usize;
    loop {
        match *bytes.get(cursor)? {
            0x3B => return Some(frames),
            0x2C => {
                // 先跨过块起始符，下面一律以描述符首字节为基准（否则色表标志会读成
                // 高度的低位字节，子块链从 LZW 最小码长那一位错开）。
                cursor += 1;
                if cursor + 9 > bytes.len() {
                    return None;
                }
                // 图像描述符最后一字节的 bit7 是局部色表标志，与全局色表同构。
                let local = bytes[cursor + 8];
                cursor += 9;
                if local & 0x80 != 0 {
                    cursor = cursor.checked_add(3usize << ((local & 0x07) + 1))?;
                    if cursor > bytes.len() {
                        return None;
                    }
                }
                // 图像数据以 LZW 最小码长一个字节开头，后面才是子块链。
                cursor = skip_gif_sub_blocks(bytes, cursor + 1)?;
                frames += 1;
            }
            // 扩展块：一个标签字节 + 子块链。图形控制块与注释都算在这里，
            // 它们不代表新的一帧。
            0x21 => cursor = skip_gif_sub_blocks(bytes, cursor + 2)?,
            _ => return None,
        }
    }
}

/// 跳过 GIF 子块链：长度字节 + 数据，遇到 0 长度字节结束。
fn skip_gif_sub_blocks(bytes: &[u8], mut cursor: usize) -> Option<usize> {
    loop {
        let size = *bytes.get(cursor)? as usize;
        cursor += 1;
        if size == 0 {
            return Some(cursor);
        }
        cursor = cursor.checked_add(size)?;
        if cursor > bytes.len() {
            return None;
        }
    }
}

/// PNG 块链：`acTL` 出现在第一个 `IDAT` 之前就是 APNG（chunk 长度不校验 CRC）。
fn png_is_animated(bytes: &[u8]) -> bool {
    let mut cursor = 8usize;
    while cursor + 8 <= bytes.len() {
        let length = u32::from_be_bytes([
            bytes[cursor],
            bytes[cursor + 1],
            bytes[cursor + 2],
            bytes[cursor + 3],
        ]) as usize;
        let kind = &bytes[cursor + 4..cursor + 8];
        if kind == b"acTL" {
            return true;
        }
        if kind == b"IDAT" {
            return false;
        }
        // 4 字节长度 + 4 字节类型 + 数据 + 4 字节 CRC；读不到块的边界就当静态。
        match (cursor + 12).checked_add(length) {
            Some(next) if next <= bytes.len() => cursor = next,
            _ => return false,
        }
    }
    false
}

/// 动画 WebP：`VP8X` 的 ANIM 位置位，或者 chunk 列表里出现 `ANIM`。
fn webp_is_animated(bytes: &[u8]) -> bool {
    let mut cursor = 12usize;
    let mut first = true;
    while cursor + 8 <= bytes.len() {
        let kind = &bytes[cursor..cursor + 4];
        let length = u32::from_le_bytes([
            bytes[cursor + 4],
            bytes[cursor + 5],
            bytes[cursor + 6],
            bytes[cursor + 7],
        ]) as usize;
        if first && kind == b"VP8X" {
            if matches!(bytes.get(cursor + 8), Some(flags) if flags & 0x02 != 0) {
                return true;
            }
        }
        first = false;
        if kind == b"ANIM" {
            return true;
        }
        // RIFF chunk 按偶数字节对齐，块之间可能有一个填充字节。
        let next = (cursor + 8).saturating_add(length + (length & 1));
        if next <= cursor || next > bytes.len() {
            return false;
        }
        cursor = next;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一张 64×48 的合成 GIF：头部 + 每帧 12 字节（描述符 + LZW 码长 + 子块结束）+ 尾。
    fn gif_with_frames(frames: usize) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&[0x40, 0x00, 0x30, 0x00]); // 64×48
        bytes.extend_from_slice(&[0x00, 0x00, 0x00]); // 无全局色表、底色、像素比
        for _ in 0..frames {
            bytes.push(0x2C);
            bytes.extend_from_slice(&[0; 9]);
            bytes.extend_from_slice(&[0x02, 0x00]);
        }
        bytes.push(0x3B);
        bytes
    }

    /// 一张 64×48 的合成 PNG 块链：签名 + IHDR + 附加块（`acTL` 或 `IDAT`）。
    fn png_with_chunk(kind: &[u8; 4]) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        let mut ihdr = vec![0x00, 0x00, 0x00, 0x0d];
        ihdr.extend_from_slice(b"IHDR");
        ihdr.extend_from_slice(&64u32.to_be_bytes());
        ihdr.extend_from_slice(&48u32.to_be_bytes());
        ihdr.extend_from_slice(&[0x08, 0x06, 0x00, 0x00, 0x00]);
        ihdr.extend_from_slice(&[0; 4]); // CRC：这一层不校验
        bytes.extend_from_slice(&ihdr);
        let mut extra = vec![0x00, 0x00, 0x00, 0x08];
        extra.extend_from_slice(kind);
        extra.extend_from_slice(&[0; 8]);
        extra.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&extra);
        bytes
    }

    /// 一张 64×48 的扩展格式 WebP：`VP8X` 是第一个 chunk，画布大小写「减一」。
    fn webp_with_vp8x_flags(flags: u8) -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&22u32.to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(b"VP8X");
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.push(flags);
        bytes.extend_from_slice(&[0; 3]);
        bytes.extend_from_slice(&[63, 0, 0, 47, 0, 0]); // 64-1、48-1
        bytes
    }

    #[test]
    fn only_a_gif_with_two_frames_counts_as_animated() {
        assert_eq!(animated_kind(&gif_with_frames(3)), Some(AnimatedKind::Gif));
        assert_eq!(animated_kind(&gif_with_frames(2)), Some(AnimatedKind::Gif));
        assert_eq!(animated_kind(&gif_with_frames(1)), None, "一帧的 GIF 不算动图");
        assert_eq!(animated_kind(b"GIF89a"), None, "截断的头不值得猜");
    }

    #[test]
    fn an_apng_needs_its_actl_before_the_first_frame() {
        assert_eq!(
            animated_kind(&png_with_chunk(b"acTL")),
            Some(AnimatedKind::Apng)
        );
        assert_eq!(animated_kind(&png_with_chunk(b"IDAT")), None);
    }

    #[test]
    fn a_webp_is_animated_by_the_vp8x_animation_bit() {
        assert_eq!(
            animated_kind(&webp_with_vp8x_flags(0x02)),
            Some(AnimatedKind::WebP)
        );
        assert_eq!(animated_kind(&webp_with_vp8x_flags(0x00)), None);
    }

    #[test]
    fn anything_unreadable_is_static_not_animated() {
        assert!(!is_animated_image(b"<html>not an image</html>"));
        assert!(!is_animated_image(&[]));
        assert!(!is_animated_image(&[0x89, b'P']));
    }

    /// 画布大小来自容器头：三个容器都说 64×48，而**帧**的尺寸与它无关。
    #[test]
    fn the_canvas_comes_from_the_container_header() {
        assert_eq!(canvas_size(&gif_with_frames(3)), Some((64, 48)));
        assert_eq!(canvas_size(&png_with_chunk(b"acTL")), Some((64, 48)));
        assert_eq!(canvas_size(&webp_with_vp8x_flags(0x02)), Some((64, 48)));
    }

    #[test]
    fn a_canvas_is_unknown_for_anything_this_layer_does_not_parse() {
        assert_eq!(canvas_size(b"\xff\xd8\xff\xe0 not a jpeg this layer reads"), None);
        assert_eq!(canvas_size(b"GIF89a"), None, "头都不够长");
        assert_eq!(canvas_size(&PNG_SIGNATURE), None, "只有签名、没有 IHDR");
        assert_eq!(canvas_size(b"RIFF\x00\x00\x00\x00WEBP"), None, "只有容器头");
    }

    #[test]
    fn the_mime_and_extension_follow_the_container() {
        assert_eq!(AnimatedKind::Gif.mime(), "image/gif");
        assert_eq!(AnimatedKind::Apng.mime(), "image/png");
        assert_eq!(AnimatedKind::WebP.mime(), "image/webp");
        assert_eq!(AnimatedKind::Gif.extension(), "gif");
        assert_eq!(AnimatedKind::Apng.extension(), "png");
        assert_eq!(AnimatedKind::WebP.extension(), "webp");
    }
}
