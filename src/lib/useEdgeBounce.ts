import { useEffect, type RefObject } from 'react';

/** Excessive sibling surfaces degrade to native scrolling rather than blocking input. */
const MAX_BOUNCE_SURFACES = 16;

/** Non-refresh pages share edge feedback; library lists keep their own pull owner. */
export function useEdgeBounce(workspace: RefObject<HTMLElement>, route: string) {
  useEffect(() => {
    const root = workspace.current;
    if (!root) return;
    let host: HTMLElement | undefined;
    let start: { x: number; y: number; edge: 1 | -1 | undefined } | undefined;
    let claimed = false;
    let claimedScrollTop = 0;
    let settle: number | undefined;
    let frame: number | undefined;
    let queued = false;
    let pendingOffset = 0;
    let surfaces: Array<{ element: HTMLElement; top: string; position: string; transition: string; translate: string; safe: boolean; relative: boolean; baseTop: number }> = [];
    const paint = (offset: number, settling = false) => {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      for (const surface of surfaces) {
        const property = surface.safe ? 'translate' : 'top';
        surface.element.style.transition = settling && !reduced ? `${property} 200ms cubic-bezier(.2, .8, .2, 1)` : 'none';
        if (surface.safe) surface.element.style.translate = `0 ${offset}px`;
        else surface.element.style.top = `${surface.baseTop + offset}px`;
      }
    };
    const schedulePaint = (offset: number) => {
      pendingOffset = offset;
      if (queued) return;
      queued = true;
      frame = window.requestAnimationFrame(() => { queued = false; frame = undefined; paint(pendingOffset); });
    };
    const observer = new MutationObserver(() => reset());
    const reset = () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined; queued = false;
      if (settle !== undefined) window.clearTimeout(settle);
      settle = undefined;
      for (const surface of surfaces) {
        surface.element.style.top = surface.top;
        surface.element.style.translate = surface.translate;
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
        // Horizontal rails defer axis ownership until the first decisive move.
        const rail = node.matches('.archive-rail-grid, [data-horizontal-scroll]') || node.scrollWidth > node.clientWidth + 1;
        if (rail && node !== root && !node.matches('[data-scroll-region]')) continue;
        if (node === root || node.matches('[data-scroll-region]')) {
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') { scroller = node; break; }
        } else if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return;
        if (node === root) break;
      }
      if (!scroller) return;
      const edge = scroller.scrollTop <= 0 ? 1 : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 ? -1 : undefined;

      host = scroller;
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY, edge };
    };
    const touchMove = (event: TouchEvent) => {
      if (!host || !start) return;
      if (event.touches.length !== 1) { reset(); return; }
      const touch = event.touches[0]!;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!start.edge) {
        // Native scrolling may reach an edge during this gesture. Rebase there;
        // if the browser can no longer cancel, leave the gesture native.
        const edge = host.scrollTop <= 0 && dy > 0 ? 1 : host.scrollTop + host.clientHeight >= host.scrollHeight - 1 && dy < 0 ? -1 : undefined;
        if (!edge) return;
        start = { x: touch.clientX, y: touch.clientY, edge };
        return;
      }
      if (claimed && (!event.cancelable || host.scrollTop !== claimedScrollTop)) { reset(); return; }
      const travel = dy * start.edge;
      if (!claimed) {
        if (Math.abs(dx) > Math.abs(dy) || travel < 0) { reset(); return; }
        if (travel < 12) return;
        if (!event.cancelable) { reset(); return; }
        if (host.children.length > MAX_BOUNCE_SURFACES) { reset(); return; }
        claimed = true;
        claimedScrollTop = host.scrollTop;
        host.dataset.edgeBounce = 'dragging';
        // A menu/dialog inserted during drag or settling must never inherit a
        // translated containing block, even for one displayed frame.
        observer.observe(host, { childList: true, subtree: true });
        // Structural visual contract: only leaf surfaces may translate. Content
        // containers always use relative top, so even hidden/future fixed children
        // remain viewport anchored without inspecting their descendants. The
        // childList observer invalidates a translated leaf before it gains children.
        // Read only the bounded set of direct surfaces, never the content tree.
        surfaces = [];
        for (const element of host.children) {
          if (!(element instanceof HTMLElement) || element.hidden) continue;
          const style = getComputedStyle(element);
          if (style.position === 'fixed') continue;
          const safe = element.childElementCount === 0 && (!style.translate || style.translate === 'none');
          surfaces.push({ element, top: element.style.top, position: element.style.position, transition: element.style.transition, translate: element.style.translate, safe, relative: style.position === 'static' || !style.position, baseTop: parseFloat(style.top) || 0 });
        }
        for (const surface of surfaces) {
          if (!surface.safe && surface.relative) surface.element.style.position = 'relative';
        }
      }
      if (event.cancelable) event.preventDefault();
      schedulePaint(start.edge * Math.min(80, Math.max(0, travel) * 0.5));
    };
    const touchEnd = () => {
      if (!host || !claimed) { reset(); return; }
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined; queued = false;
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
