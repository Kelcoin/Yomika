import { useEffect, useRef, type RefObject } from 'react';

/** A panel switch owns only deliberate horizontal single-finger gestures.
 * Native vertical scrolling, pinch zoom, editors and horizontal rails keep theirs. */
export function usePanelSwipe(ref: RefObject<HTMLElement>, onSwipe: (direction: 'left' | 'right') => void, enabled = true) {
  const callback = useRef(onSwipe);
  callback.current = onSwipe;
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let gesture: { x: number; y: number; dx: number; horizontal: boolean } | undefined;
    let suppressClickUntil = 0;
    const start = (event: TouchEvent) => {
      gesture = undefined;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (target?.closest('input, textarea, select, [contenteditable], [role="slider"], [data-horizontal-scroll], .archive-rail-grid')) return;
      gesture = { x: touch.clientX, y: touch.clientY, dx: 0, horizontal: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) { gesture = undefined; return; }
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.horizontal) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.25 || !event.cancelable) { gesture = undefined; return; }
        gesture.horizontal = true;
      }
      gesture.dx = dx;
      if (event.cancelable) event.preventDefault();
    };
    const end = () => {
      const current = gesture;
      gesture = undefined;
      if (!current?.horizontal) return;
      suppressClickUntil = performance.now() + 400;
      const threshold = Math.max(48, Math.min(80, element.clientWidth * .16));
      if (Math.abs(current.dx) >= threshold) callback.current(current.dx < 0 ? 'left' : 'right');
    };
    const cancel = () => { gesture = undefined; };
    const click = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
    };
    element.addEventListener('touchstart', start, { passive: true });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end, { passive: true });
    element.addEventListener('touchcancel', cancel, { passive: true });
    element.addEventListener('click', click, true);
    return () => {
      element.removeEventListener('touchstart', start);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', cancel);
      element.removeEventListener('click', click, true);
    };
  }, [ref, enabled]);
}
