import { useEffect, type RefObject } from 'react';

/** Non-refresh pages share edge feedback; library lists keep their own pull owner. */
export function useEdgeBounce(workspace: RefObject<HTMLElement>, route: string) {
  useEffect(() => {
    const root = workspace.current;
    if (!root) return;
    let host: HTMLElement | undefined;
    let start: { x: number; y: number; edge: 1 | -1 } | undefined;
    let claimed = false;
    let settle: number | undefined;
    let surfaces: Array<{ element: HTMLElement; top: string; position: string; transition: string; baseTop: number }> = [];
    const paint = (offset: number, settling = false) => {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      for (const surface of surfaces) {
        surface.element.style.transition = settling && !reduced ? 'top 200ms cubic-bezier(.2, .8, .2, 1)' : 'none';
        surface.element.style.top = `${surface.baseTop + offset}px`;
      }
    };
    const reset = () => {
      if (settle !== undefined) window.clearTimeout(settle);
      settle = undefined;
      for (const surface of surfaces) {
        surface.element.style.top = surface.top;
        surface.element.style.position = surface.position;
        surface.element.style.transition = surface.transition;
      }
      surfaces = [];
      if (host) delete host.dataset.edgeBounce;
      host = undefined; start = undefined; claimed = false;
    };
    const touchStart = (event: TouchEvent) => {
      reset();
      const target = event.target;
      if (!(target instanceof Element) || event.touches.length !== 1) return;
      if (target.closest('input, textarea, select, [contenteditable], [role="slider"], [role="dialog"], .library-workspace, .reader-screen, [hidden]')) return;
      let scroller: HTMLElement | undefined;
      for (let node = target as HTMLElement | null; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        // Horizontal rails and nested scrolling controls own the whole gesture.
        if (node.matches('.archive-rail-grid, [data-horizontal-scroll]') || ((style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1)) return;
        if (node === root || node.matches('[data-scroll-region]')) {
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') { scroller = node; break; }
        } else if (style.overflowY === 'auto' || style.overflowY === 'scroll') return;
        if (node === root) break;
      }
      if (!scroller) return;
      const edge = scroller.scrollTop <= 0 ? 1 : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 ? -1 : undefined;
      if (!edge) return;
      host = scroller;
      // Relative top moves content without making a containing block for fixed
      // menus/modals (transform or translate on the scroller would do that).
      surfaces = [...host.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hidden && getComputedStyle(child).position !== 'fixed').map((element) => {
        const style = getComputedStyle(element);
        const surface = { element, top: element.style.top, position: element.style.position, transition: element.style.transition, baseTop: parseFloat(style.top) || 0 };
        if (style.position === 'static' || !style.position) element.style.position = 'relative';
        return surface;
      });
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY, edge };
    };
    const touchMove = (event: TouchEvent) => {
      if (!host || !start) return;
      if (event.touches.length !== 1) { reset(); return; }
      const touch = event.touches[0]!;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const travel = dy * start.edge;
      if (!claimed) {
        if (Math.abs(dx) > Math.abs(dy) || travel < 0) { reset(); return; }
        if (travel < 12) return;
        claimed = true;
      }
      if (event.cancelable) event.preventDefault();
      host.dataset.edgeBounce = 'dragging';
      paint(start.edge * Math.min(80, Math.max(0, travel) * 0.5));
    };
    const touchEnd = () => {
      if (!host || !claimed) { reset(); return; }
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      host.dataset.edgeBounce = 'settling';
      paint(0, true);
      start = undefined; claimed = false;
      settle = window.setTimeout(reset, reduced ? 0 : 200);
    };
    const visibility = () => { if (document.visibilityState !== 'visible') reset(); };
    root.addEventListener('touchstart', touchStart, { passive: true });
    root.addEventListener('touchmove', touchMove, { passive: false });
    root.addEventListener('touchend', touchEnd, { passive: true });
    root.addEventListener('touchcancel', reset, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    return () => {
      reset();
      root.removeEventListener('touchstart', touchStart);
      root.removeEventListener('touchmove', touchMove);
      root.removeEventListener('touchend', touchEnd);
      root.removeEventListener('touchcancel', reset);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [workspace, route]);
}
