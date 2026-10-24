import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OverlayLayer } from './OverlayLayer';

/** One themed tooltip for cards and native title hints, including retained pages. */
export function ArchiveTitleTooltip() {
  const [tip, setTip] = useState<{ title: string; x: number; y: number }>();
  const bubble = useRef<HTMLDivElement>(null);
  const described = useRef(new WeakSet<HTMLElement>());
  useEffect(() => {
    // Keep an empty title to suppress inherited native tooltips. React can still
    // update/remove its title prop; the observer mirrors those changes as well.
    const clearTitle = (element: HTMLElement) => {
      delete element.dataset.uiTooltip;
      if (described.current.has(element)) { element.removeAttribute('aria-description'); described.current.delete(element); }
    };
    const migrateTitle = (element: HTMLElement) => {
      const title = element.getAttribute('title');
      if (title === '') return;
      if (title === null) {
        clearTitle(element);
        return;
      }
      element.dataset.uiTooltip = title;
      if (!element.hasAttribute('aria-description') || described.current.has(element)) {
        element.setAttribute('aria-description', title);
        described.current.add(element);
      }
      element.setAttribute('title', '');
    };
    const scan = (root: Element) => {
      if (root instanceof HTMLElement && root.hasAttribute('title')) migrateTitle(root);
      root.querySelectorAll<HTMLElement>('[title]').forEach(migrateTitle);
    };
    scan(document.body);
    const observer = new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === 'attributes' && change.target instanceof HTMLElement) {
          if (change.target.getAttribute('title') === '' && change.oldValue === '') clearTitle(change.target);
          else migrateTitle(change.target);
        }
        else for (const node of change.addedNodes) if (node instanceof Element) scan(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['title'] });
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
          const title = card.dataset.archiveTooltip ?? card.dataset.uiTooltip;
          if (title) setTip({ title, x, y });
        }
      }, 650);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.buttons) { hide(); return; }
      const next = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-archive-tooltip], [data-ui-tooltip]') : null;
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
      observer.disconnect();
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
