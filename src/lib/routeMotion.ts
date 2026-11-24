import { NAVIGATION_ROUTES, navigationOwner } from './navigationOrder';

export type RouteDirection = 1 | -1;
export type RouteMotion = { kind: 'none' | 'fade' | 'slide' | 'detail-open' | 'detail-close' | 'page-open' | 'page-close'; axis: 'x' | 'y'; direction: RouteDirection };
type RouteAddress = { pathname: string; search: string; state?: { homeEntry?: boolean; navigationTab?: boolean; iosBackSettled?: boolean } | null };

export function detailIdentity(location: RouteAddress): string | undefined {
  const match = location.pathname.match(/^\/(home|library|history|watchlist|to-read)\/([^/]+)$/);
  if (match) return match[2];
  if (location.pathname === '/downloads') return new URLSearchParams(location.search).get('path') || undefined;
  return undefined;
}

/** Home shortcuts retain their page depth until closed. Ordinary tabs use
 * spatial order; detail depth applies within the same workspace. */
export function resolveRouteMotion(from: RouteAddress | undefined, to: RouteAddress, compact: boolean, historyDirection: RouteDirection = 1): RouteMotion {
  const axis = compact ? 'x' : 'y';
  const none: RouteMotion = { kind: 'none', axis, direction: historyDirection };
  if (!from || to.state?.iosBackSettled) return none;
  const sourceOwner = navigationOwner(from.pathname);
  const targetOwner = navigationOwner(to.pathname);
  const sourceDetail = detailIdentity(from);
  const targetDetail = detailIdentity(to);
  // The same destination can be a bottom tab or a home shortcut. Only the
  // latter pushes a page above home; route order alone cannot distinguish it.
  if (from.pathname === '/' && to.state?.homeEntry && targetOwner !== '/') {
    return { ...none, kind: to.pathname === '/library' ? 'fade' : 'page-open' };
  }
  if (to.pathname === '/settings' && sourceOwner !== '/settings') return { ...none, kind: 'fade' };
  if (sourceOwner === '/settings' && !targetDetail
    && ['/library', '/history', '/watchlist', '/to-read'].includes(to.pathname)) return { ...none, kind: 'fade' };
  if (to.pathname === '/' && to.state?.navigationTab && sourceOwner !== '/') return { kind: 'slide', axis: 'x', direction: -1 };
  if (from.state?.homeEntry && sourceOwner !== targetOwner && (to.pathname === '/' || to.state?.navigationTab)) return { ...none, kind: 'page-close' };
  if (targetDetail && (sourceOwner !== targetOwner || sourceDetail !== targetDetail)) return { ...none, kind: 'detail-open' };
  if (sourceOwner === targetOwner && sourceDetail && !targetDetail) return { ...none, kind: 'detail-close' };
  if (from.pathname === to.pathname) return none;
  const sourceIndex = NAVIGATION_ROUTES.findIndex(path => path === sourceOwner);
  const targetIndex = NAVIGATION_ROUTES.findIndex(path => path === targetOwner);
  if (sourceOwner !== targetOwner && sourceIndex >= 0 && targetIndex >= 0) {
    return { kind: 'slide', axis: targetOwner === '/' ? 'x' : axis, direction: targetIndex > sourceIndex ? 1 : -1 };
  }
  // Editors and tools are drill-down routes, independent of the navigation rail.
  return { kind: 'slide', axis: 'x', direction: historyDirection };
}

// iOS-optimized motion: Material ease with iOS timing for instant feel
export const NAVIGATION_MOTION = { duration: 175, easing: 'cubic-bezier(.25, .1, .25, 1)' } as const;
// Detail transitions: longer entrance (320ms) for elegance, faster exit (170ms) for responsiveness
export const DETAIL_ENTER_MS = 320;
export const DETAIL_EXIT_MS = 170;

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
    // iOS-refined exit: scale to 0.92 (less than Android's 0.90) with smoother acceleration
    const origin = target ? `${Math.min(rect.width, Math.max(0, target.left + target.width / 2 - rect.left))}px ${Math.min(bottom, Math.max(top, target.top + target.height / 2)) - rect.top}px` : transformOrigin;
    // Swift continuous acceleration with gentler fade curve for iOS feel
    return panel.animate([
      { offset: 0, opacity: 1, transform: 'scale(1)', transformOrigin: origin },
      { offset: .18, opacity: 1, transform: 'scale(0.985)', transformOrigin: origin },
      { offset: 1, opacity: 0, transform: 'scale(0.92)', transformOrigin: origin },
    ], { duration: DETAIL_EXIT_MS, easing: 'cubic-bezier(.36, 0, .66, .56)', fill: 'forwards' });
  }
  // iOS-tuned entrance: starts at 0.95 (tighter than Flutter's 0.85), two-stage curve
  // with swift initial expansion (45% in first 1/6) then gentle settle
  const start = .95;
  const end = 1;
  return panel.animate([
    { offset: 0, opacity: 0, transform: `scale(${start})`, transformOrigin, easing: 'cubic-bezier(.06, 0, .15, .08)' },
    { offset: 1 / 6, opacity: .42, transform: `scale(${start + (end - start) * .45})`, transformOrigin, easing: 'cubic-bezier(.22, .84, .28, 1)' },
    { offset: 1, opacity: 1, transform: `scale(${end})`, transformOrigin },
  ], { duration: DETAIL_ENTER_MS, easing: 'linear', fill: 'none' });
}
