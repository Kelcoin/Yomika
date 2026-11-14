import { NAVIGATION_ROUTES, navigationOwner } from './navigationOrder';

export type RouteDirection = 1 | -1;
export type RouteMotion = { kind: 'none' | 'slide' | 'detail-open' | 'detail-close' | 'page-open' | 'page-close'; axis: 'x' | 'y'; direction: RouteDirection };
type RouteAddress = { pathname: string; search: string; state?: { homeEntry?: boolean; navigationTab?: boolean } | null };

function detailIdentity(location: RouteAddress): string | undefined {
  const match = location.pathname.match(/^\/(home|library|history|watchlist|to-read)\/([^/]+)$/);
  if (match) return match[2];
  if (location.pathname === '/downloads') return new URLSearchParams(location.search).get('path') || undefined;
  return undefined;
}

/** Spatial tab order wins over PUSH/POP history order. Detail depth wins only
 * within the same workspace; selecting another tab must still move spatially. */
export function resolveRouteMotion(from: RouteAddress | undefined, to: RouteAddress, compact: boolean, historyDirection: RouteDirection = 1): RouteMotion {
  const axis = compact ? 'x' : 'y';
  const none: RouteMotion = { kind: 'none', axis, direction: historyDirection };
  if (!from) return none;
  const sourceOwner = navigationOwner(from.pathname);
  const targetOwner = navigationOwner(to.pathname);
  const sourceDetail = detailIdentity(from);
  const targetDetail = detailIdentity(to);
  // The same destination can be a bottom tab or a home shortcut. Only the
  // latter pushes a page above home; route order alone cannot distinguish it.
  if (from.pathname === '/' && to.state?.homeEntry && targetOwner !== '/') return { ...none, kind: 'page-open' };
  if (to.pathname === '/' && from.state?.homeEntry && !to.state?.navigationTab) return { ...none, kind: 'page-close' };
  if (targetDetail && (sourceOwner !== targetOwner || sourceDetail !== targetDetail)) return { ...none, kind: 'detail-open' };
  if (sourceOwner === targetOwner && sourceDetail && !targetDetail) return { ...none, kind: 'detail-close' };
  if (from.pathname === to.pathname) return none;
  const sourceIndex = NAVIGATION_ROUTES.findIndex(path => path === sourceOwner);
  const targetIndex = NAVIGATION_ROUTES.findIndex(path => path === targetOwner);
  if (sourceOwner !== targetOwner && sourceIndex >= 0 && targetIndex >= 0) {
    return { kind: 'slide', axis, direction: targetIndex > sourceIndex ? 1 : -1 };
  }
  // Editors and tools are drill-down routes, independent of the navigation rail.
  return { kind: 'slide', axis: 'x', direction: historyDirection };
}

// Keep the TabController ease curve, with a shorter duration for this UI.
export const NAVIGATION_MOTION = { duration: 180, easing: 'cubic-bezier(.25, .1, .25, 1)' } as const;
export const DETAIL_ENTER_MS = 300;
export const DETAIL_EXIT_MS = 180;

export function routeMotionAllowed(): boolean {
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Use the visible part of a tall detail as the zoom origin, rather than its
 * full content midpoint (which could be thousands of pixels offscreen). */
export function animateDetail(panel: HTMLElement, closing = false, target?: DOMRect): Animation | undefined {
  if (!routeMotionAllowed() || typeof panel.animate !== 'function') return undefined;
  const rect = panel.getBoundingClientRect();
  const viewport = panel.closest('.workspace')?.getBoundingClientRect();
  const top = Math.max(rect.top, viewport?.top ?? 0);
  const bottom = Math.min(rect.bottom, viewport?.bottom ?? window.innerHeight);
  const transformOrigin = bottom > top ? `50% ${(top + bottom) / 2 - rect.top}px` : '50% 50%';
  if (closing) {
    // Android's Zoom exit scales a complete page to .90, rather than morphing
    // its text into a tiny card. The source only biases the scale origin.
    const origin = target ? `${Math.min(rect.width, Math.max(0, target.left + target.width / 2 - rect.left))}px ${Math.min(bottom, Math.max(top, target.top + target.height / 2)) - rect.top}px` : transformOrigin;
    // One continuous accelerating scale curve. Restarting an ease at 65%
    // brought the old exit to a visible stop before it could finish fading.
    return panel.animate([
      { offset: 0, opacity: 1, transform: 'scale(1)', transformOrigin: origin },
      { offset: .2, opacity: 1, transform: 'scale(0.98)', transformOrigin: origin },
      { offset: 1, opacity: 0, transform: 'scale(0.9)', transformOrigin: origin },
    ], { duration: DETAIL_EXIT_MS, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  }
  // Flutter ZoomPageTransitionsBuilder's two-part fastOutExtraSlowIn curve:
  // the first sixth travels 40%, then the remainder settles gently. Keep the
  // excursion smaller than Flutter's .85 to reduce mobile text rasterization.
  const start = .94;
  const end = 1;
  return panel.animate([
    { offset: 0, opacity: 0, transform: `scale(${start})`, transformOrigin, easing: 'cubic-bezier(.05, 0, .133333, .06)' },
    { offset: 1 / 6, opacity: .4, transform: `scale(${start + (end - start) * .4})`, transformOrigin, easing: 'cubic-bezier(.208333, .82, .25, 1)' },
    { offset: 1, opacity: 1, transform: `scale(${end})`, transformOrigin },
  ], { duration: DETAIL_ENTER_MS, easing: 'linear', fill: 'none' });
}
