use super::*;
use objc2_ui_kit::UIPinchGestureRecognizer;

#[derive(Clone, Copy)]
pub(super) struct PinchConfig {
    pub session: u32,
    pub page: i32,
    pub maximum: f64,
    pub reduce_motion: bool,
    pub left: Option<i32>,
    pub right: Option<i32>,
    pub exit_left: Option<bool>,
}

#[derive(Clone, Copy)]
struct PinchStart {
    transform: ViewTransform,
    maximum: f64,
    x: f64,
    y: f64,
}

struct PinchTargetState {
    window: WebviewWindow,
    start: Cell<Option<PinchStart>>,
    pan_start: Cell<Option<ViewTransform>>,
    boundary_visible: Cell<bool>,
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
        fn should_begin(&self, gesture: &UIGestureRecognizer) -> bool {
            !COVERED.get() && READERS.with_borrow(|readers| {
                let Some(reader) = readers.get(self.ivars().window.label()) else { return false };
                let Some(pan) = gesture.downcast_ref::<UIPanGestureRecognizer>() else {
                    return reader.pinch_key().is_some();
                };
                reader.active_page_key().is_some_and(|key| {
                    if !reader.pinch_config.is_some_and(|config| config.session == key.0 && config.page == key.1) {
                        return false;
                    }
                    if reader.pinching.is_some() { return false; }
                    if reader.transforms.get(&key).is_some_and(|transform| transform.scale > 1.04) { return true; }
                    let velocity = pan.velocityInView(None);
                    velocity.x.abs() > velocity.y.abs()
                        && (reader.pan_neighbour(velocity.x).is_some() || reader.pan_boundary(velocity.x).is_some())
                })
            })
        }

        #[unsafe(method(gestureRecognizer:shouldRecognizeSimultaneouslyWithGestureRecognizer:))]
        fn allow_pinch_to_take_over_pan(&self, gesture: &UIGestureRecognizer, other: &UIGestureRecognizer) -> bool {
            other.delegate().is_some_and(|delegate| std::ptr::eq(
                &*delegate, ProtocolObject::from_ref(self),
            )) && (gesture.downcast_ref::<UIPinchGestureRecognizer>().is_some()
                || other.downcast_ref::<UIPinchGestureRecognizer>().is_some())
        }
    }

    impl PinchTarget {
        #[unsafe(method(yomikaPanPage:))]
        fn on_pan(&self, pan: &UIPanGestureRecognizer) {
            let Some(web) = pan.view() else { return };
            let window = &self.ivars().window;
            let label = window.label();
            let state = pan.state();
            let ended = matches!(state, UIGestureRecognizerState::Ended | UIGestureRecognizerState::Cancelled);
            let translation = pan.translationInView(Some(&web));
            let velocity = pan.velocityInView(Some(&web)).x;
            let size = web.bounds().size;
            let mut landing = None;
            let mut turn = None;
            let mut exit = None;
            let mut boundary_cue = None;
            let update = READERS.with_borrow_mut(|readers| {
                let reader = readers.get_mut(label)?;
                let key = reader.pinch_key()?;
                if COVERED.get() || reader.pinching.is_some() { return None; }
                if state == UIGestureRecognizerState::Began {
                    self.ivars().pan_start.set(Some(reader.transforms.get(&key).copied().unwrap_or_else(|| initial_transform(key))));
                    reader.pinch_settle = None;
                    reader.turn_settling = None;
                    reader.turn_outgoing = None;
                    reader.panning = Some(key);
                }
                let start = self.ivars().pan_start.get()?;
                if reader.panning != Some(key) || !start.matches(key.0, key.1) { return None; }
                let zoomed = start.scale > 1.04;
                if ended {
                    self.ivars().pan_start.set(None);
                    reader.panning = None;
                }
                let config = reader.pinch_config?;
                let mut moved = if zoomed {
                    settle(ViewTransform {
                        pan_x: start.pan_x + translation.x / start.scale,
                        pan_y: start.pan_y + translation.y / start.scale,
                        ..start
                    }, config.maximum, size.width, size.height)
                } else {
                    let neighbour = reader.pan_neighbour(translation.x).map(|(page, _)| page);
                    let width = size.width.max(1.0);
                    let boundary = reader.pan_boundary(translation.x);
                    let offset = if neighbour.is_some() {
                        (translation.x / width).clamp(-1.0, 1.0)
                    } else if let Some(exits) = boundary {
                        let travel = translation.x.abs();
                        let limit = if exits { (width * 0.82).min(360.0) } else { (width * 0.16).min(64.0) };
                        let distance = (width * 0.23).clamp(80.0, 210.0);
                        let offset = translation.x.signum() * limit * travel / (travel + limit / 0.55);
                        if exits && !ended {
                            boundary_cue = Some((key, translation.x < 0.0, (travel / distance).min(1.0), offset.abs()));
                        }
                        if exits && travel >= distance && state == UIGestureRecognizerState::Ended {
                            exit = Some((key, translation.x < 0.0));
                        }
                        offset / width
                    } else { 0.0 };
                    ViewTransform {
                        edge_offset: offset,
                        neighbour_page: neighbour,
                        ..start
                    }
                };
                if ended && !zoomed && exit.is_none() {
                    let left = translation.x < 0.0;
                    let distance = translation.x.abs();
                    let far = distance > (size.width * 0.2).min(180.0);
                    let flick = velocity.abs() > 400.0 && velocity.signum() == translation.x.signum();
                    if state == UIGestureRecognizerState::Ended && distance > 30.0 && (far || flick) {
                        if let Some((page, slot)) = reader.pan_neighbour(translation.x) {
                            let old_offset = moved.edge_offset;
                            let next_key = (key.0, page);
                            let target = initial_transform(next_key);
                            let offset = old_offset - old_offset.signum();
                            let from = ViewTransform { edge_offset: offset, neighbour_page: Some(key.1), ..target };
                            reader.transforms.insert(key, initial_transform(key));
                            reader.transforms.insert(next_key, if config.reduce_motion { target } else { from });
                            reader.turn_outgoing = (!config.reduce_motion && offset != 0.0).then_some(ViewTransform {
                                edge_offset: offset,
                                ..moved
                            });
                            if reader.present(&web, self.mtm(), slot) {
                                reader.requested = Some(slot);
                                if !config.reduce_motion && offset != 0.0 {
                                    let token = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
                                    reader.pinch_settle = Some(token);
                                    reader.turn_settling = Some(next_key);
                                    let remaining = offset.abs() * size.width;
                                    let minimum = (115.0 + remaining * 0.15).min(180.0);
                                    let speed = (velocity.abs() / 1000.0).max(0.7);
                                    let duration = (remaining / speed).clamp(minimum, 240.0);
                                    landing = Some((token, from, target, duration));
                                }
                                turn = Some((key, page, slot, left));
                                return None;
                            }
                            reader.turn_outgoing = None;
                            reader.transforms.remove(&next_key);
                        }
                    }
                    let target = ViewTransform { edge_offset: 0.0, neighbour_page: None, ..start };
                    if config.reduce_motion || moved.edge_offset == 0.0 {
                        moved = target;
                    } else {
                        let token = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
                        reader.pinch_settle = Some(token);
                        reader.turn_settling = Some(key);
                        landing = Some((token, moved, target, 160.0));
                    }
                }
                reader.transforms.insert(key, moved);
                if let Some(pane) = &reader.pane {
                    reader.paint_transform(pane, Some(moved), self.mtm());
                }
                (ended && zoomed).then_some(moved)
            });
            if let Some(((session, page), left, progress, pixels)) = boundary_cue {
                self.ivars().boundary_visible.set(true);
                let _ = window.eval(format!("dispatchEvent(new CustomEvent('yomika-reader-native-boundary',{{detail:{{session:{session},page:{page},left:{left},progress:{progress},pixels:{pixels}}}}}));"));
            } else if self.ivars().boundary_visible.replace(false) {
                let _ = window.eval("dispatchEvent(new Event('yomika-reader-native-boundary-clear'));".to_owned());
            }
            if let Some(((session, page), left)) = exit {
                let _ = window.eval(format!("dispatchEvent(new CustomEvent('yomika-reader-native-exit',{{detail:{{session:{session},page:{page},left:{left}}}}}));"));
            }
            if let Some((token, from, target, duration)) = landing {
                start_settle(window.clone(), token, from, target, duration);
            }
            if let Some(((session, from), to, slot, left)) = turn {
                let _ = window.eval(format!("dispatchEvent(new CustomEvent('yomika-reader-native-turn',{{detail:{{session:{session},from:{from},to:{to},left:{left}}}}}));"));
                notify_presented(window, slot);
                schedule_animation(window, label);
            }
            if let Some(zoom) = update {
                schedule_refinement(window, label);
                notify_zoom(window, zoom);
            }
        }

        #[unsafe(method(yomikaPinch:))]
        fn on_pinch(&self, pinch: &UIPinchGestureRecognizer) {
            let state = pinch.state();
            let Some(web) = pinch.view() else { return };
            let window = &self.ivars().window;
            let label = window.label();
            let bounds = web.bounds();
            let width = bounds.size.width;
            let height = bounds.size.height;
            let location = pinch.locationInView(Some(&web));
            let x = location.x - width / 2.0;
            let y = location.y - height / 2.0;
            let scale = pinch.scale();
            let ending = matches!(state, UIGestureRecognizerState::Ended | UIGestureRecognizerState::Cancelled);
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
                    self.ivars().start.set(Some(PinchStart { transform, maximum, x, y }));
                    reader.pinching = Some(key);
                    began = Some(key);
                    reader.panning = None;
                    self.ivars().pan_start.set(None);
                    reader.pinch_settle = None;
                    reader.turn_settling = None;
                    reader.turn_outgoing = None;
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
                    let scale = elastic_scale(start.transform.scale * scale, start.maximum);
                    let mut transform = ViewTransform { scale, edge_offset: 0.0, neighbour_page: None, ..start.transform };
                    if scale <= 1.0 {
                        transform.pan_x = 0.0;
                        transform.pan_y = 0.0;
                    } else {
                        let max_x = width * (1.0 - scale.recip()) / 2.0;
                        let max_y = height * (1.0 - scale.recip()) / 2.0;
                        transform.pan_x = (start.transform.pan_x + x / scale - start.x / start.transform.scale).clamp(-max_x, max_x);
                        transform.pan_y = (start.transform.pan_y + y / scale - start.y / start.transform.scale).clamp(-max_y, max_y);
                    }
                    transform
                };
                reader.transforms.insert(key, transform);
                if let Some(pane) = &reader.pane {
                    reader.paint_transform(pane, Some(transform), self.mtm());
                }
                if !ending { return None; }
                self.ivars().start.set(None);
                reader.pinching = None;
                let target = settle(transform, start.maximum, width, height);
                let animation = if !config.reduce_motion && transform.scale != target.scale {
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

fn elastic_scale(raw: f64, maximum: f64) -> f64 {
    if (1.0..=maximum).contains(&raw) { return raw; }
    let edge = if raw < 1.0 { 1.0 } else { maximum };
    let travel = raw / edge - 1.0;
    edge * (1.0 + travel.signum() * 0.12 * (1.0 - (-2.75 * travel.abs()).exp()))
}

fn settle(mut transform: ViewTransform, maximum: f64, width: f64, height: f64) -> ViewTransform {
    transform.scale = transform.scale.clamp(1.0, maximum);
    let max_x = width * (1.0 - transform.scale.recip()) / 2.0;
    let max_y = height * (1.0 - transform.scale.recip()) / 2.0;
    transform.pan_x = transform.pan_x.clamp(-max_x, max_x);
    transform.pan_y = transform.pan_y.clamp(-max_y, max_y);
    transform
}

fn start_settle(window: WebviewWindow, token: u64, from: ViewTransform, target: ViewTransform, duration_ms: f64) {
    tauri::async_runtime::spawn(async move {
        let start = Instant::now();
        let mut ticks = tokio::time::interval(Duration::from_millis(16));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            let time = (start.elapsed().as_secs_f64() * 1000.0 / duration_ms).min(1.0);
            let remaining = (1.0 - time).powi(if from.neighbour_page.is_some() { 2 } else { 3 });
            let frame = ViewTransform {
                scale: target.scale + (from.scale - target.scale) * remaining,
                pan_x: target.pan_x + (from.pan_x - target.pan_x) * remaining,
                pan_y: target.pan_y + (from.pan_y - target.pan_y) * remaining,
                edge_offset: target.edge_offset + (from.edge_offset - target.edge_offset) * remaining,
                neighbour_page: if time < 1.0 { from.neighbour_page } else { target.neighbour_page },
                ..target
            };
            let applied = on_view(&window, move |label, _, mtm| {
                READERS.with_borrow_mut(|readers| {
                    let Some(reader) = readers.get_mut(label) else { return false };
                    let key = (frame.session, frame.page);
                    if reader.pinch_settle != Some(token) || reader.pinch_key() != Some(key) || COVERED.get() { return false; }
                    reader.transforms.insert(key, frame);
                    if let Some(pane) = &reader.pane {
                        reader.paint_transform(pane, Some(frame), mtm);
                    }
                    if time == 1.0 {
                        reader.pinch_settle = None;
                        reader.turn_settling = None;
                        reader.turn_outgoing = None;
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
    pan: Retained<UIPanGestureRecognizer>,
    _target: Retained<PinchTarget>,
}

impl PinchRecognizer {
    pub(super) fn window(&self) -> &WebviewWindow { &self._target.ivars().window }

    pub fn new(window: WebviewWindow, web: &UIView, mtm: MainThreadMarker) -> Self {
        let target = mtm.alloc::<PinchTarget>().set_ivars(PinchTargetState { window, start: Cell::new(None), pan_start: Cell::new(None), boundary_visible: Cell::new(false) });
        let target: Retained<PinchTarget> = unsafe { msg_send![super(target), init] };
        let recognizer = unsafe {
            UIPinchGestureRecognizer::initWithTarget_action(mtm.alloc(), Some(target.as_ref()), Some(sel!(yomikaPinch:)))
        };
        recognizer.setDelegate(Some(ProtocolObject::from_ref(&*target)));
        // Keep DOM taps and compatibility gestures available alongside UIKit input.
        recognizer.setCancelsTouchesInView(false);
        web.addGestureRecognizer(&recognizer);
        let pan = unsafe {
            UIPanGestureRecognizer::initWithTarget_action(mtm.alloc(), Some(target.as_ref()), Some(sel!(yomikaPanPage:)))
        };
        pan.setDelegate(Some(ProtocolObject::from_ref(&*target)));
        pan.setMaximumNumberOfTouches(1);
        // Only warmed horizontal pans and zoomed image pans are recognized.
        // Once UIKit accepts one, WebKit must not also release a page turn.
        pan.setCancelsTouchesInView(true);
        web.addGestureRecognizer(&pan);
        Self { web: web.retain(), recognizer, pan, _target: target }
    }
}

impl Drop for PinchRecognizer {
    fn drop(&mut self) {
        self.recognizer.setDelegate(None);
        unsafe { self.recognizer.removeTarget_action(None, None) };
        self.web.removeGestureRecognizer(&self.recognizer);
        self.pan.setDelegate(None);
        unsafe { self.pan.removeTarget_action(None, None) };
        self.web.removeGestureRecognizer(&self.pan);
    }
}

impl Reader {
    fn pan_neighbour(&self, x: f64) -> Option<(i32, i32)> {
        let config = self.pinch_config?;
        let page = if x < 0.0 { config.left? } else if x > 0.0 { config.right? } else { return None; };
        self.slots.iter().filter(|(_, slot)| slot.session == config.session && slot.page == page
            && slot.committed && slot.previews.is_some())
            .max_by_key(|(_, slot)| slot.revision)
            .map(|(&slot, _)| (page, slot))
    }

    fn pan_boundary(&self, x: f64) -> Option<bool> {
        let config = self.pinch_config?;
        let exit_left = config.exit_left?;
        if x == 0.0 { return None; }
        let left = x < 0.0;
        let neighbour = if left { config.left } else { config.right };
        neighbour.is_none().then_some(left == exit_left)
    }

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
    reduce_motion: bool, left: Option<i32>, right: Option<i32>, exit_left: Option<bool>,
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
                reader.panning = None;
                reader.pinch_settle = None;
                reader.turn_settling = None;
                reader.turn_outgoing = None;
                return;
            }
            if reader.pinch_config.is_some_and(|config| config.session != session || config.page != page) {
                let key = (session, page);
                if reader.pinching != Some(key) && reader.active_page_key() != Some(key) {
                    reader.pinch_settle = None;
                    reader.turn_settling = None;
                    reader.turn_outgoing = None;
                }
                reader.pinching = reader.pinching.filter(|active| *active == key);
                reader.panning = reader.panning.filter(|active| *active == key);
            }
            reader.pinch_config = Some(PinchConfig { session, page, maximum, reduce_motion, left, right, exit_left });
            if reader.pinch.is_none() {
                reader.pinch = Some(PinchRecognizer::new(handle, web, mtm));
            }
        });
    }).await
}
