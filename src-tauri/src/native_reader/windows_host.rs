//! Window-bound Windows reader slots. Decode on the blocking pool and upload
//! on the window thread. A dropped slot cannot be published by a late decode.
use super::{animation::Animation, d2d::Surface, png_pixels::PngPixels, wic, ContinuousLayout, ContinuousPlacement, ViewTransform};
use super::continuous_input::{ContinuousInput, ContinuousInputStamp};
use crate::compute::leases::ReaderFile;
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{HWND, RECT},
        Graphics::Direct2D::Common::D2D_RECT_F,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetClientRect, IsIconic, SetWindowPos, ShowWindow,
            HWND_BOTTOM, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNOACTIVATE, WS_CHILD,
        },
    },
};

const MAX_SLOTS: usize = 6;
static NEXT_TICKET: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static COVERED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    static READERS: RefCell<HashMap<String, Reader>> = RefCell::new(HashMap::new());
}

struct Slot {
    ticket: u64,
    page: i32,
    session: u32,
    pages: Option<Vec<Page>>,
    animation_start: Cell<Option<Instant>>,
    committed: bool,
    files: Vec<ReaderFile>,
    detail: Vec<Option<Detail>>,
    png_backings: Vec<PngBacking>,
}

enum Page {
    Static(wic::Tile),
    Animated(Animation<wic::Tile>),
}

impl Page {
    fn first(&self) -> &wic::Tile {
        match self {
            Self::Static(tile) => tile,
            Self::Animated(animation) => animation.first(),
        }
    }

    fn frame(&self, elapsed: Duration) -> &wic::Tile {
        match self {
            Self::Static(tile) => tile,
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

struct Reader {
    slots: HashMap<i32, Slot>,
    requested: Option<i32>,
    active: Option<i32>,
    surface: Option<Pane>,
    transforms: HashMap<(u32, i32), ViewTransform>,
    continuous: ContinuousLayout,
    scroll_input: ContinuousInput,
    continuous_ratio: f32,
    continuous_visible: Vec<i32>,
    detail_worker: Option<u64>,
    detail_epoch: u64,
    animation_tick: Option<(Instant, u64)>,
}

struct Pane {
    hwnd: HWND,
    surface: Surface,
    client: [u32; 2],
}

impl Pane {
    fn new(parent: HWND) -> windows::core::Result<Self> {
        let hwnd = unsafe {
            CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                PCWSTR::null(),
                WS_CHILD,
                0,
                0,
                0,
                0,
                Some(parent),
                None,
                None,
                None,
            )?
        };
        Ok(Self {
            hwnd,
            surface: Surface::new(hwnd),
            client: [0; 2],
        })
    }

    fn paint(
        &mut self,
        client: [u32; 2],
        pages: &[Page],
        elapsed: Duration,
        detail: &[Option<Detail>],
        transform: Option<ViewTransform>,
        incoming: Option<(&[Page], Duration, ViewTransform)>,
    ) -> windows::core::Result<()> {
        if client.contains(&0) {
            return Ok(());
        }
        let mut destinations: Vec<_> = pages
            .iter()
            .zip(page_destinations(client, pages, transform))
            .enumerate()
            .map(|(index, (page, dest))| {
                let preview = page.frame(elapsed);
                let visible = visible_region(client, dest, preview.source_size, 0.0);
                let detail = detail.get(index).and_then(Option::as_ref).filter(|detail| {
                    visible.is_some_and(|region| contains(detail.region, region))
                        && needs_detail(preview, dest)
                });
                match detail {
                    Some(detail) => (
                        &detail.tile,
                        region_destination(detail.region, preview.source_size, dest),
                    ),
                    None => (preview, dest),
                }
            })
            .collect();
        if let Some((pages, elapsed, transform)) = incoming {
            destinations.extend(
                pages
                    .iter()
                    .zip(page_destinations(client, pages, Some(transform)))
                    .map(|(page, dest)| (page.frame(elapsed), dest)),
            );
        }
        self.position(client)?;
        self.surface.draw(&destinations, client)
    }

    fn position(&mut self, client: [u32; 2]) -> windows::core::Result<()> {
        if self.client != client {
            unsafe {
                SetWindowPos(
                    self.hwnd,
                    Some(HWND_BOTTOM),
                    0,
                    0,
                    client[0] as i32,
                    client[1] as i32,
                    SWP_NOACTIVATE,
                )?;
            }
            self.client = client;
        }
        Ok(())
    }
}

type Region = [u32; 4]; // source x, y, width, height

// None in the outer option means the format has not been checked yet.
type PngBacking = Option<Option<Arc<Mutex<PngPixels>>>>;

struct Detail {
    region: Region,
    tile: wic::Tile,
}

fn client_size(parent: HWND) -> [u32; 2] {
    let mut rect = RECT::default();
    let _ = unsafe { GetClientRect(parent, &mut rect) };
    [
        (rect.right - rect.left).max(0) as u32,
        (rect.bottom - rect.top).max(0) as u32,
    ]
}

fn page_destinations(
    client: [u32; 2],
    pages: &[Page],
    transform: Option<ViewTransform>,
) -> Vec<D2D_RECT_F> {
    let [width, height] = client.map(|edge| edge as f32);
    let half = if pages.len() == 2 { width / 2.0 } else { width };
    let sx = width / 2.0;
    let sy = height / 2.0;
    let (scale, x, y, edge) = transform.map_or((1.0, 0.0, 0.0, 0.0), |t| {
        (
            t.scale as f32,
            (t.pan_x * t.pixel_ratio) as f32,
            (t.pan_y * t.pixel_ratio) as f32,
            t.edge_offset as f32 * width,
        )
    });
    let tx = |px| sx + (px - sx + x) * scale + edge;
    let ty = |py| sy + (py - sy + y) * scale;
    pages
        .iter()
        .map(Page::first)
        .enumerate()
        .map(|(index, tile)| {
            let [source_width, source_height] = tile.source_size.map(|edge| edge as f32);
            let fit = (half / source_width).min(height / source_height);
            let scaled_width = source_width * fit;
            let scaled_height = source_height * fit;
            let left = match (pages.len(), index) {
                (2, 0) => half - scaled_width,
                (2, _) => half,
                _ => (width - scaled_width) / 2.0,
            };
            let top = (height - scaled_height) / 2.0;
            D2D_RECT_F {
                left: tx(left),
                right: tx(if pages.len() == 2 && index == 0 { half } else { left + scaled_width }),
                top: ty(top),
                bottom: ty(top + scaled_height),
            }
        })
        .collect()
}

fn needs_detail(tile: &wic::Tile, dest: D2D_RECT_F) -> bool {
    tile.source_size != tile.size
        && (dest.right - dest.left > tile.size[0] as f32 * 1.15
            || dest.bottom - dest.top > tile.size[1] as f32 * 1.15)
}

fn visible_region(
    client: [u32; 2],
    dest: D2D_RECT_F,
    source: [u32; 2],
    padding: f32,
) -> Option<Region> {
    let intersect = |start: f32, end: f32, client: u32, source: u32| {
        if start >= end || start >= client as f32 || end <= 0.0 || client == 0 {
            return None;
        }
        let to_source =
            |pixel: f32| ((pixel - start) / (end - start)).clamp(0.0, 1.0) * source as f32;
        let first = to_source(-padding).floor() as u32;
        let last = to_source(client as f32 + padding).ceil() as u32;
        Some((first, last.saturating_sub(first)))
    };
    let (x, width) = intersect(dest.left, dest.right, client[0], source[0])?;
    let (y, height) = intersect(dest.top, dest.bottom, client[1], source[1])?;
    (width > 0 && height > 0).then_some([x, y, width, height])
}

fn contains([x, y, w, h]: Region, [left, top, width, height]: Region) -> bool {
    x <= left && y <= top && x + w >= left + width && y + h >= top + height
}

fn region_destination(
    [x, y, w, h]: Region,
    [width, height]: [u32; 2],
    dest: D2D_RECT_F,
) -> D2D_RECT_F {
    let px = |x| dest.left + x as f32 / width as f32 * (dest.right - dest.left);
    let py = |y| dest.top + y as f32 / height as f32 * (dest.bottom - dest.top);
    D2D_RECT_F {
        left: px(x),
        right: px(x + w),
        top: py(y),
        bottom: py(y + h),
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

impl Reader {
    fn new() -> Self {
        Self {
            slots: HashMap::new(),
            requested: None,
            active: None,
            surface: None,
            transforms: HashMap::new(),
            continuous: ContinuousLayout::default(),
            scroll_input: ContinuousInput::default(),
            continuous_ratio: 1.0,
            continuous_visible: Vec::new(),
            detail_worker: None,
            detail_epoch: 0,
            animation_tick: None,
        }
    }

    fn begin_slot(&mut self, slot: i32, page: i32, session: u32) -> Option<u64> {
        if self.slots.len() >= MAX_SLOTS || self.slots.contains_key(&slot) {
            return None;
        }
        let ticket = NEXT_TICKET.fetch_add(1, Ordering::Relaxed);
        self.slots.insert(
            slot,
            Slot {
                ticket,
                page,
                session,
                pages: None,
                animation_start: Cell::new(None),
                committed: false,
                files: Vec::new(),
                detail: Vec::new(),
                png_backings: Vec::new(),
            },
        );
        Some(ticket)
    }

    fn complete_slot(
        &mut self,
        slot: i32,
        ticket: u64,
        pages: Option<Vec<Page>>,
    ) -> Option<Vec<[u32; 2]>> {
        let pending = self.slots.get_mut(&slot)?;
        if pending.ticket != ticket {
            return None;
        }
        match pages {
            Some(pages) => {
                let dimensions = pages.iter().map(|page| page.first().source_size).collect();
                pending.pages = Some(pages);
                Some(dimensions)
            }
            None => {
                self.slots.remove(&slot);
                None
            }
        }
    }

    fn committed_page(slots: &HashMap<i32, Slot>, transform: ViewTransform) -> Option<&Slot> {
        slots.values()
            .filter(|slot| slot.committed && transform.matches(slot.session, slot.page) && slot.pages.is_some())
            .max_by_key(|slot| slot.ticket)
    }

    fn present(&mut self, parent: HWND, slot: i32) -> bool {
        let Some(entry) = self.slots.get(&slot) else {
            return false;
        };
        let Some(pages) = entry.pages.as_ref() else {
            return false;
        };
        if self.surface.is_none() {
            self.surface = Pane::new(parent).ok();
        }
        let Some(pane) = &mut self.surface else {
            return false;
        };
        if self.active != Some(slot) {
            self.continuous_visible.clear();
        }
        let transform = self.transforms.get(&(entry.session, entry.page)).copied();
        let now = Instant::now();
        let incoming = transform
            .and_then(ViewTransform::incoming)
            .and_then(|transform| {
                let neighbour = Self::committed_page(&self.slots, transform)?;
                Some((
                    neighbour.pages.as_deref()?,
                    neighbour.elapsed(now),
                    transform,
                ))
            });
        if pane
            .paint(
                client_size(parent),
                pages,
                entry.elapsed(now),
                &entry.detail,
                transform,
                incoming,
            )
            .is_err()
        {
            // Handle loss or failed upload. Leave the previous logical slot
            // selected and allow the next paint to re-create its resources.
            return false;
        }
        if self.active != Some(slot) {
            self.detail_epoch += 1;
            if let Some(old) = self.active.and_then(|id| self.slots.get_mut(&id)) {
                old.detail.clear();
                old.png_backings.clear();
            }
        }
        self.active = Some(slot);
        let _ = unsafe { ShowWindow(pane.hwnd, SW_SHOWNOACTIVATE) };
        true
    }

    fn paint_continuous(&mut self, parent: HWND) -> Vec<i32> {
        if self.requested.is_some() || self.active.is_some() {
            return Vec::new();
        }
        let client = client_size(parent);
        let ratio = self.continuous_ratio;
        let now = Instant::now();
        let pages = self
            .continuous
            .visible()
            .filter_map(|(slot, rect)| {
                let entry = self.slots.get(&slot)?;
                let tile = entry.pages.as_ref()?.first()?.frame(entry.elapsed(now));
                let [x, y, width, height] = rect.map(|value| value as f32 * ratio);
                Some((
                    slot,
                    tile,
                    D2D_RECT_F {
                        left: x,
                        top: y,
                        right: x + width,
                        bottom: y + height,
                    },
                ))
            })
            .collect::<Vec<_>>();
        if pages.is_empty() {
            if let Some(pane) = &self.surface {
                let _ = unsafe { ShowWindow(pane.hwnd, SW_HIDE) };
            }
            self.continuous_visible.clear();
            return Vec::new();
        }
        if self.surface.is_none() {
            self.surface = Pane::new(parent).ok();
        }
        let Some(pane) = &mut self.surface else {
            return Vec::new();
        };
        let ids = pages.iter().map(|(id, _, _)| *id).collect::<Vec<_>>();
        let frame = pages
            .iter()
            .map(|(_, tile, destination)| (*tile, *destination))
            .collect::<Vec<_>>();
        if client.contains(&0)
            || pane.position(client).is_err()
            || pane.surface.draw(&frame, client).is_err()
        {
            return Vec::new();
        }
        let _ = unsafe { ShowWindow(pane.hwnd, SW_SHOWNOACTIVATE) };
        let presented = ids
            .iter()
            .copied()
            .filter(|id| !self.continuous_visible.contains(id))
            .collect();
        self.continuous_visible = ids;
        presented
    }

    fn animation_deadline(&self, now: Instant) -> Option<Instant> {
        let slots = self.active.as_slice();
        let visible = if slots.is_empty() {
            &self.continuous_visible[..]
        } else {
            slots
        };
        visible
            .iter()
            .filter_map(|slot| self.slots.get(slot))
            .flat_map(|entry| {
                let elapsed = entry.elapsed(now);
                entry
                    .pages
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
            if let Some(entry) = self.slots.get_mut(&slot) {
                entry.detail.clear();
                entry.png_backings.clear();
            }
            self.detail_epoch += 1;
            if let Some(pane) = &self.surface {
                let _ = unsafe { ShowWindow(pane.hwnd, SW_HIDE) };
            }
        }
    }
}

pub(super) async fn prepare(
    window: WebviewWindow,
    slot: i32,
    page: i32,
    session: u32,
    file: ReaderFile,
    right: Option<ReaderFile>,
    committed: bool,
) -> Result<bool, String> {
    let files: Vec<_> = std::iter::once(file).chain(right).collect();
    let previews = files.clone();
    let ticket = on_window(&window, move |label, _| {
        READERS.with_borrow_mut(|readers| {
            let reader = readers.entry(label.into()).or_insert_with(Reader::new);
            let ticket = reader.begin_slot(slot, page, session)?;
            let entry = reader.slots.get_mut(&slot)?;
            entry.files = files;
            entry.committed = committed;
            Some(ticket)
        })
    })
    .await?;
    let Some(ticket) = ticket else {
        return Ok(false);
    };
    let tile = tokio::task::spawn_blocking(move || {
        previews
            .into_iter()
            .map(|file| {
                let file = file.lock().ok()?;
                match Animation::decode(&file).ok()? {
                    Some(animation) => Some(Page::Animated(animation)),
                    None => wic::decode_tile(&file, None, [2048, 2048])
                        .ok()
                        .map(Page::Static),
                }
            })
            .collect::<Option<Vec<_>>>()
    })
    .await
    .ok()
    .flatten();
    let notify = window.clone();
    on_window(&window, move |label, parent| {
        let (dimensions, presented) = READERS.with_borrow_mut(|readers| {
            let Some(reader) = readers.get_mut(label) else { return (None, false); };
            let dimensions = reader.complete_slot(slot, ticket, tile);
            let presented = dimensions.is_some() && reader.requested == Some(slot)
                && !is_covered(label) && reader.present(parent, slot);
            (dimensions, presented)
        });
        if let Some(pages) = &dimensions {
            let width: u32 = pages.iter().map(|size| size[0]).sum();
            let height = pages.iter().map(|size| size[1]).max().unwrap_or(0);
            let pages = pages.iter().map(|size| serde_json::json!({
                "naturalWidth": size[0], "naturalHeight": size[1]
            })).collect::<Vec<_>>();
            let _ = notify.eval(format!("window.dispatchEvent(new CustomEvent('yomika-reader-tile-status',{{detail:{{slot:{slot},width:{width},height:{height},pages:{pages}}}}}))", pages = serde_json::json!(pages)));
        }
        if presented { notify_presented(&notify, slot); }
        paint_continuous(&notify, label, parent);
        start_detail_worker(&notify, parent);
        dimensions.is_some()
    }).await
}

pub(super) async fn message(window: WebviewWindow, op: String, slot: i32) -> Result<(), String> {
    let notify = window.clone();
    on_window(&window, move |label, parent| {
        let presented = READERS.with_borrow_mut(|readers| {
            if op == "present" {
                let reader = readers.entry(label.to_owned()).or_insert_with(Reader::new);
                reader.requested = Some(slot);
                return !is_covered(label) && reader.present(parent, slot);
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
                    if reader.slots.is_empty() && !reader.scroll_input.active {
                        readers.remove(label);
                    }
                }
                _ => {}
            }
            false
        });
        if presented {
            notify_presented(&notify, slot);
        }
        paint_continuous(&notify, label, parent);
        start_detail_worker(&notify, parent);
    })
    .await
}

pub(super) async fn continuous_layout(
    window: WebviewWindow,
    placements: Option<Vec<ContinuousPlacement>>,
    pixel_ratio: f32,
    scroll_top: f64,
    viewport_height: f64,
    scroll_input: Option<ContinuousInputStamp>,
) -> Result<(), String> {
    let notify = window.clone();
    on_window(&window, move |label, parent| {
        READERS.with_borrow_mut(|readers| {
            if placements.as_ref().is_none_or(Vec::is_empty) && !readers.contains_key(label) {
                return;
            }
            let reader = readers.entry(label.to_owned()).or_insert_with(Reader::new);
            let scroll_top = reader.scroll_input.accept_layout(scroll_input, scroll_top);
            reader.continuous.apply(placements, scroll_top, viewport_height);
            reader.continuous_ratio = pixel_ratio;
        });
        paint_continuous(&notify, label, parent);
    })
    .await
}

pub(super) async fn continuous_configure(
    window: WebviewWindow, session: u32, active: bool, limit: f64, offset: f64, reduce_motion: bool,
) -> Result<(), String> {
    let handle = window.clone();
    on_window(&window, move |label, parent| {
        READERS.with_borrow_mut(|readers| {
            if !active && !readers.contains_key(label) { return; }
            let reader = readers.entry(label.to_owned()).or_insert_with(Reader::new);
            reader.scroll_input.configure(session, active, limit, offset, reduce_motion);
        });
        if active { publish_scroll(&handle, label, parent); }
    }).await
}

pub(super) async fn continuous_reposition(
    window: WebviewWindow, session: u32, revision: u32, offset: f64, relative: bool,
) -> Result<(), String> {
    let handle = window.clone();
    on_window(&window, move |label, parent| {
        let moved = READERS.with_borrow_mut(|readers| {
            let Some(reader) = readers.get_mut(label) else { return false };
            reader.scroll_input.reposition(session, revision, offset, relative) && reader.scroll_input.active
        });
        if moved { publish_scroll(&handle, label, parent); }
    }).await
}

pub(super) async fn continuous_wheel(
    window: WebviewWindow, session: u32, revision: u32, delta: f64,
) -> Result<(), String> {
    let handle = window.clone();
    on_window(&window, move |label, parent| {
        if is_covered(label) { return; }
        let moved = READERS.with_borrow_mut(|readers| {
            let Some(reader) = readers.get_mut(label) else { return false };
            let input = &mut reader.scroll_input;
            input.active && input.stamp.session == session && input.stamp.revision == revision
                && input.scroll_to(input.offset + delta)
        });
        if moved { publish_scroll(&handle, label, parent); }
    }).await
}

fn publish_scroll(window: &WebviewWindow, label: &str, parent: HWND) {
    let sample = READERS.with_borrow_mut(|readers| {
        let reader = readers.get_mut(label)?;
        let input = &reader.scroll_input;
        if !input.active { return None; }
        reader.continuous.scroll_top = input.offset;
        Some((input.stamp, input.offset))
    });
    let Some((stamp, offset)) = sample else { return };
    paint_continuous(window, label, parent);
    let _ = window.eval(format!(
        "dispatchEvent(new CustomEvent('yomika-reader-continuous-scroll',{{detail:{{session:{},revision:{},sample:{},offset:{offset}}}}}));",
        stamp.session, stamp.revision, stamp.sample,
    ));
}

fn paint_continuous(window: &WebviewWindow, label: &str, parent: HWND) {
    if is_covered(label) {
        return;
    }
    let presented = READERS.with_borrow_mut(|readers| {
        readers
            .get_mut(label)
            .map(|reader| reader.paint_continuous(parent))
            .unwrap_or_default()
    });
    for slot in presented {
        notify_presented(window, slot);
    }
    schedule_animation(window, parent);
}

fn schedule_animation(window: &WebviewWindow, parent: HWND) {
    let label = window.label();
    let hidden = is_covered(label) || unsafe { IsIconic(parent).as_bool() };
    let scheduled = READERS.with_borrow_mut(|readers| {
        let reader = readers.get_mut(label)?;
        let deadline = if hidden {
            None
        } else {
            reader.animation_deadline(Instant::now())
        };
        let Some(deadline) = deadline else {
            reader.animation_tick = None;
            return None;
        };
        if reader
            .animation_tick
            .is_some_and(|(pending, _)| pending <= deadline)
        {
            return None;
        }
        let ticket = NEXT_TICKET.fetch_add(1, Ordering::Relaxed);
        reader.animation_tick = Some((deadline, ticket));
        Some((deadline, ticket))
    });
    let Some((deadline, ticket)) = scheduled else {
        return;
    };
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep_until(deadline.into()).await;
        let notify = window.clone();
        let _ = on_window(&window, move |label, parent| {
            let covered = is_covered(label) || unsafe { IsIconic(parent).as_bool() };
            let repaint = READERS.with_borrow_mut(|readers| {
                let Some(reader) = readers.get_mut(label) else {
                    return false;
                };
                if !reader
                    .animation_tick
                    .is_some_and(|(_, pending)| pending == ticket)
                {
                    return false;
                }
                reader.animation_tick = None;
                if covered {
                    return false;
                }
                if let Some(slot) = reader.active {
                    reader.present(parent, slot);
                }
                true
            });
            if repaint {
                paint_continuous(&notify, label, parent);
            }
        })
        .await;
    });
}

pub(super) async fn wheel_zoom(
    window: WebviewWindow,
    session: u32,
    page: i32,
    pixel_ratio: f64,
    maximum: f64,
    samples: Vec<[f64; 4]>,
) -> Result<Option<[f64; 3]>, String> {
    let notify = window.clone();
    on_window(&window, move |label, parent| {
        if is_covered(label) { return None; }
        let changed = READERS.with_borrow_mut(|readers| {
            let reader = readers.get_mut(label)?;
            let key = (session, page);
            let active = reader.active.filter(|slot| reader.slots.get(slot)
                .is_some_and(|entry| (entry.session, entry.page) == key));
            // The first wheel sample can arrive between a prepared page's
            // logical commit and its presentation on the window thread.
            if active.is_none() && !reader.slots.values().any(|entry| {
                (entry.session, entry.page) == key && entry.committed && entry.pages.is_some()
            }) {
                return None;
            }
            let start = reader.transforms.get(&key).copied().unwrap_or(ViewTransform {
                session, page, pixel_ratio, scale: 1.0, pan_x: 0.0, pan_y: 0.0,
                edge_offset: 0.0, neighbour_page: None,
            });
            let transform = apply_wheel_zoom(start, maximum, &samples);
            if !transform.valid() { return None; }
            // Late frames from a wheel rebound or the previous page slide
            // must not overwrite this first sample on the window thread.
            if let Ok(mut slides) = super::SLIDES.lock() {
                if let Some(old) = slides.remove(label) { old.store(true, Ordering::Release); }
            }
            reader.transforms.insert(key, transform);
            if let Some(slot) = active {
                reader.detail_epoch += 1;
                reader.present(parent, slot);
            }
            Some([transform.scale, transform.pan_x, transform.pan_y])
        });
        if changed.is_some() { start_detail_worker(&notify, parent); }
        changed
    }).await
}

fn apply_wheel_zoom(mut transform: ViewTransform, maximum: f64, samples: &[[f64; 4]]) -> ViewTransform {
    let elastic_limit = 4.0_f64.max(maximum * 1.12);
    for &[x, y, delta, snap_to_fit] in samples {
        // Match the compatibility viewer's snap and min/max resistance.
        let previous = transform.scale;
        let resistance = if previous <= 1.0 && delta > 0.0 { 0.22 } else { 1.0 };
        let scaled = previous * (-delta * 0.0015 * resistance).exp();
        let snap = snap_to_fit == 1.0 && ((previous < 1.0 && delta < 0.0)
            || (previous > 1.0 && delta > 0.0 && (scaled - 1.0).abs() <= 0.05));
        transform.scale = if snap { 1.0 } else { scaled.clamp(0.88, elastic_limit) };
        if transform.scale <= 1.0 {
            transform.pan_x = 0.0;
            transform.pan_y = 0.0;
        } else {
            transform.pan_x += x / transform.scale - x / previous;
            transform.pan_y += y / transform.scale - y / previous;
        }
    }
    transform.edge_offset = 0.0;
    transform.neighbour_page = None;
    transform
}

pub(super) async fn transform(
    window: WebviewWindow,
    transform: ViewTransform,
    cancelled: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<(), String> {
    let notify = window.clone();
    on_window(&window, move |label, parent| {
        if cancelled.as_ref().is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return;
        }
        READERS.with_borrow_mut(|readers| {
            let Some(reader) = readers.get_mut(label) else {
                return;
            };
            let key = (transform.session, transform.page);
            if !reader
                .slots
                .values()
                .any(|entry| (entry.session, entry.page) == key)
            {
                return;
            }
            // The prepared page may still be decoding while WebView emits its first zoom.
            reader.transforms.insert(key, transform);
            if let Some(slot) = reader.active {
                if !reader
                    .slots
                    .get(&slot)
                    .is_some_and(|entry| transform.matches(entry.session, entry.page))
                {
                    return;
                }
                reader.detail_epoch += 1;
                if !is_covered(label) {
                    reader.present(parent, slot);
                }
            }
        });
        start_detail_worker(&notify, parent);
    })
    .await
}

struct DetailRequest {
    index: usize,
    file: ReaderFile,
    region: Region,
    source_size: [u32; 2],
    png_backing: PngBacking,
}

fn decode_detail(request: DetailRequest) -> (usize, PngBacking, Option<Detail>) {
    let png_backing = request.png_backing.unwrap_or_else(|| {
        let file = request.file.lock().ok()?;
        if super::static_reader_file_info(&file)?.0 != "image/png" {
            return None;
        }
        Some(Arc::new(Mutex::new(PngPixels::build(&file)?)))
    });
    let [_, _, width, height] = request.region;
    let tile = png_backing.as_ref().and_then(|backing| {
        if width > 2560 || height > 2560 {
            return None;
        }
        let bgra = backing.lock().ok()?.read(request.region)?;
        Some(wic::Tile {
            texture_id: super::animation::next_texture_id(),
            size: [width, height],
            source_size: request.source_size,
            bgra,
        })
    }).or_else(|| {
        let file = request.file.lock().ok()?;
        wic::decode_tile(&file, Some(request.region), [2560, 2560]).ok()
    });
    (request.index, Some(png_backing), tile.map(|tile| Detail { region: request.region, tile }))
}

fn detail_requests(reader: &Reader, client: [u32; 2]) -> Option<(i32, u64, Vec<DetailRequest>)> {
    let slot = reader.active?;
    let entry = reader.slots.get(&slot)?;
    let pages = entry.pages.as_ref()?;
    let transform = *reader.transforms.get(&(entry.session, entry.page))?;
    if transform.scale <= 1.0 || transform.edge_offset != 0.0 {
        return None;
    }
    let requests: Vec<_> = pages
        .iter()
        .zip(page_destinations(client, pages, Some(transform)))
        .zip(&entry.files)
        .enumerate()
        .filter_map(|(index, ((page, dest), file))| {
            let Page::Static(tile) = page else {
                return None;
            };
            if !needs_detail(tile, dest) {
                return None;
            }
            let region = visible_region(client, dest, tile.source_size, 128.0)?;
            let visible = visible_region(client, dest, tile.source_size, 0.0)?;
            if entry
                .detail
                .get(index)
                .and_then(Option::as_ref)
                .is_some_and(|detail| contains(detail.region, visible))
            {
                return None;
            }
            Some(DetailRequest {
                index,
                file: file.clone(),
                region,
                source_size: tile.source_size,
                png_backing: entry.png_backings.get(index).cloned().flatten(),
            })
        })
        .collect();
    (!requests.is_empty()).then_some((slot, entry.ticket, requests))
}

fn start_detail_worker(window: &WebviewWindow, parent: HWND) {
    let label = window.label();
    if is_covered(label) {
        return;
    }
    let start = READERS.with_borrow_mut(|readers| {
        let reader = readers.get_mut(label)?;
        if reader.detail_worker.is_some() || detail_requests(reader, client_size(parent)).is_none()
        {
            return None;
        }
        let worker = NEXT_TICKET.fetch_add(1, Ordering::Relaxed);
        reader.detail_worker = Some(worker);
        Some((worker, reader.detail_epoch))
    });
    if let Some((worker, epoch)) = start {
        tauri::async_runtime::spawn(run_detail_worker(window.clone(), worker, epoch));
    }
}

async fn run_detail_worker(window: WebviewWindow, worker: u64, mut epoch: u64) {
    loop {
        tokio::time::sleep(Duration::from_millis(90)).await;
        let plan = on_window(&window, move |label, parent| {
            READERS.with_borrow_mut(|readers| {
                let reader = readers
                    .get_mut(label)
                    .filter(|reader| reader.detail_worker == Some(worker))?;
                if reader.detail_epoch != epoch {
                    return Some(Err(reader.detail_epoch));
                }
                let requests = (!is_covered(label))
                    .then(|| detail_requests(reader, client_size(parent)))
                    .flatten();
                if requests.is_none() {
                    reader.detail_worker = None;
                }
                requests.map(Ok)
            })
        })
        .await;
        let (slot, ticket, requests) = match plan {
            Ok(Some(Ok(plan))) => plan,
            Ok(Some(Err(next))) => {
                epoch = next;
                continue;
            }
            _ => return,
        };
        let details = tokio::task::spawn_blocking(move || {
            requests
                .into_iter()
                .map(decode_detail)
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let next = on_window(&window, move |label, parent| {
            READERS.with_borrow_mut(|readers| {
                let reader = readers
                    .get_mut(label)
                    .filter(|reader| reader.detail_worker == Some(worker))?;
                let valid = !is_covered(label) && reader.active == Some(slot);
                let mut redraw = false;
                if let Some(entry) = valid.then(|| reader.slots.get_mut(&slot)).flatten().filter(|entry| entry.ticket == ticket) {
                    entry.png_backings.resize_with(entry.files.len(), || None);
                    entry.detail.resize_with(entry.files.len(), || None);
                    for (index, backing, detail) in details {
                        entry.png_backings[index] = backing;
                        if let Some(detail) = detail {
                            // Painting checks coverage against the current viewport.
                            // Keep this crop if the user moved within its padding.
                            entry.detail[index] = Some(detail);
                            redraw = true;
                        }
                    }
                }
                if redraw {
                    reader.present(parent, slot);
                }
                if reader.detail_epoch != epoch {
                    return Some(reader.detail_epoch);
                }
                reader.detail_worker = None;
                None
            })
        })
        .await;
        match next {
            Ok(Some(next)) => epoch = next,
            _ => return,
        }
    }
}

fn notify_presented(window: &WebviewWindow, slot: i32) {
    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('yomika-reader-tile-presented',{{detail:{{slot:{slot}}}}}))"));
}

fn is_covered(label: &str) -> bool {
    COVERED.with_borrow(|windows| windows.contains(label))
}

// Runs inside the WebView controller's main-thread callback. Keep the sibling
// window hidden for the same interval as the protected WebView.
pub(crate) fn cover_window(window: &WebviewWindow, parent: HWND, covered: bool) {
    let label = window.label();
    COVERED.with_borrow_mut(|windows| {
        if covered {
            windows.insert(label.to_owned());
        } else {
            windows.remove(label);
        }
    });
    let presented = READERS.with_borrow_mut(|readers| {
        let reader = readers.get_mut(label)?;
        reader.detail_epoch += 1;
        if covered {
            reader.animation_tick = None;
            if let Some(pane) = &reader.surface {
                let _ = unsafe { ShowWindow(pane.hwnd, SW_HIDE) };
            }
            return None;
        }
        if let Some(slot) = reader.requested {
            if reader.present(parent, slot) {
                return Some(slot);
            }
        }
        if let Some(slot) = reader.active {
            reader.present(parent, slot);
        }
        None
    });
    if let Some(slot) = presented {
        notify_presented(window, slot);
    }
    if !covered {
        paint_continuous(window, label, parent);
        start_detail_worker(window, parent);
    }
}

pub(crate) fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) {
        READERS.with_borrow_mut(|readers| readers.remove(window.label()));
        COVERED.with_borrow_mut(|windows| windows.remove(window.label()));
    } else if matches!(event, tauri::WindowEvent::Resized(_)) && !is_covered(window.label()) {
        let Ok(parent) = window.hwnd() else {
            return;
        };
        READERS.with_borrow_mut(|readers| {
            if let Some(reader) = readers.get_mut(window.label()) {
                if let Some(slot) = reader.active {
                    reader.detail_epoch += 1;
                    reader.present(HWND(parent.0), slot);
                }
            }
        });
        if let Some(webview) = window.get_webview_window(window.label()) {
            paint_continuous(&webview, window.label(), HWND(parent.0));
            start_detail_worker(&webview, HWND(parent.0));
        }
    }
}

async fn on_window<T: Send + 'static>(
    window: &WebviewWindow,
    action: impl FnOnce(&str, HWND) -> T + Send + 'static,
) -> Result<T, String> {
    let owner = window.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(
                owner
                    .hwnd()
                    .map(|parent| action(owner.label(), HWND(parent.0))),
            );
        })
        .map_err(|error| error.to_string())?;
    rx.await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spread_shares_its_spine_at_fractional_offsets_and_scales() {
        let page = |source_size| Page::Static(wic::Tile {
            texture_id: 0, size: [1, 1], source_size, bgra: vec![0; 4],
        });
        let pages = [page([3943, 5807]), page([3701, 5689])];
        let zoom = ViewTransform {
            session: 1, page: 2, scale: 1.73, pan_x: 31.3, pan_y: 0.0,
            pixel_ratio: 1.25, edge_offset: -0.19, neighbour_page: None,
        };
        let rects = page_destinations([1223, 813], &pages, Some(zoom));
        assert_eq!(rects[0].right, rects[1].left);
    }

    #[test]
    fn wheel_batch_keeps_its_focus_and_clears_the_previous_slide() {
        let start = ViewTransform {
            session: 1, page: 2, scale: 1.0, pan_x: 0.0, pan_y: 0.0,
            pixel_ratio: 2.0, edge_offset: 0.25, neighbour_page: Some(1),
        };
        let next = apply_wheel_zoom(start, 3.0, &[[120.0, -60.0, -120.0, 1.0]; 2]);
        assert!((next.scale - 0.36_f64.exp()).abs() < 1e-9);
        assert!((next.pan_x - (120.0 / next.scale - 120.0)).abs() < 1e-9);
        assert!((next.pan_y - (-60.0 / next.scale + 60.0)).abs() < 1e-9);
        assert_eq!((next.edge_offset, next.neighbour_page), (0.0, None));
        let below_fit = apply_wheel_zoom(start, 3.0, &[[120.0, -60.0, 400.0, 1.0]]);
        assert!(below_fit.scale < 1.0);
        let restored = apply_wheel_zoom(below_fit, 3.0, &[[120.0, -60.0, -1.0, 1.0]]);
        assert_eq!((restored.scale, restored.pan_x, restored.pan_y), (1.0, 0.0, 0.0));
        let near_fit = ViewTransform { scale: 1.03, ..start };
        assert!(apply_wheel_zoom(near_fit, 3.0, &[[120.0, -60.0, 1.0, 0.0]]).scale > 1.0);
        let high_zoom = ViewTransform { scale: 5.0, ..start };
        let enlarged = apply_wheel_zoom(high_zoom, 6.0, &[[120.0, -60.0, -120.0, 1.0]]);
        assert!(enlarged.scale > high_zoom.scale);
        assert!((enlarged.pan_x - (120.0 / enlarged.scale - 120.0 / high_zoom.scale)).abs() < 1e-9);
    }

    #[test]
    fn the_next_png_crop_can_read_the_same_backing_without_the_encoded_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("page.png");
        let encoded = image::RgbaImage::from_fn(4, 3, |x, y| image::Rgba([x as u8, y as u8, 1, 255]));
        encoded.save(&path).unwrap();
        let file = Arc::new(Mutex::new(std::fs::File::open(path).unwrap()));
        let (_, backing, first) = decode_detail(DetailRequest {
            index: 0,
            file,
            region: [0, 0, 1, 1],
            source_size: [4, 3],
            png_backing: None,
        });
        assert_eq!(first.unwrap().tile.bgra, [1, 0, 0, 255]);
        let (_, next_backing, second) = decode_detail(DetailRequest {
            index: 0,
            file: Arc::new(Mutex::new(tempfile::tempfile().unwrap())),
            region: [2, 1, 1, 1],
            source_size: [4, 3],
            png_backing: backing.clone(),
        });
        assert!(Arc::ptr_eq(&backing.unwrap().unwrap(), &next_backing.unwrap().unwrap()));
        assert_eq!(second.unwrap().tile.bgra, [1, 1, 2, 255]);
    }

    #[test]
    fn padded_detail_contains_viewport_and_maps_back_to_the_page() {
        let dest = D2D_RECT_F {
            left: -200.0,
            top: -100.0,
            right: 1800.0,
            bottom: 900.0,
        };
        let client = [800, 600];
        let source = [4000, 2000];
        let visible = visible_region(client, dest, source, 0.0).unwrap();
        let padded = visible_region(client, dest, source, 128.0).unwrap();
        assert_eq!(visible, [400, 200, 1600, 1200]);
        assert!(contains(padded, visible));
        assert!(!contains(visible, padded));
        let mapped = region_destination(visible, source, dest);
        for (actual, expected) in [mapped.left, mapped.top, mapped.right, mapped.bottom]
            .into_iter()
            .zip([0.0, 0.0, 800.0, 600.0])
        {
            assert!((actual - expected).abs() < 0.01);
        }
        assert!(visible_region(client, dest, source, 0.0).is_some());
        assert!(visible_region([0, 600], dest, source, 0.0).is_none());
    }

    #[test]
    fn slide_uses_committed_revision_in_the_same_session() {
        let mut reader = Reader::new();
        let original = reader.begin_slot(1, 2, 1).unwrap();
        let candidate = reader.begin_slot(2, 2, 1).unwrap();
        let other_session = reader.begin_slot(3, 2, 2).unwrap();
        for (slot, ticket) in [(1, original), (2, candidate), (3, other_session)] {
            reader.complete_slot(slot, ticket, Some(Vec::new())).unwrap();
        }
        reader.slots.get_mut(&1).unwrap().committed = true;
        reader.slots.get_mut(&3).unwrap().committed = true;
        let incoming = ViewTransform {
            session: 1, page: 2, scale: 1.0, pan_x: 0.0, pan_y: 0.0,
            pixel_ratio: 1.0, edge_offset: 0.0, neighbour_page: None,
        };
        assert_eq!(Reader::committed_page(&reader.slots, incoming).unwrap().ticket, original);
        reader.slots.get_mut(&2).unwrap().committed = true;
        assert_eq!(Reader::committed_page(&reader.slots, incoming).unwrap().ticket, candidate);
    }

    #[test]
    fn retiring_the_original_keeps_the_active_replacement_viewport_and_slide() {
        let mut reader = Reader::new();
        reader.begin_slot(1, 2, 1).unwrap();
        reader.begin_slot(2, 2, 1).unwrap();
        reader.active = Some(2);
        reader.requested = Some(2);
        reader.transforms.insert((1, 2), ViewTransform {
            session: 1, page: 2, scale: 1.02, pan_x: 4.0, pan_y: 2.0,
            pixel_ratio: 1.0, edge_offset: -0.22, neighbour_page: Some(4),
        });
        reader.unpresent(1);
        let current = reader.transforms[&(1, 2)];
        assert_eq!((current.scale, current.pan_x, current.pan_y), (1.02, 4.0, 2.0));
        assert_eq!((current.edge_offset, current.neighbour_page), (-0.22, Some(4)));
        assert_eq!(reader.active, Some(2));
        reader.unpresent(2);
        assert_eq!(reader.transforms[&(1, 2)].edge_offset, 0.0);
    }

    #[test]
    fn decode_cannot_publish_back_into_a_reused_slot() {
        let mut reader = Reader::new();
        let old = reader.begin_slot(1, 1, 1).unwrap();
        reader.slots.remove(&1);
        let replacement = reader.begin_slot(1, 1, 1).unwrap();
        assert!(reader.complete_slot(1, old, Some(Vec::new())).is_none());
        assert!(reader.slots[&1].pages.is_none());
        assert!(reader
            .complete_slot(1, replacement, Some(Vec::new()))
            .is_some());
    }
}
