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
use crate::cancel::CancelToken;

/// 一次动画处理接受的**总像素**（画布像素 × 帧数）上限。
///
/// 按的是「这一次要花多少时间、产出多少字节」，**不是**「帧集合占多少内存」——这条
/// 路是逐帧流式的：一帧进来、处理完、编进 APNG 就丢，驻留的是编码产物本身。
///
/// 实测（720×720、用户设置里的三层、社区 DLL）：首帧 1.23s 建 feature，之后
/// 12ms/帧；一帧 720×720 编成 APNG 约 317KB（0.61 字节/像素）。于是 128MP 的最坏
/// 情况是 240 帧 ≈ 4s、约 78MB 产物，而 720p 那一档真正卡住的应该是**帧数**上限
/// （720×720×240 = 124,416,000 正好落在预算内），4K 一档则是 15 帧。
///
/// 旧值 40MP 是按「一帧 4K 的 RGBA 有 33MB」估的：那个理由把流式实现当成了攒帧实
/// 现，结果 720×720 的 128 帧动图（66,355,200 像素）被判出界、原图静默交回，看上去
/// 就像「开了 DLSSNR 但完全没生效」。
pub const ANIMATION_PIXEL_BUDGET: u64 = 128_000_000;
/// 容器头里声明的帧数上限，只用来挡住「这不是一页图，是一段片子」的文件。
///
/// 真正的帧数是靠帧步长降下来的（见 [`plan`]），所以这一档比原来（240）宽得多：
/// 一页 1200 帧的动图现在会被降采样后照样交回，而不是静默保持原图。
pub const ANIMATION_FRAME_LIMIT: u32 = 1200;
/// 交回阅读器的**产物字节**上限。
///
/// 为什么必须有这一条：输入尺寸的限额只管「跑不跑得起」，管不了产物多大。实测
/// 720×720×240 帧那一页——像素 124,416,000 落在像素预算之内，编出来的 APNG 却是
/// **150,853,625 字节**：WebView2 拿它当 `<img>` 会一直解不完，页面上表现为整块空白
/// （没有破图图标、没有 onError、胶囊停在「DLSSNR 处理中…」）。
///
/// 取 96 MiB 是为了**不把上一轮特意放行的那一档打回去**：720×720×128 帧那一页的产物
/// 约 80MB（66,355,200 像素 × 实测 1.21 字节/像素），必须继续原样通过；而 150MB 那一档
/// 必须被挡下来。真实可播边界没有量过——所以前端还有一道「解不开就退回本地那一版」的
/// 兜底（见 `src/lib/readerComputedPage.ts` 的产物解码闸），不靠这个阈值兜住。
pub const ANIMATION_PRODUCT_BUDGET_BYTES: u64 = 96 * 1024 * 1024;
/// 产物**解码后**的像素上限：Chromium 播 APNG 会把所有帧展开在内存里（RGBA 一像素
/// 四字节），96M 像素 ≈ 384MB。
///
/// 同样卡在「上一轮放行的 128 帧 720p（66,355,200）要过」与「把阅读器刷白的 240 帧
/// 720p（124,416,000）要降」之间。
pub const ANIMATION_DECODE_PIXEL_BUDGET: u64 = 96_000_000;

/// 与 `filter::MIN_EDGE` 同值：更小的图 DLSSNR 自己会拒，动画也不必开。
const MIN_EDGE: u32 = 32;

/// 规划时按一像素多少字节估：实测 150,853,625 / 124,416,000 = 1.21，这里按 1.5 估，
/// 留出 PNG 过滤器与内容差异的余量（宁可缩过头一点，也不要交出一份解不开的产物）。
const BYTES_PER_PIXEL_NUM: u64 = 3;
const BYTES_PER_PIXEL_DEN: u64 = 2;

/// 帧步长最多降到这个倍数：再稀就不是动画了，宁可把画布缩下去。
const MAX_STRIDE: u32 = 8;

/// 步长收敛的下限：产物至少要留下这么多帧（短动图因此只缩画布、不抽帧）。
const MIN_KEPT_FRAMES: u32 = 4;

/// 一次处理的预算。默认取上面那几个常量，测试可以调小来覆盖降采样分支。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnimationLimits {
    /// 真要跑 GPU 的像素（帧步长降完之后的）。
    pub pixels: u64,
    /// 容器声明的帧数上限。
    pub frames: u32,
    /// 产物字节上限。
    pub product_bytes: u64,
    /// 产物解码后的像素上限。
    pub decode_pixels: u64,
}

impl Default for AnimationLimits {
    fn default() -> Self {
        Self {
            pixels: ANIMATION_PIXEL_BUDGET,
            frames: ANIMATION_FRAME_LIMIT,
            product_bytes: ANIMATION_PRODUCT_BUDGET_BYTES,
            decode_pixels: ANIMATION_DECODE_PIXEL_BUDGET,
        }
    }
}

/// 容器头里说得出的话。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shape {
    pub frames: u32,
    pub width: u32,
    pub height: u32,
}

/// 只读容器头：GIF / APNG / 动画 WebP 各自的帧数与画布尺寸。
///
/// 读不出来、或者根本不是说得出帧数的容器，一律 `None`（调用方原样交回）。
pub fn shape(bytes: &[u8]) -> Option<Shape> {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        // GIF 的逻辑屏幕尺寸就在固定头部里：宽、高各 2 字节小端。
        if bytes.len() < 13 {
            return None;
        }
        let frames = crate::image_kind::gif_frame_count(bytes)? as u32;
        return Some(Shape {
            frames,
            width: u32::from(u16::from_le_bytes([bytes[6], bytes[7]])),
            height: u32::from(u16::from_le_bytes([bytes[8], bytes[9]])),
        });
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        // acTL 按规范必须出现在第一个 IDAT 之前，所以 `read_info` 之后它就在
        // Info 里（`yomika_compute_core::image_kind` 认得同一件事）。
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

/// `image` 的循环语义 → 圈数：`Infinite` 就是「一直播」的 0。
///
/// 只用来**读**源文件声明的圈数（测试拿它对照，也让人看得出我们在丢掉什么）。
fn plays(loops: image::metadata::LoopCount) -> u32 {
    match loops {
        image::metadata::LoopCount::Infinite => 0,
        image::metadata::LoopCount::Finite(value) => value.get(),
    }
}

/// 产物写进 acTL 的 `num_plays`：**一律 0，也就是一直播**，不照抄源文件的圈数。
///
/// 三种容器的「循环次数」语义并不统一，照抄会把「源里写着播一遍」原样搬过来：
/// - WebP 的 `ANIM` Loop Count 是**圈数**（Chromium `webp_image_decoder.cc`：
///   `repetition_count_ = count == 0 ? kAnimationLoopInfinite : count - 1`，注释原文
///   “WebP defines loop count as the number of cycles, with 0 meaning infinite”）——
///   所以 `Loop Count = 1` 就是「播一遍」。用户库里那 5 份动图 WebP 全写着 1（下载器
///   写死的），界面上的表现就是「动图只播一遍就停了」。
/// - GIF 的 Netscape 块、APNG 的 acTL 又各有一套（0 都表示无限，非 0 的含义不同）。
///
/// 阅读器里的动图是内容：播一遍停在半路等于坏图。作者写的那点圈数是给播放器的提示，
/// 不是给阅读者的限制，所以这里统一成一直播。代价是「本来只想播两遍」的动图也会一直
/// 播——那正是阅读时想要的。
const READER_PLAYS: u32 = 0;

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

/// 这一份字节该不该动手。
///
/// 拆出来是因为它有**两个**消费者：`transcode` 拿它当门，`apply_dlssnr` 拿它解释
/// 「为什么跳过了」。两处各自重写一遍判断迟早会分叉。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnimationVerdict {
    /// 动手。
    Process,
    /// 容器读不懂，或者根本不是动图。
    NotAnAnimation,
    /// 画布小于 DLSSNR 自己的下限。
    TooSmall,
    /// 帧数超上限。
    TooManyFrames,
}

/// 只读容器头就能给出的判断（一道门都不碰像素）。
fn decide(bytes: &[u8], limits: AnimationLimits) -> AnimationVerdict {
    let Some(shape) = shape(bytes).filter(|shape| shape.frames >= 2) else {
        return AnimationVerdict::NotAnAnimation;
    };
    if shape.width < MIN_EDGE || shape.height < MIN_EDGE {
        return AnimationVerdict::TooSmall;
    }
    if shape.frames > limits.frames {
        return AnimationVerdict::TooManyFrames;
    }
    // 总像素超预算**不再是**「原样交回」：降采样之后照样处理（见 [`plan`]）。上一版把
    // 它当门，于是 720×720×240 帧那一页（124,416,000 像素，落在像素预算之内）原样跑完，
    // 编出 150 MB 的 APNG 把阅读器噎成一片空白（2026-10-13 真机现场）。
    AnimationVerdict::Process
}

/// 这一份动图打算怎么处理：抽掉多少帧、缩到多大画布、要跑多少像素、产物大概多大。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// 每这么多帧留一帧。
    pub stride: u32,
    /// 抽帧从哪一帧开始对齐（见 [`offset_for`]）：保证**最后一帧**总被留下。
    pub offset: u32,
    /// 产物画布。
    pub canvas: (u32, u32),
    /// 产物的帧数（`ceil(frames / stride)`）。
    pub kept_frames: u32,
    /// 真要跑 GPU 的像素（`kept_frames × canvas`）。
    pub pixels: u64,
    /// 按 [`BYTES_PER_PIXEL_NUM`] 估的产物字节。
    pub bytes: u64,
}

impl Plan {
    /// 这一版会不会把输入缩小：**产物与原图不同**就是「缩了」（抽帧也算）。
    pub fn shrank(&self, shape: Shape) -> bool {
        self.stride > 1 || self.canvas != (shape.width, shape.height)
    }

    /// 日志里那句人话：丢了多少帧、画布从多少缩到多少、要跑多少像素、产物多大。
    pub fn describe(&self, shape: Shape) -> String {
        format!(
            "{} 帧 {}×{}（{} 像素）→ 留 {} 帧 {}×{}（{} 像素，约 {} MB）",
            shape.frames,
            shape.width,
            shape.height,
            u64::from(shape.width) * u64::from(shape.height) * u64::from(shape.frames),
            self.kept_frames,
            self.canvas.0,
            self.canvas.1,
            self.pixels,
            self.bytes / (1024 * 1024)
        )
    }
}

/// 按预算挑一个「跑得完、产物也播得动」的处置。
///
/// 为什么不能只把超预算的输入原样交回：720×720×240 帧那一页的输入**在像素预算之内**，
/// 编出来的 APNG 却是 150 MB，WebView2 解不完就是一片空白（2026-10-13 真机现场）。所以
/// 这里把「产物多大」也算进预算：先抽帧（帧步长 2、3…最多 [`MAX_STRIDE`]），还不行就把
/// 画布按面积缩下去（每轮 7/8，最多缩到 1×1 为止），最后按 [`MIN_KEPT_FRAMES`] 保底。
/// 抽掉的帧的延迟会累加到留下的那一帧上（见 `transcode`），所以时长不变。
pub fn plan(shape: Shape, limits: AnimationLimits) -> Plan {
    let bytes_for = |canvas: (u32, u32), kept: u32| -> u64 {
        u64::from(canvas.0) * u64::from(canvas.1) * u64::from(kept) * BYTES_PER_PIXEL_NUM
            / BYTES_PER_PIXEL_DEN
    };
    let fits = |canvas: (u32, u32), kept: u32| -> bool {
        let pixels = u64::from(canvas.0) * u64::from(canvas.1) * u64::from(kept);
        pixels <= limits.pixels
            && pixels <= limits.decode_pixels
            && bytes_for(canvas, kept) <= limits.product_bytes
    };

    let mut stride = 1;
    loop {
        let kept = kept_frames(shape.frames, stride);
        if fits((shape.width, shape.height), kept) {
            return Plan {
                stride,
                offset: offset_for(shape.frames, stride),
                canvas: (shape.width, shape.height),
                kept_frames: kept,
                pixels: u64::from(shape.width) * u64::from(shape.height) * u64::from(kept),
                bytes: bytes_for((shape.width, shape.height), kept),
            };
        }
        if kept <= MIN_KEPT_FRAMES || stride >= MAX_STRIDE {
            break;
        }
        stride += 1;
    }

    let mut canvas = (shape.width.max(1), shape.height.max(1));
    loop {
        let kept = kept_frames(shape.frames, stride);
        if fits(canvas, kept) || (canvas.0 <= 1 && canvas.1 <= 1) {
            break;
        }
        let next = ((canvas.0 * 7 / 8).max(1), (canvas.1 * 7 / 8).max(1));
        if next == canvas {
            break;
        }
        canvas = next;
    }
    let kept = kept_frames(shape.frames, stride);
    Plan {
        stride,
        offset: offset_for(shape.frames, stride),
        canvas,
        kept_frames: kept,
        pixels: u64::from(canvas.0) * u64::from(canvas.1) * u64::from(kept),
        bytes: bytes_for(canvas, kept),
    }
}

/// 抽帧之后留下几帧。
///
/// 这里就是纯粹的 `ceil(frames / stride)`：**下限不在这里**（[`MIN_KEPT_FRAMES`] 管的是
/// 步长能涨到多大，见 `plan` 的循环）。两边各算一次「至少留几帧」的话，写进 acTL 的
/// 帧数与选择规则真正留下的帧数就会对不上——`png` 写满 acTL 声明的帧数之后会把
/// frame_control 置空，多写的帧变成普通 IDAT，整份文件不再是能播的 APNG。
fn kept_frames(frames: u32, stride: u32) -> u32 {
    frames.div_ceil(stride.max(1))
}

/// 抽帧从哪一帧开始对齐：让**最后一帧**总是被留下。
///
/// 不留最后一帧的话，它后面那些被抽掉的帧的延迟就没有地方累加（见 `transcode`），总时长
/// 会短掉一点——用户看到的是「动图比原来快」。对齐到末尾之后，累加正好在最后一帧收尾，
/// 总时长严格不变。
fn offset_for(frames: u32, stride: u32) -> u32 {
    if stride <= 1 {
        return 0;
    }
    (stride - (frames.saturating_sub(1) % stride)) % stride
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
///
/// 循环次数**不照抄**源文件，一律写成一直播，理由见 [`READER_PLAYS`]。
pub fn transcode<F>(
    bytes: &[u8],
    limits: AnimationLimits,
    cancel: &CancelToken,
    mut process: F,
) -> Result<Option<Vec<u8>>, String>
where
    F: FnMut(Vec<u8>, u32, u32) -> Result<Vec<u8>, String>,
{
    if decide(bytes, limits) != AnimationVerdict::Process {
        return Ok(None);
    }
    // 再读一次头：两处读的都是容器头（WebP 也只是建个 decoder），换来的是「门只
    // 有一个地方定义」。
    let Some(shape) = shape(bytes) else {
        return Ok(None);
    };
    // 这一版打算怎么处理：抽帧 / 缩画布都在这里定，下面只负责照着写。
    let planned = plan(shape, limits);

    // 源声明的圈数直接丢掉（`_source_plays`）：产物一直是 `READER_PLAYS`。
    let (mut frames, _source_plays) = frames_of(bytes)?;
    let mut encoded = Vec::new();
    let mut writer = {
        let mut encoder = png::Encoder::new(&mut encoded, planned.canvas.0, planned.canvas.1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        // 与静态那条路同一档压缩：`image::codecs::png::PngEncoder::new` 的默认档是
        // `CompressionType::Fast` → `png::Compression::Fast`，过滤档是
        // `FilterType::Adaptive` → `png::Filter::Adaptive`（实测 1.08MP 一帧 release
        // 3ms、1.7MB；换成 NoFilter 会到 4.2MB）。
        encoder.set_compression(png::Compression::Fast);
        encoder.set_filter(png::Filter::Adaptive);
        encoder
            .set_animated(planned.kept_frames, READER_PLAYS)
            .map_err(|error| error.to_string())?;
        encoder.write_header().map_err(|error| error.to_string())?
    };

    // 恰好写 planned.kept_frames 帧：png 在写满 acTL 声明的帧数之后会把 frame_control
    // 置空，再多写的帧就成了普通 IDAT，整份文件不再是能播的 APNG。
    //
    // 帧步长 > 1 时把**丢掉的帧的延迟累加到留下的那一帧**上：抽掉一半帧而延迟照旧，
    // 动画会变成两倍速；累加之后时长不变，只是不再平滑（有意的取舍：先保证能播，再谈
    // 顺不顺）。
    let mut carried_delay = 0u16;
    let mut written = 0u32;
    let mut source_index = 0u32;
    while written < planned.kept_frames {
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
        let keep = (source_index + planned.offset) % planned.stride == 0;
        source_index += 1;
        if !keep {
            carried_delay = carried_delay.saturating_add(delay);
            continue;
        }
        let canvas = planned.canvas;
        let frame_bytes = if canvas == (shape.width, shape.height) {
            frame.into_buffer().into_raw()
        } else {
            resize_frame(&frame.into_buffer(), canvas)?
        };
        let processed = process(frame_bytes, canvas.0, canvas.1)?;
        if processed.len() != canvas.0 as usize * canvas.1 as usize * 4 {
            return Err("dlssnr: 动图某一帧的产物尺寸与画布对不上".to_string());
        }
        writer
            .set_frame_delay(carried_delay.saturating_add(delay), 1000)
            .map_err(|error| error.to_string())?;
        carried_delay = 0;
        writer
            .set_dispose_op(png::DisposeOp::None)
            .map_err(|error| error.to_string())?;
        writer
            .set_blend_op(png::BlendOp::Source)
            .map_err(|error| error.to_string())?;
        writer
            .set_frame_dimension(canvas.0, canvas.1)
            .map_err(|error| error.to_string())?;
        writer
            .set_frame_position(0, 0)
            .map_err(|error| error.to_string())?;
        writer
            .write_image_data(&processed)
            .map_err(|error| error.to_string())?;
        written += 1;
    }
    writer.finish().map_err(|error| error.to_string())?;
    // 估得不准（PNG 压不动的那一页）：这一份交出去就是阅读器噎住，宁可不交。
    if encoded.len() as u64 > limits.product_bytes {
        return Err(format!(
            "dlssnr: 动图产物 {} 字节超出上限 {}",
            encoded.len(),
            limits.product_bytes
        ));
    }
    Ok(Some(encoded))
}

/// 把一帧缩到计划好的画布。
///
/// 三角形过滤：缩图时它比最近邻干净，又不像 Lanczos 那样在漫画的线条上振铃（缩图是
/// 「不得不」，不是「更好看」，所以取中间那一档）。
fn resize_frame(frame: &image::RgbaImage, canvas: (u32, u32)) -> Result<Vec<u8>, String> {
    let resized =
        image::imageops::resize(frame, canvas.0, canvas.1, image::imageops::FilterType::Triangle);
    Ok(resized.into_raw())
}

/// 一页动图走 DLSSNR：`Ok(None)` ＝ 不是能处理的动图（原样直出），`Ok(Some)` ＝
/// 编好的 APNG。
pub fn apply_dlssnr(
    data_dir: &Path,
    bytes: &[u8],
    settings: &DlssnrSettings,
    cancel: &CancelToken,
) -> Result<Option<Vec<u8>>, String> {
    let limits = AnimationLimits::default();
    // 被上限挡下来的情形要留一笔。调用方把原图当**成功**交回是刻意的（原图本来就
    // 能看），代价是这个跳过在界面上与「处理过了」长得一模一样：用户翻到一页动图，
    // 开着 DLSSNR，看到的还是原图，界面上没有任何一处说得出为什么。第一次发现这件事
    // 是从缓存里把原文件翻出来数帧数——不该再有第二次。
    //
    // 该记哪几类、不该记哪几类见 `skip_note`。
    if let Some((message, detail)) = skip_note(decide(bytes, limits), limits) {
        note_skip(data_dir, message, &detail, bytes);
    }
    // 降采样过也要留一笔：产物比原图小是**我们的选择**，界面上同样没有地方解释得了。
    // 与「跳过」分开记，因为两者的处置完全不同（一个没处理，一个处理了但缩了）。
    if let Some(shape) = shape(bytes) {
        let planned = plan(shape, limits);
        if planned.shrank(shape) {
            note_adapt(data_dir, &planned, shape, limits);
        }
    }
    transcode(bytes, limits, cancel, |rgba, width, height| {
        let image = super::filter::DlssnrImage::new(width, height, rgba)?;
        // 逐帧走 `apply_with_token`（而不是 `dlssnr::apply_rgba`）：那段动画有
        // 几十上百帧，切页之后要能在帧与帧之间立刻停。
        super::filter::apply_with_token(data_dir, &image, settings, cancel).map(|out| out.rgba)
    })
}

/// 这一份动图该不该在错误日志里留一笔，留的话写什么。
///
/// 只有**因为限额**被挡下来的那一类值得记：`TooSmall`（每页都有的小图标）与
/// `NotAnAnimation`（静图）在漫画库里满地都是，记了只会把日志淹掉，而「原样交回」
/// 对它们本来就是正确答案，不是意外。反过来，被帧数上限挡下来的动图**本该**能处理，
/// 用户看到的却和「处理过了」一模一样，所以必须有个地方说得出为什么。
///
/// 抽成纯函数是为了能不碰 GPU 就守住「只记这几类」——真去 `apply_dlssnr` 一份能处理
/// 的动图会把这个进程的 DLSSNR 上下文初始化到测试的临时目录上，而 feature 是进程级
/// 的、只能对着一个数据目录初始化一次。
fn skip_note(verdict: AnimationVerdict, limits: AnimationLimits) -> Option<(&'static str, String)> {
    match verdict {
        AnimationVerdict::TooManyFrames => Some((
            "动图帧数超出上限，本页保持原图",
            format!("frames_limit={}", limits.frames),
        )),
        AnimationVerdict::Process
        | AnimationVerdict::NotAnAnimation
        | AnimationVerdict::TooSmall => None,
    }
}

/// 把「这一页被降采样了」写进错误日志：产物尺寸、帧步长与四条预算都写清楚。
fn note_adapt(data_dir: &Path, planned: &Plan, shape: Shape, limits: AnimationLimits) {
    let message = format!("动图产物超出预算，已降采样后交回：{}", planned.describe(shape));
    let detail = format!(
        "stride={} product_budget={} decode_pixel_budget={} effort_pixel_budget={}",
        planned.stride, limits.product_bytes, limits.decode_pixels, limits.pixels
    );
    if let Err(error) =
        super::log_skip(data_dir, "warn", "dlssnr/animation", &message, Some(detail.as_str()))
    {
        eprintln!("yomika: 动图降采样的原因没能写进错误日志：{error}");
    }
}

/// 把「这一页为什么没处理」写进错误日志（`<data>/logs/error.log`，界面里那个错误日
/// 志面板读的就是它）。
///
/// 只记形状与上限，不记图片内容：日志是给用户自己查的，不是给我们收集素材的。日志
/// 写不上不算失败——这一页照样原样交回，屏幕上不会因此少一张图。
fn note_skip(data_dir: &Path, message: &str, detail: &str, bytes: &[u8]) {
    let described = match shape(bytes) {
        Some(shape) => format!(
            "{} 帧 {}×{}（{} 像素）",
            shape.frames,
            shape.width,
            shape.height,
            u64::from(shape.width) * u64::from(shape.height) * u64::from(shape.frames)
        ),
        None => "容器头里读不出帧数".to_string(),
    };
    if let Err(error) = super::log_skip(
        data_dir,
        "warn",
        "dlssnr/animation",
        &format!("{message}：{described}"),
        Some(detail),
    ) {
        eprintln!("yomika: 动图跳过的原因没能写进错误日志：{error}");
    }
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

    /// 恒等跑一遍：断言输出是 APNG，且帧数/尺寸/延迟/像素都与源文件解出来的一致。
    /// 返回源文件解出来的那份（延迟、像素、**源里写的循环次数**），供各容器的用例再
    /// 补几条硬断言；循环次数是唯一不照抄的东西——产物必须一直播。
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
        assert_eq!(
            decoded.plays, 0,
            "循环次数不照抄源：产物一律写「一直播」"
        );
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

    /// 把夹具 WebP 的 `ANIM` 循环次数改成 `count`——用户那份动图里写的就是 1。
    ///
    /// `ANIM` 的载荷是「背景色 u32 + Loop Count u16」，所以 Loop Count 落在 `'ANIM'`
    /// 这个标签之后 12 字节处。（我第一版按 6 读，读到的是 chunk 长度的高字节，全是
    /// 0，差点得出「用户的动图本来就是无限循环」的错结论。）
    fn webp_with_patched_loop_count(count: u16) -> Vec<u8> {
        let mut bytes = WEBP.to_vec();
        let at = bytes
            .windows(4)
            .position(|window| window == b"ANIM")
            .expect("夹具 WebP 里应当有 ANIM");
        bytes[at + 12..at + 14].copy_from_slice(&count.to_le_bytes());
        bytes
    }

    /// 源里写「播 N 圈」，产物也必须一直播。
    ///
    /// 用户库里那 5 份动图 WebP 的 `ANIM` 全写着 `Loop Count = 1`，而按 WebP 规范与
    /// Chromium 的读法（`webp_image_decoder.cc`：`count == 0 ? kAnimationLoopInfinite
    /// : count - 1`，注释原文是 “WebP defines loop count as the number of cycles,
    /// with 0 meaning infinite”）那是**播一遍**。照抄它，界面上就是「动图只播一遍就
    /// 停」——阅读器里的动图是内容，播一遍停在半路等于坏图。
    #[test]
    fn writes_forever_even_when_the_source_counts_its_cycles() {
        for source_plays in [1, 6] {
            let source = write_apng(2, source_plays, &[(100, 1000), (100, 1000)], 2, SHAPE);
            assert_eq!(
                source_frames(&source).2,
                source_plays,
                "夹具里写的圈数要真的被解码器读出来"
            );
            let out = transcode(
                &source,
                AnimationLimits::default(),
                &CancelToken::none(),
                |rgba, _, _| Ok(rgba),
            )
            .expect("转码不该失败")
            .expect("这份动图应当被处理");
            assert_eq!(
                decode_apng(&out).plays,
                0,
                "源里写着 {source_plays} 圈，产物也得一直播"
            );
        }
    }

    /// 用户那份文件的形状：动图 WebP + `ANIM Loop Count = 1`。
    #[test]
    fn loops_a_webp_that_asks_for_a_single_cycle() {
        let source = webp_with_patched_loop_count(1);
        assert_eq!(source_frames(&source).2, 1, "夹具得真的写着「一圈」");
        let out = transcode(
            &source,
            AnimationLimits::default(),
            &CancelToken::none(),
            |rgba, _, _| Ok(rgba),
        )
        .expect("转码不该失败")
        .expect("这份动图应当被处理");
        assert_eq!(
            decode_apng(&out).plays,
            0,
            "源里写着「播一遍」，产物也得一直播"
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

    /// 超预算**不再**原样交回：降采样之后照样处理。上一版把它当门，于是 720×720 的
    /// 240 帧动图（像素落在预算内、产物 150 MB）原样跑完，把阅读器噎成一片空白。
    #[test]
    fn an_animation_over_the_effort_budget_is_downsampled_instead_of_handed_back() {
        let frames = 12u32;
        let source_bytes = synthetic_gif(frames, SHAPE);
        let limits = AnimationLimits {
            pixels: u64::from(SHAPE.0) * u64::from(SHAPE.1) * u64::from(frames) - 1,
            ..AnimationLimits::default()
        };
        let source = shape(&source_bytes).expect("夹具读得出形状");
        let planned = plan(source, limits);
        assert!(planned.shrank(source), "这一档该被降采样：{planned:?}");
        let mut seen = Vec::new();
        let out = transcode(&source_bytes, limits, &CancelToken::none(), |rgba, width, height| {
            seen.push((width, height));
            Ok(rgba)
        })
        .expect("超预算不是错误")
        .expect("降采样之后要交回一份产物");
        assert_eq!(
            seen.len() as u32,
            planned.kept_frames,
            "跑过的帧数 = 计划留下的帧数"
        );
        assert!(
            seen.iter().all(|(width, height)| (*width, *height) == planned.canvas),
            "每一帧都按计划的画布跑：{seen:?}"
        );
        let source_total: u32 = (0..frames).map(|index| DELAYS[index as usize % DELAYS.len()]).sum();
        let product_total: u32 = decode_apng(&out).delays.iter().sum();
        assert_eq!(
            product_total, source_total,
            "抽掉的帧的延迟要累加到留下的那一帧上，总时长不变"
        );
    }

    /// 用户实测那份动图就长这样：720×720、128 帧。这一档必须**原样**通过（不抽帧、
    /// 不缩画布），否则上一轮特意放行的那一档又被打了回去。
    #[test]
    fn a_720p_animation_of_128_frames_still_goes_through_untouched() {
        let limits = AnimationLimits::default();
        let shape = Shape {
            frames: 128,
            width: 720,
            height: 720,
        };
        let planned = plan(shape, limits);
        assert!(!planned.shrank(shape), "这一档不该被降采样：{planned:?}");
        assert!(
            planned.bytes <= limits.product_bytes,
            "产物估算也要落在字节预算里：{planned:?}"
        );
    }

    /// 把阅读器刷白的那一页：720×720、240 帧。输入在**像素**预算之内，编出来的 APNG
    /// 却是 150,853,625 字节，所以判据落在**产物字节**与解码像素上——降采样之后两者都
    /// 要落在预算内，而且必须真的降了。
    #[test]
    fn the_page_that_blanked_the_reader_comes_out_inside_the_product_budget() {
        let limits = AnimationLimits::default();
        let shape = Shape {
            frames: 240,
            width: 720,
            height: 720,
        };
        let planned = plan(shape, limits);
        assert!(planned.shrank(shape), "这一档必须降采样：{planned:?}");
        assert!(
            planned.bytes <= limits.product_bytes,
            "降采样之后产物估算 {} 仍在字节预算 {} 之外",
            planned.bytes,
            limits.product_bytes
        );
        assert!(
            planned.pixels <= limits.decode_pixels,
            "解码像素 {} 仍在预算 {} 之外",
            planned.pixels,
            limits.decode_pixels
        );
    }

    /// 抽帧抽到底还是超字节预算（画布太大）时改缩画布：产物字节是硬约束，抽帧只能让
    /// 它变小、不能保证变小到够。
    #[test]
    fn an_animation_whose_product_would_be_too_big_gets_a_smaller_canvas() {
        let limits = AnimationLimits {
            product_bytes: 4 * 1024 * 1024,
            ..AnimationLimits::default()
        };
        let shape = Shape {
            frames: 4,
            width: 1024,
            height: 1024,
        };
        let planned = plan(shape, limits);
        assert!(
            planned.canvas.0 < shape.width && planned.canvas.1 < shape.height,
            "画布该缩下去：{planned:?}"
        );
        assert!(planned.bytes <= limits.product_bytes, "{planned:?}");
    }

    /// 记下这一层交出去的诊断。用静态 + 互斥锁而不是闭包：`SkipLogger` 是函数指针
    /// （进程里只装一次），记录也只能写进一个进程级的地方。
    mod notes {
        use std::path::Path;
        use std::sync::{Mutex, OnceLock};

        static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

        pub fn install() {
            static INSTALLED: OnceLock<()> = OnceLock::new();
            INSTALLED.get_or_init(|| {
                crate::dlssnr::set_skip_logger(|_dir: &Path, message: &str, detail: Option<&str>| {
                    SEEN.lock()
                        .expect("notes")
                        .push(format!("{message} / {}", detail.unwrap_or_default()));
                    Ok(())
                });
            });
        }

        pub fn take() -> Vec<String> {
            std::mem::take(&mut *SEEN.lock().expect("notes"))
        }
    }

    /// 降采样要留一笔：产物比原图小是**我们的选择**，界面上没有地方解释得了。
    ///
    /// 不跑 GPU：`plan` 与 `note_adapt` 都是纯函数 / 只写日志，而真去 `apply_dlssnr` 一份
    /// 能处理的动图会把这个进程的 DLSSNR 上下文初始化到临时数据目录上（见
    /// `a_processable_animation_is_not_worth_a_note`）。
    #[test]
    fn a_downsampled_animation_leaves_a_note_that_says_what_it_gave_up() {
        notes::install();
        notes::take();
        let dir = tempfile::tempdir().expect("temp dir");
        let limits = AnimationLimits::default();
        let shape = Shape {
            frames: 240,
            width: 720,
            height: 720,
        };
        let planned = plan(shape, limits);
        assert!(planned.shrank(shape), "夹具本身得是需要降采样的那一类");
        note_adapt(dir.path(), &planned, shape, limits);

        let notes = notes::take();
        assert_eq!(notes.len(), 1, "降采样应当正好交出一笔：{notes:?}");
        let note = &notes[0];
        assert!(note.contains("降采样"), "要说清是缩了而不是没处理：{note}");
        assert!(note.contains("240 帧 720×720"), "要带上原样的形状：{note}");
        assert!(
            note.contains(&format!("留 {} 帧", planned.kept_frames)),
            "要带上留了多少帧：{note}"
        );
        assert!(note.contains("stride="), "要带上抽帧步长：{note}");
    }

    /// 能处理的动图不该往日志里写东西——否则漫画库里那几百页正常动图会把日志淹掉。
    ///
    /// 不跑 GPU：这条守的是**记不记**，不是处理得对不对。真拿一份能处理的动图去
    /// `apply_dlssnr`，会把这个进程的 DLSSNR 上下文初始化到临时数据目录上，而 feature
    /// 是进程级的、只能对着一个数据目录初始化一次——`dlssnr::tests` 里那几条查计数的
    /// 用例随后就会因为「换过数据目录」而失败（实测过）。
    #[test]
    fn a_processable_animation_is_not_worth_a_note() {
        let limits = AnimationLimits::default();
        assert_eq!(
            decide(GIF, limits),
            AnimationVerdict::Process,
            "夹具本身得是能处理的那一类，否则这条守了个寂寞"
        );
        assert!(
            skip_note(AnimationVerdict::Process, limits).is_none(),
            "预算之内的动图不该出现在错误日志里"
        );
        // 另外两类直出也是满地都是的小东西，同样不许记。
        assert!(skip_note(AnimationVerdict::TooSmall, limits).is_none());
        assert!(skip_note(AnimationVerdict::NotAnAnimation, limits).is_none());
        // 而被帧数上限挡下来的那一类必须记，否则用户没有任何地方能看出「为什么没生效」。
        assert!(skip_note(AnimationVerdict::TooManyFrames, limits).is_some());
    }

    /// 防锈：产物身份里带着计划器的版本（`dlssnr::ANIMATION_PLAN_REVISION`），改了
    /// `plan` 的预算或算法就必须把它 +1——产物按「起点 + DLL + 参数 + 计划器版本」认版，
    /// 不 +1 的话用户翻回那一页端上来的还是旧产物（150 MB 那一份正是这么来的）。
    #[test]
    fn the_plan_revision_names_the_planner_this_build_ships() {
        assert_eq!(
            crate::dlssnr::ANIMATION_PLAN_REVISION,
            1,
            "改了 plan 的预算或算法就要把它 +1（旧产物按旧版本号认版，不会自己落空）"
        );
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
        let guard = crate::cancel::begin(Some("animation-cancel-test"));
        let token = guard.token();
        let mut seen = 0;
        let error = transcode(GIF, AnimationLimits::default(), &token, |rgba, _, _| {
            seen += 1;
            crate::cancel::cancel("animation-cancel-test");
            Ok(rgba)
        })
        .expect_err("取消应当报错");
        assert_eq!(error, crate::dlssnr::filter::CANCELLED);
        assert_eq!(seen, 1, "取消之后不该再跑第二帧");
    }

}
