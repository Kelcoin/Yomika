//! Platform-independent entry point for presenting leased reader files.

use crate::compute::ComputeHandle;
use crate::domain::result::CommandResult;
use tauri::{AppHandle, State, WebviewWindow};

pub(crate) mod crop;

#[cfg(any(windows, target_os = "ios", target_os = "android"))]
pub(crate) mod animation;
#[cfg(windows)]
mod d2d;
#[cfg(target_os = "ios")]
mod image_io;
#[cfg(target_os = "ios")]
mod ios_host;
#[cfg(any(windows, target_os = "ios"))]
mod continuous_input;
#[cfg(any(windows, target_os = "ios"))]
use continuous_input::ContinuousInputStamp;
#[cfg(any(windows, target_os = "ios", test))]
mod png_pixels;
#[cfg(target_os = "ios")]
pub(crate) use ios_host::{cover as cover_ios, retire_window as retire_ios_window};
#[cfg(windows)]
mod wic;
#[cfg(windows)]
mod windows_host;
#[cfg(windows)]
pub(crate) use windows_host::{cover_window, window_event};

#[cfg(any(windows, target_os = "ios"))]
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewTransform {
    session: u32,
    page: i32,
    scale: f64,
    pan_x: f64,
    pan_y: f64,
    pixel_ratio: f64,
    #[serde(default)]
    edge_offset: f64,
    #[serde(default)]
    neighbour_page: Option<i32>,
}

#[cfg(any(windows, target_os = "ios"))]
impl ViewTransform {
    fn matches(self, session: u32, page: i32) -> bool {
        self.session == session && self.page == page
    }

    fn incoming(self) -> Option<Self> {
        if self.edge_offset == 0.0 {
            return None;
        }
        Some(Self {
            page: self.neighbour_page?,
            scale: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
            edge_offset: self.edge_offset - self.edge_offset.signum(),
            neighbour_page: None,
            ..self
        })
    }

    fn valid(self) -> bool {
        self.page > 0
            && self.neighbour_page.is_none_or(|page| page > 0 && page != self.page)
            && (0.8..=16.0).contains(&self.scale)
            && (0.5..=8.0).contains(&self.pixel_ratio)
            && (-1.0..=1.0).contains(&self.edge_offset)
            && self.pan_x.abs() <= 32_768.0
            && self.pan_y.abs() <= 32_768.0
    }
}

// Read only format metadata before picking the static native renderer.
pub(crate) fn static_reader_file_info(file: &std::fs::File) -> Option<(&'static str, u32, u32)> {
    reader_file_info(file, false)
}

pub(crate) fn reader_file_info(mut file: &std::fs::File, allow_animation: bool) -> Option<(&'static str, u32, u32)> {
    use image::{codecs::{gif::GifDecoder, png::PngDecoder, webp::WebPDecoder}, ImageDecoder, ImageFormat, ImageReader};
    use std::io::Seek;
    file.rewind().ok()?;
    let reader = ImageReader::new(std::io::BufReader::new(file)).with_guessed_format().ok()?;
    let (mime, dimensions) = match reader.format()? {
        ImageFormat::Jpeg => ("image/jpeg", reader.into_dimensions().ok()?),
        ImageFormat::Png => {
            let decoder = PngDecoder::new(reader.into_inner()).ok()?;
            if decoder.is_apng().ok()? && !allow_animation { return None; }
            ("image/png", decoder.dimensions())
        }
        ImageFormat::WebP => {
            let decoder = WebPDecoder::new(reader.into_inner()).ok()?;
            if decoder.has_animation() && !allow_animation { return None; }
            ("image/webp", decoder.dimensions())
        }
        ImageFormat::Gif if allow_animation => ("image/gif", GifDecoder::new(reader.into_inner()).ok()?.dimensions()),
        _ => return None,
    };
    Some((mime, dimensions.0, dimensions.1))
}

#[tauri::command]
pub(crate) async fn reader_prepare_native_slot(
    app: AppHandle,
    webview: WebviewWindow,
    compute: State<'_, ComputeHandle>,
    lease_id: String,
    right_lease_id: Option<String>,
    aspect: Option<f32>,
    slot: i32,
    page: i32,
    session: u32,
    committed: Option<bool>,
) -> Result<CommandResult<bool>, String> {
    let aspect = aspect.unwrap_or(1.0);
    #[cfg(not(any(windows, target_os = "ios")))]
    let _ = committed;
    if session == 0 || slot <= 0 || page <= 0 || !(0.1..=10.0).contains(&aspect) {
        return Ok(CommandResult::success(false));
    }
    #[cfg(target_os = "android")]
    {
        let Some((left, right)) = compute.leases().reader_files(
            &lease_id,
            right_lease_id.as_deref(),
            webview.label(),
            session,
            page,
            std::time::Instant::now(),
        ) else {
            return Ok(CommandResult::success(false));
        };
        let ready =
            crate::mobile_host::prepare_reader_slot(&app, left, right, aspect, slot, page, session).await?;
        Ok(CommandResult::success(ready))
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        let _ = app;
        let Some((file, right)) = compute.leases().reader_files(
            &lease_id,
            right_lease_id.as_deref(),
            webview.label(),
            session,
            page,
            std::time::Instant::now(),
        ) else {
            return Ok(CommandResult::success(false));
        };
        #[cfg(windows)]
        let ready = windows_host::prepare(webview, slot, page, session, file, right, committed.unwrap_or(false)).await?;
        #[cfg(target_os = "ios")]
        let ready = ios_host::prepare(webview, slot, page, session, file, right, committed.unwrap_or(false)).await?;
        Ok(CommandResult::success(ready))
    }
    #[cfg(not(any(windows, target_os = "android", target_os = "ios")))]
    {
        let _ = (app, webview, compute, lease_id, right_lease_id, session);
        Ok(CommandResult::success(false))
    }
}

#[cfg(any(windows, target_os = "ios"))]
#[tauri::command]
pub(crate) async fn reader_native_slot_message(
    webview: WebviewWindow,
    op: String,
    slot: i32,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_host::message(webview, op, slot).await
    }
    #[cfg(target_os = "ios")]
    {
        ios_host::message(webview, op, slot).await
    }
}

#[cfg(any(windows, target_os = "ios"))]
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}},
    time::{Duration, Instant},
};

#[cfg(any(windows, target_os = "ios"))]
static SLIDES: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(any(windows, target_os = "ios"))]
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SlideTransition {
    from: f64,
    duration_ms: u32,
    #[serde(default)]
    boundary: bool,
    zoom_from: Option<ZoomTransitionStart>,
}

#[cfg(any(windows, target_os = "ios"))]
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZoomTransitionStart {
    scale: f64,
    pan_x: f64,
    pan_y: f64,
}

#[cfg(any(windows, target_os = "ios"))]
impl SlideTransition {
    fn starting_zoom(self, target: ViewTransform) -> Option<ZoomTransitionStart> {
        self.zoom_from.filter(|zoom| {
            ViewTransform { scale: zoom.scale, pan_x: zoom.pan_x, pan_y: zoom.pan_y, ..target }.valid()
                && (zoom.scale != target.scale || zoom.pan_x != target.pan_x || zoom.pan_y != target.pan_y)
        })
    }

    fn sample(self, target: ViewTransform, time: f64) -> ViewTransform {
        if time >= 1.0 {
            return target;
        }
        let slide = slide_easing(time, self.boundary);
        let mut frame = ViewTransform { edge_offset: self.from + (target.edge_offset - self.from) * slide, ..target };
        if let Some(start) = self.zoom_from {
            let remaining = (1.0 - time).powi(3);
            frame.scale += (start.scale - target.scale) * remaining;
            frame.pan_x += (start.pan_x - target.pan_x) * remaining;
            frame.pan_y += (start.pan_y - target.pan_y) * remaining;
        }
        frame
    }
}

#[cfg(any(windows, target_os = "ios"))]
fn slide_easing(time: f64, boundary: bool) -> f64 {
    // Use the same control points as the fallback track so both layers stay aligned.
    let (y1, x2) = if boundary { (1.0, 0.36) } else { (0.45, 0.28) };
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..16 {
        let t = (lo + hi) * 0.5;
        let u = 1.0 - t;
        let x = 3.0 * u * t * (u * 0.22 + t * x2) + t * t * t;
        if x < time { lo = t; } else { hi = t; }
    }
    let t = (lo + hi) * 0.5;
    let u = 1.0 - t;
    3.0 * u * t * (u * y1 + t) + t * t * t
}

#[cfg(any(windows, target_os = "ios"))]
async fn paint_transform(
    window: WebviewWindow,
    transform: ViewTransform,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    #[cfg(windows)]
    return windows_host::transform(window, transform, cancelled).await;
    #[cfg(target_os = "ios")]
    ios_host::transform(window, transform, cancelled).await
}

#[cfg(any(windows, target_os = "ios"))]
#[tauri::command]
pub(crate) async fn reader_native_view_transform(
    webview: WebviewWindow,
    transform: ViewTransform,
    transition: Option<SlideTransition>,
) -> Result<(), String> {
    if !transform.valid() {
        return Ok(());
    }
    let label = webview.label().to_owned();
    let transition = transition.map(|mut slide| {
        slide.zoom_from = slide.starting_zoom(transform);
        slide
    }).filter(|slide| {
        (-1.0..=1.0).contains(&slide.from)
            && (1..=400).contains(&slide.duration_ms)
            && (!slide.boundary || transform.neighbour_page.is_none())
            && (slide.from != transform.edge_offset || slide.zoom_from.is_some())
    });
    let cancelled = transition.map(|_| Arc::new(AtomicBool::new(false)));
    {
        let mut slides = SLIDES.lock().map_err(|_| "Reader animation lock")?;
        if let Some(old) = slides.remove(&label) {
            old.store(true, Ordering::Release);
        }
        if let Some(cancelled) = &cancelled {
            slides.insert(label.clone(), cancelled.clone());
        }
    }
    let (Some(slide), Some(cancelled)) = (transition, cancelled) else {
        return paint_transform(webview, transform, None).await;
    };
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let duration = Duration::from_millis(slide.duration_ms.into());
        let mut ticks = tokio::time::interval(Duration::from_millis(16));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        while !cancelled.load(Ordering::Acquire) {
            ticks.tick().await;
            let elapsed = started.elapsed();
            let frame = slide.sample(transform, elapsed.as_secs_f64() / duration.as_secs_f64());
            if paint_transform(webview.clone(), frame, Some(cancelled.clone())).await.is_err()
                || elapsed >= duration
            {
                break;
            }
        }
        if let Ok(mut slides) = SLIDES.lock() {
            if slides.get(&label).is_some_and(|entry| Arc::ptr_eq(entry, &cancelled)) {
                slides.remove(&label);
            }
        }
    });
    Ok(())
}

#[cfg(any(windows, target_os = "ios"))]
#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub(crate) struct ContinuousPlacement {
    slot: i32,
    rect: [f64; 4], // CSS left, content top, width and height
}

#[cfg(any(windows, target_os = "ios"))]
#[derive(Default)]
pub(crate) struct ContinuousLayout {
    placements: Vec<ContinuousPlacement>,
    scroll_top: f64,
    viewport_height: f64,
}

#[cfg(any(windows, target_os = "ios"))]
impl ContinuousLayout {
    fn apply(&mut self, placements: Option<Vec<ContinuousPlacement>>, scroll_top: f64, viewport_height: f64) {
        if let Some(placements) = placements {
            self.placements = placements;
        }
        self.scroll_top = scroll_top;
        self.viewport_height = viewport_height;
    }

    fn remove(&mut self, slot: i32) {
        self.placements.retain(|placement| placement.slot != slot);
    }

    fn visible(&self) -> impl Iterator<Item = (i32, [f64; 4])> + '_ {
        self.placements.iter().filter_map(|placement| {
            let [left, top, width, height] = placement.rect;
            let y = top - self.scroll_top;
            (y < self.viewport_height && y + height > 0.0)
                .then_some((placement.slot, [left, y, width, height]))
        })
    }
}

#[cfg(any(windows, target_os = "ios"))]
#[tauri::command]
pub(crate) async fn reader_native_continuous_layout(
    webview: WebviewWindow,
    mut placements: Option<Vec<ContinuousPlacement>>,
    pixel_ratio: f32,
    scroll_top: f64,
    viewport_height: f64,
    scroll_input: Option<ContinuousInputStamp>,
) -> Result<(), String> {
    if !(0.5..=8.0).contains(&pixel_ratio) || !scroll_top.is_finite()
        || !(0.0..=32_768.0).contains(&viewport_height)
    {
        return Ok(());
    }
    if let Some(placements) = placements.as_mut() {
        if placements.len() > 48 {
            return Ok(());
        }
        placements.retain(|placement| {
            let [left, top, width, height] = placement.rect;
            placement.slot > 0 && left.abs() <= 32768.0 && top.is_finite()
                && width > 0.0 && width <= 32768.0 && height > 0.0 && height <= i32::MAX as f64
        });
        placements.sort_unstable_by_key(|placement| placement.slot);
        placements.dedup_by_key(|placement| placement.slot);
    }
    #[cfg(windows)]
    {
        windows_host::continuous_layout(webview, placements, pixel_ratio, scroll_top, viewport_height, scroll_input).await
    }
    #[cfg(target_os = "ios")]
    ios_host::continuous_layout(webview, placements, scroll_top, viewport_height, scroll_input).await
}

#[cfg(any(windows, target_os = "ios"))]
#[tauri::command]
pub(crate) async fn reader_native_continuous_input(
    webview: WebviewWindow,
    session: u32,
    active: Option<bool>,
    limit: Option<f64>,
    offset: f64,
    reduce_motion: Option<bool>,
    revision: Option<u32>,
    relative: Option<bool>,
    wheel: Option<bool>,
) -> Result<(), String> {
    if session == 0 || !offset.is_finite() || limit.is_some_and(|n| !n.is_finite() || n < 0.0) {
        return Ok(());
    }
    #[cfg(windows)]
    if wheel.unwrap_or(false) {
        return windows_host::continuous_wheel(webview, session, revision.unwrap_or(0), offset).await;
    }
    #[cfg(target_os = "ios")]
    let _ = wheel;
    #[cfg(target_os = "ios")]
    use ios_host as host;
    #[cfg(windows)]
    use windows_host as host;
    if let Some(revision) = revision {
        host::continuous_reposition(webview, session, revision, offset, relative.unwrap_or(false)).await
    } else {
        host::continuous_configure(webview, session, active.unwrap_or(false), limit.unwrap_or(0.0), offset, reduce_motion.unwrap_or(false)).await
    }
}

#[cfg(windows)]
#[tauri::command]
pub(crate) async fn reader_native_wheel_zoom(
    webview: WebviewWindow,
    session: u32,
    page: i32,
    pixel_ratio: f64,
    maximum: f64,
    samples: Vec<[f64; 4]>,
) -> Result<Option<[f64; 3]>, String> {
    if session == 0 || page <= 0 || !(0.5..=8.0).contains(&pixel_ratio)
        || !(1.0..=14.0).contains(&maximum)
        || samples.is_empty() || samples.len() > 32
        || samples.iter().any(|sample| !matches!(sample[3], 0.0 | 1.0))
        || samples.iter().flatten().any(|value| !value.is_finite() || value.abs() > 32_768.0)
    {
        return Ok(None);
    }
    windows_host::wheel_zoom(webview, session, page, pixel_ratio, maximum, samples).await
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub(crate) async fn reader_native_pinch_input(
    webview: WebviewWindow,
    session: u32,
    page: i32,
    enabled: bool,
    maximum: f64,
    reduce_motion: bool,
    left: Option<i32>,
    right: Option<i32>,
) -> Result<(), String> {
    if session == 0 || page <= 0 || !(1.0..=14.0).contains(&maximum) {
        return Ok(());
    }
    let left = left.filter(|number| *number > 0 && *number != page);
    let right = right.filter(|number| *number > 0 && *number != page);
    ios_host::configure_pinch(webview, session, page, enabled, maximum, reduce_motion, left, right).await
}

#[cfg(all(test, any(windows, target_os = "ios")))]
mod tests {
    use super::*;

    #[test]
    fn offset_only_scroll_updates_reuse_previous_page_geometry() {
        let mut layout = ContinuousLayout::default();
        layout.apply(Some(vec![
            ContinuousPlacement { slot: 1, rect: [10.0, 0.0, 80.0, 100.0] },
            ContinuousPlacement { slot: 2, rect: [10.0, 100.0, 80.0, 350.0] },
        ]), 0.0, 100.0);
        assert_eq!(layout.visible().map(|(slot, _)| slot).collect::<Vec<_>>(), vec![1]);
        layout.apply(None, 125.0, 100.0);
        assert_eq!(layout.visible().collect::<Vec<_>>(), vec![(2, [10.0, -25.0, 80.0, 350.0])]);
        layout.apply(Some(Vec::new()), 0.0, 100.0);
        assert!(layout.visible().next().is_none());
    }

    #[test]
    fn slide_returns_near_fit_zoom_to_rest_in_the_same_frames() {
        let target = ViewTransform {
            session: 7, page: 3, scale: 1.0, pan_x: 0.0, pan_y: 0.0, pixel_ratio: 1.0,
            edge_offset: -1.0, neighbour_page: Some(5),
        };
        let transition = SlideTransition {
            from: -0.2, duration_ms: 140, boundary: false,
            zoom_from: Some(ZoomTransitionStart { scale: 1.04, pan_x: 8.0, pan_y: -4.0 }),
        };
        let middle = transition.sample(target, 0.5);
        assert!(middle.edge_offset < -0.2 && middle.edge_offset > -1.0);
        assert!((1.0..1.04).contains(&middle.scale));
        assert_eq!((middle.pan_x, middle.pan_y), (1.0, -0.5));
        assert_eq!(middle.incoming().unwrap().scale, 1.0);
        let end = transition.sample(target, 1.0);
        assert_eq!((end.scale, end.pan_x, end.pan_y, end.edge_offset), (1.0, 0.0, 0.0, -1.0));
    }
}
