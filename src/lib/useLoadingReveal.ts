import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Fade newly ready content once, without replaying on updates or activation. */
export function useLoadingReveal<T extends HTMLElement>(target: RefObject<T>, loading: boolean) {
  const previous = useRef(loading);
  useLayoutEffect(() => {
    const reveal = previous.current && !loading;
    previous.current = loading;
    const node = target.current;
    if (!reveal || !node || !node.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const animation = node.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)',
    });
    return () => animation.cancel();
  }, [loading, target]);
}
