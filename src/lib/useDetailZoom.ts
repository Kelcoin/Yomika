import { useCallback, useLayoutEffect, useRef } from 'react';
import { animateDetail, DETAIL_EXIT_MS } from './routeMotion';

/** Portal-based details share the route detail's entrance/reverse transition. */
export function useDetailZoom(onClose: () => void) {
  const surface = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const animation = useRef<Animation>();
  const timer = useRef<number>();
  const closing = useRef(false);
  useLayoutEffect(() => {
    if (surface.current) animation.current = animateDetail(surface.current);
    return () => {
      if (animation.current) { animation.current.onfinish = null; animation.current.cancel(); }
      clearTimeout(timer.current);
    };
  }, []);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    animation.current?.cancel();
    const node = surface.current;
    const exit = node ? animateDetail(node, true) : undefined;
    if (!exit) { closeRef.current(); return; }
    animation.current = exit;
    node?.setAttribute('inert', '');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer.current);
      closeRef.current();
    };
    exit.onfinish = finish;
    timer.current = window.setTimeout(finish, DETAIL_EXIT_MS + 50);
  }, []);
  return { surface, close };
}
