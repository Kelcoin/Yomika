import { useLayoutEffect, type RefObject } from 'react';
import { EDGE_CLAIM_PX, EDGE_SETTLE_EASING, EDGE_SETTLE_MS, rubberBand } from './motion';
import { isIosDevice } from './layoutMode';
import { createWheelMotion, isDiscreteWheel } from './wheelMotion';

/** Excessive sibling surfaces degrade to native scrolling rather than blocking input. */
const MAX_BOUNCE_SURFACES = 16;

/** Non-refresh pages share edge feedback; library lists keep their own pull owner. */
export function useEdgeBounce(workspace: RefObject<HTMLElement>, route: string) {
  useLayoutEffect(() => {
    const root = workspace.current;
    if (!root) return;
    let host: HTMLElement | undefined;
    let start: { x: number; y: number; edge: 1 | -1 | undefined } | undefined;
    let claimed = false;
    let claimedScrollTop = 0;
    let lastY = 0;
    let settle: number | undefined;
    let frame: number | undefined;
    let queued = false;
    let pendingOffset = 0;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const wheelMotion = createWheelMotion();
    let wheelPainting = false;
    let surfaces: Array<{ element: HTMLElement; top: string; position: string; transition: string; translate: string; safe: boolean; relative: boolean; baseTop: number }> = [];
    const paint = (offset: number, settling = false) => {
      for (const surface of surfaces) {
        const property = surface.safe ? 'translate' : 'top';
        if (settling) surface.element.style.transition = reduced ? 'none' : `${property} ${EDGE_SETTLE_MS}ms ${EDGE_SETTLE_EASING}`;
        else if (wheelPainting) surface.element.style.transition = reduced ? 'none' : `${property} 180ms cubic-bezier(.16,.7,.2,1)`;
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
    const observer = new MutationObserver((records) => {
      // Portal-only page surfaces may update cards/images while the finger is
      // down. That does not change their containing-block contract. Unknown
      // surfaces still reset before any newly inserted fixed child can paint.
      if (records.some((record) => record.target === host || surfaces.some((surface) => !surface.element.hasAttribute('data-bounce-surface') && surface.element.contains(record.target)))) reset();
    });
    const reset = () => {
      if (wheelRelease !== undefined) window.clearTimeout(wheelRelease);
      wheelRelease = undefined;
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
    let wheelRelease: number | undefined;
    let wheelTravel = 0;
    const begin = (target: EventTarget | null, x: number, y: number, wheel = false) => {
      reset();
      if (!(target instanceof Element)) return;
      if (target.closest('input, textarea, select, [contenteditable], [role="slider"], [role="dialog"], .reader-screen, [hidden]') || (!wheel && target.closest('.library-workspace'))) return;
      let scroller: HTMLElement | undefined;
      for (let node = target as HTMLElement | null; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        // Horizontal rails defer axis ownership until the first decisive move.
        const rail = node.matches('.archive-rail-grid, [data-horizontal-scroll]') || node.scrollWidth > node.clientWidth + 1;
        if (rail && node !== root && !node.matches('[data-scroll-region]')) continue;
        if (node === root || node.matches('[data-scroll-region]') || wheel && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') { scroller = node; break; }
        } else if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return;
        if (node === root) break;
      }
      if (!scroller) return;
      const edge = scroller.scrollTop <= 1 ? 1 : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 ? -1 : undefined;

      host = scroller;
      start = { x, y, edge };
      lastY = y;
    };
    const touchStart = (event: TouchEvent) => {
      if (route === '/settings' && isIosDevice()) return;
      wheelMotion.cancel();
      wheelPainting = false;
      if (wheelRelease !== undefined) window.clearTimeout(wheelRelease);
      if (event.touches.length !== 1) { reset(); return; }
      begin(event.target, event.touches[0]!.clientX, event.touches[0]!.clientY);
    };
    const move = (x: number, y: number, event: { cancelable: boolean; preventDefault: () => void }) => {
      if (!host || !start) return;
      const dx = x - start.x;
      const dy = y - start.y;
      const step = y - lastY;
      lastY = y;
      if (!start.edge) {
        // Rebase at the edge reached during native scrolling. The remaining
        // outward movement belongs to edge feedback, even if it is no longer
        // possible to cancel the browser's already-running scroll gesture.
        const edge = host.scrollTop <= 1 && step > 0 ? 1 : host.scrollTop + host.clientHeight >= host.scrollHeight - 1 && step < 0 ? -1 : undefined;
        if (!edge) return;
        start = { x, y, edge };
        return;
      }
      if (claimed && Math.abs(host.scrollTop - claimedScrollTop) > 1) {
        // Once native scrolling has reached an edge, later touchmoves are
        // noncancelable on Chromium. Edge feedback is still safe while the
        // scrollport stays at that edge; abandon it only if content moves away.
        const atEdge = start.edge === 1 ? host.scrollTop <= 1
          : host.scrollTop + host.clientHeight >= host.scrollHeight - 1;
        if (!atEdge) { reset(); return; }
        claimedScrollTop = host.scrollTop;
      }
      const travel = dy * start.edge;
      if (!claimed) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < EDGE_CLAIM_PX) return;
        if (Math.abs(dx) > Math.abs(dy)) { reset(); return; }
        if (travel < 0) { start = { x, y, edge: undefined }; return; }
        if (travel < EDGE_CLAIM_PX) return;
        const children = Array.from(host.children).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.hidden);
        if (children.length > MAX_BOUNCE_SURFACES) { reset(); return; }
        claimed = true;
        claimedScrollTop = host.scrollTop;
        host.dataset.edgeBounce = 'dragging';
        // A menu/dialog inserted during drag or settling must never inherit a
        // translated containing block, even for one displayed frame.
        observer.observe(host, { childList: true, subtree: true });
        // Structural visual contract: leaves and explicitly portal-only route
        // surfaces may translate. Unknown containers keep fixed-safe relative
        // top; the observer invalidates a leaf before it gains children.
        // Read only the bounded set of direct surfaces, never the content tree.
        surfaces = [];
        for (const element of children) {
          const style = getComputedStyle(element);
          if (style.position === 'fixed') continue;
          const safe = (element.childElementCount === 0 || element.hasAttribute('data-bounce-surface')) && (!style.translate || style.translate === 'none');
          surfaces.push({ element, top: element.style.top, position: element.style.position, transition: element.style.transition, translate: element.style.translate, safe, relative: style.position === 'static' || !style.position, baseTop: parseFloat(style.top) || 0 });
        }
        for (const surface of surfaces) {
          surface.element.style.transition = 'none';
          if (!surface.safe && surface.relative) surface.element.style.position = 'relative';
        }
      }
      if (event.cancelable) event.preventDefault();
      schedulePaint(start.edge * rubberBand(Math.max(0, travel)));
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) { reset(); return; }
      move(event.touches[0]!.clientX, event.touches[0]!.clientY, event);
    };
    const touchEnd = () => {
      if (!host || !claimed) { reset(); return; }
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined; queued = false;
      host.dataset.edgeBounce = 'settling';
      paint(0, true);
      start = undefined; claimed = false;
      settle = window.setTimeout(reset, reduced ? 0 : EDGE_SETTLE_MS);
    };
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || !event.cancelable || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return;
      // Horizontal rails own their wheel even when they have reached an end.
      const target = event.target instanceof Element ? event.target : undefined;
      if (target?.closest('.archive-rail-grid, [data-horizontal-scroll]')) return;
      const direction = event.deltaY < 0 ? 1 : -1;
      if (!host || !claimed || start?.edge !== direction) {
        begin(event.target, 0, 0, true);
        wheelTravel = 0;
      }
      if (!host || start?.edge !== direction) {
        if (host && !reduced && isDiscreteWheel(event)) {
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1;
          if (wheelMotion.push(host, event.deltaY * unit)) event.preventDefault();
        } else wheelMotion.cancel();
        reset(); return;
      }
      // Library has a dedicated pull-to-refresh owner; never translate it twice.
      if (target?.closest('.library-workspace')) { reset(); return; }
      wheelPainting = true;
      if (wheelRelease !== undefined) window.clearTimeout(wheelRelease);
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1;
      wheelTravel = Math.min(400, wheelTravel + Math.abs(event.deltaY) * unit);
      move(0, direction * wheelTravel, event);
      wheelRelease = window.setTimeout(() => { wheelRelease = undefined; touchEnd(); }, 280);
    };
    const visibility = () => { if (document.visibilityState !== 'visible') { wheelMotion.cancel(); reset(); } };
    root.addEventListener('wheel', wheel, { passive: false });
    root.addEventListener('pointerdown', wheelMotion.cancel, { passive: true });
    root.addEventListener('keydown', wheelMotion.cancel);
    root.addEventListener('touchstart', touchStart, { passive: true });
    root.addEventListener('touchmove', touchMove, { passive: false });
    root.addEventListener('touchend', touchEnd, { passive: true });
    root.addEventListener('touchcancel', reset, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    return () => {
      reset();
      wheelMotion.cancel();
      root.removeEventListener('pointerdown', wheelMotion.cancel);
      root.removeEventListener('keydown', wheelMotion.cancel);
      if (wheelRelease !== undefined) window.clearTimeout(wheelRelease);
      root.removeEventListener('wheel', wheel);
      root.removeEventListener('touchstart', touchStart);
      root.removeEventListener('touchmove', touchMove);
      root.removeEventListener('touchend', touchEnd);
      root.removeEventListener('touchcancel', reset);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [workspace, route]);
}
