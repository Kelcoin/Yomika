import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { DETAIL_RETURN_PREVIEW, prepareDetailReturn } from './detailReturn';
import { useLocation, useNavigate } from 'react-router-dom';
import { resolveRouteMotion, routeMotionAllowed } from './routeMotion';
import { closeTopOverlay, hasBackOverlay, topBackGesturePreview, topBackGestureSurface } from './overlayBackGuard';
import { isIosBackEdge, isMobileDevice } from './layoutMode';
import { pageKeyFor } from './pageKeys';

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

/** 返回手势拖到一半时，把「上一层」那一块已经挂着的页面露出来（用户 2026-11-24 第 1 项）。
 *
 * 路由缓存里每个页面都还在 DOM 里，只是 hidden。拖手时把它解除隐藏、按视口铺在下面，
 * 当前页滑开就能看见真正的上一层，而不是空白；松手取消就原样收回去，提交则交给
 * useWorkspaceRouteMotion 的 page-close 动画（它从 -26% 起步，正好接上这里的位置）。 */
export interface BackPreview { preview: HTMLElement; panel: HTMLElement }

export function revealBackPreview(panel: HTMLElement | null, key: string): BackPreview | undefined {
  if (!panel) return undefined;
  const preview = Array.from(panel.parentElement?.children ?? []).find((element): element is HTMLElement =>
    element instanceof HTMLElement && element.dataset.pageKey === key);
  if (!preview || preview === panel || !preview.hidden) return undefined;
  const workspace = preview.parentElement;
  const padding = workspace ? getComputedStyle(workspace) : undefined;
  preview.hidden = false;
  preview.setAttribute('data-back-preview', '');
  panel.setAttribute('data-back-foreground', '');
  preview.setAttribute('aria-hidden', 'true');
  preview.setAttribute('inert', '');
  if (padding) {
    preview.style.paddingTop = padding.paddingTop;
    preview.style.paddingRight = padding.paddingRight;
    preview.style.paddingLeft = padding.paddingLeft;
    preview.style.paddingBottom = '0px';
  }
  return { preview, panel };
}

export function releaseBackPreview(back: BackPreview | undefined, keepVisible: boolean): void {
  if (!back) return;
  const { preview, panel } = back;
  panel.removeAttribute('data-back-foreground');
  preview.removeAttribute('data-back-preview');
  preview.removeAttribute('aria-hidden');
  preview.removeAttribute('inert');
  preview.style.removeProperty('translate');
  for (const name of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']) preview.style.removeProperty(name);
  if (!keepVisible) preview.hidden = true;
}
function restoreWorkspaceScroll(surface: HTMLElement | undefined, top: number | undefined): void {
  const workspace = surface?.closest<HTMLElement>('.workspace');
  if (!workspace || top === undefined || workspace.scrollTop === top) return;
  const behavior = workspace.style.scrollBehavior;
  workspace.style.scrollBehavior = 'auto';
  workspace.scrollTop = top;
  workspace.style.scrollBehavior = behavior;
}

export function backParallax(surface: HTMLElement, offset: number): string {
  return `${Math.min(0, (offset - (surface.clientWidth || window.innerWidth)) * .26)}px`;
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
    let edge: { id: number; x: number; y: number; horizontal: boolean; surface?: HTMLElement | undefined; preview?: BackPreview | undefined; list?: HTMLElement | undefined; restoreDetail?: (() => void) | undefined; temporary?: boolean; workspaceScroll?: number; hideOverlayPreview?: () => void } | undefined;
    const clearEdge = () => {
      const previous = edge;
      edge = undefined;
      return previous;
    };
    const cancelEdge = () => {
      const previous = clearEdge();
      const surface = previous?.surface;
      if (!previous || !surface) return;
      const clean = () => {
        releaseBackPreview(previous.preview, false);
        previous.list?.style.removeProperty('translate');
        previous.restoreDetail?.();
        previous.hideOverlayPreview?.();
        restoreWorkspaceScroll(surface, previous.workspaceScroll);
        if (previous.temporary) stageBackPreview();
      };
      const from = surface.style.translate;
      surface.style.removeProperty('translate');
      const animation = from && surface.animate?.([{ translate: from }, { translate: '0px' }], { duration: 160, easing: 'ease-out' });
      if (animation) {
        const underneath = previous.list ?? previous.preview?.preview;
        const backdrop = underneath?.style.translate && underneath.animate?.([
          { translate: underneath.style.translate }, { translate: backParallax(underneath, 0) },
        ], { duration: 160, easing: 'ease-out', fill: 'forwards' });
        const finish = () => {
          finishCancellation = undefined;
          if (backdrop) backdrop.cancel();
          clean();
        };
        animation.onfinish = finish;
        finishCancellation = () => { animation.cancel(); finish(); };
      } else clean();
    };
    let finishCancellation: (() => void) | undefined;
    const edgeStart = (event: TouchEvent) => {
      finishCancellation?.();
      finishCancellation = undefined;
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
          if (hasBackOverlay()) {
            edge.surface = topBackGestureSurface() ?? undefined;
            const showPreview = topBackGesturePreview();
            if (edge.surface && showPreview) {
              edge.list = showPreview(true) ?? undefined;
              edge.hideOverlayPreview = () => { showPreview(false); };
            }
          } else if (target && !current.current.url.startsWith('/reader/')) {
            const from = new URL(current.current.url, window.location.origin);
            const to = new URL(target, window.location.origin);
            const motion = resolveRouteMotion(from, { pathname: to.pathname, search: to.search, state: { iosBack: true } }, true, -1);
            const panel = document.querySelector<HTMLElement>('.workspace > .route-cache-panel:not([hidden])');
            edge.surface = (motion.kind === 'detail-close' ? panel?.querySelector<HTMLElement>('.library-shell-detail') : panel) ?? undefined;
            if (motion.kind === 'detail-close' && panel && edge.surface) {
              const workspace = panel.parentElement;
              if (workspace) edge.workspaceScroll = workspace.scrollTop;
              edge.restoreDetail = prepareDetailReturn(panel, edge.surface);
              edge.list = panel.querySelector<HTMLElement>('.library-shell-list') ?? undefined;
              document.dispatchEvent(new CustomEvent(DETAIL_RETURN_PREVIEW));
            } else if (motion.kind === 'page-close' && panel) {
              const key = pageKeyFor(to.pathname);
              const saved = Array.from(panel.parentElement?.children ?? []).find(node =>
                node instanceof HTMLElement && node.dataset.pageKey === key) as HTMLElement | undefined;
              if (saved && saved !== panel && (!saved.dataset.pageUrl || saved.dataset.pageUrl === target)) {
                edge.preview = revealBackPreview(panel, key);
              } else {
                flushSync(() => stageBackPreview(target));
                edge.preview = revealBackPreview(panel, 'ios-back');
                edge.temporary = Boolean(edge.preview);
                if (!edge.temporary) stageBackPreview();
              }
            }
          }
        }
      }
      if (event.cancelable) event.preventDefault();
      if (edge.surface) edge.surface.style.translate = `${Math.max(0, dx)}px`;
      const underneath = edge.list ?? edge.preview?.preview;
      if (underneath) underneath.style.translate = backParallax(underneath, Math.max(0, dx));
    };
    const edgeEnd = (event: TouchEvent) => {
      const start = edge;
      if (!start?.horizontal) { cancelEdge(); return; }
      const touch = event.changedTouches[0];
      if (touch?.identifier !== start.id) { cancelEdge(); return; }
      const dx = touch.clientX - start.x;
      if (dx < 56 || dx <= Math.abs(touch.clientY - start.y) * 1.4) { cancelEdge(); return; }
      const offset = parseFloat(start.surface?.style.translate ?? '') || 0;
      const previous = clearEdge();
      const surface = previous?.surface;
      const preview = previous?.preview;
      // Restore the outgoing layout before the route effect takes its own measurements.
      previous?.restoreDetail?.();
      if (previous?.restoreDetail) previous.list?.style.removeProperty('translate');
      restoreWorkspaceScroll(surface, previous?.workspaceScroll);
      const handled = !window.dispatchEvent(new CustomEvent(MOBILE_BACK_EVENT, { cancelable: true, detail: { iosBack: true, offset } }));
      // Allow the destination's layout effect to take ownership before clearing the drag.
      if (surface) requestAnimationFrame(() => {
        if (surface.style.translate === `${offset}px`) surface.style.removeProperty('translate');
      });
      // A handled Back leaves the revealed page on screen: the route motion animates it
      // from exactly this position, so only the drag's own inline styles must go away.
      if (preview && (!previous?.temporary || !handled)) requestAnimationFrame(() => releaseBackPreview(preview, handled));
      if (!handled) {
        previous?.hideOverlayPreview?.();
        if (previous?.temporary) stageBackPreview();
      }
      if (handled && event.cancelable) event.preventDefault();
    };
    window.addEventListener('touchstart', edgeStart, { capture: true, passive: true });
    window.addEventListener('touchmove', edgeMove, { capture: true, passive: false });
    window.addEventListener('touchend', edgeEnd, { capture: true, passive: false });
    window.addEventListener('touchcancel', cancelEdge, true);
    return () => {
      finishCancellation?.();
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
