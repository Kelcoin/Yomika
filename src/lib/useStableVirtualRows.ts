import { useRef } from 'react';

/** A hidden WebView/retained pane can report a zero viewport and discard all
 * visible cards. Keep their DOM until a real viewport is available again. */
export function useStableVirtualRows<T>(items: T[], totalSize: number, count: number, measurable: boolean) {
  const previous = useRef({ items, totalSize, count });
  if (!measurable && previous.current.items.length > 0 && previous.current.count === count) return previous.current;
  const next = { items, totalSize, count };
  previous.current = next;
  return next;
}
