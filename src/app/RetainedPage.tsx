import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';

const PageActiveContext = createContext(true);
export const usePageActive = () => useContext(PageActiveContext);

/** Retain component state and scroll positions; hidden regions must never save
 * their zero-sized layout over the last visible position. */
export function RetainedPage({ active, flow = false, motionSurface = false, children }: { active: boolean; flow?: boolean; motionSurface?: boolean; children: ReactNode }) {
  const parentActive = usePageActive();
  const visible = active && parentActive;
  const root = useRef<HTMLElement>(null);
  const positions = useRef(new Map<HTMLElement, number>());
  useLayoutEffect(() => {
    if (!visible || !root.current) return;
    const panel = root.current;
    const workspace = panel.closest<HTMLElement>('.workspace');
    const restore = () => positions.current.forEach((top, region) => {
      if (!region.isConnected) { positions.current.delete(region); return; }
      if (region.isConnected && !region.closest('[hidden]')) region.scrollTop = top;
    });
    if (workspace) workspace.scrollTop = positions.current.get(workspace) ?? 0;
    restore();
    const frame = requestAnimationFrame(restore);
    const save = (event: Event) => {
      const region = event.target;
      if (region instanceof HTMLElement && region.getClientRects().length > 0 && !region.closest('[hidden]') && (region === workspace || panel.contains(region))) {
        positions.current.set(region, region.scrollTop);
      }
    };
    document.addEventListener('scroll', save, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', save, true);
      // Detached scroll regions are dead weight: the map keys DOM nodes
      // strongly, so a re-rendered or hidden subtree would otherwise stay
      // retained from the moment this page is first shown.
      positions.current.forEach((_, region) => {
        if (!region.isConnected) positions.current.delete(region);
      });
    };
  }, [visible]);
  return <PageActiveContext.Provider value={visible}>
    {/* Workspace pages keep viewport-fixed UI in body portals. The outer shell
        and reader deliberately do not opt into this transform contract. */}
    <section ref={root} data-bounce-surface={motionSurface ? '' : undefined} className={`route-cache-panel${flow ? ' is-flow' : ''}`} hidden={!visible}>{children}</section>
  </PageActiveContext.Provider>;
}
