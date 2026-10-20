import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePageActive } from '../app/RetainedPage';

/** Keep page previews bounded by the viewport, including detail grids which
 * scroll with their enclosing page rather than an extra nested scroller. */
export function VirtualPageGrid({ count, className, minWidth, children, onRangeChange }: {
  count: number;
  className: string;
  minWidth: number;
  children: (index: number) => ReactNode;
  onRangeChange?: ((start: number, end: number) => void) | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const active = usePageActive();
  const [window, setWindow] = useState({ start: 0, end: Math.min(count, 48), columns: 1, stride: 0, gap: 8 });
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
      if (width <= 0 || grid.closest('[hidden]')) return;
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 8;
      const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
      const stride = ((width - gap * (columns - 1)) / columns) * 4 / 3 + gap;
      const top = host === grid ? grid.scrollTop : Math.max(0, host.getBoundingClientRect().top - grid.getBoundingClientRect().top);
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
  }, [active, count, minWidth]);
  const start = Math.min(count, window.start);
  const end = Math.min(count, window.end);
  useLayoutEffect(() => { if (active) rangeCallback.current?.(start, end); }, [active, start, end]);
  const before = start / window.columns * window.stride;
  const after = Math.max(0, Math.ceil(count / window.columns) - Math.ceil(end / window.columns)) * window.stride;
  // Spacer rows themselves have the grid's gap on either side.
  const gap = window.gap;
  return <div ref={root} className={className}>
    {before > 0 && <div aria-hidden="true" style={{ gridColumn: '1 / -1', height: Math.max(0, before - gap) }} />}
    {Array.from({ length: Math.max(0, end - start) }, (_, offset) => children(start + offset))}
    {after > 0 && <div aria-hidden="true" style={{ gridColumn: '1 / -1', height: Math.max(0, after - gap) }} />}
  </div>;
}
