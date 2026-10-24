import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OverlayLayer } from './OverlayLayer';

/** One delegated tooltip for all archive cards, including retained pages. */
export function ArchiveTitleTooltip() {
  const [tip, setTip] = useState<{ title: string; x: number; y: number }>();
  const bubble = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let card: HTMLElement | undefined;
    let x = 0;
    let y = 0;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    const hide = () => { cancel(); card = undefined; setTip(undefined); };
    const schedule = () => {
      cancel();
      timer = setTimeout(() => {
        if (card?.isConnected && !card.closest('[hidden]')) {
          const title = card.dataset.archiveTooltip;
          if (title) setTip({ title, x, y });
        }
      }, 650);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.buttons) { hide(); return; }
      const next = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-archive-tooltip]') : null;
      if (!next) { if (card) hide(); return; }
      if (next !== card || Math.abs(event.clientX - x) + Math.abs(event.clientY - y) > 4) {
        setTip(undefined);
        card = next;
        x = event.clientX;
        y = event.clientY;
        schedule();
      }
    };
    const leave = (event: PointerEvent) => {
      if (card && (!(event.relatedTarget instanceof Node) || !card.contains(event.relatedTarget))) hide();
    };
    document.addEventListener('pointerover', move);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerout', leave);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('contextmenu', hide, true);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      cancel();
      document.removeEventListener('pointerover', move);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('contextmenu', hide, true);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);
  useLayoutEffect(() => {
    const node = bubble.current;
    if (!node || !tip) return;
    const rect = node.getBoundingClientRect();
    node.style.left = Math.max(8, Math.min(tip.x + 12, window.innerWidth - rect.width - 8)) + 'px';
    node.style.top = Math.max(8, tip.y + 18 + rect.height <= window.innerHeight - 8 ? tip.y + 18 : tip.y - rect.height - 10) + 'px';
  }, [tip]);
  return tip ? <OverlayLayer><div ref={bubble} role="tooltip" className="archive-title-tooltip">{tip.title}</div></OverlayLayer> : null;
}
