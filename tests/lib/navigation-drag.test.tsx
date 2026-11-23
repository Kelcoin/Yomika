import { fireEvent, render, screen, act } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNavigationDrag } from '../../src/lib/useNavigationDrag';

const navigate = vi.fn();
function Harness({ active = '/', enabled = true, hidden = false, floating = false }: { active?: string; enabled?: boolean; hidden?: boolean; floating?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useNavigationDrag(ref, { enabled, hidden, active, onSelect: navigate });
  return <nav ref={ref} className={floating ? 'is-floating' : undefined} aria-label="test"><span data-nav-indicator /><a href="#home" data-nav-route="/"><span className="nav-icon-pair" />首页</a><a href="#library" data-nav-route="/library"><span className="nav-icon-pair" />档案库</a><a href="#history" data-nav-route="/history"><span className="nav-icon-pair" />历史</a></nav>;
}
let frame: FrameRequestCallback | undefined;
let time = 0;
let resized: ResizeObserverCallback;
beforeEach(() => {
  navigate.mockReset();
  time = 0;
  frame = undefined;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => { frame = callback; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn(() => { frame = undefined; }));
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resized = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const route = this.closest<HTMLElement>('[data-nav-route]')?.dataset.navRoute;
    const x = route === '/library' ? 100 : route === '/history' ? 200 : 0;
    if (this.classList.contains('nav-icon-pair')) {
      return { x: x + 40, y: 10, left: x + 40, top: 10, right: x + 60, bottom: 30, width: 20, height: 20, toJSON() {} };
    }
    return { x, y: 0, left: x, top: 0, right: x + 100, bottom: 60, width: this.tagName === 'NAV' ? 300 : 100, height: 60, toJSON() {} };
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function pointer(type: string, x: number, y = 30, id = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y, isPrimary: id === 1 });
  fireEvent(screen.getByRole('navigation'), event);
}
function flush() { act(() => { const callback = frame; frame = undefined; time += 1000 / 60; callback?.(time); }); }
function settle() { for (let i = 0; frame && i < 180; i++) flush(); expect(frame).toBeUndefined(); }

it('previews continuous movement without navigation, then commits once on release and suppresses the compatibility click', () => {
  render(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', 170);
  flush();
  const nav = screen.getByRole('navigation');
  expect(nav).toHaveAttribute('data-nav-dragging');
  expect(parseFloat(nav.style.getPropertyValue('--nav-indicator-x'))).toBeGreaterThan(0);
  expect(parseFloat(nav.style.getPropertyValue('--nav-indicator-x'))).toBeLessThan(120);
  settle();
  expect(nav.style.getPropertyValue('--nav-indicator-x')).toBe('120px');
  expect(navigate).not.toHaveBeenCalled();
  pointer('pointerup', 170);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/library');
  expect(nav).not.toHaveAttribute('data-nav-dragging');
  expect(fireEvent.click(screen.getByText('首页'), { detail: 1 })).toBe(false);
  pointer('pointerdown', 250);
  pointer('pointerup', 250);
  expect(fireEvent.click(screen.getByText('历史'))).toBe(true);
});

it('lets ordinary taps use the existing link rather than issuing duplicate navigation', () => {
  render(<Harness />);
  pointer('pointerdown', 150);
  pointer('pointerup', 150);
  expect(navigate).not.toHaveBeenCalled();
  expect(fireEvent.click(screen.getByText('档案库'))).toBe(true);
});

it('keeps a tap highlight visible from an unlisted settings route through the route commit', () => {
  const view = render(<Harness active="/settings" />);
  const nav = screen.getByRole('navigation');
  pointer('pointerdown', 150);
  expect(nav).toHaveAttribute('data-nav-indicator-ready');
  pointer('pointerup', 150);
  expect(nav).toHaveAttribute('data-nav-indicator-ready');
  fireEvent.click(screen.getByText('档案库'), { detail: 1 });
  view.rerender(<Harness active="/library" />);
  expect(nav).toHaveAttribute('data-nav-indicator-ready');
  settle();
  expect(nav.style.getPropertyValue('--nav-indicator-x')).toBe('100px');
  expect(navigate).not.toHaveBeenCalled();
});

it('keeps moving toward the tapped tab across a deferred compatibility click and observer delivery', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const view = render(<Harness />);
  const nav = screen.getByRole('navigation');
  const position = () => parseFloat(nav.style.getPropertyValue('--nav-indicator-x'));
  pointer('pointerdown', 150);
  pointer('pointerup', 150);
  flush();
  const before = position();
  act(() => vi.advanceTimersByTime(32));
  act(() => resized([], {} as ResizeObserver));
  flush();
  expect(position()).toBeGreaterThan(before);
  fireEvent.click(screen.getByText('档案库'), { detail: 1 });
  view.rerender(<Harness active="/library" />);
  const committed = position();
  act(() => resized([], {} as ResizeObserver));
  expect(position()).toBe(committed);
  settle();
  expect(position()).toBe(100);
});

it('restores an unlisted route when a released tap never produces a click', () => {
  vi.useFakeTimers();
  render(<Harness active="/settings" />);
  pointer('pointerdown', 150);
  pointer('pointerup', 150);
  act(() => vi.runOnlyPendingTimers());
  settle();
  expect(screen.getByRole('navigation')).not.toHaveAttribute('data-nav-indicator-ready');
});

it.each(['pointercancel', 'lostpointercapture'])('restores the active tab after %s', (type) => {
  render(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', 240);
  flush();
  pointer(type, 240);
  settle();
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('navigation').style.getPropertyValue('--nav-indicator-x')).toBe('0px');
});

it('rejects vertical gestures and secondary pointers', () => {
  render(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', 60, 60);
  pointer('pointermove', 250);
  pointer('pointerup', 250);
  expect(navigate).not.toHaveBeenCalled();
  pointer('pointerdown', 50);
  pointer('pointermove', 240);
  pointer('pointerdown', 240, 30, 2);
  pointer('pointerup', 240);
  expect(navigate).not.toHaveBeenCalled();
});

it('cancels on blur, hiding or external navigation and stops pending frames on unmount', () => {
  const view = render(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', 240);
  fireEvent(window, new Event('blur'));
  pointer('pointerup', 240);
  expect(navigate).not.toHaveBeenCalled();
  pointer('pointerdown', 50);
  pointer('pointermove', 240);
  view.rerender(<Harness hidden />);
  pointer('pointerup', 240);
  expect(navigate).not.toHaveBeenCalled();
  view.rerender(<Harness active="/library" />);
  settle();
  expect(screen.getByRole('navigation').style.getPropertyValue('--nav-indicator-x')).toBe('100px');
  act(() => resized([], {} as ResizeObserver));
  pointer('pointerdown', 150);
  pointer('pointermove', 240);
  view.unmount();
  expect(cancelAnimationFrame).toHaveBeenCalled();
});

it('does not intercept desktop navigation or navigation to the active tab', () => {
  const view = render(<Harness enabled={false} />);
  pointer('pointerdown', 50);
  pointer('pointermove', 240);
  pointer('pointerup', 240);
  expect(navigate).not.toHaveBeenCalled();
  view.rerender(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', 65);
  pointer('pointerup', 65);
  expect(navigate).not.toHaveBeenCalled();
});

it('suppresses the old link click even after the selected route rerenders, while keyboard activation remains usable', () => {
  const view = render(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', 170);
  pointer('pointerup', 170);
  view.rerender(<Harness active="/library" />);
  expect(fireEvent.click(screen.getByText('首页'), { detail: 1 })).toBe(false);
  expect(fireEvent.click(screen.getByText('历史'), { detail: 0 })).toBe(true);
});

it('bounds edge stretching and uses the release position even when its final move was not painted', () => {
  render(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', -500);
  flush();
  const offset = parseFloat(screen.getByRole('navigation').style.getPropertyValue('--nav-indicator-x'));
  expect(offset).toBeGreaterThanOrEqual(-6);
  pointer('pointerup', 250);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/history');
});

it('cancels an in-flight drag if another navigation changes the active route', () => {
  const view = render(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', 240);
  view.rerender(<Harness active="/library" />);
  pointer('pointerup', 240);
  flush();
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('navigation')).not.toHaveAttribute('data-nav-dragging');
});

it('does not read layout during pointer movement', () => {
  render(<Harness />);
  pointer('pointerdown', 50);
  const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
  measure.mockClear();
  for (const x of [70, 100, 170, 240]) pointer('pointermove', x);
  flush();
  settle();
  expect(measure).not.toHaveBeenCalled();
});

it('aligns the soft icon mask to the stretched capsule and ramps scale before route selection', () => {
  render(<Harness floating />);
  const nav = screen.getByRole('navigation');
  const origin = screen.getByText('首页');
  const destination = screen.getByText('档案库');
  const value = (element: HTMLElement, name: string) => parseFloat(element.style.getPropertyValue(name));
  pointer('pointerdown', 50);
  settle();
  expect(value(origin, '--nav-icon-scale')).toBeCloseTo(1.32);
  expect(value(destination, '--nav-icon-scale')).toBe(1);
  pointer('pointermove', 87);
  settle();
  const x = value(nav, '--nav-indicator-x');
  const scaleX = value(nav, '--nav-indicator-scale-x');
  const scaleY = value(nav, '--nav-indicator-scale-y');
  expect(value(nav, '--nav-mask-rx')).toBeCloseTo(30 * scaleX);
  expect(value(nav, '--nav-mask-ry')).toBeCloseTo(30 * scaleY);
  expect(value(nav, '--nav-mask-span-x')).toBeCloseTo(40 * scaleX);
  expect(value(destination, '--nav-mask-x')).toBeCloseTo(x - 100);
  expect(value(destination, '--nav-mask-y')).toBe(10);
  expect(value(destination, '--nav-icon-scale')).toBeGreaterThan(1);
  expect(value(destination, '--nav-icon-scale')).toBeLessThan(scaleY);
  expect(destination).not.toHaveAttribute('data-nav-preview');
  expect(navigate).not.toHaveBeenCalled();
});

it('preserves position across a route commit and animates the remainder without snapping', () => {
  const view = render(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', 150);
  flush();
  const nav = screen.getByRole('navigation');
  const before = nav.style.getPropertyValue('--nav-indicator-x');
  pointer('pointerup', 150);
  view.rerender(<Harness active="/library" />);
  expect(nav.style.getPropertyValue('--nav-indicator-x')).toBe(before);
  settle();
  expect(nav.style.getPropertyValue('--nav-indicator-x')).toBe('100px');
});

it('honors reduced motion without a spring or deformation', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  render(<Harness />);
  pointer('pointerdown', 50);
  pointer('pointermove', 150);
  const nav = screen.getByRole('navigation');
  expect(nav.style.getPropertyValue('--nav-indicator-x')).toBe('100px');
  expect(nav.style.getPropertyValue('--nav-indicator-scale-x')).toBe('1');
  expect(frame).toBeUndefined();
  pointer('pointerup', 150);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/library');
});

it('keeps the full fixed indicator inside the bar at its edge', () => {
  render(<Harness />);
  pointer('pointerdown', 50);
  settle();
  const style = screen.getByRole('navigation').style;
  expect(style.getPropertyValue('--nav-indicator-scale-x')).toBe('1');
  expect(style.getPropertyValue('--nav-indicator-scale-y')).toBe('1');
  expect(style.getPropertyValue('--nav-icon-scale')).toBe('');
});

it('springs the enlarged floating indicator and icon back on release', () => {
  render(<Harness floating />);
  pointer('pointerdown', 50);
  settle();
  const nav = screen.getByRole('navigation');
  expect(parseFloat(nav.style.getPropertyValue('--nav-indicator-scale-x'))).toBeCloseTo(1.30);
  expect(parseFloat(screen.getByText('首页').style.getPropertyValue('--nav-icon-scale'))).toBeCloseTo(1.32);
  pointer('pointerup', 50);
  expect(parseFloat(nav.style.getPropertyValue('--nav-indicator-scale-x'))).toBeCloseTo(1.30);
  flush();
  expect(parseFloat(nav.style.getPropertyValue('--nav-indicator-scale-x'))).toBeGreaterThan(1);
  settle();
  expect(nav.style.getPropertyValue('--nav-indicator-scale-x')).toBe('1');
});
