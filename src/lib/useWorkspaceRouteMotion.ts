import { useLayoutEffect, useRef, useState } from 'react';
import type { Location } from 'react-router-dom';
import { animateDetail, DETAIL_EXIT_MS, resolveRouteMotion, routeMotionAllowed, type RouteDirection, type RouteMotion } from './routeMotion';
import { DETAIL_RETURN_PREVIEW, detailReturnTarget, prepareDetailReturn } from './detailReturn';
import { navigationOwner } from './navigationOrder';

/** Keep the existing detail mounted until its reverse transition completes.
 * No duplicate React tree, screenshot, image decode or new network request. */
export function useWorkspaceRouteMotion(location: Location, compact: boolean, direction: RouteDirection, active: boolean) {
  const previous = useRef<{ location: Location; motion: RouteMotion }>({ location, motion: resolveRouteMotion(undefined, location, compact, direction) });
  const shortcutOwner = useRef<string | undefined>(location.state?.homeEntry ? navigationOwner(location.pathname) : undefined);
  if (previous.current.location !== location) {
    const from = previous.current.location;
    const origin = shortcutOwner.current === navigationOwner(from.pathname) ? { ...from, state: { ...from.state, homeEntry: true } } : from;
    previous.current = { location, motion: resolveRouteMotion(origin, location, compact, direction) };
    const owner = navigationOwner(location.pathname);
    if (location.state?.navigationTab || owner !== shortcutOwner.current) shortcutOwner.current = undefined;
    if (from.pathname === '/' && location.state?.homeEntry) shortcutOwner.current = owner;
  }
  const motion = previous.current.motion;
  const displayedRef = useRef(location);
  const [completed, setCompleted] = useState<Location>();
  const [returning, setReturning] = useState<Location>();
  const surface = useRef<HTMLElement | null>(null);
  // Ordinary navigation can render its destination immediately. Only a detail
  // return needs to retain the old location until its live DOM finishes moving.
  const exiting = active && (motion.kind === 'detail-close' || motion.kind === 'page-close') && displayedRef.current !== location
    && completed !== location && routeMotionAllowed();
  if (!exiting) displayedRef.current = location;
  const displayed = displayedRef.current;
  useLayoutEffect(() => {
    if (!exiting) return;
    const wholePage = motion.kind === 'page-close';
    const detail = wholePage ? surface.current : surface.current?.querySelector<HTMLElement>('.library-shell-detail');
    if (!detail || typeof detail.animate !== 'function') { setCompleted(location); return; }
    const panel = surface.current!;
    const restore = prepareDetailReturn(panel, detail, wholePage);
    setReturning(location);
    let animation: Animation | undefined;
    let backdrop: Animation | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      setCompleted(location);
    };
    // Give the restored home chrome one commit before measuring the source
    // card. The outgoing detail is already fixed and cannot jump with it.
    const frame = requestAnimationFrame(() => {
      document.dispatchEvent(new CustomEvent(DETAIL_RETURN_PREVIEW));
      // Align before animating the underneath page: its transformed card bounds
      // are visual coordinates, not the scroll position we intend to preserve.
      const target = detailReturnTarget(displayed);
      const underneath = wholePage
        ? panel.parentElement?.querySelector<HTMLElement>('.route-cache-panel:not([hidden]):not([data-page-return])')
        : panel.querySelector<HTMLElement>('.library-shell-list');
      if (location.pathname === '/' && underneath?.animate) backdrop = underneath.animate([
        { transform: 'scale(1.025)' }, { transform: 'scale(1)' },
      ], { duration: DETAIL_EXIT_MS, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      animation = animateDetail(detail, true, target);
      if (animation) animation.onfinish = finish;
      else finish();
      // Restoring a large cached page can delay this first frame. The playback
      // deadline belongs to animation start, not the earlier navigation event.
      clearTimeout(timer);
      timer = window.setTimeout(finish, DETAIL_EXIT_MS + 50);
    });
    // Some embedded WebViews omit finish events when backgrounded. Never leave
    // the old route inert forever, even if its first rAF never arrives. Once
    // that frame starts, the shorter playback deadline replaces this guard.
    let timer = window.setTimeout(finish, 1000);
    return () => {
      settled = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      if (animation) { animation.onfinish = null; animation.cancel(); }
      backdrop?.cancel();
      restore();
    };
  }, [location, displayed, exiting, motion.kind]);
  const preview = returning === location && displayed !== location;
  return { location: displayed, motion, surface, returning: preview, previewLocation: preview && motion.kind === 'page-close' ? location : undefined };
}
