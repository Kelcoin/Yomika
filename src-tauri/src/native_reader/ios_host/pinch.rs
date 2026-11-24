use super::*;
use crate::native_reader::zoom::{drag_pan, elastic_scale, settle};
use objc2_ui_kit::UIPinchGestureRecognizer;

#[derive(Clone, Copy)]
pub(super) struct PinchConfig {
    pub session: u32,
    pub page: i32,
    pub maximum: f64,
    pub reduce_motion: bool,
    pub left: Option<i32>,
    pub right: Option<i32>,
}

#[derive(Clone, Copy)]
struct PinchStart {
    transform: ViewTransform,
    maximum: f64,
    recognizer_scale: f64,
    x: f64,
    y: f64,
}

struct PinchTargetState {
    window: WebviewWindow,
    start: Cell<Option<PinchStart>>,
    focus: Cell<(f64, f64)>,
}

define_class!(
    // The NSObject delegate and all view mutations are main-thread-only.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = PinchTargetState]
    struct PinchTarget;

    unsafe impl NSObjectProtocol for PinchTarget {}

    unsafe impl UIGestureRecognizerDelegate for PinchTarget {
        #[unsafe(method(gestureRecognizerShouldBegin:))]
        fn should_begin(&self, _gesture: &UIGestureRecognizer) -> bool {
            !COVERED.get() && READERS.with_borrow(|readers| {
                readers.get(self.ivars().window.label()).is_some_and(|reader| reader.pinch_key().is_some())
            })
        }
    }

    impl PinchTarget {
        #[unsafe(method(yomikaPinch:))]
        fn on_pinch(&self, pinch: &UIPinchGestureRecognizer) {
            let state = pinch.state();
            let Some(web) = pinch.view() else { return };
            let window = &self.ivars().window;
            let label = window.label();
            let bounds = web.bounds();
            let width = bounds.size.width;
            let height = bounds.size.height;
            let ending = matches!(state, UIGestureRecognizerState::Ended | UIGestureRecognizerState::Cancelled);
            // UIKit can still report Changed when only one touch remains. Its
            // location then jumps from the midpoint to the remaining finger.
            if !ending && pinch.numberOfTouches() != 2 { return; }
            let location = pinch.locationInView(Some(&web));
            let x = location.x - width / 2.0;
            let y = location.y - height / 2.0;
            let recognizer_scale = pinch.scale();
            if !ending && (!recognizer_scale.is_finite() || recognizer_scale <= 0.0) { return; }
            let mut began = None;
            let publish = READERS.with_borrow_mut(|readers| {
                let reader = readers.get_mut(label)?;
                if COVERED.get() { return None; }
                let key = reader.pinch_key()?;
                let config = reader.pinch_config?;
                if state == UIGestureRecognizerState::Began {
                    let transform = reader.transforms.get(&key).copied().unwrap_or_else(|| initial_transform(key));
                    // The prepared neighbour can become active before the next
                    // page's configuration arrives from WebKit.
                    let maximum = if key.1 == config.page { config.maximum } else { 3.0 };
                    self.ivars().start.set(Some(PinchStart { transform, maximum, recognizer_scale, x, y }));
                    // A quick flick can go Began → Ended with no Changed frame. Seed the
                    // focus here, or the release would settle about wherever the previous
                    // gesture left its fingers and shift the page towards that corner.
                    self.ivars().focus.set((x, y));
                    reader.pinching = Some(key);
                    began = Some(key);
                    reader.pinch_settle = None;
                }
                let start = self.ivars().start.get()?;
                if reader.pinching != Some(key) || !start.transform.matches(key.0, key.1) {
                    reader.pinching = None;
                    self.ivars().start.set(None);
                    return None;
                }
                let transform = if ending {
                    reader.transforms.get(&key).copied().unwrap_or(start.transform)
                } else {
                    self.ivars().focus.set((x, y));
                    let scale = elastic_scale(start.transform.scale * recognizer_scale / start.recognizer_scale, start.maximum);
                    ViewTransform {
                        scale,
                        edge_offset: 0.0,
                        neighbour_page: None,
                        pan_x: drag_pan(start.transform.pan_x, start.x, start.transform.scale, x, scale, width),
                        pan_y: drag_pan(start.transform.pan_y, start.y, start.transform.scale, y, scale, height),
                        ..start.transform
                    }
                };
                reader.transforms.insert(key, transform);
                if let Some(pane) = &reader.pane {
                    reader.paint_transform(pane, Some(transform), self.mtm());
                }
                if !ending { return None; }
                self.ivars().start.set(None);
                reader.pinching = None;
                let focus = self.ivars().focus.get();
                let (scale, pan_x, pan_y) = settle(transform.scale, (transform.pan_x, transform.pan_y), start.maximum, (width, height), focus);
                let target = ViewTransform { scale, pan_x, pan_y, ..transform };
                let animation = if !config.reduce_motion && (transform.scale != target.scale || transform.pan_x != target.pan_x || transform.pan_y != target.pan_y) {
                    let token = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
                    reader.pinch_settle = Some(token);
                    Some(token)
                } else {
                    reader.transforms.insert(key, target);
                    if let Some(pane) = &reader.pane {
                        reader.paint_transform(pane, Some(target), self.mtm());
                    }
                    None
                };
                Some((transform, target, animation))
            });
            if let Some(key) = began {
                notify_pinch(window, key, true);
            }
            let Some((from, target, animation)) = publish else { return };
            if let Some(token) = animation {
                start_settle(window.clone(), token, from, target, 140.0);
            } else {
                schedule_refinement(window, label);
            }
            notify_zoom(window, target);
            notify_pinch(window, (target.session, target.page), false);
        }
    }
);

fn initial_transform((session, page): (u32, i32)) -> ViewTransform {
    ViewTransform { session, page, scale: 1.0, pan_x: 0.0, pan_y: 0.0,
        pixel_ratio: 1.0, edge_offset: 0.0, neighbour_page: None }
}

pub(super) fn notify_pinch(window: &WebviewWindow, (session, page): (u32, i32), active: bool) {
    let _ = window.eval(format!(
        "dispatchEvent(new CustomEvent('yomika-reader-native-pinch',{{detail:{{session:{session},page:{page},active:{active}}}}}));"
    ));
}

fn notify_zoom(window: &WebviewWindow, target: ViewTransform) {
    let _ = window.eval(format!(
        "dispatchEvent(new CustomEvent('yomika-reader-native-zoom',{{detail:{{session:{},page:{},scale:{},panX:{},panY:{}}}}}));",
        target.session, target.page, target.scale, target.pan_x, target.pan_y,
    ));
}

fn start_settle(window: WebviewWindow, token: u64, from: ViewTransform, target: ViewTransform, duration_ms: f64) {
    tauri::async_runtime::spawn(async move {
        let start = Instant::now();
        let mut ticks = tokio::time::interval(Duration::from_millis(16));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            let time = (start.elapsed().as_secs_f64() * 1000.0 / duration_ms).min(1.0);
            let remaining = (1.0 - time).powi(3);
            let frame = ViewTransform {
                scale: target.scale + (from.scale - target.scale) * remaining,
                pan_x: target.pan_x + (from.pan_x - target.pan_x) * remaining,
                pan_y: target.pan_y + (from.pan_y - target.pan_y) * remaining,
                ..target
            };
            let applied = on_view(&window, move |label, _, mtm| {
                READERS.with_borrow_mut(|readers| {
                    let Some(reader) = readers.get_mut(label) else { return false };
                    let key = (frame.session, frame.page);
                    if reader.pinch_settle != Some(token) { return false; }
                    if reader.pinch_key() != Some(key) || COVERED.get() {
                        // Drop our own token: a stale one silently swallows the next
                        // animated transform the webview sends.
                        reader.pinch_settle = None;
                        return false;
                    }
                    reader.transforms.insert(key, frame);
                    if let Some(pane) = &reader.pane {
                        reader.paint_transform(pane, Some(frame), mtm);
                    }
                    if time == 1.0 {
                        reader.pinch_settle = None;
                    }
                    true
                })
            }).await;
            if !matches!(applied, Ok(true)) || time == 1.0 { break; }
        }
        let handle = window.clone();
        let _ = on_view(&window, move |label, _, _| schedule_refinement(&handle, label)).await;
    });
}

pub(super) struct PinchRecognizer {
    web: Retained<UIView>,
    recognizer: Retained<UIPinchGestureRecognizer>,
    _target: Retained<PinchTarget>,
}

impl PinchRecognizer {
    pub(super) fn window(&self) -> &WebviewWindow { &self._target.ivars().window }

    pub fn new(window: WebviewWindow, web: &UIView, mtm: MainThreadMarker) -> Self {
        let target = mtm.alloc::<PinchTarget>().set_ivars(PinchTargetState { window, start: Cell::new(None), focus: Cell::new((0.0, 0.0)) });
        let target: Retained<PinchTarget> = unsafe { msg_send![super(target), init] };
        let recognizer = unsafe {
            UIPinchGestureRecognizer::initWithTarget_action(mtm.alloc(), Some(target.as_ref()), Some(sel!(yomikaPinch:)))
        };
        recognizer.setDelegate(Some(ProtocolObject::from_ref(&*target)));
        // The shared reader owns the full single-finger stream, including turns
        // toward pages without a native preview. UIKit only handles pinches.
        recognizer.setCancelsTouchesInView(false);
        web.addGestureRecognizer(&recognizer);
        Self { web: web.retain(), recognizer, _target: target }
    }
}

impl Drop for PinchRecognizer {
    fn drop(&mut self) {
        self.recognizer.setDelegate(None);
        unsafe { self.recognizer.removeTarget_action(None, None) };
        self.web.removeGestureRecognizer(&self.recognizer);
    }
}

impl Reader {
    fn active_page_key(&self) -> Option<(u32, i32)> {
        let entry = self.slots.get(&self.active?)?;
        Some((entry.session, entry.page))
    }

    fn pinch_key(&self) -> Option<(u32, i32)> {
        let config = self.pinch_config?;
        let key = self.active_page_key()?;
        (key.0 == config.session && (key.1 == config.page
            || Some(key.1) == config.left || Some(key.1) == config.right)).then_some(key)
    }
}

pub(in super::super) async fn configure(
    window: WebviewWindow, session: u32, page: i32, enabled: bool, maximum: f64,
    reduce_motion: bool, left: Option<i32>, right: Option<i32>,
) -> Result<(), String> {
    let handle = window.clone();
    on_view(&window, move |label, web, mtm| {
        READERS.with_borrow_mut(|readers| {
            if !enabled && !readers.contains_key(label) { return; }
            let reader = readers.entry(label.to_owned()).or_default();
            if reader.pinch_config.is_some_and(|config| config.session > session) { return; }
            if !enabled {
                reader.pinch = None;
                reader.pinch_config = None;
                reader.pinching = None;
                reader.pinch_settle = None;
                return;
            }
            if reader.pinch_config.is_some_and(|config| config.session != session || config.page != page) {
                let key = (session, page);
                if reader.pinching != Some(key) && reader.active_page_key() != Some(key) {
                    reader.pinch_settle = None;
                }
                reader.pinching = reader.pinching.filter(|active| *active == key);
            }
            reader.pinch_config = Some(PinchConfig { session, page, maximum, reduce_motion, left, right });
            if reader.pinch.is_none() {
                reader.pinch = Some(PinchRecognizer::new(handle, web, mtm));
            }
        });
    }).await
}
