import { EDGE_CLAIM_PX, EDGE_SETTLE_EASING, EDGE_SETTLE_MS, rubberBand } from './motion';

/** Move one content layer inside the stationary scrollport. Native scrolling
 * retains both axes until an outward horizontal drag reaches an edge. */
export function installHorizontalEdgeBounce(element: HTMLElement) {
  const track = element.querySelector<HTMLElement>(':scope > [data-horizontal-content]');
  const originalTranslate = track?.style.translate ?? '';
  const originalTransition = track?.style.transition ?? '';
  let frame: number | undefined;
  let timer: number | undefined;
  let offset = 0;
  let active = false;
  let bound = 0;
  let wheelTravel = 0;
  let gesture: { x: number; y: number; lastX: number; edge: 1 | -1 | undefined; rejected: boolean } | undefined;
  const clear = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    frame = timer = undefined;
    active = false;
    wheelTravel = 0;
    if (track) { track.style.translate = originalTranslate; track.style.transition = originalTransition; }
  };
  const maxScroll = () => active ? bound : Math.max(0, element.scrollWidth - element.clientWidth);
  const pull = (overflow: number) => {
    if (!track) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!active) bound = Math.max(0, element.scrollWidth - element.clientWidth);
    active = true;
    offset = rubberBand(-overflow, 64);
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      track.style.transition = 'none';
      track.style.translate = `${offset}px 0`;
    });
  };
  const release = () => {
    if (!active || !track) return;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { clear(); return; }
    // iOS-optimized horizontal bounce settle with refined curve
    track.style.transition = `translate ${EDGE_SETTLE_MS}ms ${EDGE_SETTLE_EASING}`;
    track.style.translate = originalTranslate || '0px 0';
    timer = window.setTimeout(clear, EDGE_SETTLE_MS);
  };
  const cancel = () => { gesture = undefined; clear(); };
  const start = (event: TouchEvent) => {
    cancel();
    if (!track || event.touches.length !== 1 || element.scrollWidth <= element.clientWidth + 1) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [role="slider"]')) return;
    const touch = event.touches[0]!;
    bound = Math.max(0, element.scrollWidth - element.clientWidth);
    const edge = element.scrollLeft <= 1 ? 1 : element.scrollLeft >= bound - 1 ? -1 : undefined;
    gesture = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, edge, rejected: false };
  };
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    if (event.touches.length !== 1) { cancel(); return; }
    const touch = event.touches[0]!;
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    const step = touch.clientX - gesture.lastX;
    gesture.lastX = touch.clientX;
    if (gesture.rejected) return;
    // iOS-refined: use optimized 3px claim threshold for immediate horizontal bounce response
    if (!active && Math.max(Math.abs(dx), Math.abs(dy)) < EDGE_CLAIM_PX) return;
    if (!active && Math.abs(dy) >= Math.abs(dx)) { gesture.rejected = true; return; }
    if (!gesture.edge) {
      const edge = element.scrollLeft <= 1 && step > 0 ? 1
        : element.scrollLeft >= bound - 1 && step < 0 ? -1 : undefined;
      if (!edge) return;
      gesture.edge = edge;
      // Rebase where native scrolling reached the boundary, without a jump.
      gesture.x = touch.clientX;
      return;
    }
    const travel = (touch.clientX - gesture.x) * gesture.edge;
    if (travel <= 0) { clear(); gesture.edge = undefined; gesture.x = touch.clientX; return; }
    const stillAtEdge = gesture.edge === 1 ? element.scrollLeft <= 1 : element.scrollLeft >= bound - 1;
    if (!stillAtEdge) { cancel(); return; }
    pull(-gesture.edge * travel);
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  };
  const end = () => { gesture = undefined; release(); };
  element.addEventListener('touchstart', start, { passive: true });
  element.addEventListener('touchmove', move, { passive: false });
  element.addEventListener('touchend', end, { passive: true });
  element.addEventListener('touchcancel', cancel, { passive: true });
  window.addEventListener('blur', cancel);
  const visibility = () => { if (document.visibilityState === 'hidden') cancel(); };
  document.addEventListener('visibilitychange', visibility);
  return {
    pull, release, reset: cancel, maxScroll,
    isActive: () => active,
    wheel(overflow: number) {
      if (wheelTravel * overflow < 0) wheelTravel = 0;
      wheelTravel += overflow;
      pull(wheelTravel);
      timer = window.setTimeout(release, 140);
    },
    dispose() {
      cancel();
      element.removeEventListener('touchstart', start);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', cancel);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
