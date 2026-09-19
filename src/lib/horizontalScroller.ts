import { useCallback, useEffect, useRef } from 'react';

/** How far a wheel moves the rail, or null when the rail must leave the event
 * alone and let the page have it.
 *
 * A wheel over the cards moves the rail — sideways input (a trackpad swipe, a
 * tilted wheel) and the plain vertical wheel alike. ctrl+wheel is zoom and stays
 * untouched; shift+wheel is the mouse's explicit sideways ask and follows the
 * axis Chromium reports. Which events reach here at all is decided per gesture
 * by `handleWheel`: a gesture that starts mid-rail belongs to the rail, one that
 * starts past either end belongs to the page.
 */
export function getHorizontalWheelDelta(
  event: Pick<WheelEvent, 'ctrlKey' | 'shiftKey' | 'deltaX' | 'deltaY'>,
  scrollWidth: number,
  clientWidth: number,
): number | null {
  if (event.ctrlKey || scrollWidth <= clientWidth + 1) return null;
  if (event.shiftKey) return event.deltaX !== 0 ? event.deltaX : event.deltaY;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  return delta === 0 ? null : delta;
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

/** Wheel events closer together than this belong to one gesture. Ownership of
 * the wheel is decided when the gesture starts and frozen until it settles —
 * see `handleWheel` for why the page may not join a gesture half way through. */
export const WHEEL_GESTURE_SETTLE_MS = 250;

export function useHorizontalScroller() {
  const elementRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState>({ active: false, element: null, startX: 0, startScrollLeft: 0, moved: false, suppressClickUntil: 0, previousUserSelect: '' });
  const gestureRef = useRef({ lastAt: 0, owns: false });

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
    // Ownership is per gesture, decided when the gesture starts and frozen until
    // the wheel settles: a gesture that begins mid-rail belongs to the rail even
    // after it runs out (otherwise the horizontal scroll dragged the page along
    // with it, half way through the same gesture), and a gesture that begins at
    // either end belongs to the page — the rails span nearly the whole viewport,
    // and only this keeps the page reachable from a pointer resting on the cards.
    const now = Date.now();
    const fresh = now - gestureRef.current.lastAt > WHEEL_GESTURE_SETTLE_MS;
    gestureRef.current.lastAt = now;
    const atStart = element.scrollLeft <= 0;
    const atEnd = element.scrollLeft >= element.scrollWidth - element.clientWidth - 1;
    if (fresh) gestureRef.current.owns = !((delta < 0 && atStart) || (delta > 0 && atEnd));
    if (!gestureRef.current.owns) return;
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
