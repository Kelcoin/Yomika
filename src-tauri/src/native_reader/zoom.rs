//! Pinch geometry shared by the native reader hosts.
//!
//! The same numbers decide where the page sits while two fingers are down and
//! where it lands when they lift, so they live outside the iOS host: the release
//! settle is the step a stale focus makes jump, and it has to be unit-testable
//! on a machine without a device.
//!
//! Coordinates are the reader's own: `pan` is in unscaled content units, so the
//! painted screen offset is `pan * scale` and `focus` is measured from the
//! viewport centre (the transform origin of both hosts).

/// Rubber band past either end: 12% of the edge scale, approached asymptotically.
pub(crate) fn elastic_scale(raw: f64, maximum: f64) -> f64 {
    if (1.0..=maximum).contains(&raw) {
        return raw;
    }
    let edge = if raw < 1.0 { 1.0 } else { maximum };
    let travel = raw / edge - 1.0;
    edge * (1.0 + travel.signum() * 0.12 * (1.0 - (-2.75 * travel.abs()).exp()))
}

/// How far the content may travel on one axis before its edge would leave the viewport.
pub(crate) fn pan_limit(extent: f64, scale: f64) -> f64 {
    if scale <= 1.0 {
        return 0.0;
    }
    extent * (1.0 - scale.recip()) / 2.0
}

/// Pan that keeps the content point which started under the fingers under them.
pub(crate) fn drag_pan(start_pan: f64, start_focus: f64, start_scale: f64, focus: f64, scale: f64, extent: f64) -> f64 {
    if scale <= 1.0 {
        return 0.0;
    }
    let limit = pan_limit(extent, scale);
    (start_pan + focus / scale - start_focus / start_scale).clamp(-limit, limit)
}

/// Where the page lands once the fingers lift: the scale clamps into range and
/// the point under `focus` stays under `focus` while it does.
pub(crate) fn settle(scale: f64, pan: (f64, f64), maximum: f64, extent: (f64, f64), focus: (f64, f64)) -> (f64, f64, f64) {
    let previous = scale;
    let scale = scale.clamp(1.0, maximum);
    let inverse_delta = scale.recip() - previous.recip();
    let x = (pan.0 + focus.0 * inverse_delta).clamp(-pan_limit(extent.0, scale), pan_limit(extent.0, scale));
    let y = (pan.1 + focus.1 * inverse_delta).clamp(-pan_limit(extent.1, scale), pan_limit(extent.1, scale));
    (scale, x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDTH: f64 = 1170.0;
    const HEIGHT: f64 = 2532.0;

    #[test]
    fn the_drag_keeps_the_point_under_the_fingers_still() {
        // Fingers land at (120, -300) from the centre on a 2x page and slide to
        // (200, -180): the content point that started under them must stay there.
        let start_scale = 2.0;
        let start_focus = (120.0, -300.0);
        let start_pan = (0.0, 0.0);
        let content = (start_focus.0 / start_scale - start_pan.0, start_focus.1 / start_scale - start_pan.1);
        let scale = 2.4;
        let focus = (200.0, -180.0);
        let pan = (
            drag_pan(start_pan.0, start_focus.0, start_scale, focus.0, scale, WIDTH),
            drag_pan(start_pan.1, start_focus.1, start_scale, focus.1, scale, HEIGHT),
        );
        // The page is painted at scale * (content + pan), so the point under the
        // fingers stays put when that product still lands on the focus.
        assert!(((content.0 + pan.0) * scale - focus.0).abs() < 1e-9);
        assert!(((content.1 + pan.1) * scale - focus.1).abs() < 1e-9);
    }

    #[test]
    fn the_drag_stops_at_the_content_edge() {
        // Pushing far past the edge pins the page to it instead of scrolling it away.
        let pan = drag_pan(0.0, 0.0, 2.0, 4000.0, 2.0, WIDTH);
        assert_eq!(pan, pan_limit(WIDTH, 2.0));
        assert_eq!(pan, WIDTH / 4.0);
    }

    #[test]
    fn a_settled_scale_does_not_move_the_page() {
        let (scale, x, y) = settle(2.0, (40.0, -80.0), 4.0, (WIDTH, HEIGHT), (300.0, 500.0));
        assert_eq!(scale, 2.0);
        assert_eq!((x, y), (40.0, -80.0));
    }

    #[test]
    fn the_release_keeps_the_focus_point_under_the_fingers() {
        // Over-maximum rubber band snaps back to the maximum while the point
        // under the fingers stays put: no drift towards a corner on release.
        let elastic = elastic_scale(4.6, 4.0);
        assert!(elastic > 4.0);
        let pan = (100.0, -200.0);
        let focus = (260.0, 420.0);
        let (scale, x, y) = settle(elastic, pan, 4.0, (WIDTH, HEIGHT), focus);
        assert_eq!(scale, 4.0);
        assert!((x - (pan.0 + focus.0 * (0.25 - elastic.recip()))).abs() < 1e-9);
        assert!((y - (pan.1 + focus.1 * (0.25 - elastic.recip()))).abs() < 1e-9);
        // Well inside the limits, so the clamp does not take part.
        assert!(x.abs() < pan_limit(WIDTH, 4.0) && y.abs() < pan_limit(HEIGHT, 4.0));
    }

    #[test]
    fn pinching_in_settles_to_the_fitted_page() {
        let (scale, x, y) = settle(elastic_scale(0.8, 4.0), (0.0, 0.0), 4.0, (WIDTH, HEIGHT), (500.0, -700.0));
        assert_eq!(scale, 1.0);
        assert_eq!((x, y), (0.0, 0.0), "a fitted page has nowhere to pan");
    }

    #[test]
    fn the_rubber_band_is_bounded_and_monotonic() {
        let over = elastic_scale(8.0, 3.0);
        assert!(over > 3.0 && over <= 3.36);
        let under = elastic_scale(0.1, 3.0);
        assert!(under < 1.0 && under >= 0.88);
        assert!(elastic_scale(1.5, 3.0) == 1.5);
    }
}
