import { useCallback, useEffect, useRef } from 'react';

/** How far a wheel moves the rail, or null when the rail must leave the event
 * alone and let the page have it.
 *
 * The rail takes a wheel that is actually going sideways — a trackpad swipe
 * (deltaX), or shift+wheel, which is how a mouse asks for it. It does *not* take a
 * plain vertical wheel. Converting that was the old behaviour, and it trapped the
 * page: the rails span nearly the whole viewport, so with the pointer anywhere over
 * the cards a vertical wheel moved the strip sideways instead of scrolling, and the
 * only way down a page was to aim at the margin beside the rails.
 */
export function getHorizontalWheelDelta(
  event: Pick<WheelEvent, 'ctrlKey' | 'shiftKey' | 'deltaX' | 'deltaY'>,
  scrollWidth: number,
  clientWidth: number,
): number | null {
  if (event.ctrlKey || scrollWidth <= clientWidth + 1) return null;
  if (event.shiftKey) return event.deltaX !== 0 ? event.deltaX : event.deltaY;
  return Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : null;
}

type DragState = {
  active: boolean;
  element: HTMLElement | null;
  startX: number;
  startScrollLeft: number;
  moved: boolean;
  suppressClickUntil: number;
  previousUserSelect: string;
};

export function useHorizontalScroller() {
  const elementRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState>({ active: false, element: null, startX: 0, startScrollLeft: 0, moved: false, suppressClickUntil: 0, previousUserSelect: '' });

  const finishDrag = useCallback(() => {
    const state = dragRef.current;
    if (!state.active) return;
    state.active = false;
    if (state.element) state.element.style.cursor = '';
    document.body.style.userSelect = state.previousUserSelect;
    window.removeEventListener('mousemove', handleWindowMouseMove);
    window.removeEventListener('mouseup', finishDrag);
    window.removeEventListener('blur', finishDrag);
  }, []);

  const handleWindowMouseMove = useCallback((event: MouseEvent) => {
    const state = dragRef.current;
    if (!state.active || !state.element) return;
    const delta = event.clientX - state.startX;
    if (!state.moved && Math.abs(delta) < 4) return;
    state.moved = true;
    // A click that never arrives (pointer released outside the rail) must not
    // leave the suppression armed: a later keyboard activation produces a click
    // without a preceding mousedown and would be swallowed.
    state.suppressClickUntil = Date.now() + 300;
    state.element.scrollLeft = state.startScrollLeft - delta;
    if (event.cancelable) event.preventDefault();
  }, []);

  useEffect(() => () => finishDrag(), [finishDrag]);

  const handleWheel = useCallback((event: WheelEvent) => {
    const element = (event.currentTarget as HTMLElement | null) ?? elementRef.current;
    if (!element) return;
    const delta = getHorizontalWheelDelta(event, element.scrollWidth, element.clientWidth);
    if (delta === null) return;
    // Chain to the page at either end: a rail with no room left must not keep
    // swallowing the wheel — the home rails span nearly the whole viewport, and
    // the page behind them would never scroll again.
    const atStart = element.scrollLeft <= 0;
    const atEnd = element.scrollLeft >= element.scrollWidth - element.clientWidth - 1;
    if ((delta < 0 && atStart) || (delta > 0 && atEnd)) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    element.scrollLeft += delta * 2.4;
  }, []);

  const setRef = useCallback((element: HTMLElement | null) => {
    const previous = elementRef.current;
    if (previous === element) return;
    if (previous) previous.removeEventListener('wheel', handleWheel, true);
    elementRef.current = element;
    if (element) element.addEventListener('wheel', handleWheel, { capture: true, passive: false });
  }, [handleWheel]);

  const onMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth + 1) return;
    const element = event.currentTarget;
    dragRef.current = { active: true, element, startX: event.clientX, startScrollLeft: element.scrollLeft, moved: false, suppressClickUntil: 0, previousUserSelect: document.body.style.userSelect };
    document.body.style.userSelect = 'none';
    element.style.cursor = 'grabbing';
    window.addEventListener('mousemove', handleWindowMouseMove, { passive: false });
    window.addEventListener('mouseup', finishDrag, { passive: true });
    window.addEventListener('blur', finishDrag, { passive: true });
  }, [finishDrag, handleWindowMouseMove]);
  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const state = dragRef.current;
    if (state.suppressClickUntil === 0) return;
    const suppress = Date.now() <= state.suppressClickUntil;
    state.suppressClickUntil = 0;
    if (!suppress) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  }, []);
  const onDragStart = useCallback((event: React.DragEvent<HTMLElement>) => { if (event.cancelable) event.preventDefault(); }, []);

  return { ref: setRef, elementRef, onMouseDown, onClickCapture, onDragStart };
}
