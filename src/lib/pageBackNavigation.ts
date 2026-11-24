import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { routeMotionAllowed } from './routeMotion';
import { closeTopOverlay, hasBackOverlay, topBackGesturePreview, topBackGestureSurface } from './overlayBackGuard';
import { isIosBackEdge, isMobileDevice } from './layoutMode';

export const MOBILE_BACK_EVENT = 'yomika-mobile-back';
export const IOS_BACK_PREVIEW = 'yomika-ios-back-preview';

function stageBackPreview(target?: string) {
  document.dispatchEvent(new CustomEvent(IOS_BACK_PREVIEW, { detail: target }));
}

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
    let owner = pageRoot(path);
    if (leaf && returnTo) owner = this.ownerFor(returnTo);
    else if (leaf && this.pages.size > 0) owner = this.owner;
    else if (owner === '/reader') owner = '/library';
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
      if (closeTopOverlay()) {
        event.preventDefault();
        return;
      }
      const target = history.current.back();
      // Unhandled root Back lets Android's host move the task to the background.
      if (!target) return;
      event.preventDefault();
      navigate(target, { replace: true, state: { routeDirection: -1, ...(event instanceof CustomEvent && event.detail?.iosBack ? { iosBackSettled: event.detail.settled === true } : {}) } });
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
    type Edge = {
      id: number; x: number; y: number; horizontal: boolean;
      target?: string; surface?: HTMLElement; preview?: HTMLElement;
      width?: number; offset?: number; overlay?: boolean; hideOverlayPreview?: () => void;
    };
    let edge: Edge | undefined;
    let interruptSettlement: (() => void) | undefined;
    const dispatchBack = (settled = false) => !window.dispatchEvent(new CustomEvent(MOBILE_BACK_EVENT, {
      cancelable: true, detail: { iosBack: true, settled },
    }));
    const translate = (offset: number) => `translate3d(${offset}px, 0, 0)`;
    const cleanGesture = ({ surface, preview, target, hideOverlayPreview }: Edge) => {
      surface?.style.removeProperty('transform');
      surface?.removeAttribute('data-ios-back-foreground');
      preview?.style.removeProperty('transform');
      if (target) stageBackPreview();
      hideOverlayPreview?.();
    };
    const settle = (gesture: Edge, commit: boolean) => {
      const { surface, preview, target, overlay, offset = 0, width = window.innerWidth } = gesture;
      const end = commit ? width : 0;
      const duration = commit ? 235 : 190;
      const options = { duration, easing: 'cubic-bezier(.22, .7, .22, 1)', fill: 'both' } as const;
      // Drag and release drive the same transform on both layers. Hold the
      // final frame until React has switched the foreground and its chrome.
      const animations = [
        surface?.animate?.([{ transform: translate(offset) }, { transform: translate(end) }], options),
        preview?.animate?.([{ transform: translate((offset - width) * .26) }, { transform: translate((end - width) * .26) }], options),
      ].filter((animation): animation is Animation => Boolean(animation));
      let timer: number | undefined;
      let remaining = animations.length;
      let finished = false;
      const finish = (advance: boolean) => {
        if (finished) return;
        finished = true;
        interruptSettlement = undefined;
        clearTimeout(timer);
        for (const animation of animations) { animation.onfinish = null; animation.cancel(); }
        const canAdvance = overlay ? hasBackOverlay() : target === history.current.peekBack() && !hasBackOverlay();
        if (advance && commit && canAdvance) {
          flushSync(() => { cleanGesture(gesture); dispatchBack(true); });
        } else cleanGesture(gesture);
      };
      if (animations.length) {
        timer = window.setTimeout(() => finish(true), duration + 100);
        for (const animation of animations) animation.onfinish = () => {
          remaining -= 1;
          if (remaining === 0) finish(true);
        };
        interruptSettlement = () => finish(false);
      } else finish(true);
    };
    const cancelEdge = () => {
      const previous = edge;
      edge = undefined;
      if (previous?.surface) settle(previous, false);
    };
    const edgeStart = (event: TouchEvent) => {
      if (interruptSettlement) return;
      if (edge?.horizontal && event.touches.length !== 1) { cancelEdge(); return; }
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || !isIosBackEdge(touch.clientX)) return;
      // Record initial touch with high-precision coordinates for sub-pixel tracking
      edge = { id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false };
    };
    const edgeMove = (event: TouchEvent) => {
      const gesture = edge;
      if (!gesture) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch?.identifier !== gesture.id) { cancelEdge(); return; }
      const dx = touch.clientX - gesture.x;
      const dy = Math.abs(touch.clientY - gesture.y);
      if (!gesture.horizontal) {
        // iOS-refined gesture recognition: 6px activation (faster than 8px),
        // 1.5 diagonal ratio (more forgiving than 1.4) for natural edge swipes
        if (Math.max(Math.abs(dx), dy) < 6) return;
        if (dx <= dy * 1.5) { edge = undefined; return; }
        gesture.horizontal = true;
        if (routeMotionAllowed()) {
          const target = history.current.peekBack();
          if (hasBackOverlay()) {
            const surface = topBackGestureSurface();
            const showPreview = topBackGesturePreview();
            if (surface) {
              gesture.surface = surface;
              gesture.overlay = true;
              gesture.width = surface.clientWidth || window.innerWidth;
            }
            if (surface && showPreview) {
              const preview = showPreview(true);
              if (preview) gesture.preview = preview;
              gesture.hideOverlayPreview = () => { showPreview(false); };
            }
          } else if (target && !target.startsWith('/reader/') && !current.current.url.startsWith('/reader/')) {
            const surface = document.getElementById('main-content')?.closest<HTMLElement>('.app-main');
            if (surface?.parentElement) {
              flushSync(() => stageBackPreview(target));
              const preview = surface.parentElement.querySelector<HTMLElement>('[data-ios-back-preview]');
              if (preview) {
                gesture.target = target;
                gesture.surface = surface;
                gesture.preview = preview;
                gesture.width = surface.clientWidth || window.innerWidth;
                surface.setAttribute('data-ios-back-foreground', '');
              } else stageBackPreview();
            }
          }
        }
      }
      if (event.cancelable) event.preventDefault();
      const width = gesture.width ?? window.innerWidth;
      const offset = Math.min(width, Math.max(0, dx));
      gesture.offset = offset;
      if (gesture.surface) gesture.surface.style.transform = translate(offset);
      if (gesture.preview) gesture.preview.style.transform = translate((offset - width) * .26);
    };
    const edgeEnd = (event: TouchEvent) => {
      const gesture = edge;
      if (!gesture?.horizontal) { cancelEdge(); return; }
      const touch = event.changedTouches[0];
      if (touch?.identifier !== gesture.id) { cancelEdge(); return; }
      const dx = touch.clientX - gesture.x;
      // iOS-refined threshold: 48px minimum swipe (tighter than 56px for quicker response),
      // 1.6 diagonal ratio (stricter than 1.4) to prevent accidental triggers on vertical scrolls
      if (dx < 48 || dx <= Math.abs(touch.clientY - gesture.y) * 1.6) { cancelEdge(); return; }
      edge = undefined;
      if (gesture.surface) {
        if (event.cancelable) event.preventDefault();
        settle(gesture, true);
      } else if (dispatchBack() && event.cancelable) event.preventDefault();
    };
    window.addEventListener('touchstart', edgeStart, { capture: true, passive: true });
    window.addEventListener('touchmove', edgeMove, { capture: true, passive: false });
    window.addEventListener('touchend', edgeEnd, { capture: true, passive: false });
    window.addEventListener('touchcancel', cancelEdge, true);
    return () => {
      interruptSettlement?.();
      if (edge) cleanGesture(edge);
      window.removeEventListener(MOBILE_BACK_EVENT, back);
      window.removeEventListener('popstate', pop, true);
      window.removeEventListener('touchstart', edgeStart, true);
      window.removeEventListener('touchmove', edgeMove, true);
      window.removeEventListener('touchend', edgeEnd, true);
      window.removeEventListener('touchcancel', cancelEdge, true);
    };
  }, [navigate, location.key]);
}
