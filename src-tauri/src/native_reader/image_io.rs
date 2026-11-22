//! Image I/O creates a bounded, correctly oriented preview from the leased file.
use std::{
    ffi::c_void,
    fs::File,
    io::ErrorKind,
    os::fd::AsRawFd,
    ptr::{self, NonNull},
};

const ENCODED_LIMIT: u64 = 128 * 1024 * 1024;
const MAX_PREVIEW_EDGE: i32 = 2048;

type Cf = *const c_void;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: Cf;
    static kCFTypeDictionaryKeyCallBacks: u8;
    static kCFTypeDictionaryValueCallBacks: u8;
    fn CFNumberCreate(allocator: Cf, kind: isize, value: *const i32) -> Cf;
    fn CFNumberGetValue(number: Cf, kind: isize, value: *mut i32) -> u8;
    fn CFDictionaryGetValue(dictionary: Cf, key: Cf) -> Cf;
    fn CFDictionaryCreate(
        allocator: Cf,
        keys: *const Cf,
        values: *const Cf,
        count: isize,
        key_callbacks: Cf,
        value_callbacks: Cf,
    ) -> Cf;
    fn CFRelease(value: Cf);
}

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    static kCGImageSourceCreateThumbnailFromImageAlways: Cf;
    static kCGImageSourceCreateThumbnailWithTransform: Cf;
    static kCGImageSourceThumbnailMaxPixelSize: Cf;
    static kCGImageSourceShouldCacheImmediately: Cf;
    fn CGImageSourceCreateWithDataProvider(provider: Cf, options: Cf) -> Cf;
    static kCGImagePropertyOrientation: Cf;
    fn CGImageSourceGetCount(source: Cf) -> usize;
    fn CGImageSourceCopyPropertiesAtIndex(source: Cf, index: usize, options: Cf) -> Cf;
    fn CGImageSourceCreateThumbnailAtIndex(source: Cf, index: usize, options: Cf) -> Cf;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGColorSpaceCreateDeviceRGB() -> Cf;
    fn CGDataProviderCreateWithData(
        info: *mut c_void,
        data: Cf,
        length: usize,
        release: unsafe extern "C" fn(*mut c_void, Cf, usize),
    ) -> Cf;
    fn CGImageCreate(
        width: usize,
        height: usize,
        bits_per_component: usize,
        bits_per_pixel: usize,
        bytes_per_row: usize,
        color_space: Cf,
        bitmap_info: u32,
        provider: Cf,
        decode: *const f64,
        interpolate: bool,
        intent: i32,
    ) -> Cf;
    fn CGDataProviderCreateDirect(
        info: *mut c_void,
        length: i64,
        callbacks: *const DirectCallbacks,
    ) -> Cf;
}

extern "C" {
    fn pread(fd: i32, buffer: *mut c_void, count: usize, offset: i64) -> isize;
}

#[repr(C)]
struct DirectCallbacks {
    version: u32,
    get_byte_pointer: Option<unsafe extern "C" fn(*mut c_void) -> Cf>,
    release_byte_pointer: Option<unsafe extern "C" fn(*mut c_void, Cf)>,
    get_bytes_at_position: unsafe extern "C" fn(*mut c_void, *mut c_void, i64, usize) -> usize,
    release_info: unsafe extern "C" fn(*mut c_void),
}

unsafe extern "C" fn read_file_at(
    info: *mut c_void,
    buffer: *mut c_void,
    offset: i64,
    count: usize,
) -> usize {
    if offset < 0
        || count == 0
        || buffer.is_null()
        || offset.checked_add_unsigned(count as u64).is_none()
    {
        return 0;
    }
    // Core Graphics supplies writable storage, which need not be initialized.
    // pread fills it directly and leaves the leased file's cursor untouched.
    let file = unsafe { &*info.cast::<File>() };
    let mut done = 0;
    while done < count {
        let destination = unsafe { buffer.cast::<u8>().add(done).cast() };
        let read = unsafe {
            pread(
                file.as_raw_fd(),
                destination,
                count - done,
                offset + done as i64,
            )
        };
        if read == 0 {
            break;
        }
        if read < 0 {
            if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        done += read as usize;
    }
    done
}

unsafe extern "C" fn release_file(info: *mut c_void) {
    drop(unsafe { Box::from_raw(info.cast::<File>()) });
}

static FILE_CALLBACKS: DirectCallbacks = DirectCallbacks {
    version: 0,
    get_byte_pointer: None,
    release_byte_pointer: None,
    get_bytes_at_position: read_file_at,
    release_info: release_file,
};

struct OwnedCf(NonNull<c_void>);
impl OwnedCf {
    fn from_create_rule(value: Cf) -> Option<Self> {
        NonNull::new(value.cast_mut()).map(Self)
    }
    fn as_ptr(&self) -> Cf {
        self.0.as_ptr()
    }
}
impl Drop for OwnedCf {
    fn drop(&mut self) {
        unsafe { CFRelease(self.as_ptr()) }
    }
}

pub(super) struct Preview {
    image: OwnedCf,
    source_size: [u32; 2],
}
// This owns an immutable CGImage, eagerly decoded before leaving the worker.
// The image has no UIKit state and the receiving thread takes its only owner.
unsafe impl Send for Preview {}
impl Preview {
    pub(super) fn image(&self) -> Cf {
        self.image.as_ptr()
    }
    pub(super) fn dimensions(&self) -> [u32; 2] {
        self.source_size
    }
}

pub(super) fn from_animation_frame(frame: super::animation::FramePixels) -> Option<Preview> {
    unsafe extern "C" fn release_pixels(info: *mut c_void, _: Cf, _: usize) {
        drop(unsafe { Box::from_raw(info.cast::<Vec<u8>>()) });
    }
    let [width, height] = frame.size.map(|edge| edge as usize);
    let space = OwnedCf::from_create_rule(unsafe { CGColorSpaceCreateDeviceRGB() })?;
    let pixels = Box::new(frame.bgra);
    let data = pixels.as_ptr().cast();
    let length = pixels.len();
    let info = Box::into_raw(pixels).cast();
    let Some(provider) = OwnedCf::from_create_rule(unsafe {
        CGDataProviderCreateWithData(info, data, length, release_pixels)
    }) else {
        unsafe { release_pixels(info, data, length) };
        return None;
    };
    const PREMULTIPLIED_FIRST_LITTLE_ENDIAN: u32 = (2 << 12) | 2;
    let image = OwnedCf::from_create_rule(unsafe {
        CGImageCreate(
            width,
            height,
            8,
            32,
            width * 4,
            space.as_ptr(),
            PREMULTIPLIED_FIRST_LITTLE_ENDIAN,
            provider.as_ptr(),
            ptr::null(),
            true,
            0,
        )
    })?;
    Some(Preview {
        image,
        source_size: frame.source_size,
    })
}

pub(super) fn decode(file: &File) -> Option<Preview> {
    decode_with_limit(file, MAX_PREVIEW_EDGE)
}

pub(super) fn decode_with_limit(file: &File, max_edge: i32) -> Option<Preview> {
    let length = file.metadata().ok()?.len();
    if length == 0 || length > ENCODED_LIMIT {
        return None;
    }
    let (_, width, height) = super::static_reader_file_info(file)?;
    let mut source_size = [width, height];
    let info = Box::into_raw(Box::new(file.try_clone().ok()?)).cast();
    unsafe {
        // The provider owns the duplicate descriptor for as long as Image I/O
        // can request bytes from it, even after the original lease is released.
        let Some(provider) = OwnedCf::from_create_rule(CGDataProviderCreateDirect(
            info,
            length as i64,
            &FILE_CALLBACKS,
        )) else {
            release_file(info);
            return None;
        };
        let source = OwnedCf::from_create_rule(CGImageSourceCreateWithDataProvider(
            provider.as_ptr(),
            ptr::null(),
        ))?;
        // A still preview must never silently replace an animated page.
        if CGImageSourceGetCount(source.as_ptr()) != 1 {
            return None;
        }
        // Match the axes of the EXIF-oriented preview while reporting the
        // full source resolution to layout and zoom calculations.
        if let Some(properties) = OwnedCf::from_create_rule(CGImageSourceCopyPropertiesAtIndex(
            source.as_ptr(),
            0,
            ptr::null(),
        )) {
            let value = CFDictionaryGetValue(properties.as_ptr(), kCGImagePropertyOrientation);
            let mut orientation = 1;
            if !value.is_null()
                && CFNumberGetValue(value, 3, &mut orientation) != 0
                && (5..=8).contains(&orientation)
            {
                source_size.swap(0, 1);
            }
        }
        // kCFNumberSInt32Type = 3.
        let limit = OwnedCf::from_create_rule(CFNumberCreate(ptr::null(), 3, &max_edge))?;
        let keys = [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceThumbnailMaxPixelSize,
            kCGImageSourceShouldCacheImmediately,
        ];
        let values = [
            kCFBooleanTrue,
            kCFBooleanTrue,
            limit.as_ptr(),
            kCFBooleanTrue,
        ];
        let options = OwnedCf::from_create_rule(CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            keys.len() as isize,
            ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
            ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast(),
        ))?;
        OwnedCf::from_create_rule(CGImageSourceCreateThumbnailAtIndex(
            source.as_ptr(),
            0,
            options.as_ptr(),
        ))
        .map(|image| Preview { image, source_size })
    }
}
