import type { Location } from 'react-router-dom';

export const DETAIL_RETURN_PREVIEW = 'yomika:detail-return-preview';
export const DETAIL_RETURN_ALIGNED = 'yomika:detail-return-aligned';
const origins = new Map<string, { node: WeakRef<HTMLAnchorElement>; top: number; viewportWidth: number }>();
const identity = (location: Pick<Location, 'pathname' | 'search'>) => `${location.pathname}:${new URLSearchParams(location.search).get('server') ?? ''}:${location.pathname === '/downloads' ? new URLSearchParams(location.search).get('path') ?? '' : ''}`;

/** Remember the actual link, so a restored/resized list supplies fresh geometry. */
export function installDetailOrigins() {
  const capture = (event: MouseEvent) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || !anchor.closest('.mobile-home-topbar') && !/^\/(home|library|history|watchlist|to-read)\/[^/]+$/.test(url.pathname) && !(url.pathname === '/downloads' && url.searchParams.has('path'))) return;
    const key = identity(url);
    origins.delete(key);
    origins.set(key, { node: new WeakRef(anchor), top: anchor.getBoundingClientRect().top, viewportWidth: window.innerWidth });
    if (origins.size > 64) origins.delete(origins.keys().next().value!);
  };
  document.addEventListener('click', capture, true);
  return () => { document.removeEventListener('click', capture, true); origins.clear(); };
}

export function detailReturnTarget(location: Pick<Location, 'pathname' | 'search'>): DOMRect | undefined {
  const origin = origins.get(identity(location));
  const node = origin?.node.deref();
  if (!node?.isConnected || node.closest('[hidden]')) return undefined;
  let rect = node.getBoundingClientRect();
  // A split list may have changed height while details were open. Align the
  // same card after restoring full width, not a stale raw scrollTop alone.
  if (rect.width > 0 && origin?.viewportWidth === window.innerWidth) {
    let scroller = node.parentElement;
    while (scroller) {
      if (scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
        const behavior = scroller.style.scrollBehavior;
        scroller.style.scrollBehavior = 'auto';
        scroller.scrollTop += rect.top - origin.top;
        scroller.style.scrollBehavior = behavior;
        rect = node.getBoundingClientRect();
        break;
      }
      scroller = scroller.parentElement;
    }
    document.dispatchEvent(new CustomEvent(DETAIL_RETURN_ALIGNED));
  }
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight ? rect : undefined;
}

/** Freeze the live detail in viewport coordinates before revealing the existing
 * list behind it. The visible slice stays identical even deep in a long page. */
export function prepareDetailReturn(panel: HTMLElement, detail: HTMLElement, wholePage = false): () => void {
  const rect = detail.getBoundingClientRect();
  const viewport = panel.closest('.workspace')?.getBoundingClientRect();
  const previous = detail.getAttribute('style');
  // A short page still owns the entire canvas. For whole-page returns include
  // workspace gutters, preserving the content's old position with padding.
  // Otherwise the home page leaks through below/above the settings content
  // before the foreground has even started shrinking.
  const left = wholePage && viewport ? Math.min(rect.left, viewport.left) : rect.left;
  const top = wholePage && viewport ? Math.min(rect.top, viewport.top) : rect.top;
  const right = wholePage && viewport ? Math.max(rect.right, viewport.right) : rect.right;
  const bottom = Math.max(rect.bottom, viewport?.bottom ?? window.innerHeight);
  const padding = wholePage ? getComputedStyle(detail) : undefined;
  const insets = padding ? {
    paddingLeft: `${(parseFloat(padding.paddingLeft) || 0) + rect.left - left}px`,
    paddingRight: `${(parseFloat(padding.paddingRight) || 0) + right - rect.right}px`,
    paddingTop: `${(parseFloat(padding.paddingTop) || 0) + rect.top - top}px`,
  } : {};
  Object.assign(detail.style, {
    position: 'fixed', left: `${left}px`, top: `${top}px`,
    width: `${right - left}px`, height: `${bottom - top}px`, boxSizing: 'border-box',
    ...insets, maxWidth: 'none',
    // A live page transition sits above content, below persistent navigation.
    // Menu-level stacking made the shrinking canvas briefly cover the dock.
    margin: '0', maxHeight: 'none', overflow: 'hidden', zIndex: 'var(--z-route-transition)',
    clipPath: `inset(${Math.max(0, (viewport?.top ?? 0) - top)}px 0 ${Math.max(0, bottom - (viewport?.bottom ?? window.innerHeight))}px 0)`,
  });
  const attribute = wholePage ? 'data-page-return' : 'data-detail-return';
  panel.setAttribute(attribute, '');
  panel.setAttribute('inert', '');
  return () => {
    if (previous === null) detail.removeAttribute('style');
    else detail.setAttribute('style', previous);
    panel.removeAttribute(attribute);
    panel.removeAttribute('inert');
  };
}
