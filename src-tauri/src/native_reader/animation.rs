//! Composited animation frames for native reader surfaces. Refuse large
//! timelines before they can accumulate an unbounded set of decoded frames.
use image::{
    codecs::{gif::GifDecoder, png::PngDecoder, webp::WebPDecoder},
    metadata::LoopCount,
    AnimationDecoder, Frames, ImageDecoder, ImageFormat, ImageReader,
};
use std::{
    fs::File,
    io::{BufReader, Seek},
    time::Duration,
};

const MAX_FRAME_PIXELS: u64 = 4 * 1024 * 1024;
const MAX_TIMELINE_BYTES: usize = 24 * 1024 * 1024;
const MAX_FRAMES: usize = 360;

#[cfg(windows)]
pub(super) fn next_texture_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub(crate) struct FramePixels {
    #[cfg(windows)]
    pub(super) texture_id: u64,
    pub(super) size: [u32; 2],
    pub(super) source_size: [u32; 2],
    pub(super) bgra: Vec<u8>,
}

pub(crate) struct Animation<T> {
    frames: Vec<T>,
    ends: Vec<Duration>,
    duration: Duration,
    loops: LoopCount,
}

impl Animation<FramePixels> {
    // A recognized animation that exceeds the budget must fall back as an
    // animation. Sending it through WIC would silently freeze it on frame one.
    #[cfg(any(windows, target_os = "ios"))]
    pub(super) fn decode(file: &File) -> Result<Option<Self>, ()> {
        Self::decode_format(file, false)
    }

    fn decode_format(mut file: &File, only_png: bool) -> Result<Option<Self>, ()> {
        file.rewind().map_err(|_| ())?;
        let reader = ImageReader::new(BufReader::new(file))
            .with_guessed_format()
            .map_err(|_| ())?;
        let (frames, loops) = match reader.format() {
            Some(ImageFormat::Gif) if !only_png => {
                let decoder = GifDecoder::new(reader.into_inner()).map_err(|_| ())?;
                check_size(decoder.dimensions()).ok_or(())?;
                let count = decoder.loop_count();
                (decoder.into_frames(), count)
            }
            Some(ImageFormat::Png) => {
                let decoder = PngDecoder::new(reader.into_inner()).map_err(|_| ())?;
                if !decoder.is_apng().map_err(|_| ())? {
                    return Ok(None);
                }
                check_size(decoder.dimensions()).ok_or(())?;
                let decoder = decoder.apng().map_err(|_| ())?;
                let count = decoder.loop_count();
                (decoder.into_frames(), count)
            }
            Some(ImageFormat::WebP) if !only_png => {
                let decoder = WebPDecoder::new(reader.into_inner()).map_err(|_| ())?;
                if !decoder.has_animation() {
                    return Ok(None);
                }
                check_size(decoder.dimensions()).ok_or(())?;
                let count = decoder.loop_count();
                (decoder.into_frames(), count)
            }
            _ => return Ok(None),
        };
        Self::collect(frames, loops).map(Some).ok_or(())
    }

    /// Android's platform animation decoder covers GIF/WebP. Supply APNG as
    /// composited native frames through a private descriptor instead.
    #[cfg(target_os = "android")]
    pub(crate) fn prepare_apng(file: &File, cache: &std::path::Path) -> Result<Option<File>, ()> {
        use std::io::{BufWriter, Write};
        let Some(animation) = Self::decode_format(file, true)? else {
            return Ok(None);
        };
        let mut storage = tempfile::tempfile_in(cache).map_err(|_| ())?;
        let mut output = BufWriter::new(&mut storage);
        let [width, height] = animation.frames[0].source_size;
        let loops = match animation.loops {
            LoopCount::Infinite => 0,
            LoopCount::Finite(count) => count.get(),
        };
        output.write_all(b"YAP1").map_err(|_| ())?;
        for value in [width, height, animation.frames.len() as u32, loops] {
            output.write_all(&value.to_be_bytes()).map_err(|_| ())?;
        }
        // Bitmap.Config.ARGB_8888 takes premultiplied RGBA bytes in native memory.
        for (mut frame, end) in animation.frames.into_iter().zip(animation.ends) {
            output
                .write_all(&(end.as_millis() as u64).to_be_bytes())
                .map_err(|_| ())?;
            for pixel in frame.bgra.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            output.write_all(&frame.bgra).map_err(|_| ())?;
        }
        output.flush().map_err(|_| ())?;
        drop(output);
        storage.rewind().map_err(|_| ())?;
        Ok(Some(storage))
    }

    fn collect(frames: Frames<'_>, loops: LoopCount) -> Option<Self> {
        let mut tiles = Vec::new();
        let mut ends = Vec::new();
        let mut duration = Duration::ZERO;
        let mut retained: usize = 0;
        for frame in frames {
            let frame = frame.ok()?;
            let (numerator, denominator) = frame.delay().numer_denom_ms();
            duration += Duration::from_secs_f64(
                (f64::from(numerator) / f64::from(denominator)).max(16.0) / 1000.0,
            );
            let rgba = frame.into_buffer();
            let size = [rgba.width(), rgba.height()];
            let mut bgra = rgba.into_raw();
            retained += bgra.len();
            if retained > MAX_TIMELINE_BYTES || tiles.len() == MAX_FRAMES {
                return None;
            }
            for pixel in bgra.chunks_exact_mut(4) {
                let alpha = u16::from(pixel[3]);
                pixel.swap(0, 2);
                for component in &mut pixel[..3] {
                    *component = ((u16::from(*component) * alpha + 127) / 255) as u8;
                }
            }
            tiles.push(FramePixels {
                #[cfg(windows)]
                texture_id: next_texture_id(),
                size,
                source_size: size,
                bgra,
            });
            ends.push(duration);
        }
        (!tiles.is_empty()).then_some(Self {
            frames: tiles,
            ends,
            duration,
            loops,
        })
    }
}

impl<T> Animation<T> {
    pub(super) fn first(&self) -> &T {
        &self.frames[0]
    }

    #[cfg(target_os = "ios")]
    pub(super) fn try_map<U>(self, convert: impl FnMut(T) -> Option<U>) -> Option<Animation<U>> {
        Some(Animation {
            frames: self
                .frames
                .into_iter()
                .map(convert)
                .collect::<Option<_>>()?,
            ends: self.ends,
            duration: self.duration,
            loops: self.loops,
        })
    }

    pub(super) fn frame(&self, elapsed: Duration) -> (usize, &T, Option<Duration>) {
        let total = self.duration.as_nanos();
        let elapsed = elapsed.as_nanos();
        let completed = matches!(self.loops, LoopCount::Finite(count) if elapsed >= total * u128::from(count.get()));
        if completed || self.frames.len() == 1 {
            let index = self.frames.len() - 1;
            return (index, &self.frames[index], None);
        }
        let phase = Duration::from_nanos((elapsed % total) as u64);
        let index = self.ends.partition_point(|end| *end <= phase);
        (index, &self.frames[index], Some(self.ends[index] - phase))
    }
}

fn check_size((width, height): (u32, u32)) -> Option<()> {
    (width > 0 && height > 0 && u64::from(width) * u64::from(height) <= MAX_FRAME_PIXELS)
        .then_some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroU32;

    #[test]
    fn variable_duration_frames_stop_on_the_last_frame_after_finite_loops() {
        let millis = Duration::from_millis;
        let animation = Animation {
            frames: vec![0, 1, 2],
            ends: vec![millis(20), millis(45), millis(100)],
            duration: millis(100),
            loops: LoopCount::Finite(NonZeroU32::new(2).unwrap()),
        };
        assert_eq!(animation.frame(millis(19)), (0, &0, Some(millis(1))));
        assert_eq!(animation.frame(millis(20)), (1, &1, Some(millis(25))));
        assert_eq!(animation.frame(millis(100)), (0, &0, Some(millis(20))));
        assert_eq!(animation.frame(millis(199)), (2, &2, Some(millis(1))));
        assert_eq!(animation.frame(millis(200)), (2, &2, None));
    }
}
