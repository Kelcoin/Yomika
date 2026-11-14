import { useLayoutEffect, useRef, type RefObject } from 'react';
import { DETAIL_RETURN_ALIGNED, DETAIL_RETURN_PREVIEW } from './detailReturn';

/** The compact list and detail share the workspace scrollport. Hiding the
 * list shrinks that port and clamps scrollTop; never save the clamped value
 * over the list's position, or let detail scrolling overwrite it. */
export function useDetailListScroll(detailOpen: boolean, list: RefObject<HTMLElement>) {
  const saved = useRef(new Map<HTMLElement, number>());
  const previous = useRef(detailOpen);
  useLayoutEffect(() => {
    const section = list.current;
    if (!section) return;
    const workspace = section.closest<HTMLElement>('.workspace');
    const restore = () => saved.current.forEach((top, region) => {
      if (!region.isConnected) { saved.current.delete(region); return; }
      const behavior = region.style.scrollBehavior;
      region.style.scrollBehavior = 'auto';
      region.scrollTop = top;
      region.style.scrollBehavior = behavior;
    });
    let frame: number | undefined;
    if (previous.current && !detailOpen) {
      restore();
      frame = requestAnimationFrame(restore);
    }
    previous.current = detailOpen;
    const save = (event: Event) => {
      const region = event.target;
      if (section.closest('[hidden]') || !(region instanceof HTMLElement)) return;
      // Split layouts keep the list interactive. Keep its latest position,
      // but exclude the shared workspace while it belongs to a compact detail.
      const listScroll = section.contains(region) && (!detailOpen || section.getClientRects().length > 0);
      if (listScroll || (region === workspace && !detailOpen)) saved.current.set(region, region.scrollTop);
    };
    document.addEventListener('scroll', save, true);
    const preview = () => { if (section.closest('[data-detail-return]')) restore(); };
    const aligned = () => { if (section.closest('[data-detail-return]')) saved.current.forEach((_, region) => saved.current.set(region, region.scrollTop)); };
    document.addEventListener(DETAIL_RETURN_PREVIEW, preview);
    document.addEventListener(DETAIL_RETURN_ALIGNED, aligned);
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); document.removeEventListener('scroll', save, true); document.removeEventListener(DETAIL_RETURN_PREVIEW, preview); document.removeEventListener(DETAIL_RETURN_ALIGNED, aligned); };
  }, [detailOpen, list]);
}
