//! Decode a bounded viewport tile directly from the leased Windows file handle.

use std::{
    fs::File,
    io::Seek,
    os::windows::io::AsRawHandle,
    ptr,
};
use windows::core::{Error, Result, HRESULT};
use windows::Win32::{
    Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat32bppPBGRA, IWICBitmapSource,
        IWICImagingFactory, IWICPalette, WICBitmapDitherTypeNone, WICBitmapInterpolationModeFant,
        WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand, WICRect,
    },
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    },
};

struct Apartment;
impl Apartment {
    fn enter() -> Result<Self> {
        // Each blocking decoder thread owns its COM apartment. Drop the WIC
        // objects before dropping this guard.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

pub(super) use super::animation::FramePixels as Tile;

pub(super) fn decode_tile(mut file: &File, region: Option<[u32; 4]>, bound: [u32; 2]) -> Result<Tile> {
    fn invalid() -> Error {
        Error::from_hresult(HRESULT(0x80070057u32 as i32))
    }
    const MAX_EDGE: u32 = 4096;
    if bound.into_iter().any(|edge| edge == 0 || edge > MAX_EDGE) {
        return Err(invalid());
    }
    if super::static_reader_file_info(file).is_none() {
        return Err(invalid());
    }
    file.rewind().map_err(Error::from)?;
    let _com = Apartment::enter()?;
    // WIC objects remain local to this apartment. The File stays alive through
    // CopyPixels so eviction and path replacement cannot change the input.
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let decoder = factory.CreateDecoderFromFileHandle(
            file.as_raw_handle() as usize,
            ptr::null(),
            WICDecodeMetadataCacheOnDemand,
        )?;
        if decoder.GetFrameCount()? != 1 {
            return Err(invalid());
        }
        let frame = decoder.GetFrame(0)?;
        let mut source_width = 0;
        let mut source_height = 0;
        frame.GetSize(&mut source_width, &mut source_height)?;
        let source_size = [source_width, source_height];
        let [x, y, width, height] = region.unwrap_or([0, 0, source_width, source_height]);
        if width == 0
            || height == 0
            || x.checked_add(width)
                .is_none_or(|end| end > source_width || end > i32::MAX as u32)
            || y.checked_add(height)
                .is_none_or(|end| end > source_height || end > i32::MAX as u32)
        {
            return Err(invalid());
        }
        let clip = WICRect {
            X: x as i32,
            Y: y as i32,
            Width: width as i32,
            Height: height as i32,
        };
        let clipper = factory.CreateBitmapClipper()?;
        clipper.Initialize(&frame, &clip)?;
        let scale = (f64::from(bound[0]) / f64::from(width))
            .min(f64::from(bound[1]) / f64::from(height))
            .min(1.0);
        let size = [width, height].map(|edge| (f64::from(edge) * scale).round().max(1.0) as u32);
        let scaler = factory.CreateBitmapScaler()?;
        let input: &IWICBitmapSource = if size == [width, height] {
            &clipper
        } else {
            scaler.Initialize(&clipper, size[0], size[1], WICBitmapInterpolationModeFant)?;
            &scaler
        };
        let converter = factory.CreateFormatConverter()?;
        converter.Initialize(
            input,
            &GUID_WICPixelFormat32bppPBGRA,
            WICBitmapDitherTypeNone,
            None::<&IWICPalette>,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;
        let stride = size[0] * 4;
        let mut bgra = vec![0; (stride * size[1]) as usize];
        converter.CopyPixels(ptr::null(), stride, &mut bgra)?;
        Ok(Tile {
            texture_id: super::animation::next_texture_id(),
            size,
            source_size,
            bgra,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_preview_does_not_freeze_an_animated_png() {
        let mut file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(
            &mut file,
            include_bytes!("../../crates/compute-core/src/dlssnr/testdata/animated.png"),
        ).unwrap();
        assert!(decode_tile(&file, None, [128, 128]).is_err());
    }

    #[test]
    fn decodes_the_leased_revision_and_clips_before_scaling() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("page.png");
        let pixels = image::RgbImage::from_fn(8, 4, |x, _| {
            if x < 4 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 0, 255])
            }
        });
        pixels.save(&path).unwrap();
        let file = File::open(&path).unwrap();
        std::fs::rename(&path, directory.path().join("previous.png")).unwrap();
        image::RgbImage::new(8, 4).save(&path).unwrap();
        let tile = decode_tile(&file, Some([4, 0, 4, 4]), [2, 2]).unwrap();
        assert_eq!(tile.source_size, [8, 4]);
        assert_eq!(tile.size, [2, 2]);
        assert_eq!(tile.bgra, [255, 0, 0, 255].repeat(4));
        assert!(decode_tile(&file, Some([4, 0, 5, 4]), [2, 2]).is_err());
        assert!(decode_tile(&file, None, [4097, 4097]).is_err());
    }
}
