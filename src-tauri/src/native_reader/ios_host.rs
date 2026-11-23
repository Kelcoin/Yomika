//! UIKit owns the view tree. Only immutable Image I/O previews cross threads.
use super::{
    animation::Animation,
    continuous_input::{ContinuousInput, ContinuousInputStamp},
    image_io,
    png_pixels::{PngPixels, Region},
    ContinuousLayout, ContinuousPlacement, ViewTransform,
};
use crate::compute::leases::ReaderFile;
use objc2::{define_class, msg_send, rc::Retained, runtime::ProtocolObject, sel, DefinedClass, MainThreadMarker, MainThreadOnly, Message};
use objc2_foundation::{NSObject, NSObjectProtocol};
use objc2_ui_kit::{
    UIColor, UIGestureRecognizer, UIGestureRecognizerDelegate, UIGestureRecognizerState,
    UIImage, UIImageView, UIPanGestureRecognizer, UIView, UIViewAutoresizing, UIViewContentMode,
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::WebviewWindow;

#[path = "ios_host/pinch.rs"]
mod pinch;
pub(super) use pinch::configure as configure_pinch;

const MAX_SLOTS: usize = 6;
static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static COVERED: Cell<bool> = const { Cell::new(false) };
    static READERS: RefCell<HashMap<String, Reader>> = Default::default();
}

#[derive(Default)]
struct Reader {
    slots: HashMap<i32, Slot>,
    requested: Option<i32>,
    active: Option<i32>,
    pane: Option<Pane>,
    transforms: HashMap<(u32, i32), ViewTransform>,
    refinement_worker: Option<u64>,
    continuous: ContinuousLayout,
    scroll_input: ContinuousInput,
    scroll_pan: Option<ScrollPan>,
    scroll_fling: Option<u64>,
    pinch_config: Option<pinch::PinchConfig>,
    pinch: Option<pinch::PinchRecognizer>,
    pinching: Option<(u32, i32)>,
    pinch_settle: Option<u64>,
    continuous_views: HashMap<i32, PageView>,
    animation_window: Option<WebviewWindow>,
    animation_tick: Option<(Instant, u64)>,
}

pub(crate) fn cover(covered: bool) {
    COVERED.set(covered);
    let mut interrupted_pinches = Vec::new();
    let resume = READERS.with_borrow_mut(|readers| {
        readers
            .values_mut()
            .filter_map(|reader| {
                if let Some(pane) = &reader.pane {
                    pane.canvas.setHidden(covered);
                }
                if covered {
                    reader.animation_tick = None;
                    reader.scroll_fling = None;
                    if let (Some(key), Some(window)) = (reader.pinching.take(), reader.pinch.as_ref().map(|input| input.window().clone())) {
                        interrupted_pinches.push((window, key));
                    }
                    reader.pinch_settle = None;
                    None
                } else {
                    reader.animation_window.clone()
                }
            })
            .collect::<Vec<_>>()
    });
    for (window, key) in interrupted_pinches {
        pinch::notify_pinch(&window, key, false);
    }
    for window in resume {
        if let Some(mtm) = MainThreadMarker::new() {
            READERS.with_borrow_mut(|readers| {
                if let Some(reader) = readers.get_mut(window.label()) {
                    reader.paint_animation(mtm);
                }
            });
        }
        schedule_animation(&window, window.label());
    }
}

pub(crate) fn retire_window(label: &str) {
    READERS.with_borrow_mut(|readers| readers.remove(label));
}

struct Slot {
    revision: u64,
    page: i32,
    session: u32,
    previews: Option<Vec<Page>>,
    animation_start: Cell<Option<Instant>>,
    committed: bool,
    files: Vec<ReaderFile>,
    detail: Vec<DetailState>,
}

#[derive(Default)]
struct DetailState {
    backing: Option<Arc<Mutex<PngPixels>>>,
    delivered: Option<Region>,
    attempted: Option<Region>,
    fallback: bool,
}

struct DetailRequest {
    index: usize,
    file: ReaderFile,
    size: [u32; 2],
    region: Region,
    backing: Option<Arc<Mutex<PngPixels>>>,
}

enum Refinement {
    Region(Region, Arc<Mutex<PngPixels>>, Option<image_io::Preview>),
    Whole(Option<image_io::Preview>),
}

enum Page {
    Static(image_io::Preview),
    Animated(Animation<image_io::Preview>),
}

impl Page {
    fn first(&self) -> &image_io::Preview {
        match self {
            Self::Static(preview) => preview,
            Self::Animated(animation) => animation.first(),
        }
    }

    fn frame(&self, elapsed: Duration) -> &image_io::Preview {
        match self {
            Self::Static(preview) => preview,
            Self::Animated(animation) => animation.frame(elapsed).1,
        }
    }
}

impl Slot {
    fn elapsed(&self, now: Instant) -> Duration {
        let start = self.animation_start.get().unwrap_or_else(|| {
            self.animation_start.set(Some(now));
            now
        });
        now.saturating_duration_since(start)
    }
}

struct PageView {
    view: Retained<UIImageView>,
    frame_identity: usize,
    detail: Option<PageDetail>,
}

struct PageDetail {
    view: Retained<UIImageView>,
    region: Region,
    source_size: [u32; 2],
}

impl PageView {
    fn show_detail(
        &mut self,
        region: Region,
        tile: &image_io::Preview,
        mtm: MainThreadMarker,
    ) {
        let bounds = self.view.bounds();
        let [x, y, width, height] = region;
        let source_size = tile.dimensions();
        let source = source_size.map(f64::from);
        let mut frame = bounds;
        frame.origin.x += f64::from(x) / source[0] * bounds.size.width;
        frame.origin.y += f64::from(y) / source[1] * bounds.size.height;
        frame.size.width = f64::from(width) / source[0] * bounds.size.width;
        frame.size.height = f64::from(height) / source[1] * bounds.size.height;
        let view = UIImageView::initWithFrame(mtm.alloc(), frame);
        view.setUserInteractionEnabled(false);
        view.setBackgroundColor(Some(&UIColor::blackColor()));
        let image: Retained<UIImage> =
            unsafe { msg_send![mtm.alloc::<UIImage>(), initWithCGImage: tile.image()] };
        view.setImage(Some(&image));
        self.view.addSubview(&view);
        if let Some(old) = self.detail.replace(PageDetail { view, region, source_size }) {
            old.view.removeFromSuperview();
        }
    }

    fn update_detail(&self, transform: Option<ViewTransform>, viewport: [f64; 2]) {
        let Some(detail) = &self.detail else { return; };
        let covers_viewport = transform.filter(|t| t.scale >= 1.4 && t.edge_offset == 0.0).and_then(|t| {
            let frame = self.view.frame();
            let (x, width) = source_span(viewport[0], frame.origin.x, frame.size.width,
                detail.source_size[0], t.scale, t.pan_x, 0.0)?;
            let (y, height) = source_span(viewport[1], frame.origin.y, frame.size.height,
                detail.source_size[1], t.scale, t.pan_y, 0.0)?;
            Some(contains_region(detail.region, [x, y, width, height]))
        }).unwrap_or(false);
        // Keep a moving crop edge off-screen. A lower-resolution whole
        // preview covers this interval until the next padded crop arrives.
        if detail.view.isHidden() == covers_viewport {
            detail.view.setHidden(!covers_viewport);
        }
    }

    fn show(&mut self, preview: &image_io::Preview, mtm: MainThreadMarker) {
        let identity = preview.image() as usize;
        if identity != self.frame_identity {
            let image: Retained<UIImage> =
                unsafe { msg_send![mtm.alloc::<UIImage>(), initWithCGImage: preview.image()] };
            self.view.setImage(Some(&image));
            self.frame_identity = identity;
        }
    }
}

struct Pane {
    root: Retained<UIView>,
    canvas: Retained<UIView>,
    content: Retained<UIView>,
    incoming: Retained<UIView>,
    incoming_revision: Cell<Option<u64>>,
    incoming_views: RefCell<Vec<PageView>>,
    scroll: Retained<UIView>,
    page_views: RefCell<Vec<PageView>>,
    original_opaque: bool,
    original_scroll_opaque: bool,
    original_background: Option<Retained<UIColor>>,
    original_scroll_background: Option<Retained<UIColor>>,
}

impl Pane {
    fn new(web: &UIView, mtm: MainThreadMarker) -> Option<Self> {
        let parent = web.superview()?;
        // The incoming UIView is the retained WKWebView owned by Tauri.
        let scroll: Retained<UIView> = unsafe { msg_send![web, scrollView] };
        let canvas = UIView::initWithFrame(mtm.alloc(), web.frame());
        let resize = UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight;
        canvas.setAutoresizingMask(resize);
        canvas.setUserInteractionEnabled(false);
        canvas.setHidden(COVERED.get());
        canvas.setClipsToBounds(true);
        canvas.setBackgroundColor(Some(&UIColor::blackColor()));
        let content = UIView::initWithFrame(mtm.alloc(), canvas.bounds());
        content.setAutoresizingMask(resize);
        let incoming = UIView::initWithFrame(mtm.alloc(), canvas.bounds());
        incoming.setAutoresizingMask(resize);
        incoming.setHidden(true);
        canvas.addSubview(&content);
        canvas.addSubview(&incoming);
        parent.insertSubview_belowSubview(&canvas, web);
        let root = web.retain();
        let pane = Self {
            original_opaque: root.isOpaque(),
            original_scroll_opaque: scroll.isOpaque(),
            original_background: root.backgroundColor(),
            original_scroll_background: scroll.backgroundColor(),
            root,
            canvas,
            content,
            incoming,
            incoming_revision: Cell::new(None),
            incoming_views: RefCell::default(),
            scroll,
            page_views: RefCell::default(),
        };
        pane.root.setOpaque(false);
        pane.scroll.setOpaque(false);
        pane.root.setBackgroundColor(Some(&UIColor::clearColor()));
        pane.scroll.setBackgroundColor(Some(&UIColor::clearColor()));
        Some(pane)
    }

    fn set_transform(&self, transform: Option<ViewTransform>) {
        let mut matrix = self.content.transform();
        let (scale, x, y) = transform.map_or((1.0, 0.0, 0.0), |transform| {
            (
                transform.scale,
                transform.pan_x * transform.scale
                    + transform.edge_offset * self.root.bounds().size.width,
                transform.pan_y * transform.scale,
            )
        });
        matrix.a = scale;
        matrix.d = scale;
        matrix.tx = x;
        matrix.ty = y;
        self.content.setTransform(matrix);
    }

    fn set_pages<'a>(
        &self,
        revision: u64,
        previews: impl ExactSizeIterator<Item = &'a image_io::Preview>,
        mtm: MainThreadMarker,
    ) {
        if self.incoming_revision.get() == Some(revision) {
            // The swipe already arranged this exact rendition. Move its
            // views to the active container without recreating UIImages.
            let previous = self.content.subviews();
            let views = self.incoming_views.take();
            for view in &views {
                self.content.addSubview(&view.view);
            }
            for index in 0..previous.count() {
                previous.objectAtIndex(index).removeFromSuperview();
            }
            self.page_views.replace(views);
            self.incoming_revision.set(None);
            self.incoming.setHidden(true);
        } else {
            self.page_views.replace(Self::place_pages(&self.content, previews, mtm));
        }
    }

    fn place_pages<'a>(
        content: &UIView,
        previews: impl ExactSizeIterator<Item = &'a image_io::Preview>,
        mtm: MainThreadMarker,
    ) -> Vec<PageView> {
        // Construct the whole incoming spread before removing the old views.
        let previous = content.subviews();
        let bounds = content.bounds();
        let count = previews.len();
        let width = bounds.size.width / count as f64;
        let mut views = Vec::with_capacity(count);
        for (index, preview) in previews.enumerate() {
            let mut frame = bounds;
            let [source_width, source_height] = preview.dimensions().map(f64::from);
            let scale = (width / source_width).min(bounds.size.height / source_height);
            frame.size.width = source_width * scale;
            frame.size.height = source_height * scale;
            frame.origin.y += (bounds.size.height - frame.size.height) / 2.0;
            frame.origin.x += match (count, index) {
                (2, 0) => width - frame.size.width,
                (2, _) => width,
                _ => (width - frame.size.width) / 2.0,
            };
            let page = UIImageView::initWithFrame(mtm.alloc(), frame);
            page.setAutoresizingMask(
                UIViewAutoresizing::FlexibleLeftMargin
                    | UIViewAutoresizing::FlexibleRightMargin
                    | UIViewAutoresizing::FlexibleTopMargin
                    | UIViewAutoresizing::FlexibleBottomMargin
                    | UIViewAutoresizing::FlexibleWidth
                    | UIViewAutoresizing::FlexibleHeight,
            );
            page.setContentMode(UIViewContentMode::ScaleAspectFit);
            let mut view = PageView {
                view: page,
                frame_identity: 0,
                detail: None,
            };
            view.show(preview, mtm);
            content.addSubview(&view.view);
            views.push(view);
        }
        for index in 0..previous.count() {
            previous.objectAtIndex(index).removeFromSuperview();
        }
        views
    }

    fn set_incoming(&self, incoming: Option<(&Slot, ViewTransform)>, mtm: MainThreadMarker) {
        let Some((slot, transform)) = incoming else {
            self.incoming.setHidden(true);
            if self.incoming_revision.replace(None).is_some() {
                for view in self.incoming_views.take() {
                    view.view.removeFromSuperview();
                }
            }
            return;
        };
        if self.incoming_revision.replace(Some(slot.revision)) != Some(slot.revision) {
            let elapsed = slot.elapsed(Instant::now());
            if let Some(pages) = &slot.previews {
                self.incoming_views.replace(Self::place_pages(
                    &self.incoming,
                    pages.iter().map(|page| page.frame(elapsed)),
                    mtm,
                ));
            }
        }
        let mut matrix = self.incoming.transform();
        matrix.tx = transform.edge_offset * self.canvas.bounds().size.width;
        self.incoming.setTransform(matrix);
        self.incoming.setHidden(false);
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        self.root.setOpaque(self.original_opaque);
        self.scroll.setOpaque(self.original_scroll_opaque);
        self.root
            .setBackgroundColor(self.original_background.as_deref());
        self.scroll
            .setBackgroundColor(self.original_scroll_background.as_deref());
        self.canvas.removeFromSuperview();
    }
}

impl Reader {
    fn present(&mut self, web: &UIView, mtm: MainThreadMarker, slot: i32) -> bool {
        let Some(entry) = self.slots.get(&slot) else {
            return false;
        };
        let Some(previews) = entry.previews.as_ref() else {
            return false;
        };
        if self.pane.is_none() {
            self.pane = Pane::new(web, mtm);
        }
        let Some(pane) = &self.pane else {
            return false;
        };
        let previous = self.active;
        if previous != Some(slot) {
            self.continuous_views.clear();
            let elapsed = entry.elapsed(Instant::now());
            pane.set_pages(entry.revision, previews.iter().map(|page| page.frame(elapsed)), mtm);
        }
        let transform = self.transforms.get(&(entry.session, entry.page)).copied();
        self.paint_transform(pane, transform, mtm);
        self.active = Some(slot);
        if previous != Some(slot) {
            if let Some(old) = previous.and_then(|id| self.slots.get_mut(&id)) {
                old.detail.clear();
            }
        }
        true
    }

    fn paint_transform(
        &self,
        pane: &Pane,
        transform: Option<ViewTransform>,
        mtm: MainThreadMarker,
    ) {
        pane.set_transform(transform);
        let size = pane.canvas.bounds().size;
        for page in pane.page_views.borrow().iter() {
            page.update_detail(transform, [size.width, size.height]);
        }
        let incoming = transform
            .and_then(ViewTransform::incoming)
            .and_then(|incoming| {
                let slot = self
                    .slots
                    .values()
                    .filter(|slot| {
                        slot.committed
                            && incoming.matches(slot.session, slot.page)
                            && slot.previews.is_some()
                    })
                    .max_by_key(|slot| slot.revision)?;
                Some((slot, incoming))
            });
        pane.set_incoming(incoming, mtm);
    }

    fn paint_continuous(&mut self, web: &UIView, mtm: MainThreadMarker) -> Vec<i32> {
        if self.active.is_some() || self.requested.is_some() || COVERED.get() {
            return Vec::new();
        }
        let now = Instant::now();
        let pages = self
            .continuous
            .visible()
            .filter_map(|(id, rect)| {
                let slot = self.slots.get(&id)?;
                let preview = slot.previews.as_ref()?.first()?.frame(slot.elapsed(now));
                Some((id, rect, preview))
            })
            .collect::<Vec<_>>();
        if pages.is_empty() {
            self.continuous_views.clear();
            self.pane = None;
            return Vec::new();
        }
        if self.pane.is_none() {
            self.pane = Pane::new(web, mtm);
        }
        let Some(pane) = &self.pane else {
            return Vec::new();
        };
        self.continuous_views.retain(|slot, image| {
            let keep = pages.iter().any(|(id, _, _)| id == slot);
            if !keep {
                image.view.removeFromSuperview();
            }
            keep
        });
        let mut presented = Vec::new();
        for (id, [x, y, width, height], preview) in pages {
            let mut frame = pane.content.bounds();
            frame.origin.x = x;
            frame.origin.y = y;
            frame.size.width = width;
            frame.size.height = height;
            if let Some(view) = self.continuous_views.get_mut(&id) {
                view.view.setFrame(frame);
                view.show(preview, mtm);
                continue;
            }
            let image = UIImageView::initWithFrame(mtm.alloc(), frame);
            image.setContentMode(UIViewContentMode::ScaleAspectFit);
            let mut view = PageView {
                view: image,
                frame_identity: 0,
                detail: None,
            };
            view.show(preview, mtm);
            pane.content.addSubview(&view.view);
            self.continuous_views.insert(id, view);
            presented.push(id);
        }
        presented
    }

    fn incoming_slot(&self) -> Option<&Slot> {
        let revision = self.pane.as_ref()?.incoming_revision.get()?;
        self.slots.values().find(|slot| slot.revision == revision)
    }

    fn animation_deadline(&self, now: Instant) -> Option<Instant> {
        let visible = self
            .active
            .into_iter()
            .chain(self.continuous_views.keys().copied());
        visible
            .filter_map(|slot| self.slots.get(&slot))
            .chain(self.incoming_slot())
            .flat_map(|entry| {
                let elapsed = entry.elapsed(now);
                entry
                    .previews
                    .iter()
                    .flatten()
                    .filter_map(move |page| match page {
                        Page::Animated(animation) => animation.frame(elapsed).2,
                        Page::Static(_) => None,
                    })
            })
            .min()
            .map(|delay| now + delay.max(Duration::from_millis(1)))
    }

    fn paint_animation(&mut self, mtm: MainThreadMarker) {
        let now = Instant::now();
        if let Some(pane) = &self.pane {
            for (slot, views) in [
                (self.active.and_then(|slot| self.slots.get(&slot)), &pane.page_views),
                (self.incoming_slot(), &pane.incoming_views),
            ] {
                let Some(entry) = slot else { continue; };
                let elapsed = entry.elapsed(now);
                for (page, view) in entry.previews.iter().flatten().zip(views.borrow_mut().iter_mut()) {
                    if let Page::Animated(animation) = page {
                        view.show(animation.frame(elapsed).1, mtm);
                    }
                }
            }
        }
        for (slot, view) in &mut self.continuous_views {
            let Some(entry) = self.slots.get(slot) else {
                continue;
            };
            if let Some(Page::Animated(animation)) =
                entry.previews.as_ref().and_then(|pages| pages.first())
            {
                view.show(animation.frame(entry.elapsed(now)).1, mtm);
            }
        }
    }

    fn unpresent(&mut self, slot: i32) {
        // Retiring a previous rendition must not reset the active same-page slide.
        if self.active == Some(slot) {
            if let Some(entry) = self.slots.get(&slot) {
                if let Some(transform) = self.transforms.get_mut(&(entry.session, entry.page)) {
                    transform.edge_offset = 0.0;
                    transform.neighbour_page = None;
                }
            }
        }
        if self.requested == Some(slot) {
            self.requested = None;
        }
        if self.active == Some(slot) {
            self.active = None;
            self.pane = None;
            if let Some(entry) = self.slots.get_mut(&slot) {
                entry.detail.clear();
            }
        }
    }
}

pub(super) async fn prepare(
    window: WebviewWindow,
    slot: i32,
    page: i32,
    session: u32,
    left: ReaderFile,
    right: Option<ReaderFile>,
    committed: bool,
) -> Result<bool, String> {
    let revision = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
    let files: Vec<_> = std::iter::once(left).chain(right).collect();
    let retained_files = files.clone();
    if !on_view(&window, move |label, _, _| {
        READERS.with_borrow_mut(|readers| {
            let reader = readers.entry(label.to_owned()).or_default();
            if reader.slots.len() >= MAX_SLOTS || reader.slots.contains_key(&slot) {
                return false;
            }
            reader.slots.insert(
                slot,
                Slot {
                    revision,
                    page,
                    session,
                    previews: None,
                    animation_start: Cell::new(None),
                    committed,
                    files: retained_files,
                    detail: Vec::new(),
                },
            );
            true
        })
    })
    .await?
    {
        return Ok(false);
    }
    let previews = tokio::task::spawn_blocking(move || {
        files
            .into_iter()
            .map(|file| {
                let file = file.lock().ok()?;
                match Animation::decode(&file).ok()? {
                    Some(animation) => animation
                        .try_map(image_io::from_animation_frame)
                        .map(Page::Animated),
                    None => image_io::decode(&file).map(Page::Static),
                }
            })
            .collect::<Option<Vec<_>>>()
    })
    .await
    .ok()
    .flatten();
    let notify = window.clone();
    on_view(&window, move |label, web, mtm| {
        let (sizes, presented) = READERS.with_borrow_mut(|readers| {
            let Some(reader) = readers.get_mut(label) else { return (None, false); };
            let Some(entry) = reader.slots.get_mut(&slot) else { return (None, false); };
            if entry.revision != revision { return (None, false); }
            let Some(previews) = previews else { reader.slots.remove(&slot); return (None, false); };
            let sizes = previews.iter().map(|page| page.first().dimensions()).collect::<Vec<_>>();
            entry.previews = Some(previews);
            let presented = reader.requested == Some(slot) && reader.present(web, mtm, slot);
            (Some(sizes), presented)
        });
        if let Some(sizes) = &sizes {
            let width: u32 = sizes.iter().map(|size| size[0]).sum();
            let height = sizes.iter().map(|size| size[1]).max().unwrap_or(0);
            let pages = sizes.iter().map(|size| serde_json::json!({
                "naturalWidth": size[0], "naturalHeight": size[1]
            })).collect::<Vec<_>>();
            let _ = notify.eval(format!("window.dispatchEvent(new CustomEvent('yomika-reader-tile-status',{{detail:{{slot:{slot},width:{width},height:{height},pages:{pages}}}}}))", pages = serde_json::json!(pages)));
        }
        if presented {
            notify_presented(&notify, slot);
            schedule_refinement(&notify, label);
        }
        paint_continuous(&notify, label, web, mtm);
        sizes.is_some()
    }).await
}

pub(super) async fn message(window: WebviewWindow, op: String, slot: i32) -> Result<(), String> {
    let notify = window.clone();
    on_view(&window, move |label, web, mtm| {
        let presented = READERS.with_borrow_mut(|readers| {
            if op == "present" {
                let reader = readers.entry(label.to_owned()).or_default();
                reader.requested = Some(slot);
                return reader.present(web, mtm, slot);
            }
            let Some(reader) = readers.get_mut(label) else {
                return false;
            };
            match op.as_str() {
                "arm" | "disarm" => {
                    if let Some(entry) = reader.slots.get_mut(&slot) {
                        entry.committed = op == "arm";
                    }
                }
                "continuous-hide" => reader.continuous.remove(slot),
                "unpresent" => reader.unpresent(slot),
                "drop" | "drop-after-web-frame" => {
                    reader.unpresent(slot);
                    reader.continuous.remove(slot);
                    if let Some(entry) = reader.slots.remove(&slot) {
                        let key = (entry.session, entry.page);
                        if !reader
                            .slots
                            .values()
                            .any(|slot| (slot.session, slot.page) == key)
                        {
                            reader.transforms.remove(&key);
                        }
                    }
                    if reader.slots.is_empty() && !reader.scroll_input.active && reader.pinch_config.is_none() {
                        readers.remove(label);
                    }
                }
                _ => {}
            }
            false
        });
        if presented {
            notify_presented(&notify, slot);
            schedule_refinement(&notify, label);
        }
        paint_continuous(&notify, label, web, mtm);
    })
    .await
}

struct ScrollTargetState {
    window: WebviewWindow,
    previous_y: Cell<f64>,
}

define_class!(
    // NSObject has no additional subclassing requirements. UIKit calls this on the main thread.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = ScrollTargetState]
    struct ScrollTarget;

    unsafe impl NSObjectProtocol for ScrollTarget {}

    unsafe impl UIGestureRecognizerDelegate for ScrollTarget {
        #[unsafe(method(gestureRecognizerShouldBegin:))]
        fn should_begin(&self, gesture: &UIGestureRecognizer) -> bool {
            gesture.downcast_ref::<UIPanGestureRecognizer>().is_some_and(|pan| {
                let velocity = pan.velocityInView(None);
                velocity.y.abs() > velocity.x.abs()
            }) && !COVERED.get() && READERS.with_borrow(|readers| {
                readers.get(self.ivars().window.label()).is_some_and(|reader| {
                    reader.scroll_input.active && reader.active.is_none() && reader.requested.is_none()
                })
            })
        }

        #[unsafe(method(gestureRecognizer:shouldBeRequiredToFailByGestureRecognizer:))]
        fn prioritise_native_scroll(&self, gesture: &UIGestureRecognizer, other: &UIGestureRecognizer) -> bool {
            // Give this recognizer first claim against WKWebView's scroll view
            // pan. WK's tap recognizers and ordinary DOM controls stay enabled.
            gesture.view().is_some_and(|web| {
                let scroll: Retained<UIView> = unsafe { msg_send![&*web, scrollView] };
                other.downcast_ref::<UIPanGestureRecognizer>().is_some()
                    && other.view().is_some_and(|view| std::ptr::eq(&*scroll, &*view))
            })
        }
    }

    impl ScrollTarget {
        #[unsafe(method(yomikaScroll:))]
        fn on_scroll(&self, pan: &UIPanGestureRecognizer) {
            let state = pan.state();
            let Some(web) = pan.view() else { return };
            let window = &self.ivars().window;
            let label = window.label();
            let translation = pan.translationInView(Some(&web)).y;
            if state == UIGestureRecognizerState::Began {
                self.ivars().previous_y.set(0.0);
            }
            let delta = self.ivars().previous_y.replace(translation) - translation;
            let (moved, fling) = READERS.with_borrow_mut(|readers| {
                let Some(reader) = readers.get_mut(label) else { return (false, None) };
                reader.scroll_fling = None;
                if !reader.scroll_input.active || COVERED.get() || state == UIGestureRecognizerState::Cancelled {
                    return (false, None);
                }
                let moved = reader.scroll_input.scroll_to(reader.scroll_input.offset + delta);
                let velocity = -pan.velocityInView(Some(&web)).y;
                let fling = if state == UIGestureRecognizerState::Ended && !reader.scroll_input.reduce_motion && velocity.abs() > 80.0 {
                    let token = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
                    reader.scroll_fling = Some(token);
                    Some((token, velocity.clamp(-6000.0, 6000.0)))
                } else { None };
                (moved, fling)
            });
            if moved { publish_scroll(window, label, &web, self.mtm()); }
            if let Some((token, velocity)) = fling { start_scroll_fling(window.clone(), token, velocity); }
        }
    }
);

struct ScrollPan {
    web: Retained<UIView>,
    recognizer: Retained<UIPanGestureRecognizer>,
    _target: Retained<ScrollTarget>,
}

impl ScrollPan {
    fn new(window: WebviewWindow, web: &UIView, mtm: MainThreadMarker) -> Self {
        let target = mtm.alloc::<ScrollTarget>().set_ivars(ScrollTargetState { window, previous_y: Cell::new(0.0) });
        // The NSObject target is fully initialised before being attached to the recognizer.
        let target: Retained<ScrollTarget> = unsafe { msg_send![super(target), init] };
        let recognizer = unsafe {
            UIPanGestureRecognizer::initWithTarget_action(mtm.alloc(), Some(target.as_ref()), Some(sel!(yomikaScroll:)))
        };
        recognizer.setDelegate(Some(ProtocolObject::from_ref(&*target)));
        recognizer.setMaximumNumberOfTouches(1);
        web.addGestureRecognizer(&recognizer);
        Self { web: web.retain(), recognizer, _target: target }
    }
}

impl Drop for ScrollPan {
    fn drop(&mut self) {
        self.recognizer.setDelegate(None);
        // Detaching the recognizer may synchronously cancel a gesture. Remove its action first.
        unsafe { self.recognizer.removeTarget_action(None, None) };
        self.web.removeGestureRecognizer(&self.recognizer);
    }
}

pub(super) async fn continuous_configure(
    window: WebviewWindow, session: u32, active: bool, limit: f64, offset: f64, reduce_motion: bool,
) -> Result<(), String> {
    let handle = window.clone();
    on_view(&window, move |label, web, mtm| {
        READERS.with_borrow_mut(|readers| {
            if !active && !readers.contains_key(label) { return; }
            let reader = readers.entry(label.to_owned()).or_default();
            if session < reader.scroll_input.stamp.session { return; }
            if !active || limit == 0.0 || session != reader.scroll_input.stamp.session {
                reader.scroll_fling = None;
                reader.scroll_pan = None;
            }
            reader.scroll_input.configure(session, active, limit, offset, reduce_motion);
            if active && limit > 0.0 && reader.scroll_pan.is_none() {
                reader.scroll_pan = Some(ScrollPan::new(handle.clone(), web, mtm));
            }
        });
        if active { publish_scroll(&handle, label, web, mtm); }
    }).await
}

pub(super) async fn continuous_reposition(
    window: WebviewWindow, session: u32, revision: u32, offset: f64, relative: bool,
) -> Result<(), String> {
    let handle = window.clone();
    on_view(&window, move |label, web, mtm| {
        let moved = READERS.with_borrow_mut(|readers| {
            let Some(reader) = readers.get_mut(label) else { return false };
            let moved = reader.scroll_input.reposition(session, revision, offset, relative);
            if moved && !relative { reader.scroll_fling = None; }
            moved && reader.scroll_input.active
        });
        if moved { publish_scroll(&handle, label, web, mtm); }
    }).await
}

fn publish_scroll(window: &WebviewWindow, label: &str, web: &UIView, mtm: MainThreadMarker) {
    let sample = READERS.with_borrow_mut(|readers| {
        let reader = readers.get_mut(label)?;
        let input = &reader.scroll_input;
        if !input.active { return None; }
        reader.continuous.scroll_top = input.offset;
        Some((input.stamp, input.offset))
    });
    let Some((stamp, offset)) = sample else { return };
    paint_continuous(window, label, web, mtm);
    let _ = window.eval(format!(
        "dispatchEvent(new CustomEvent('yomika-reader-continuous-scroll',{{detail:{{session:{},revision:{},sample:{},offset:{offset}}}}}));",
        stamp.session, stamp.revision, stamp.sample,
    ));
}

fn start_scroll_fling(window: WebviewWindow, token: u64, mut velocity: f64) {
    tauri::async_runtime::spawn(async move {
        let mut last = Instant::now();
        while velocity.abs() > 30.0 {
            tokio::time::sleep(Duration::from_millis(16)).await;
            let now = Instant::now();
            let dt = now.duration_since(last).as_secs_f64().min(0.05);
            last = now;
            let decay = (-5.0 * dt).exp();
            let delta = velocity * (1.0 - decay) / 5.0;
            velocity *= decay;
            let handle = window.clone();
            let moved = on_view(&window, move |label, web, mtm| {
                let moved = READERS.with_borrow_mut(|readers| {
                    let Some(reader) = readers.get_mut(label) else { return false };
                    reader.scroll_fling == Some(token) && reader.scroll_input.active && !COVERED.get()
                        && reader.scroll_input.scroll_to(reader.scroll_input.offset + delta)
                });
                if moved { publish_scroll(&handle, label, web, mtm); }
                moved
            }).await;
            if !matches!(moved, Ok(true)) { break; }
        }
    });
}

pub(super) async fn continuous_layout(
    window: WebviewWindow,
    placements: Option<Vec<ContinuousPlacement>>,
    scroll_top: f64,
    viewport_height: f64,
    scroll_input: Option<ContinuousInputStamp>,
) -> Result<(), String> {
    let notify = window.clone();
    on_view(&window, move |label, web, mtm| {
        READERS.with_borrow_mut(|readers| {
            if placements.as_ref().is_none_or(Vec::is_empty) && !readers.contains_key(label) {
                return;
            }
            let reader = readers.entry(label.to_owned()).or_default();
            let scroll_top = reader.scroll_input.accept_layout(scroll_input, scroll_top);
            reader.continuous.apply(placements, scroll_top, viewport_height);
        });
        paint_continuous(&notify, label, web, mtm);
    })
    .await
}

fn paint_continuous(window: &WebviewWindow, label: &str, web: &UIView, mtm: MainThreadMarker) {
    let presented = READERS.with_borrow_mut(|readers| {
        readers
            .get_mut(label)
            .map(|reader| reader.paint_continuous(web, mtm))
            .unwrap_or_default()
    });
    for slot in presented {
        notify_presented(window, slot);
    }
    schedule_animation(window, label);
}

fn schedule_animation(window: &WebviewWindow, label: &str) {
    let scheduled = READERS.with_borrow_mut(|readers| {
        let reader = readers.get_mut(label)?;
        if COVERED.get() {
            return None;
        }
        let Some(deadline) = reader.animation_deadline(Instant::now()) else {
            reader.animation_tick = None;
            reader.animation_window = None;
            return None;
        };
        if reader
            .animation_tick
            .is_some_and(|(pending, _)| pending <= deadline)
        {
            return None;
        }
        let revision = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
        reader.animation_tick = Some((deadline, revision));
        reader
            .animation_window
            .get_or_insert_with(|| window.clone());
        Some((deadline, revision))
    });
    let Some((deadline, revision)) = scheduled else {
        return;
    };
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep_until(deadline.into()).await;
        let notify = window.clone();
        let _ = on_view(&window, move |label, _, mtm| {
            let advanced = READERS.with_borrow_mut(|readers| {
                let Some(reader) = readers.get_mut(label) else {
                    return false;
                };
                if !reader
                    .animation_tick
                    .is_some_and(|(_, pending)| pending == revision)
                {
                    return false;
                }
                reader.animation_tick = None;
                if COVERED.get() {
                    return false;
                }
                reader.paint_animation(mtm);
                true
            });
            if advanced {
                schedule_animation(&notify, label);
            }
        })
        .await;
    });
}

pub(super) async fn transform(
    window: WebviewWindow,
    transform: ViewTransform,
    cancelled: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<(), String> {
    let notify = window.clone();
    on_view(&window, move |label, _, mtm| {
        if cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            return;
        }
        READERS.with_borrow_mut(|readers| {
            let Some(reader) = readers.get_mut(label) else {
                return;
            };
            let key = (transform.session, transform.page);
            if reader.pinching == Some(key)
                || (reader.pinch_settle.is_some() && cancelled.is_some()) {
                return;
            }
            if reader.active.is_some_and(|slot| reader.slots.get(&slot).is_some_and(|entry| transform.matches(entry.session, entry.page))) {
                reader.pinch_settle = None;
            }
            if !reader
                .slots
                .values()
                .any(|entry| (entry.session, entry.page) == key)
            {
                return;
            }
            // The prepared page may still be decoding while WebView emits its first zoom.
            reader.transforms.insert(key, transform);
            let active = reader.active.and_then(|slot| reader.slots.get(&slot));
            if !active.is_some_and(|entry| transform.matches(entry.session, entry.page)) {
                return;
            }
            if let Some(pane) = &reader.pane {
                reader.paint_transform(pane, Some(transform), mtm);
            }
        });
        schedule_refinement(&notify, label);
        schedule_animation(&notify, label);
    })
    .await
}

// Keep the preview on screen while the current crop is prepared. Each active
// page keeps at most one raw backing file and one padded tile.
fn schedule_refinement(window: &WebviewWindow, label: &str) {
    let request = READERS.with_borrow_mut(|readers| {
        let reader = readers.get_mut(label)?;
        if COVERED.get() || reader.refinement_worker.is_some() {
            return None;
        }
        let slot = reader.active?;
        let entry = reader.slots.get_mut(&slot)?;
        let transform = reader
            .transforms
            .get(&(entry.session, entry.page))
            .copied()?;
        if transform.scale < 1.4 || transform.edge_offset != 0.0 {
            return None;
        }
        let previews = entry.previews.as_ref()?;
        let pane = reader.pane.as_ref()?;
        let viewport = pane.canvas.bounds().size;
        let views = pane.page_views.borrow();
        entry
            .detail
            .resize_with(previews.len(), DetailState::default);
        let requests = previews
            .iter()
            .zip(views.iter())
            .enumerate()
            .filter_map(|(index, (page, view))| {
                let Page::Static(preview) = page else {
                    return None;
                };
                let size = preview.dimensions();
                if size.into_iter().max()? <= 2048 || entry.detail[index].fallback {
                    return None;
                }
                let frame = view.view.frame();
                let region = |padding| {
                    let (x, width) = source_span(
                        viewport.width,
                        frame.origin.x,
                        frame.size.width,
                        size[0],
                        transform.scale,
                        transform.pan_x,
                        padding,
                    )?;
                    let (y, height) = source_span(
                        viewport.height,
                        frame.origin.y,
                        frame.size.height,
                        size[1],
                        transform.scale,
                        transform.pan_y,
                        padding,
                    )?;
                    Some([x, y, width, height])
                };
                let visible = region(0.0)?;
                if entry.detail[index]
                    .delivered
                    .is_some_and(|last| contains_region(last, visible))
                {
                    return None;
                }
                let padded = region(72.0)?;
                if entry.detail[index].attempted == Some(padded) {
                    return None;
                }
                Some(DetailRequest {
                    index,
                    size,
                    region: padded,
                    file: entry.files[index].clone(),
                    backing: entry.detail[index].backing.clone(),
                })
            })
            .collect::<Vec<_>>();
        if requests.is_empty() {
            return None;
        }
        reader.refinement_worker = Some(entry.revision);
        Some((
            slot,
            entry.revision,
            requests,
            if previews.len() == 1 { 3072 } else { 2560 },
        ))
    });
    let Some((slot, revision, requests, max_edge)) = request else {
        return;
    };
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let refined = tokio::task::spawn_blocking(move || {
            requests
                .into_iter()
                .map(|request| {
                    let result = refine_page(&request, max_edge);
                    (request.index, result)
                })
                .collect::<Vec<_>>()
        })
        .await;
        let notify = window.clone();
        let _ = on_view(&window, move |label, _, mtm| {
            READERS.with_borrow_mut(|readers| {
                let Some(reader) = readers.get_mut(label) else {
                    return;
                };
                if reader.refinement_worker != Some(revision) {
                    return;
                }
                reader.refinement_worker = None;
                if reader.active != Some(slot) || COVERED.get() {
                    return;
                }
                let Some(entry) = reader.slots.get_mut(&slot) else {
                    return;
                };
                if entry.revision != revision {
                    return;
                }
                let Some(pane) = &reader.pane else {
                    return;
                };
                let mut views = pane.page_views.borrow_mut();
                let Ok(refined) = refined else {
                    // Prevent a failed worker from relaunching indefinitely.
                    entry
                        .detail
                        .iter_mut()
                        .for_each(|state| state.fallback = true);
                    return;
                };
                let transform = reader.transforms.get(&(entry.session, entry.page)).copied();
                let viewport = pane.canvas.bounds().size;
                for (index, result) in refined {
                    let (Some(state), Some(view)) =
                        (entry.detail.get_mut(index), views.get_mut(index))
                    else {
                        continue;
                    };
                    match result {
                        Refinement::Region(region, backing, tile) => {
                            state.backing = Some(backing);
                            state.attempted = Some(region);
                            if let Some(tile) = tile {
                                state.delivered = Some(region);
                                view.show_detail(region, &tile, mtm);
                                view.update_detail(transform, [viewport.width, viewport.height]);
                            }
                        }
                        Refinement::Whole(preview) => {
                            state.fallback = true;
                            if let Some(preview) = preview {
                                view.show(&preview, mtm);
                            }
                        }
                    }
                }
            });
            schedule_refinement(&notify, label);
        })
        .await;
    });
}

fn refine_page(request: &DetailRequest, max_edge: i32) -> Refinement {
    let backing = request.backing.clone().or_else(|| {
        let file = request.file.lock().ok()?;
        Some(Arc::new(Mutex::new(PngPixels::build(&file)?)))
    });
    if let Some(backing) = backing {
        let [_, _, width, height] = request.region;
        let tile = backing
            .lock()
            .ok()
            .and_then(|mut pixels| pixels.read(request.region))
            .and_then(|bgra| {
                image_io::from_animation_frame(super::animation::FramePixels {
                    size: [width, height],
                    source_size: request.size,
                    bgra,
                })
            });
        // The first crop can exceed the texture budget at low zoom. Keep the
        // backing for smaller crops and leave the original preview visible.
        return Refinement::Region(request.region, backing, tile);
    }
    Refinement::Whole(
        request
            .file
            .lock()
            .ok()
            .and_then(|file| image_io::decode_with_limit(&file, max_edge)),
    )
}

fn source_span(
    view: f64,
    start: f64,
    length: f64,
    pixels: u32,
    scale: f64,
    pan: f64,
    padding: f64,
) -> Option<(u32, u32)> {
    let middle = view / 2.0;
    let leading = middle + (start - middle + pan) * scale;
    let extent = length * scale;
    if view <= 0.0 || extent <= 0.0 || leading >= view || leading + extent <= 0.0 {
        return None;
    }
    let project = |point: f64| ((point - leading) / extent).clamp(0.0, 1.0) * f64::from(pixels);
    let start = project(-padding).floor() as u32;
    let end = project(view + padding).ceil() as u32;
    (end > start).then(|| (start, end - start))
}

fn contains_region([x, y, w, h]: Region, [left, top, width, height]: Region) -> bool {
    x <= left && y <= top && x + w >= left + width && y + h >= top + height
}

fn notify_presented(window: &WebviewWindow, slot: i32) {
    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('yomika-reader-tile-presented',{{detail:{{slot:{slot}}}}}))"));
}

async fn on_view<T: Send + 'static>(
    window: &WebviewWindow,
    run: impl FnOnce(&str, &UIView, MainThreadMarker) -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let label = window.label().to_owned();
    window
        .with_webview(move |web| {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let Some(view) = (unsafe { Retained::retain(web.inner().cast::<UIView>()) }) else {
                return;
            };
            let _ = tx.send(run(&label, &view, mtm));
        })
        .map_err(|error| error.to_string())?;
    rx.await.map_err(|error| error.to_string())
}
