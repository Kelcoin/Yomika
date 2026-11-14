import { createContext, useCallback, useContext, useLayoutEffect, useRef, type MutableRefObject, type ReactNode } from 'react';
import { animateDetail, NAVIGATION_MOTION, routeMotionAllowed, type RouteMotion } from '../lib/routeMotion';
export type { RouteDirection } from '../lib/routeMotion';
import type { RouteDirection } from '../lib/routeMotion';

const PageActiveContext = createContext(true);
export const usePageActive = () => useContext(PageActiveContext);

export function animateRouteEntry(panel: HTMLElement, motionSurface = false, direction: RouteDirection = 1, motion?: RouteMotion): Animation | undefined {
  if (!routeMotionAllowed() || typeof panel.animate !== 'function' || motion?.kind === 'none' || motion?.kind === 'detail-close' || motion?.kind === 'page-close') return undefined;
  if (motion?.kind === 'page-open') return animateDetail(panel);
  if (motion?.kind === 'detail-open') {
    const detail = panel.querySelector<HTMLElement>('.library-shell-detail');
    return detail ? animateDetail(detail) : undefined;
  }
  const axis = motion?.axis === 'y' ? 'Y' : 'X';
  const sign = motion?.direction ?? direction;
  return panel.animate(motionSurface
    ? [{ opacity: 0.7, transform: `translate${axis}(${sign * 100}%)` }, { opacity: 1, transform: `translate${axis}(0)` }]
    : [{ opacity: 0 }, { opacity: 1 }], {
    duration: motionSurface ? NAVIGATION_MOTION.duration : 240,
    easing: motionSurface ? NAVIGATION_MOTION.easing : 'cubic-bezier(.2, .8, .2, 1)',
  });
}

/** 把 scrollTop 直接写到位，而不是让它滚过去。
 *
 * 样式表给 `.workspace` 与滚动区加了 `scroll-behavior: smooth`（视觉优化那一批），
 * 于是「回到这一页」不再是瞬间复位，而是从顶部一路滚到记住的位置——用户报的
 * 「首页不在顶部时，从其他页面切到首页会从顶部滚过去而不是直接显示在原先位置」。
 * 写之前把平滑关掉、写完立刻还原：用户自己滚仍然是平滑的。 */
function writeInstantScroll(region: HTMLElement, write: () => void) {
  const previous = region.style.scrollBehavior;
  region.style.scrollBehavior = 'auto';
  write();
  region.style.scrollBehavior = previous;
}

/** Retain component state and scroll positions; hidden regions must never save
 * their zero-sized layout over the last visible position. */
export function RetainedPage({ active, flow = false, motionSurface = false, transitionKey, direction = 1, motion, surfaceRef, children }: { active: boolean; flow?: boolean; motionSurface?: boolean; transitionKey?: string; direction?: RouteDirection; motion?: RouteMotion | undefined; surfaceRef?: MutableRefObject<HTMLElement | null> | undefined; children: ReactNode }) {
  const parentActive = usePageActive();
  const visible = active && parentActive;
  const root = useRef<HTMLElement | null>(null);
  const setRoot = useCallback((node: HTMLElement | null) => {
    root.current = node;
    if (surfaceRef) surfaceRef.current = node;
  }, [surfaceRef]);
  const positions = useRef(new Map<HTMLElement, number>());
  const directionRef = useRef(direction);
  directionRef.current = direction;
  const motionRef = useRef(motion);
  motionRef.current = motion;
  useLayoutEffect(() => {
    const node = root.current;
    if (!visible || !node) return;
    const animation = animateRouteEntry(node, motionSurface, directionRef.current, motionRef.current);
    return () => animation?.cancel();
  }, [visible, transitionKey, motionSurface]);
  useLayoutEffect(() => {
    if (!visible || !root.current) return;
    const panel = root.current;
    const workspace = panel.closest<HTMLElement>('.workspace');
    const restore = () => positions.current.forEach((top, region) => {
      if (!region.isConnected) { positions.current.delete(region); return; }
      if (region.isConnected && !region.closest('[hidden]')) writeInstantScroll(region, () => { region.scrollTop = top; });
    });
    if (workspace) writeInstantScroll(workspace, () => { workspace.scrollTop = positions.current.get(workspace) ?? 0; });
    restore();
    const frame = requestAnimationFrame(restore);
    const save = (event: Event) => {
      const region = event.target;
      // Ignore other panels/overlays before asking the browser for layout.
      // This capture listener sees every nested scroll event in the document.
      if (region instanceof HTMLElement && (region === workspace || panel.contains(region)) && !region.closest('[hidden]') && region.getClientRects().length > 0) {
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
    <section ref={setRoot} data-bounce-surface={motionSurface ? '' : undefined} className={`route-cache-panel${flow ? ' is-flow' : ''}`} hidden={!visible}>{children}</section>
  </PageActiveContext.Provider>;
}
