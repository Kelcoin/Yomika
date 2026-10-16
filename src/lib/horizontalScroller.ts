import { useCallback, useEffect, useRef, type CSSProperties } from 'react';

/** 这台设备是不是「没有悬停、指针粗糙」。
 *
 * 参考实现（Readoshi 的 `ArchiveCard.jsx`）用它来分档：触摸设备走浏览器原生手势，
 * 鼠标设备才挂悬停/拖拽那一套。`jsdom` 里没有 `matchMedia`，所以这里必须能容错。 */
export const COARSE_POINTER_QUERY = '(hover: none), (pointer: coarse)';

export function usesCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/** 触摸设备上导轨的滚动样式：整段手势交给浏览器。
 *
 * 纵向拖拽归页面、横向拖拽归导轨，由浏览器按手势主方向择一——这不是 CSS 能替它决定
 * 的，所以这里**不**写 `touch-action: pan-x`（曾经就是它：导轨是 `overflow-x: auto`，
 * 另一轴的 computed 值跟着变成 `auto`，命中链上取交集后只剩 `pan-x`，手指落在导轨里
 * 纵向拖拽既不被浏览器当滚动、也不会交给 `.workspace`，读起来就是「触点落在组件内/
 * 档案卡片内无法滚动」）。
 *
 * 也不写 `touch-action: pan-x pan-y`：那等于顺手把双指缩放一起禁掉，而缩放该由浏览器
 * 决定。只把横向的 overscroll 收住（`overscroll-behavior-x: contain`），免得「继续往
 * 右划」被当成浏览器的返回手势。
 *
 * 与 Readoshi 的 `getTouchScrollStyle()` 逐项一致，这是刻意的：滚轮与触摸要分开对待，
 * 触摸这一路就该是原生的。 */
export function getTouchScrollStyle(): CSSProperties {
  return {
    touchAction: 'auto',
    WebkitOverflowScrolling: 'touch',
    overscrollBehaviorX: 'contain',
    overscrollBehaviorY: 'auto',
  };
}

/** 鼠标设备上导轨的样式：只有一个「可以抓着拖」的指针形状。
 *
 * 滚动本身仍由 `handleWheel` 那条路负责——鼠标没有触摸那套原生滚动，这是两种输入
 * 唯一的区别所在。 */
export function getMouseScrollStyle(): CSSProperties {
  return { cursor: 'grab' };
}

/** 上面两套样式用到的键：切换设备档时按这份清单先清空，免得留下另一档的值。 */
const POINTER_STYLE_KEYS = ['touchAction', 'WebkitOverflowScrolling', 'overscrollBehaviorX', 'overscrollBehaviorY', 'cursor'] as const;

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
  lastX: number;
  lastAt: number;
  velocity: number;
};

type PointerStyleWatch = {
  element: HTMLElement;
  media: MediaQueryList;
  listener: () => void;
};

/** Wheel events closer together than this belong to one gesture. Ownership of
 * the wheel is decided when the gesture starts and frozen until it settles —
 * see `handleWheel` for why the page may not join a gesture half way through. */
export const WHEEL_GESTURE_SETTLE_MS = 250;

export function useHorizontalScroller() {
  const elementRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState>({ active: false, element: null, startX: 0, startScrollLeft: 0, moved: false, suppressClickUntil: 0, previousUserSelect: '', lastX: 0, lastAt: 0, velocity: 0 });
  const coastRef = useRef<number>();
  const snapRef = useRef<{ element: HTMLElement; value: string }>();
  const restoreSnap = useCallback(() => {
    if (snapRef.current) snapRef.current.element.style.scrollSnapType = snapRef.current.value;
    snapRef.current = undefined;
  }, []);
  const stopCoast = useCallback(() => {
    if (coastRef.current !== undefined) window.cancelAnimationFrame(coastRef.current);
    coastRef.current = undefined;
    restoreSnap();
  }, [restoreSnap]);
  const gestureRef = useRef({ lastAt: 0, owns: false });
  const pointerStyleRef = useRef<PointerStyleWatch | null>(null);

  const finishDrag = useCallback((event?: Event) => {
    const state = dragRef.current;
    if (!state.active) return;
    state.active = false;
    if (state.element) state.element.style.cursor = usesCoarsePointer() ? '' : getMouseScrollStyle().cursor ?? '';
    document.body.style.userSelect = state.previousUserSelect;
    window.removeEventListener('mousemove', handleWindowMouseMove);
    window.removeEventListener('mouseup', finishDrag);
    window.removeEventListener('blur', finishDrag);
    if (event?.type !== 'mouseup' || !state.moved || !state.element || performance.now() - state.lastAt > 80 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { restoreSnap(); return; }
    const element = state.element;
    let velocity = Math.max(-2.5, Math.min(2.5, state.velocity));
    let previousAt = performance.now();
    const coast = (at: number) => {
      if (!element.isConnected || element.closest('[hidden]')) { stopCoast(); return; }
      const elapsed = Math.min(48, Math.max(0, at - previousAt));
      previousAt = at;
      const decay = Math.exp(-elapsed / 180);
      const before = element.scrollLeft;
      element.scrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, before + velocity * 180 * (1 - decay)));
      velocity *= decay;
      if (Math.abs(velocity) < .02 || element.scrollLeft === before) { stopCoast(); return; }
      coastRef.current = window.requestAnimationFrame(coast);
    };
    if (Math.abs(velocity) >= .02) coastRef.current = window.requestAnimationFrame(coast);
    else restoreSnap();
  }, [restoreSnap, stopCoast]);

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
    const now = performance.now();
    const elapsed = now - state.lastAt;
    if (elapsed > 0) state.velocity = (state.lastX - event.clientX) / elapsed;
    state.lastX = event.clientX;
    state.lastAt = now;
    state.element.scrollLeft = state.startScrollLeft - delta;
    if (event.cancelable) event.preventDefault();
  }, []);

  useEffect(() => {
    const cancel = () => { stopCoast(); finishDrag(); };
    const visibility = () => { if (document.visibilityState !== 'visible') cancel(); };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => { cancel(); window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', visibility); };
  }, [finishDrag, stopCoast]);

  const handleWheel = useCallback((event: WheelEvent) => {
    stopCoast();
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
  }, [stopCoast]);

  /** 按设备档把样式落到导轨上，并跟着设备档的变化改（插拔鼠标、切换平板模式）。
   *
   * 放在这里而不是 CSS 里，是因为要挑的那一套取决于「这台设备有没有悬停」，而
   * CSS 的 `@media (hover: none)` 与 `matchMedia('(hover: none), (pointer: coarse)')`
   * 不是一回事：参考实现用的是后者（触屏笔记本带鼠标时，只有后者会说「粗指针」）。 */
  const applyPointerStyle = useCallback((element: HTMLElement) => {
    const style = usesCoarsePointer() ? getTouchScrollStyle() : getMouseScrollStyle();
    // 先清掉另一档留下的键，再落这一档的：设备档会变（插拔鼠标、切换平板模式），
    // 只加不减会把触摸那套 `touch-action: auto` 留在鼠标设备上。
    for (const key of POINTER_STYLE_KEYS) {
      (element.style as unknown as Record<string, string>)[key] = '';
    }
    for (const [key, value] of Object.entries(style)) {
      (element.style as unknown as Record<string, string>)[key] = String(value);
    }
  }, []);

  const releasePointerStyle = useCallback(() => {
    const watch = pointerStyleRef.current;
    if (!watch) return;
    watch.media.removeEventListener?.('change', watch.listener);
    pointerStyleRef.current = null;
  }, []);

  const setRef = useCallback((element: HTMLElement | null) => {
    const previous = elementRef.current;
    if (previous === element) return;
    stopCoast();
    if (previous) {
      finishDrag();
      previous.removeEventListener('wheel', handleWheel, true);
      previous.removeEventListener('touchstart', stopCoast);
      releasePointerStyle();
    }
    elementRef.current = element;
    if (!element) return;
    element.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    element.addEventListener('touchstart', stopCoast, { passive: true });
    applyPointerStyle(element);
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(COARSE_POINTER_QUERY);
    const listener = () => applyPointerStyle(element);
    media.addEventListener?.('change', listener);
    pointerStyleRef.current = { element, media, listener };
  }, [applyPointerStyle, handleWheel, releasePointerStyle, stopCoast, finishDrag]);

  useEffect(() => () => releasePointerStyle(), [releasePointerStyle]);

  const onMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {
    stopCoast();
    if (event.button !== 0 || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth + 1) return;
    const element = event.currentTarget;
    // A programmatic scrollLeft write can otherwise snap at every animation
    // frame instead of decelerating. Restore native proximity at the endpoint.
    snapRef.current = { element, value: element.style.scrollSnapType };
    element.style.scrollSnapType = 'none';
    dragRef.current = { active: true, element, startX: event.clientX, startScrollLeft: element.scrollLeft, moved: false, suppressClickUntil: 0, previousUserSelect: document.body.style.userSelect, lastX: event.clientX, lastAt: performance.now(), velocity: 0 };
    document.body.style.userSelect = 'none';
    element.style.cursor = 'grabbing';
    window.addEventListener('mousemove', handleWindowMouseMove, { passive: false });
    window.addEventListener('mouseup', finishDrag, { passive: true });
    window.addEventListener('blur', finishDrag, { passive: true });
  }, [finishDrag, handleWindowMouseMove, stopCoast]);
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
