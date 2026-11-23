import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { resolveRouteMotion, routeMotionAllowed } from './routeMotion';
import { closeTopOverlay, hasBackOverlay, topBackGestureSurface } from './overlayBackGuard';
import { isIosBackEdge, isMobileDevice } from './layoutMode';

export const MOBILE_BACK_EVENT = 'yomika-mobile-back';

export function pageRoot(path: string): string {
  if (path === '/' || path.startsWith('/home/')) return '/';
  const section = path.split('/')[1];
  if (section === 'tools' || section === 'dedup') return '/more';
  return `/${section}`;
}

/** A section opened by the reader belongs to that reading excursion. */
export function readerSettingsOrigin(url: string, returnTo: unknown): string | undefined {
  const [path, query] = url.split('?');
  return path === '/settings' && new URLSearchParams(query).get('section') === 'reading'
    && typeof returnTo === 'string' && returnTo.startsWith('/reader/') ? returnTo : undefined;
}

export class PageBackHistory {
  private pages = new Map<string, string[]>();
  private owner = '/';
  private homeEntries = new Set<string>();

  visit(url: string, returnTo?: string, homeEntry = false, navigationTab = false): void {
    const path = url.split('?')[0]!;
    // Reader/editor routes belong to the page which opened them, even if their
    // route prefix is /library or /reader. Never inherit another tab's stack.
    const leaf = path.startsWith('/reader/') || path.endsWith('/edit') || Boolean(readerSettingsOrigin(url, returnTo));
    const owner = leaf ? (returnTo ? this.ownerFor(returnTo) : this.owner) : pageRoot(path);
    // Home shortcuts open a page excursion; bottom tabs explicitly select an
    // independent workspace and must never inherit that excursion later.
    if (navigationTab || (owner !== this.owner && !homeEntry)) this.homeEntries.delete(owner);
    if (homeEntry && owner !== '/') {
      this.homeEntries.add(owner);
      this.pages.set(owner, [owner]);
    }
    const stack = this.pages.get(owner) ?? [owner];
    const existing = stack.indexOf(url);
    if (existing >= 0) stack.splice(existing + 1);
    else stack.push(url);
    this.pages.set(owner, stack);
    this.owner = owner;
  }

  private ownerFor(url: string): string {
    for (const [owner, stack] of this.pages) if (stack.includes(url)) return owner;
    return pageRoot(url.split('?')[0]!);
  }

  peekBack(): string | undefined {
    const stack = this.pages.get(this.owner);
    return stack && stack.length > 1 ? stack.at(-2) : this.homeEntries.has(this.owner) ? '/' : undefined;
  }

  back(): string | undefined {
    const stack = this.pages.get(this.owner);
    if (!stack || stack.length <= 1) {
      if (this.homeEntries.delete(this.owner)) return '/';
      return undefined;
    }
    stack.pop();
    return stack.at(-1);
  }
}

/** Android delivers Back as an app action, not WebView.goBack(): global browser
 * history mixes tabs, filter edits and overlay guards into one confusing stack. */
export function usePageBackNavigation(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const history = useRef(new PageBackHistory());
  const current = useRef({ url: '', state: null as unknown });
  useLayoutEffect(() => {
    const state = location.state as { returnTo?: string; homeEntry?: boolean; navigationTab?: boolean } | null;
    history.current.visit(`${location.pathname}${location.search}`, state?.returnTo, state?.homeEntry, state?.navigationTab);
    current.current = { url: `${location.pathname}${location.search}${location.hash}`, state: window.history.state };
  }, [location]);
  useLayoutEffect(() => {
    const back = (event: Event) => {
      if (closeTopOverlay(event instanceof CustomEvent && event.detail?.iosBack ? event.detail.offset : undefined)) {
        event.preventDefault();
        return;
      }
      const target = history.current.back();
      // Unhandled root Back lets Android's host move the task to the background.
      if (!target) return;
      event.preventDefault();
      navigate(target, { replace: true, state: { routeDirection: -1, ...(event instanceof CustomEvent && event.detail?.iosBack ? { iosBack: true, iosBackOffset: event.detail.offset } : {}) } });
    };
    window.addEventListener(MOBILE_BACK_EVENT, back);
    // WKWebView/browser gestures still deliver POP. Stop cross-tab browser
    // history before the router sees it and use the same page-scoped action.
    // Same-URL entries belong to overlay guards and must pass through normally.
    const pop = (event: PopStateEvent) => {
      if (!isMobileDevice()) return;
      const url = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (url === current.current.url) return;
      event.stopImmediatePropagation();
      window.history.replaceState(current.current.state, '', current.current.url);
      back(event);
    };
    window.addEventListener('popstate', pop, true);
    // WKWebView has no hardware Back action. Use the same page stack as Android,
    // so one edge gesture dismisses the top overlay or returns within this tab.
    let edge: { id: number; x: number; y: number; horizontal: boolean; surface?: HTMLElement | undefined } | undefined;
    const clearEdge = () => {
      const previous = edge;
      edge = undefined;
      return previous;
    };
    const cancelEdge = () => {
      const surface = clearEdge()?.surface;
      if (!surface) return;
      const from = surface.style.translate;
      surface.style.removeProperty('translate');
      surface.animate?.([{ translate: from }, { translate: '0px' }], { duration: 160, easing: 'ease-out' });
    };
    const edgeStart = (event: TouchEvent) => {
      cancelEdge();
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || !isIosBackEdge(touch.clientX)) return;
      edge = { id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false };
    };
    const edgeMove = (event: TouchEvent) => {
      if (!edge) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch?.identifier !== edge.id) { cancelEdge(); return; }
      const dx = touch.clientX - edge.x;
      const dy = Math.abs(touch.clientY - edge.y);
      if (!edge.horizontal) {
        if (Math.max(Math.abs(dx), dy) < 8) return;
        if (dx <= dy * 1.4) { clearEdge(); return; }
        edge.horizontal = true;
        if (routeMotionAllowed()) {
          const target = history.current.peekBack();
          if (hasBackOverlay()) edge.surface = topBackGestureSurface() ?? undefined;
          else if (target && !current.current.url.startsWith('/reader/')) {
            const from = new URL(current.current.url, window.location.origin);
            const to = new URL(target, window.location.origin);
            const motion = resolveRouteMotion(from, { pathname: to.pathname, search: to.search, state: { iosBack: true } }, true, -1);
            const panel = document.querySelector<HTMLElement>('.workspace > .route-cache-panel:not([hidden])');
            edge.surface = (motion.kind === 'detail-close' ? panel?.querySelector<HTMLElement>('.library-shell-detail') : panel) ?? undefined;
          }
        }
      }
      if (event.cancelable) event.preventDefault();
      if (edge.surface) edge.surface.style.translate = `${Math.max(0, dx)}px`;
    };
    const edgeEnd = (event: TouchEvent) => {
      const start = edge;
      if (!start?.horizontal) { cancelEdge(); return; }
      const touch = event.changedTouches[0];
      if (touch?.identifier !== start.id) { cancelEdge(); return; }
      const dx = touch.clientX - start.x;
      if (dx < 56 || dx <= Math.abs(touch.clientY - start.y) * 1.4) { cancelEdge(); return; }
      const offset = parseFloat(start.surface?.style.translate ?? '') || 0;
      const surface = clearEdge()?.surface;
      const handled = !window.dispatchEvent(new CustomEvent(MOBILE_BACK_EVENT, { cancelable: true, detail: { iosBack: true, offset } }));
      // Allow the destination's layout effect to take ownership before clearing the drag.
      if (surface) requestAnimationFrame(() => {
        if (surface.style.translate === `${offset}px`) surface.style.removeProperty('translate');
      });
      if (handled && event.cancelable) event.preventDefault();
    };
    window.addEventListener('touchstart', edgeStart, { capture: true, passive: true });
    window.addEventListener('touchmove', edgeMove, { capture: true, passive: false });
    window.addEventListener('touchend', edgeEnd, { capture: true, passive: false });
    window.addEventListener('touchcancel', cancelEdge, true);
    return () => {
      cancelEdge();
      window.removeEventListener(MOBILE_BACK_EVENT, back);
      window.removeEventListener('popstate', pop, true);
      window.removeEventListener('touchstart', edgeStart, true);
      window.removeEventListener('touchmove', edgeMove, true);
      window.removeEventListener('touchend', edgeEnd, true);
      window.removeEventListener('touchcancel', cancelEdge, true);
    };
  }, [navigate]);
}
