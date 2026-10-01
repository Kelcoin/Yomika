//! 动图逐帧过 DLSSNR，再编回 APNG。
//!
//! DLSSNR 对每一张图都是自足的空间滤波：`filter` 里每次 `record_page` 都写
//! `DLSSNR.Reset = 1`、运动矢量按 1:1 给、深度反转，所以「第 N 帧」在它眼里与
//! 「一张静图」没有区别——逐帧当静图跑本来就是它唯一的用法。同一尺寸的帧还会命中
//! `workspace::choose` 的 `Choice::Reuse`，D3D12 工作区与 feature 只建一次。
//!
//! 容器选 APNG：`image` 只解不编，`image-webp` 只有解码器，`image` 自己的 WebP
//! 编码器只能写静态 lossless——把「多帧 + 每帧延迟 + 循环次数」一次写全的只有
//! `png` 的 `set_animated` 加逐帧 fcTL。APNG 的 magic 就是 PNG，所以落到缓存与
//! 前端的 content-type 仍然是 `image/png`（`sniff_image_mime` 照收），前端把 mime
//! 直通 `Blob`，`<img>` 原生播放。
//!
//! 三种容器都先**只读容器头**拿帧数与画布尺寸：预算必须在动手前判断（超了就原样
//! 交回），而 APNG 的 `acTL` 又必须在第一帧之前写好，帧数不能在流式解的过程中才
//! 发现。帧本身是流式的：一次只留一帧的 RGBA 与一帧的产物，不把整段动画摊开。
//!
//! 记住 `png` 写入端的一个硬约束：写满 `acTL` 声明的帧数之后 `frame_control` 会
//! 被置空，多写的帧会退化成普通 `IDAT`（把 APNG 写坏）——所以必须**恰好**写
//! `shape.frames` 帧（见 `png-0.17.16/src/encoder.rs:797-803`）。

use std::io::Cursor;
use std::path::Path;

use image::AnimationDecoder;
use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;

use super::settings::DlssnrSettings;
use crate::inference::cancel::CancelToken;

/// 一次动画处理接受的**总像素**（画布像素 × 帧数）上限。
///
/// 按的是「解出来的 RGBA 与中间产物能撑多大」：40MP 一帧 4K 是 33MB RGBA，一段
/// 40MP 的动画在 8 帧 4K 上下。超过就原样交回，不进 DLSSNR。
pub const ANIMATION_PIXEL_BUDGET: u64 = 40_000_000;
/// 一次动画处理接受的帧数上限。再长就不是「翻到的那张图」而是一段片子了。
pub const ANIMATION_FRAME_LIMIT: u32 = 240;

/// 与 `filter::MIN_EDGE` 同值：更小的图 DLSSNR 自己会拒，动画也不必开。
const MIN_EDGE: u32 = 32;

/// 一次处理的预算。默认取上面两个常量，测试可以调小来覆盖超限分支。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnimationLimits {
    pub pixels: u64,
    pub frames: u32,
}

impl Default for AnimationLimits {
    fn default() -> Self {
        Self {
            pixels: ANIMATION_PIXEL_BUDGET,
            frames: ANIMATION_FRAME_LIMIT,
        }
    }
}

/// 容器头里说得出的话。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Shape {
    frames: u32,
    width: u32,
    height: u32,
}

/// 只读容器头：GIF / APNG / 动画 WebP 各自的帧数与画布尺寸。
///
/// 读不出来、或者根本不是说得出帧数的容器，一律 `None`（调用方原样交回）。
fn shape(bytes: &[u8]) -> Option<Shape> {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        // GIF 的逻辑屏幕尺寸就在固定头部里：宽、高各 2 字节小端。
        if bytes.len() < 13 {
            return None;
        }
        let frames = crate::cache::gif_frame_count(bytes)? as u32;
        return Some(Shape {
            frames,
            width: u32::from(u16::from_le_bytes([bytes[6], bytes[7]])),
            height: u32::from(u16::from_le_bytes([bytes[8], bytes[9]])),
        });
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        // acTL 按规范必须出现在第一个 IDAT 之前，所以 `read_info` 之后它就在
        // Info 里（`cache::png_is_animated` 认得同一件事）。
        let reader = png::Decoder::new(Cursor::new(bytes)).read_info().ok()?;
        let info = reader.info();
        let control = info.animation_control()?;
        return Some(Shape {
            frames: control.num_frames,
            width: info.width,
            height: info.height,
        });
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        // `image` 的包装层没暴露帧数，只能问 `image-webp` 自己。
        let decoder = image_webp::WebPDecoder::new(Cursor::new(bytes)).ok()?;
        if !decoder.is_animated() {
            return None;
        }
        let (width, height) = decoder.dimensions();
        return Some(Shape {
            frames: decoder.num_frames(),
            width,
            height,
        });
    }
    None
}

/// `image` 的循环语义 → acTL 的 `num_plays`：`Infinite` 就是「一直播」的 0。
fn plays(loops: image::metadata::LoopCount) -> u32 {
    match loops {
        image::metadata::LoopCount::Infinite => 0,
        image::metadata::LoopCount::Finite(value) => value.get(),
    }
}

/// 三种容器解出来都是同一个迭代器形状（整画布 RGBA 帧），这里的盒子只为把三种
/// 解码器收成一个类型，免得下面的循环写三遍。
type FrameStream<'a> = Box<dyn Iterator<Item = image::ImageResult<image::Frame>> + 'a>;

/// 开一个帧流，顺带问出循环次数——`loop_count` 只需要 `&self`，所以能在
/// `into_frames()` 之前问。
fn frames_of(bytes: &[u8]) -> Result<(FrameStream<'_>, u32), String> {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        let decoder = GifDecoder::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
        let plays = plays(decoder.loop_count());
        return Ok((Box::new(decoder.into_frames()), plays));
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        let decoder = PngDecoder::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
        let apng = decoder.apng().map_err(|error| error.to_string())?;
        let plays = plays(apng.loop_count());
        return Ok((Box::new(apng.into_frames()), plays));
    }
    let decoder = WebPDecoder::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let plays = plays(decoder.loop_count());
    Ok((Box::new(decoder.into_frames()), plays))
}

/// 一帧的延迟，毫秒。
///
/// 0 补成 100：GIF 的「尽快播」在浏览器里本来就按 100ms 走，而 APNG 里的 0 是
/// 真的一帧不等——照抄会把转出来的动画放快一截。
fn frame_delay(frame: &image::Frame) -> u16 {
    let (numerator, denominator) = frame.delay().numer_denom_ms();
    let millis = if denominator == 0 {
        u64::from(numerator)
    } else {
        // 四舍五入：GIF 的延迟是百分秒（10ms 一格），换成毫秒是整的；WebP/APNG
        // 本来就存毫秒。半格的情形不存在，这里只是不主动截断。
        (u64::from(numerator) + u64::from(denominator) / 2) / u64::from(denominator)
    };
    let millis = if millis == 0 { 100 } else { millis };
    millis.min(u64::from(u16::MAX)) as u16
}

/// 逐帧过一遍 `process`，编回 APNG。
///
/// 返回 `Ok(None)` 表示**这一份不该处理，原样交回**：容器读不懂、不是动图、画布
/// 太小、超帧数或像素预算、容器声明的帧数与实际不符。这些判断都在解码之前做完，
/// 唯一需要解码的是「预算之内、真要去处理」的那一段。
///
/// `process` 拿到的是**一帧整画布**的 RGBA（三种解码器都会把帧合成到整画布、左上
/// 角为 0，所以这里不需要处理 offset），返回同尺寸的 RGBA。测试传恒等函数就能在
/// 没有 GPU 的机器上走完整条链路。
pub fn transcode<F>(
    bytes: &[u8],
    limits: AnimationLimits,
    cancel: &CancelToken,
    mut process: F,
) -> Result<Option<Vec<u8>>, String>
where
    F: FnMut(Vec<u8>, u32, u32) -> Result<Vec<u8>, String>,
{
    let shape = match shape(bytes) {
        Some(shape) if shape.frames >= 2 => shape,
        _ => return Ok(None),
    };
    if shape.width < MIN_EDGE || shape.height < MIN_EDGE {
        return Ok(None);
    }
    if shape.frames > limits.frames {
        return Ok(None);
    }
    let pixels = u64::from(shape.width) * u64::from(shape.height) * u64::from(shape.frames);
    if pixels > limits.pixels {
        return Ok(None);
    }

    let (mut frames, plays) = frames_of(bytes)?;
    let mut encoded = Vec::new();
    let mut writer = {
        let mut encoder = png::Encoder::new(&mut encoded, shape.width, shape.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        // 与静态那条路同一档压缩：`image::codecs::png::PngEncoder::new` 的默认档是
        // `CompressionType::Fast` → `png::Compression::Fast`，过滤档是
        // `FilterType::Adaptive` → `png::Filter::Adaptive`（实测 1.08MP 一帧 release
        // 3ms、1.7MB；换成 NoFilter 会到 4.2MB）。
        encoder.set_compression(png::Compression::Fast);
        encoder.set_filter(png::Filter::Adaptive);
        encoder
            .set_animated(shape.frames, plays)
            .map_err(|error| error.to_string())?;
        encoder.write_header().map_err(|error| error.to_string())?
    };

    // 恰好写 shape.frames 帧：png 在写满 acTL 声明的帧数之后会把 frame_control
    // 置空，再多写的帧就成了普通 IDAT，整份文件不再是能播的 APNG。
    for _ in 0..shape.frames {
        // 帧与帧之间才是取消点：一帧 DLSSNR 自己没法从中间停下。
        if cancel.cancelled() {
            return Err(super::filter::CANCELLED.to_string());
        }
        let Some(frame) = frames.next() else {
            // 容器声明的帧数没兑现（截断）：原样交回，别编一份半截的 APNG。
            return Ok(None);
        };
        // 解码器在这一帧上翻车也一样退回：**用户那份文件本身没事**，只是我们没能
        // 增强它，让阅读器照原样播它，总好过整页报错（这也是本次改动之前的行为）。
        let Ok(frame) = frame else {
            return Ok(None);
        };
        if frame.buffer().width() != shape.width || frame.buffer().height() != shape.height {
            // 中途中途换尺寸的容器（不是正经动画）：不猜，原样交回。
            return Ok(None);
        }
        let delay = frame_delay(&frame);
        let processed = process(frame.into_buffer().into_raw(), shape.width, shape.height)?;
        if processed.len() != shape.width as usize * shape.height as usize * 4 {
            return Err("dlssnr: 动图某一帧的产物尺寸与画布对不上".to_string());
        }
        writer
            .set_frame_delay(delay, 1000)
            .map_err(|error| error.to_string())?;
        writer
            .set_dispose_op(png::DisposeOp::None)
            .map_err(|error| error.to_string())?;
        writer
            .set_blend_op(png::BlendOp::Source)
            .map_err(|error| error.to_string())?;
        writer
            .set_frame_dimension(shape.width, shape.height)
            .map_err(|error| error.to_string())?;
        writer
            .set_frame_position(0, 0)
            .map_err(|error| error.to_string())?;
        writer
            .write_image_data(&processed)
            .map_err(|error| error.to_string())?;
    }
    writer.finish().map_err(|error| error.to_string())?;
    Ok(Some(encoded))
}

/// 一页动图走 DLSSNR：`Ok(None)` ＝ 不是能处理的动图（原样直出），`Ok(Some)` ＝
/// 编好的 APNG。
pub fn apply_dlssnr(
    data_dir: &Path,
    bytes: &[u8],
    settings: &DlssnrSettings,
    cancel: &CancelToken,
) -> Result<Option<Vec<u8>>, String> {
    transcode(
        bytes,
        AnimationLimits::default(),
        cancel,
        |rgba, width, height| {
            let image = super::filter::DlssnrImage::new(width, height, rgba)?;
            // 逐帧走 `apply_with_token`（而不是 `dlssnr::apply_rgba`）：那段动画有
            // 几十上百帧，切页之后要能在帧与帧之间立刻停。
            super::filter::apply_with_token(data_dir, &image, settings, cancel)
                .map(|out| out.rgba)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;
    use image::RgbaImage;

    const GIF: &[u8] = include_bytes!("testdata/animated.gif");
    const APNG: &[u8] = include_bytes!("testdata/animated.png");
    const WEBP: &[u8] = include_bytes!("testdata/animated.webp");
    const SHAPE: (u32, u32) = (64, 48);
    const FRAMES: u32 = 3;
    const DELAYS: [u32; 3] = [100, 250, 40];
    const COLORS: [[u8; 3]; 3] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

    struct Decoded {
        delays: Vec<u32>,
        colors: Vec<[u8; 3]>,
        /// 循环次数，用「0 ＝ 无限」表示（`LoopCount` 既不 `PartialEq` 也不 `Debug`，
        /// 直接换成 acTL 里那个 `num_plays` 更好断言）。
        plays: u32,
    }

    /// 把产物当 APNG 读回来。延迟换成毫秒，颜色取左上角那个像素。
    fn decode_apng(bytes: &[u8]) -> Decoded {
        let decoder = PngDecoder::new(Cursor::new(bytes)).expect("产物应当是可解码的 PNG");
        let apng = decoder.apng().expect("产物应当是 APNG");
        let plays = plays(apng.loop_count());
        let mut delays = Vec::new();
        let mut colors = Vec::new();
        for frame in apng.into_frames() {
            let frame = frame.expect("产物里的帧应当解得出来");
            let (numerator, denominator) = frame.delay().numer_denom_ms();
            delays.push(numerator / denominator.max(1));
            let pixel = frame.buffer().get_pixel(0, 0).0;
            colors.push([pixel[0], pixel[1], pixel[2]]);
        }
        Decoded {
            delays,
            colors,
            plays,
        }
    }

    /// 源文件自己解出来是什么样：延迟（毫秒，0 已补成 100）、左上角像素、循环次数。
    /// 产物必须与这份一致——「转码不改内容」就是这条路线全部的合同。
    fn source_frames(bytes: &[u8]) -> (Vec<u32>, Vec<[u8; 3]>, u32) {
        let (mut frames, plays) = frames_of(bytes).expect("夹具应当解得开");
        let mut delays = Vec::new();
        let mut colors = Vec::new();
        for frame in &mut frames {
            let frame = frame.expect("夹具的帧应当解得开");
            delays.push(u32::from(frame_delay(&frame)));
            let pixel = frame.buffer().get_pixel(0, 0).0;
            colors.push([pixel[0], pixel[1], pixel[2]]);
        }
        (delays, colors, plays)
    }

    /// 恒等跑一遍：断言输出是 APNG，且帧数/尺寸/延迟/像素/循环次数都与源文件解出来
    /// 的一致。返回源文件解出来的那份，供各容器的用例再补几条硬断言。
    fn round_trip(source: &[u8]) -> (Vec<u32>, Vec<[u8; 3]>, u32) {
        let (delays, colors, plays) = source_frames(source);
        let mut seen = 0u32;
        let out = transcode(
            source,
            AnimationLimits::default(),
            &CancelToken::none(),
            |rgba, width, height| {
                seen += 1;
                assert_eq!((width, height), SHAPE, "帧尺寸应当与画布一致");
                assert_eq!(
                    rgba.len(),
                    (SHAPE.0 * SHAPE.1 * 4) as usize,
                    "一帧应当是整画布 RGBA"
                );
                Ok(rgba)
            },
        )
        .expect("转码不该失败")
        .expect("这份动图应当被处理");

        assert_eq!(&out[..8], b"\x89PNG\r\n\x1a\n", "输出必须是 PNG 容器");
        let decoded = decode_apng(&out);
        assert_eq!(seen, FRAMES, "每一帧都应当过一遍");
        assert_eq!(decoded.delays, delays, "每帧延迟应当原样保留");
        assert_eq!(decoded.colors, colors, "每帧像素应当原样保留");
        assert_eq!(decoded.plays, plays, "循环次数应当原样保留");
        (delays, colors, plays)
    }

    fn solid(width: u32, height: u32, color: [u8; 3]) -> RgbaImage {
        RgbaImage::from_pixel(width, height, image::Rgba([color[0], color[1], color[2], 255]))
    }

    /// 用 `image` 的 GIF 编码器造一份动图（用于小画布这类夹具里没有的情况）。
    fn synthetic_gif(frames: u32, size: (u32, u32)) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut out);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .expect("Netscape 循环块");
        let built = (0..frames)
            .map(|index| {
                let index = index as usize;
                image::Frame::from_parts(
                    solid(size.0, size.1, COLORS[index % COLORS.len()]),
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(DELAYS[index % DELAYS.len()], 1),
                )
            })
            .collect::<Vec<_>>();
        encoder.encode_frames(built).expect("GIF 帧应当写得下去");
        drop(encoder);
        out
    }

    /// 手写一份 APNG。`declared` 是写进 acTL 的帧数、`written` 是真正写出去的帧数：
    /// 两者不等就是「容器在撒谎」，用来覆盖退回分支。
    fn write_apng(
        declared: u32,
        plays: u32,
        delays: &[(u16, u16)],
        written: u32,
        size: (u32, u32),
    ) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, size.0, size.1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .set_animated(declared, plays)
            .expect("acTL 应当写得下去");
        let mut writer = encoder.write_header().expect("IHDR 应当写得下去");
        for index in 0..written {
            let index = index as usize;
            let (numerator, denominator) = delays[index % delays.len()];
            writer.set_frame_delay(numerator, denominator).expect("fcTL 延迟");
            writer.set_dispose_op(png::DisposeOp::None).expect("fcTL 处置");
            writer.set_blend_op(png::BlendOp::Source).expect("fcTL 混合");
            let image = solid(size.0, size.1, COLORS[index % COLORS.len()]);
            writer.write_image_data(image.as_raw()).expect("帧数据");
        }
        writer.finish().expect("IEND 应当写得下去");
        out
    }

    fn still_png() -> Vec<u8> {
        let image = solid(SHAPE.0, SHAPE.1, COLORS[0]);
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                image.as_raw(),
                SHAPE.0,
                SHAPE.1,
                image::ExtendedColorType::Rgba8,
            )
            .expect("静态 PNG");
        out
    }

    /// 三份夹具都是 64×48、3 帧。
    #[test]
    fn reads_the_shape_of_every_container_it_understands() {
        for (label, bytes) in [("gif", GIF), ("apng", APNG), ("webp", WEBP)] {
            assert_eq!(
                shape(bytes),
                Some(Shape {
                    frames: FRAMES,
                    width: SHAPE.0,
                    height: SHAPE.1
                }),
                "{label} 的帧数与画布应当读得出来"
            );
        }
        assert_eq!(shape(&still_png()), None, "静态 PNG 不是动图");
        assert_eq!(shape(b"not an image at all"), None, "垃圾字节不该猜出形状");
        assert_eq!(shape(&[]), None, "空字节不该猜出形状");
    }

    #[test]
    fn rewrites_a_gif_as_an_apng() {
        // 夹具写的是 loop=0，也就是 GIF 的 Netscape 块里那个「无限」。
        let (delays, colors, plays) = round_trip(GIF);
        assert_eq!(delays, DELAYS);
        assert_eq!(colors, COLORS);
        assert_eq!(plays, 0);
    }

    #[test]
    fn rewrites_an_apng_as_an_apng() {
        let (delays, colors, plays) = round_trip(APNG);
        assert_eq!(delays, DELAYS);
        assert_eq!(colors, COLORS);
        assert_eq!(plays, 0);
    }

    #[test]
    fn rewrites_an_animated_webp_as_an_apng() {
        // 只比「解出来的像素」，不比夹具里写进去的那三个纯色：libwebp 的 lossless
        // 走的是 YCoCg 变换，纯绿纯蓝回来会差 1（实测 [0,254,0]/[0,0,254]），那是
        // **源解码器**的取整，不是我们改的。所以这里额外确认每帧主色还对得上、
        // 三帧也确实互不相同。
        let (delays, colors, plays) = round_trip(WEBP);
        assert_eq!(delays, DELAYS);
        assert_eq!(plays, 0);
        assert!(colors[0][0] >= 254 && colors[1][1] >= 254 && colors[2][2] >= 254);
        assert_ne!(colors[0], colors[1]);
        assert_ne!(colors[1], colors[2]);
    }

    #[test]
    fn carries_a_finite_loop_count_across() {
        let source = write_apng(2, 6, &[(100, 1000), (100, 1000)], 2, SHAPE);
        let out = transcode(&source, AnimationLimits::default(), &CancelToken::none(), |rgba, _, _| {
            Ok(rgba)
        })
        .expect("转码不该失败")
        .expect("这份动图应当被处理");
        assert_eq!(
            decode_apng(&out).plays,
            6,
            "有限循环次数应当写进 acTL 的 num_plays"
        );
    }

    #[test]
    fn floors_a_zero_delay_at_a_hundred_milliseconds() {
        // GIF 的「尽快播」（延迟 0）在各浏览器里都按 100ms 走，而 APNG 里写 0 就是
        // 0：不补这一下，转出来的动画会比原来快一截。
        let source = write_apng(2, 0, &[(0, 1000), (250, 1000)], 2, SHAPE);
        let out = transcode(&source, AnimationLimits::default(), &CancelToken::none(), |rgba, _, _| {
            Ok(rgba)
        })
        .expect("转码不该失败")
        .expect("这份动图应当被处理");
        assert_eq!(decode_apng(&out).delays, vec![100, 250]);
    }

    #[test]
    fn hands_the_bytes_back_when_the_animation_is_over_budget() {
        let mut calls = 0;
        let limits = AnimationLimits {
            pixels: u64::from(SHAPE.0) * u64::from(SHAPE.1) * u64::from(FRAMES) - 1,
            ..AnimationLimits::default()
        };
        let out = transcode(GIF, limits, &CancelToken::none(), |rgba, _, _| {
            calls += 1;
            Ok(rgba)
        })
        .expect("超预算不是错误");
        assert_eq!(out, None, "超预算应当原样交回");
        assert_eq!(calls, 0, "超预算不该解出一帧来");
    }

    #[test]
    fn hands_the_bytes_back_when_there_are_too_many_frames() {
        let limits = AnimationLimits {
            frames: FRAMES - 1,
            ..AnimationLimits::default()
        };
        assert_eq!(
            transcode(GIF, limits, &CancelToken::none(), |rgba, _, _| Ok(rgba)).expect("上限不是错误"),
            None
        );
    }

    #[test]
    fn hands_the_bytes_back_when_the_canvas_is_too_small() {
        let source = synthetic_gif(FRAMES, (16, 16));
        assert_eq!(
            transcode(&source, AnimationLimits::default(), &CancelToken::none(), |rgba, _, _| Ok(
                rgba
            ))
            .expect("小图不是错误"),
            None,
            "16×16 低于 DLSSNR 的下限，应当原样交回"
        );
    }

    #[test]
    fn hands_the_bytes_back_for_a_still_image() {
        let source = still_png();
        assert_eq!(
            transcode(&source, AnimationLimits::default(), &CancelToken::none(), |rgba, _, _| Ok(
                rgba
            ))
            .expect("静图不是错误"),
            None
        );
    }

    #[test]
    fn hands_the_bytes_back_when_the_container_lies_about_its_frame_count() {
        // acTL 说 4 帧、实际只写了 3 帧：照声明的帧数写 APNG 会把最后那帧写成
        // 普通 IDAT（png 的 frame_control 在写满之后就置空了），所以这里退回。
        let source = write_apng(4, 0, &[(100, 1000); 4], 3, SHAPE);
        assert_eq!(
            transcode(&source, AnimationLimits::default(), &CancelToken::none(), |rgba, _, _| Ok(
                rgba
            ))
            .expect("帧数不符不是错误"),
            None
        );
    }

    #[test]
    fn stops_between_frames_when_the_task_is_cancelled() {
        let guard = crate::inference::cancel::begin(Some("animation-cancel-test"));
        let token = guard.token();
        let mut seen = 0;
        let error = transcode(GIF, AnimationLimits::default(), &token, |rgba, _, _| {
            seen += 1;
            crate::inference::cancel::cancel("animation-cancel-test");
            Ok(rgba)
        })
        .expect_err("取消应当报错");
        assert_eq!(error, crate::dlssnr::filter::CANCELLED);
        assert_eq!(seen, 1, "取消之后不该再跑第二帧");
    }
}
