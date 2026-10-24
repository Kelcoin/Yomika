import { afterEach, expect, it, vi } from 'vitest';
import { createWheelMotion, isDiscreteWheel } from '../../src/lib/wheelMotion';

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

it('merges wheel notches, decelerates continuously, and stops when interrupted', () => {
  let queued: FrameRequestCallback | undefined;
  let time = 0;
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { queued = callback; return 1; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { queued = undefined; });
  const step = () => { const callback = queued; queued = undefined; time += 16; callback?.(time); };
  const host = document.createElement('div');
  document.body.append(host);
  Object.defineProperties(host, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
  host.style.scrollBehavior = 'smooth';
  const motion = createWheelMotion();
  expect(motion.push(host, 120)).toBe(true);
  expect(host.scrollTop).toBe(0);
  step();
  const first = host.scrollTop;
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThan(120);
  motion.push(host, 120);
  for (let i = 0; i < 40; i++) step();
  expect(host.scrollTop).toBe(240);
  expect(queued).toBeUndefined();
  expect(host.style.scrollBehavior).toBe('smooth');
  motion.push(host, 120);
  motion.cancel();
  step();
  expect(host.scrollTop).toBe(240);
  motion.push(host, -120);
  for (let i = 0; i < 40; i++) step();
  expect(host.scrollTop).toBe(120);
});

it('preserves high resolution trackpad deltas and recognises line/page wheels', () => {
  expect(isDiscreteWheel({ deltaY: 2.5, deltaMode: 0 })).toBe(false);
  expect(isDiscreteWheel({ deltaY: 120, deltaMode: 0 })).toBe(true);
  expect(isDiscreteWheel({ deltaY: 3, deltaMode: 1 })).toBe(true);
});

it('finishes even when a webview rounds scroll positions to whole pixels', () => {
  let queued: FrameRequestCallback | undefined;
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { queued = callback; return 1; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { queued = undefined; });
  const host = document.createElement('div');
  document.body.append(host);
  let top = 0;
  Object.defineProperties(host, {
    scrollHeight: { value: 2000 }, clientHeight: { value: 500 },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.round(value); } },
  });
  createWheelMotion().push(host, 120);
  for (let time = 16; time <= 1600 && queued; time += 16) {
    const callback = queued; queued = undefined; callback(time);
  }
  expect(top).toBe(120);
  expect(queued).toBeUndefined();
});
