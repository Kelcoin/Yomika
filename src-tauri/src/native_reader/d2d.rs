//! The Win32 surface owns these Direct2D resources on its UI thread.
//! CPU tiles survive a target reset, so a device loss can re-upload the same revision.
use super::wic::Tile;
use std::collections::HashMap;
use windows::core::Result;
use windows::Win32::{
    Foundation::HWND,
    Graphics::{
        Direct2D::{
            Common::{
                D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_PIXEL_FORMAT, D2D_RECT_F,
                D2D_SIZE_U,
            },
            D2D1CreateFactory, ID2D1Bitmap, ID2D1Factory, ID2D1HwndRenderTarget,
            D2D1_ANTIALIAS_MODE_ALIASED, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, D2D1_BITMAP_PROPERTIES,
            D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_HWND_RENDER_TARGET_PROPERTIES,
            D2D1_RENDER_TARGET_PROPERTIES,
        },
        Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
    },
};

pub(super) struct Surface {
    hwnd: HWND,
    target: Option<ID2D1HwndRenderTarget>,
    bitmaps: HashMap<u64, ID2D1Bitmap>,
}

impl Surface {
    pub(super) fn new(hwnd: HWND) -> Self {
        Self {
            hwnd,
            target: None,
            bitmaps: HashMap::new(),
        }
    }

    pub(super) fn draw(&mut self, pages: &[(&Tile, D2D_RECT_F)], client: [u32; 2]) -> Result<()> {
        if client.contains(&0) {
            return Ok(());
        }
        let painted = self.draw_frame(pages, client);
        if painted.is_err() {
            self.bitmaps.clear();
            self.target = None;
        }
        painted
    }

    fn draw_frame(&mut self, pages: &[(&Tile, D2D_RECT_F)], client: [u32; 2]) -> Result<()> {
        let pixel_size = D2D_SIZE_U {
            width: client[0],
            height: client[1],
        };
        // Use physical client pixels throughout. Monitor DPI is reflected in
        // the client rectangle supplied by the HWND owner.
        unsafe {
            if self.target.is_none() {
                let factory: ID2D1Factory =
                    D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
                let properties = D2D1_RENDER_TARGET_PROPERTIES {
                    dpiX: 96.0,
                    dpiY: 96.0,
                    ..Default::default()
                };
                let hwnd_properties = D2D1_HWND_RENDER_TARGET_PROPERTIES {
                    hwnd: self.hwnd,
                    pixelSize: pixel_size,
                    ..Default::default()
                };
                self.target = Some(factory.CreateHwndRenderTarget(&properties, &hwnd_properties)?);
            }
            let target = self.target.as_ref().expect("render target initialized");
            if target.GetPixelSize() != pixel_size {
                target.Resize(&pixel_size)?;
            }
            // Retain the texture of any page that stays visible while the
            // scroll window changes. Recycle a departing texture of equal size.
            let mut spare = Vec::new();
            self.bitmaps.retain(|id, bitmap| {
                if pages.iter().any(|(tile, _)| tile.texture_id == *id) {
                    true
                } else {
                    spare.push(bitmap.clone());
                    false
                }
            });
            let properties = D2D1_BITMAP_PROPERTIES {
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                },
                dpiX: 96.0,
                dpiY: 96.0,
            };
            for (tile, _) in pages {
                if self.bitmaps.contains_key(&tile.texture_id) {
                    continue;
                }
                let pixels = tile.bgra.as_ptr();
                let size = D2D_SIZE_U {
                    width: tile.size[0],
                    height: tile.size[1],
                };
                let bitmap = if let Some(index) = spare.iter().position(|bitmap| bitmap.GetPixelSize() == size) {
                    let bitmap = spare.swap_remove(index);
                    bitmap.CopyFromMemory(None, pixels.cast(), tile.size[0] * 4)?;
                    bitmap
                } else {
                    target.CreateBitmap(size, Some(pixels.cast()), tile.size[0] * 4, &properties)?
                };
                self.bitmaps.insert(tile.texture_id, bitmap);
            }
            target.BeginDraw();
            // Rasterize shared bitmap edges once per pixel. Filtering still
            // applies within each page without blending its edge with black.
            target.SetAntialiasMode(D2D1_ANTIALIAS_MODE_ALIASED);
            target.Clear(Some(&D2D1_COLOR_F {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            }));
            for (tile, destination) in pages {
                let bitmap = &self.bitmaps[&tile.texture_id];
                target.DrawBitmap(
                    bitmap,
                    Some(destination),
                    1.0,
                    D2D1_BITMAP_INTERPOLATION_MODE_LINEAR,
                    None,
                );
            }
            target.EndDraw(None, None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use windows::{
        core::{w, PCWSTR},
        Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_POPUP},
    };

    #[test]
    fn draws_two_wic_tiles_on_one_hwnd_and_reuploads_after_resize() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tile.png");
        image::RgbaImage::from_pixel(8, 4, image::Rgba([255, 0, 0, 255]))
            .save(&path)
            .unwrap();
        let tile =
            super::super::wic::decode_tile(&File::open(&path).unwrap(), None, [64, 64]).unwrap();
        let hwnd = unsafe {
            CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                PCWSTR::null(),
                WS_POPUP,
                0,
                0,
                64,
                64,
                None,
                None,
                None,
                None,
            )
        }
        .unwrap();
        struct Window(HWND);
        impl Drop for Window {
            fn drop(&mut self) {
                let _ = unsafe { DestroyWindow(self.0) };
            }
        }
        let window = Window(hwnd);
        let mut surface = Surface::new(window.0);
        let rect = D2D_RECT_F {
            left: 0.0,
            top: 16.0,
            right: 64.0,
            bottom: 48.0,
        };
        let left = D2D_RECT_F {
            right: 32.0,
            ..rect
        };
        let right = D2D_RECT_F { left: 32.0, ..rect };
        let second = super::super::wic::decode_tile(&File::open(&path).unwrap(), None, [64, 64]).unwrap();
        surface
            .draw(&[(&second, left), (&tile, right)], [64, 64])
            .unwrap();
        assert_eq!(surface.bitmaps.len(), 2);
        let retained = surface.bitmaps[&tile.texture_id].clone();
        surface.draw(&[(&tile, left)], [64, 64]).unwrap();
        assert_eq!(surface.bitmaps[&tile.texture_id], retained);
        surface.bitmaps.clear();
        surface.target = None;
        surface.draw(&[(&tile, rect)], [96, 72]).unwrap();
        assert_eq!(surface.bitmaps.len(), 1);
    }
}
