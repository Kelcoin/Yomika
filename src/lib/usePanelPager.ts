import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { rubberBand } from './motion';

/** 面板换边跟着手指走，和阅读器翻页同一套手感：整个手势期间两块面板并排铺在
 * 一个被裁切的舞台上，所以「离开的那一块」和「进来的那一块」是同时看得见的。
 *
 * 舞台只在手势/收势期间存在（`is-sliding`）：静止时仍是一块面板正常占位，
 * 高度跟着当前面板走，页面不会因为另一块更高而长出一段空白。 */

/** 收势时长：比阅读器翻页（240ms）略短——这里换的是内容不是整页，等太久会显得拖。 */
export const PANEL_SLIDE_MS = 220;
const SLIDE_EASING = 'cubic-bezier(.22, .72, .2, 1)';
/** 离触点这么远才算「有方向的拖动」，否则仍可能是抖动或纵向滚动。 */
const SLOP_PX = 6;
const PANEL_GAP_PX = 16;
/** 屏幕两侧属于系统：从那里起手是返回手势，不是换面板。 */
const EDGE_PX = 24;
/** 已经到头还继续拖时，阻力最多让它挪出这么远。 */
const BLOCKED_TRAVEL_PX = 64;
/** 距离不够时，一次又短又快的划动仍然换边；否则慢拖要拖够阈值。 */
const FLICK_PX = 24;
const FLICK_MS = 300;

/** 这些控件自己吃横向手势（编辑器、滑杆、横向轨道），不参与换面板。 */
const IGNORED_TARGETS = 'input, textarea, select, [contenteditable], [role="slider"], [data-horizontal-scroll], .archive-rail-grid';

interface Slide<T> {
  from: T;
  to: T;
  /** true = 手指已松开，正在滑到终点；false = 还跟着手指。 */
  settling: boolean;
}

/** 一块面板的位移：`percent` 是它相对起手那块的第几个身位（0、+1、-1），
 * `dx` 是手指额外拖出来的像素。百分比按元素自身宽度算，也就是舞台宽度。 */
export function panelOffset(percent: number, dx: number, dy = 0): string {
  const y = dy === 0 ? '0' : `${dy}px`;
  if (percent === 0) return `translate3d(${dx}px, ${y}, 0)`;
  const gap = Math.abs(percent / 100) * PANEL_GAP_PX;
  const travel = `calc(${percent}% ${percent > 0 ? '+' : '-'} ${gap}px${dx === 0 ? '' : ` ${dx > 0 ? '+' : '-'} ${Math.abs(dx)}px`})`;
  return `translate3d(${travel}, ${y}, 0)`;
}

/** First visit follows the same relative depth; revisits restore that panel's
 * own last position, clamped if its content has since become shorter. */
export function mapPanelDepth(offset: number, fromHeight: number, toHeight: number, viewport: number, remembered?: number): number {
  const range = Math.max(0, toHeight - viewport);
  return Math.min(range, Math.max(0, remembered ?? (offset / Math.max(1, fromHeight - viewport)) * range));
}

/** 松手后到底换不换：拖够阈值，或者一次够快够远的划动。 */
export function shouldTurnPanel(distance: number, elapsedMs: number, width: number): boolean {
  const reach = Math.max(48, Math.min(80, width * 0.16));
  if (distance >= reach) return true;
  return distance >= FLICK_PX && elapsedMs <= FLICK_MS;
}

export interface PanelPager<T extends string> {
  containerRef: RefObject<HTMLDivElement>;
  /** 舞台的类名：静止时只有基础类，手势期间多 `is-sliding`，跟手期间再加 `is-dragging`。 */
  containerClass: string;
  /** Destination is selected as soon as settling starts, before its animation finishes. */
  selectedPanel: T;
  panelProps: (panel: T) => { ref: (node: HTMLDivElement | null) => void; hidden: boolean; 'aria-hidden': boolean; inert?: '' };
  /** 点标签页换边：和滑动走同一段动画。 */
  goTo: (panel: T) => void;
}

export function usePanelPager<T extends string>({ order, panel, enabled, onChange, resetKey }: {
  order: readonly T[];
  panel: T;
  enabled: boolean;
  onChange: (panel: T) => void;
  resetKey?: string;
}): PanelPager<T> {
  const containerRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<T, HTMLDivElement>());
  const [slide, setSlide] = useState<Slide<T> | null>(null);

  const orderRef = useRef(order);
  orderRef.current = order;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const slideRef = useRef(slide);
  slideRef.current = slide;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** 手指最后画出来的位移，收势动画从这里接手，松手那一帧不会跳。 */
  const travelRef = useRef(0);
  const animations = useRef<Animation[]>([]);
  /** 已经起过动画的那一个 slide 对象；同一个不重起。 */
  const animatedFor = useRef<Slide<T> | null>(null);
  const scrollportRef = useRef<HTMLElement>();
  const positions = useRef(new Map<T, number>());
  const verticalOffsets = useRef(new Map<T, number>());
  const geometry = useRef({ offset: 0, scrollTop: 0, stageTop: 0, viewportTop: 0 });
  const restoreScroll = useRef<number>();
  const identity = useRef(resetKey);
  if (identity.current !== resetKey) {
    identity.current = resetKey;
    positions.current.clear();
    verticalOffsets.current.clear();
  }
  const viewportBounds = useCallback(() => {
    const scroller = scrollportRef.current;
    const rect = scroller?.getBoundingClientRect();
    const header = containerRef.current?.closest('.archive-detail-route')?.querySelector('.archive-detail-route-header');
    const top = Math.max(0, rect?.top ?? 0) + (header?.getBoundingClientRect().height ?? 0);
    return { top, bottom: Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight) };
  }, []);
  const prepareStage = useCallback((from: T) => {
    const element = containerRef.current;
    if (!element) return window.innerWidth;
    const rect = element.getBoundingClientRect();
    const width = element.clientWidth || window.innerWidth;
    const { top, bottom } = viewportBounds();
    const floor = Math.ceil(Math.max(280, bottom - Math.max(top, rect.top)));
    const stageHeight = Math.max(rect.height, floor);
    const host = scrollportRef.current ?? document.scrollingElement;
    const offset = Math.max(0, top - rect.top);
    const viewport = Math.max(1, bottom - top);
    geometry.current = { offset, scrollTop: host?.scrollTop ?? 0, stageTop: rect.top, viewportTop: top };

    // Idle panels already have layout boxes. Read both heights before changing
    // stage height, visibility or transforms, so revealing them needs no readback.
    const heights = new Map(Array.from(nodes.current, ([id, node]) => [id, node.scrollHeight] as const));
    const sourceHeight = heights.get(from) || viewport;
    positions.current.set(from, offset);
    verticalOffsets.current.clear();
    for (const [id, height] of heights) {
      const target = rect.top > top ? 0 : mapPanelDepth(offset, sourceHeight, height || viewport, viewport, positions.current.get(id));
      verticalOffsets.current.set(id, id === from ? 0 : offset - target);
    }

    element.style.minHeight = `${floor}px`;
    element.style.setProperty('--panel-min-height', `${floor}px`);
    element.style.height = `${stageHeight}px`;
    for (const [id, node] of nodes.current) {
      const y = verticalOffsets.current.get(id) ?? 0;
      node.style.clipPath = `inset(${Math.max(0, -y)}px 0 ${Math.max(0, (heights.get(id) ?? 0) + y - stageHeight)}px 0)`;
    }
    return width;
  }, [viewportBounds]);

  // The short/empty panel still owns the touch area below the tabs. Keep
  // enough height for the current scroll offset so switching cannot clamp the
  // outer scrollport. The floor shrinks naturally as the user scrolls back up.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || !enabled) return;
    let frame = 0;
    let scrollport: HTMLElement | undefined;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) { scrollport = parent; break; }
    }
    scrollportRef.current = scrollport;
    const measure = (allowGrow = false) => {
      frame = 0;
      if (slideRef.current || (!allowGrow && element.style.height)) return;
      const { top, bottom } = viewportBounds();
      const height = Math.ceil(Math.max(280, bottom - Math.max(top, element.getBoundingClientRect().top)));
      const next = allowGrow ? height : Math.min(parseFloat(element.style.minHeight) || height, height);
      if (element.style.minHeight !== `${next}px`) {
        element.style.minHeight = `${next}px`;
        element.style.setProperty('--panel-min-height', `${next}px`);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => measure()); };
    const resize = () => measure(true);
    measure(true);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', resize);
      element.style.minHeight = '';
      element.style.removeProperty('--panel-min-height');
    };
  }, [enabled, panel, viewportBounds]);

  const clearTransforms = useCallback(() => {
    for (const node of nodes.current.values()) { node.style.transform = ''; node.style.clipPath = ''; }
  }, []);

  const paint = useCallback((from: T, dx: number) => {
    const ids = orderRef.current;
    const origin = ids.indexOf(from);
    for (const [id, node] of nodes.current) {
      const index = ids.indexOf(id);
      if (index < 0) continue;
      node.style.transform = panelOffset((index - origin) * 100, dx, verticalOffsets.current.get(id) ?? 0);
    }
  }, []);

  const stopAnimations = useCallback(() => {
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
  }, []);

  const settle = useCallback((from: T, to: T, dx: number) => {
    travelRef.current = dx;
    setSlide({ from, to, settling: true });
  }, []);

  /** 收势与「点标签页」共用一段动画：先把两块面板摆上舞台（这一次渲染），
   * 再在布局阶段起动画——反过来的话，正在 `display: none` 的元素上起动画，
   * 等它显示出来时动画已经跑完一半了。 */
  useLayoutEffect(() => {
    const current = slide;
    if (!current) {
      // React has now committed the destination's visibility and normal layout.
      // Removing the animation/drag transform any earlier briefly repaints the
      // departing panel at x=0 inside the still-active sliding grid.
      stopAnimations();
      clearTransforms();
      if (containerRef.current) containerRef.current.style.height = '';
      if (restoreScroll.current !== undefined) {
        const host = scrollportRef.current ?? document.scrollingElement;
        if (host instanceof HTMLElement) {
          const previous = host.style.scrollBehavior;
          host.style.scrollBehavior = 'auto';
          host.scrollTop = restoreScroll.current;
          host.style.scrollBehavior = previous;
        }
        restoreScroll.current = undefined;
      }
      animatedFor.current = null;
      return;
    }
    // Commit the base positions before WAAPI samples its first frame.
    paint(current.from, travelRef.current);
    if (!current.settling) return;
    if (animatedFor.current === current) return;
    animatedFor.current = current;
    const ids = orderRef.current;
    const origin = ids.indexOf(current.from);
    const target = ids.indexOf(current.to);
    const dx = travelRef.current;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const finish = () => {
      if (slideRef.current !== current) return;
      if (current.to !== current.from) {
        const { scrollTop, stageTop, viewportTop, offset } = geometry.current;
        const target = Math.max(0, offset - (verticalOffsets.current.get(current.to) ?? 0));
        positions.current.set(current.to, target);
        restoreScroll.current = Math.max(0, scrollTop + Math.min(0, stageTop - viewportTop) + target);
      }
      setSlide(null);
      onChangeRef.current(current.to);
    };
    const running: Animation[] = [];
    if (!reduce) {
      for (const [id, node] of nodes.current) {
        const index = ids.indexOf(id);
        if (index < 0 || typeof node.animate !== 'function') continue;
        running.push(node.animate([
          { transform: panelOffset((index - origin) * 100, dx, verticalOffsets.current.get(id) ?? 0) },
          { transform: panelOffset((index - target) * 100, 0, verticalOffsets.current.get(id) ?? 0) },
        ], { duration: PANEL_SLIDE_MS, easing: SLIDE_EASING, fill: 'forwards' }));
      }
    }
    if (running.length === 0) { finish(); return; }
    animations.current = running;
    running[running.length - 1]!.onfinish = finish;
  }, [clearTransforms, paint, slide, stopAnimations]);

  /** 舞台外换边（例如切了档案、面板被重置）：动画立即作废，别把旧位移留在新面板上。 */
  useEffect(() => {
    const current = slideRef.current;
    if (!current || current.from === panel) return;
    stopAnimations();
    clearTransforms();
    setSlide(null);
  }, [clearTransforms, panel, stopAnimations]);

  useEffect(() => () => stopAnimations(), [stopAnimations]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    if (!enabled) {
      stopAnimations();
      clearTransforms();
      setSlide(null);
      return;
    }
    let gesture: { x: number; y: number; from: T; to: T | undefined; raw: number; travel: number; horizontal: boolean; blocked: boolean; time: number; width: number } | undefined;
    let suppressClickUntil = 0;

    const start = (event: TouchEvent) => {
      if (gesture?.horizontal) { release(false); return; }
      gesture = undefined;
      // 正在收势时不接新手势：上一段动画还在改这两块面板的位移。
      if (slideRef.current) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) return;
      if (touch.clientX < EDGE_PX || touch.clientX > window.innerWidth - EDGE_PX) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (target?.closest(IGNORED_TARGETS)) return;
      // Custom horizontal scrollers may not carry our rail marker.
      for (let node = target; node && node !== element; node = node.parentElement ?? undefined) {
        if (node.scrollWidth > node.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) return;
      }
      gesture = { x: touch.clientX, y: touch.clientY, from: panelRef.current, to: undefined, raw: 0, travel: 0, horizontal: false, blocked: false, time: Date.now(), width: 0 };
    };

    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) { release(false); return; }
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      const starting = !gesture.horizontal;
      if (starting) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP_PX) return;
        if (Math.abs(dy) > Math.abs(dx) * 1.3) { gesture = undefined; return; }
        // Chromium can make the next stream noncancelable while a previous
        // vertical fling settles. CSS pan-y already excludes native horizontal
        // panning; a clearly horizontal new drag can still own this pager.
        if (Math.abs(dx) < Math.abs(dy) * (event.cancelable ? 1.05 : 1.6)) return;
        gesture.horizontal = true;
        gesture.width = prepareStage(gesture.from);
      }
      // Resolve direction on every move: a drag can cross its starting point.
      const ids = orderRef.current;
      const index = ids.indexOf(gesture.from);
      const next = dx < 0 ? ids[index + 1] : ids[index - 1];
      gesture.to = next;
      gesture.blocked = next === undefined;
      const width = gesture.width;
      gesture.raw = dx;
      gesture.travel = gesture.blocked
        ? rubberBand(dx, BLOCKED_TRAVEL_PX)
        : Math.max(-width, Math.min(width, dx));
      travelRef.current = gesture.travel;
      if (event.cancelable) event.preventDefault();
      if (starting) setSlide({ from: gesture.from, to: gesture.from, settling: false });
      else paint(gesture.from, gesture.travel);
    };

    const release = (allowTurn: boolean) => {
      const current = gesture;
      gesture = undefined;
      if (!current?.horizontal) return;
      suppressClickUntil = performance.now() + 400;
      const turn = allowTurn && !current.blocked && current.to !== undefined
        && shouldTurnPanel(Math.abs(current.raw), Date.now() - current.time, current.width);
      settle(current.from, turn ? current.to! : current.from, current.travel);
    };

    const end = () => release(true);
    const cancel = () => release(false);
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
  }, [clearTransforms, enabled, paint, prepareStage, settle, stopAnimations]);

  const setters = useRef(new Map<T, (node: HTMLDivElement | null) => void>());
  const refFor = (id: T) => {
    let setter = setters.current.get(id);
    if (!setter) {
      setter = (node) => { if (node) nodes.current.set(id, node); else nodes.current.delete(id); };
      setters.current.set(id, setter);
    }
    return setter;
  };

  const goTo = useCallback((next: T) => {
    const current = panelRef.current;
    if (next === current || slideRef.current) return;
    prepareStage(current);
    settle(current, next, 0);
  }, [prepareStage, settle]);

  return {
    containerRef,
    selectedPanel: slide?.settling ? slide.to : panel,
    containerClass: `archive-detail-panels${slide ? ' is-sliding' : ''}${slide && !slide.settling ? ' is-dragging' : ''}`,
    panelProps: (id: T) => ({
      ref: refFor(id),
      // Both remain visible throughout snap-back too: the incoming panel must
      // slide out rather than disappear the instant the finger is released.
      hidden: slide === null && panel !== id,
      'aria-hidden': (slide?.settling ? slide.to : panel) !== id,
      ...((slide?.settling ? slide.to : panel) !== id ? { inert: '' as const } : {}),
    }),
    goTo,
  };
}
