//! Stream a non-interlaced PNG once into a bounded, seekable BGRA backing file.
use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
};

const MAX_BACKING_BYTES: u64 = 256 * 1024 * 1024;
const MAX_REGION_BYTES: u64 = 24 * 1024 * 1024;

pub(super) type Region = [u32; 4];

pub(super) struct PngPixels {
    file: File,
    size: [u32; 2],
}

impl PngPixels {
    pub(super) fn build(mut input: &File) -> Option<Self> {
        input.rewind().ok()?;
        let mut decoder = png::Decoder::new(BufReader::new(input));
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().ok()?;
        let info = reader.info();
        let (width, height) = info.size();
        if info.interlaced
            || info.animation_control.is_some()
            || width == 0
            || width > 32_768
            || height == 0
            || height > 32_768
            || u64::from(width) * u64::from(height) * 4 > MAX_BACKING_BYTES
            || info.exif_metadata.is_some()
        {
            return None;
        }
        let (colors, depth) = reader.output_color_type();
        if depth != png::BitDepth::Eight || colors == png::ColorType::Indexed {
            return None;
        }
        let mut backing = BufWriter::new(tempfile::tempfile().ok()?);
        let mut pixels = vec![0; width as usize * 4];
        for _ in 0..height {
            let row = reader.next_row().ok()??;
            for (input, out) in row
                .data()
                .chunks_exact(colors.samples())
                .zip(pixels.chunks_exact_mut(4))
            {
                let (r, g, b, alpha) = match colors {
                    png::ColorType::Rgb => (input[0], input[1], input[2], 255),
                    png::ColorType::Rgba => (input[0], input[1], input[2], input[3]),
                    png::ColorType::Grayscale => (input[0], input[0], input[0], 255),
                    png::ColorType::GrayscaleAlpha => (input[0], input[0], input[0], input[1]),
                    png::ColorType::Indexed => return None,
                };
                let premultiply =
                    |channel: u8| ((u16::from(channel) * u16::from(alpha) + 127) / 255) as u8;
                out.copy_from_slice(&[premultiply(b), premultiply(g), premultiply(r), alpha]);
            }
            backing.write_all(&pixels).ok()?;
        }
        reader.finish().ok()?;
        Some(Self {
            file: backing.into_inner().ok()?,
            size: [width, height],
        })
    }

    pub(super) fn read(&mut self, [x, y, width, height]: Region) -> Option<Vec<u8>> {
        let bytes = u64::from(width) * u64::from(height);
        if x.checked_add(width)? > self.size[0]
            || y.checked_add(height)? > self.size[1]
            || bytes == 0
            || bytes > MAX_REGION_BYTES / 4
        {
            return None;
        }
        let row_len = width as usize * 4;
        let mut pixels = vec![0; row_len * height as usize];
        for (row, dest) in pixels.chunks_exact_mut(row_len).enumerate() {
            let offset = ((u64::from(y) + row as u64) * u64::from(self.size[0]) + u64::from(x)) * 4;
            self.file.seek(SeekFrom::Start(offset)).ok()?;
            self.file.read_exact(dest).ok()?;
        }
        Some(pixels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backing_reads_independent_crops_with_premultiplied_colors() {
        let mut file = tempfile::tempfile().unwrap();
        let mut encoder = png::Encoder::new(&mut file, 3, 2);
        encoder.set_color(png::ColorType::Rgba);
        let rows = [
            1, 2, 3, 255, 40, 20, 10, 128, 8, 9, 10, 255, 11, 12, 13, 255, 60, 42, 20, 128, 18, 19,
            20, 255,
        ];
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&rows)
            .unwrap();
        let mut backing = PngPixels::build(&file).unwrap();
        assert_eq!(
            backing.read([1, 0, 1, 2]).unwrap(),
            [5, 10, 20, 128, 10, 21, 30, 128]
        );
        assert_eq!(backing.read([2, 1, 1, 1]).unwrap(), [20, 19, 18, 255]);
        assert!(backing.read([2, 1, 2, 1]).is_none());
    }
}
