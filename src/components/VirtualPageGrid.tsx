import { useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { usePageActive } from '../app/RetainedPage';

/** Keep page previews bounded by the viewport, including detail grids which
 * scroll with their enclosing page rather than an extra nested scroller. */
export function VirtualPageGrid({ count, className, minWidth, children, onRangeChange, footerHeight = 0, initialIndex, autoHideScrollbar = false }: {
  count: number;
  className: string;
  minWidth: number;
  footerHeight?: number;
  initialIndex?: number | undefined;
  autoHideScrollbar?: boolean;
  children: (index: number) => ReactNode;
  onRangeChange?: ((start: number, end: number) => void) | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const gridId = useId();
  const active = usePageActive();
  const [window, setWindow] = useState({ start: 0, end: Math.min(count, 48), columns: 1, stride: 0, gap: 8 });
  const initialScroll = useRef(initialIndex);
  const rangeCallback = useRef(onRangeChange);
  rangeCallback.current = onRangeChange;
  useLayoutEffect(() => {
    const grid = root.current;
    if (!grid || !active) return;
    let scroller: HTMLElement | null = grid;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const host = scroller ?? document.documentElement;
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      const width = grid.clientWidth;
      // The outgoing detail is a frozen live surface. Its transformed bounds
      // must not change the virtual range while it shrinks toward its card.
      if (width <= 0 || grid.closest('[hidden], [data-detail-return], [data-page-return]')) return;
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 8;
      const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
      const stride = ((width - gap * (columns - 1)) / columns) * 4 / 3 + footerHeight + gap;
      const target = initialScroll.current;
      const initialTop = target === undefined ? undefined : Math.max(0, Math.min(Math.ceil(count / columns) * stride - host.clientHeight, Math.floor(target / columns) * stride - (host.clientHeight - stride) / 2));
      const top = host === grid && initialTop !== undefined ? initialTop : host === grid ? grid.scrollTop : Math.max(0, host.getBoundingClientRect().top - grid.getBoundingClientRect().top);
      const height = host.clientHeight || globalThis.innerHeight || 800;
      const start = Math.min(Math.max(0, Math.ceil(count / columns) - 1), Math.max(0, Math.floor(top / stride) - 3)) * columns;
      const end = Math.min(count, (Math.ceil((top + height) / stride) + 3) * columns);
      setWindow((previous) => previous.start === start && previous.end === end && previous.columns === columns && previous.stride === stride
        ? previous : { start, end: Math.max(start, end), columns, stride, gap });
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(measure); };
    measure();
    host.addEventListener('scroll', schedule, { passive: true });
    globalThis.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    observer?.observe(grid);
    if (host !== grid) observer?.observe(host);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      host.removeEventListener('scroll', schedule);
      globalThis.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [active, count, minWidth, footerHeight]);
  useLayoutEffect(() => {
    const grid = root.current;
    const target = initialScroll.current;
    if (!active || !grid || target === undefined || !window.stride) return;
    initialScroll.current = undefined;
    grid.scrollTop = Math.max(0, Math.floor(target / window.columns) * window.stride - (grid.clientHeight - window.stride) / 2);
  }, [active, window.columns, window.stride]);
  const start = Math.min(count, window.start);
  const end = Math.min(count, window.end);
  useLayoutEffect(() => { if (active) rangeCallback.current?.(start, end); }, [active, start, end, window.stride]);
  const before = start / window.columns * window.stride;
  const after = Math.max(0, Math.ceil(count / window.columns) - Math.ceil(end / window.columns)) * window.stride;
  // Spacer rows themselves have the grid's gap on either side.
  const gap = window.gap;
  const grid = <div ref={root} id={autoHideScrollbar ? gridId : undefined} className={className}>
    {before > 0 && <div aria-hidden="true" style={{ gridColumn: '1 / -1', height: Math.max(0, before - gap) }} />}
    {Array.from({ length: Math.max(0, end - start) }, (_, offset) => children(start + offset))}
    {after > 0 && <div aria-hidden="true" style={{ gridColumn: '1 / -1', height: Math.max(0, after - gap) }} />}
  </div>;
  if (!autoHideScrollbar) return grid;
  return <div className="reader-overview-thumbnail-scroll-area">
    {grid}
    {active && <PageGridScrollbar grid={root} gridId={gridId} contentHeight={Math.ceil(count / window.columns) * window.stride} />}
  </div>;
}

function PageGridScrollbar({ grid, gridId, contentHeight }: {
  grid: RefObject<HTMLDivElement>;
  gridId: string;
  contentHeight: number;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const drag = useRef<{ pointerId: number; offset: number }>();
  const thumbHeight = (height: number, total: number) => Math.min(height, Math.max(44, height * height / total));

  function reveal() {
    const bar = rail.current!;
    bar.dataset.scrolling = 'true';
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { delete bar.dataset.scrolling; }, 800);
  }

  useLayoutEffect(() => {
    const scroller = grid.current!;
    const bar = rail.current!;
    const handle = thumb.current!;
    const update = () => {
      const height = scroller.clientHeight;
      const total = scroller.scrollHeight;
      const max = total - height;
      bar.hidden = height <= 0 || max <= 0;
      if (bar.hidden) return;
      const size = thumbHeight(height, total);
      const ratio = Math.max(0, Math.min(1, scroller.scrollTop / max));
      handle.style.height = `${size}px`;
      handle.style.transform = `translateY(${ratio * (height - size)}px)`;
      bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    };
    const onScroll = () => { update(); if (!bar.hidden) reveal(); };
    update();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(scroller);
    return () => {
      observer?.disconnect();
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [grid, contentHeight]);
  useLayoutEffect(() => () => clearTimeout(timer.current), []);

  function move(event: PointerEvent<HTMLDivElement>) {
    const held = drag.current;
    if (held?.pointerId !== event.pointerId) return;
    const scroller = grid.current!;
    const height = scroller.clientHeight;
    const total = scroller.scrollHeight;
    const track = event.currentTarget.getBoundingClientRect();
    const travel = height - thumbHeight(height, total);
    if (travel <= 0 || track.height <= 0) return;
    const y = (event.clientY - track.top) * height / track.height;
    scroller.scrollTop = Math.max(0, Math.min(1, (y - held.offset) / travel)) * (total - height);
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return;
    const scroller = grid.current!;
    const height = scroller.clientHeight;
    const total = scroller.scrollHeight;
    const bar = event.currentTarget;
    const track = bar.getBoundingClientRect();
    if (total <= height || track.height <= 0) return;
    const size = thumbHeight(height, total);
    const top = (height - size) * scroller.scrollTop / (total - height);
    const offset = (event.clientY - track.top) * height / track.height - top;
    drag.current = { pointerId: event.pointerId, offset: offset >= 0 && offset <= size ? offset : size / 2 };
    bar.setPointerCapture?.(event.pointerId);
    bar.dataset.dragging = 'true';
    reveal();
    move(event);
  }

  function end(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    delete event.currentTarget.dataset.dragging;
    reveal();
  }

  return <div ref={rail} className="reader-overview-thumbnail-scrollbar" role="scrollbar" tabIndex={0}
    aria-label="缩略图滚动位置" aria-controls={gridId} aria-orientation="vertical"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onKeyDown={(event) => {
      const scroller = grid.current!;
      const offsets: Record<string, number> = {
        ArrowUp: -40, ArrowDown: 40, PageUp: -scroller.clientHeight, PageDown: scroller.clientHeight,
        Home: -scroller.scrollTop, End: scroller.scrollHeight - scroller.scrollTop,
      };
      if (!Object.hasOwn(offsets, event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      scroller.scrollTop += offsets[event.key]!;
    }}>
    <div ref={thumb} className="reader-overview-thumbnail-scrollbar-thumb" />
  </div>;
}
