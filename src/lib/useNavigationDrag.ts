import { useLayoutEffect, useRef, type RefObject } from 'react';
import { advanceNavigationSpring } from './navigationSpring';

type Tab = { node: HTMLAnchorElement; route: string; x: number; y: number; width: number; height: number; iconX: number; iconWidth: number };
type Gesture = { id: number; x: number; y: number; start: number; current: number; dragging: boolean };
const DRAG_SLOP = 6;

/** BakaSU-style bottom-bar interaction: continuous preview, commit on release.
 * One decorative layer moves; page contents do not render or load until release.
 * Geometry is cached per gesture/resize, with no layout reads on pointermove. */
export function useNavigationDrag(ref: RefObject<HTMLElement>, { enabled, elastic = false, hidden, active, layoutKey = '', onSelect }: {
  enabled: boolean; elastic?: boolean; hidden: boolean; active: string; layoutKey?: string; onSelect: (route: string) => void;
}) {
  const select = useRef(onSelect);
  const suppressClick = useRef(false);
  // Preserve the rendered position and momentum across the route commit. The
  // old effect must not snap back to the previous tab before the new one starts.
  const spring = useRef<{ position: number; velocity: number }>();
  const stretch = useRef({ x: { position: 1, velocity: 0 }, y: { position: 1, velocity: 0 } });
  select.current = onSelect;
  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav || !enabled || hidden) return;
    let tabs: Tab[] = [];
    let gesture: Gesture | undefined;
    let frame = 0;
    let preview: HTMLAnchorElement | undefined;
    let target: Tab | undefined;
    let targetX = 0;
    let lastTime: number | undefined;
    let tapRestore: ReturnType<typeof setTimeout> | undefined;
    const clearTapRestore = () => { clearTimeout(tapRestore); tapRestore = undefined; };
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let bounds = nav.getBoundingClientRect();
    const measure = () => {
      bounds = nav.getBoundingClientRect();
      tabs = Array.from(nav.querySelectorAll<HTMLAnchorElement>('[data-nav-route]')).map(node => {
        const box = node.getBoundingClientRect();
        const icon = node.querySelector('.nav-icon-pair')?.getBoundingClientRect();
        return { node, route: node.dataset.navRoute!, x: box.left - bounds.left - nav.clientLeft,
          y: box.top - bounds.top - nav.clientTop, width: box.width, height: box.height,
          iconX: (icon?.left ?? box.left) - bounds.left - nav.clientLeft, iconWidth: icon?.width ?? box.width };
      });
    };
    const activeTab = () => tabs.find(tab => tab.route === active);
    const nearest = (center: number) => tabs.reduce<Tab | undefined>((best, tab) =>
      !best || Math.abs(tab.x + tab.width / 2 - center) < Math.abs(best.x + best.width / 2 - center) ? tab : best, undefined);
    const stretchTarget = () => {
      const speed = Math.min(1, Math.abs(spring.current?.velocity ?? 0) / (elastic ? 950 : 1200));
      const pressing = Boolean(gesture);
      if (elastic && !reducedMotion) {
        return { x: 1 + (pressing ? 0.14 : 0) + speed * 0.19, y: 1 + (pressing ? 0.10 : 0) - speed * 0.13 };
      }
      return { x: reducedMotion ? 1 : 1 + (pressing ? 0.12 : 0) + speed * 0.12,
        y: reducedMotion ? 1 : 1 + (pressing ? 0.08 : 0) - speed * 0.06 };
    };
    const render = (tab: Tab, x: number) => {
      const scaleX = stretch.current.x.position;
      const scaleY = stretch.current.y.position;
      nav.style.setProperty('--nav-indicator-scale-x', String(scaleX));
      nav.style.setProperty('--nav-indicator-scale-y', String(scaleY));
      const first = tabs[0];
      const last = tabs[tabs.length - 1];
      const displayedX = Math.max((first?.x ?? x) - 6, Math.min((last?.x ?? x) + 6, x));
      nav.style.setProperty('--nav-indicator-x', `${displayedX}px`);
      const left = displayedX - (scaleX - 1) * tab.width / 2;
      const right = displayedX + tab.width + (scaleX - 1) * tab.width / 2;
      for (const item of tabs) {
        const start = Math.max(0, Math.min(100, (left - item.iconX) / Math.max(1, item.iconWidth) * 100));
        const end = Math.max(start, Math.min(100, (right - item.iconX) / Math.max(1, item.iconWidth) * 100));
        item.node.style.setProperty('--nav-icon-start', `${start}%`);
        item.node.style.setProperty('--nav-icon-end', `${end}%`);
      }
      const current = gesture && nearest(displayedX + tab.width / 2);
      if (preview !== current?.node) {
        preview?.removeAttribute('data-nav-preview');
        preview = current?.node;
        preview?.setAttribute('data-nav-preview', '');
      }
    };
    const tick = (time: number) => {
      frame = 0;
      if (!target || !spring.current) return;
      const dt = lastTime === undefined ? 1 / 60 : (time - lastTime) / 1000;
      lastTime = time;
      spring.current = advanceNavigationSpring(spring.current, targetX, dt, Boolean(gesture), elastic);
      const positionMoving = Math.abs(spring.current.position - targetX) > 0.05 || Math.abs(spring.current.velocity) > 0.5;
      if (!positionMoving) spring.current = { position: targetX, velocity: 0 };
      const shape = stretchTarget();
      let stretching = false;
      for (const axis of ['x', 'y'] as const) {
        const state = advanceNavigationSpring(stretch.current[axis], shape[axis], dt, false, elastic);
        const moving = Math.abs(state.position - shape[axis]) > 0.0005 || Math.abs(state.velocity) > 0.005;
        stretch.current[axis] = moving ? state : { position: shape[axis], velocity: 0 };
        stretching ||= moving;
      }
      render(target, spring.current.position);
      if (positionMoving || stretching) frame = requestAnimationFrame(tick);
      else lastTime = undefined;
    };
    const paint = (tab: Tab | undefined, x = tab?.x ?? 0, immediate = false) => {
      if (!tab || tab.width <= 0) {
        target = undefined;
        clearFrame();
        nav.removeAttribute('data-nav-indicator-ready');
        return;
      }
      target = tab;
      targetX = x;
      nav.setAttribute('data-nav-indicator-ready', '');
      nav.style.setProperty('--nav-indicator-y', `${tab.y}px`);
      nav.style.setProperty('--nav-indicator-width', `${tab.width}px`);
      nav.style.setProperty('--nav-indicator-height', `${tab.height}px`);
      if (!spring.current || immediate || reducedMotion) {
        spring.current = { position: x, velocity: 0 };
        const shape = stretchTarget();
        stretch.current = { x: { position: shape.x, velocity: 0 }, y: { position: shape.y, velocity: 0 } };
        render(tab, x);
      } else if (!frame) {
        lastTime = undefined;
        frame = requestAnimationFrame(tick);
      }
    };
    const clearFrame = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
    const restore = () => {
      preview?.removeAttribute('data-nav-preview');
      preview = undefined;
      nav.removeAttribute('data-nav-pressing');
      nav.removeAttribute('data-nav-dragging');
      paint(activeTab());
    };
    const releaseCapture = (id: number) => {
      if (nav.hasPointerCapture?.(id)) nav.releasePointerCapture(id);
    };
    const cancel = () => {
      clearTapRestore();
      const previous = gesture;
      gesture = undefined; // lostpointercapture must not cancel twice.
      if (previous) { suppressClick.current = true; releaseCapture(previous.id); }
      restore();
    };
    const update = (event: PointerEvent) => {
      if (!gesture || tabs.length === 0) return;
      const first = tabs[0]!;
      const last = tabs[tabs.length - 1]!;
      const raw = gesture.start + event.clientX - gesture.x;
      const min = first.x + first.width / 2;
      const max = last.x + last.width / 2;
      const bounded = Math.max(min, Math.min(max, raw));
      // A small rubber-band displacement at either edge, never an unbounded pill.
      gesture.current = bounded + 6 * Math.tanh((raw - bounded) / 48);
      const tab = nearest(bounded);
      if (tab) paint(tab, gesture.current - tab.width / 2);
    };
    const down = (event: PointerEvent) => {
      clearTapRestore();
      if (gesture) { cancel(); return; }
      if (event.isPrimary === false || event.button !== 0) return;
      suppressClick.current = false;
      measure();
      const localX = event.clientX - bounds.left - nav.clientLeft;
      const tab = nearest(localX);
      if (!tab) return;
      const center = tab.x + tab.width / 2;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, start: center, current: center, dragging: false };
      nav.setAttribute('data-nav-pressing', '');
      paint(tab);
    };
    const move = (event: PointerEvent) => {
      if (!gesture) return;
      if (gesture.id !== event.pointerId) return;
      const dx = Math.abs(event.clientX - gesture.x);
      const dy = Math.abs(event.clientY - gesture.y);
      if (!gesture.dragging) {
        if (dy > DRAG_SLOP && dy > dx) { cancel(); return; }
        if (dx < DRAG_SLOP) return;
        gesture.dragging = true;
        nav.setAttribute('data-nav-dragging', '');
        nav.setPointerCapture?.(event.pointerId);
      }
      if (event.cancelable) event.preventDefault();
      update(event);
    };
    const up = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const previous = gesture;
      if (previous.dragging) update(event);
      const target = nearest(previous.current);
      // Vertical departure is cancellation even after a horizontal drag starts.
      const inside = Math.abs(event.clientY - previous.y) <= 60;
      gesture = undefined;
      suppressClick.current = previous.dragging;
      releaseCapture(previous.id);
      if (!previous.dragging && inside) {
        // pointerup precedes the link's click. In settings there is no active
        // bottom tab: restoring here would hide the capsule between those two
        // events. Keep the preview until click commits, or restore if canceled.
        nav.removeAttribute('data-nav-pressing');
        paint(target);
        tapRestore = setTimeout(() => { tapRestore = undefined; restore(); }, 0);
        return;
      }
      restore();
      if (previous.dragging && inside && target) {
        paint(target);
        if (target.route !== active) select.current(target.route);
      }
    };
    const lostCapture = (event: PointerEvent) => { if (event.target === nav && event.pointerId === gesture?.id) cancel(); };
    const click = (event: MouseEvent) => {
      if (tapRestore !== undefined) {
        clearTapRestore();
        const link = event.target instanceof Element ? event.target.closest('[data-nav-route]') : undefined;
        paint(tabs.find(tab => tab.node === link) ?? activeTab());
      }
      // detail=0 includes keyboard activation and must stay accessible. Native
      // touch/mouse compatibility clicks are suppressed only after an actual drag.
      if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); }
      suppressClick.current = false;
    };
    const resize = () => {
      cancel();
      measure();
      paint(activeTab(), activeTab()?.x, true);
    };
    const visibility = () => { if (document.visibilityState !== 'visible') cancel(); };
    measure();
    paint(activeTab());
    nav.addEventListener('pointerdown', down);
    nav.addEventListener('pointermove', move);
    nav.addEventListener('pointerup', up);
    nav.addEventListener('pointercancel', cancel);
    nav.addEventListener('lostpointercapture', lostCapture);
    nav.addEventListener('click', click, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', visibility);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(nav);
    return () => {
      nav.removeEventListener('pointerdown', down);
      nav.removeEventListener('pointermove', move);
      nav.removeEventListener('pointerup', up);
      nav.removeEventListener('pointercancel', cancel);
      nav.removeEventListener('lostpointercapture', lostCapture);
      nav.removeEventListener('click', click, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
      observer?.disconnect();
      clearTapRestore();
      const previous = gesture;
      gesture = undefined;
      if (previous) { suppressClick.current = true; releaseCapture(previous.id); }
      clearFrame();
      preview?.removeAttribute('data-nav-preview');
      nav.removeAttribute('data-nav-pressing');
      nav.removeAttribute('data-nav-dragging');
      nav.removeAttribute('data-nav-indicator-ready');
    };
  }, [ref, enabled, elastic, hidden, active, layoutKey]);
}
