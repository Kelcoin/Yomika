import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installHorizontalEdgeBounce } from '../../src/lib/horizontalEdgeBounce';

let rail: HTMLDivElement;
let track: HTMLDivElement;
let motion: ReturnType<typeof installHorizontalEdgeBounce>;
const touch = (x: number, y = 20) => ({ touches: [{ clientX: x, clientY: y }] });
beforeEach(() => {
  vi.useFakeTimers();
  rail = document.createElement('div');
  track = document.createElement('div');
  track.dataset.horizontalContent = '';
  rail.append(track);
  document.body.append(rail);
  Object.defineProperties(rail, { clientWidth: { value: 300 }, scrollWidth: { value: 1000 } });
  motion = installHorizontalEdgeBounce(rail);
});
afterEach(() => { motion.dispose(); rail.remove(); vi.useRealTimers(); });

it('resists outward drags at both edges, then restores the content layer', () => {
  for (const [left, from, to] of [[0, 100, 220], [700, 220, 100]]) {
    rail.scrollLeft = left!;
    fireEvent.touchStart(rail, touch(from!));
    expect(fireEvent.touchMove(rail, touch(to!))).toBe(false);
    vi.advanceTimersByTime(17);
    const offset = parseFloat(track.style.translate);
    expect(Math.abs(offset)).toBeGreaterThan(0);
    expect(Math.abs(offset)).toBeLessThan(64);
    expect(Math.sign(offset)).toBe(left === 0 ? 1 : -1);
    expect(rail.scrollLeft).toBe(left);
    fireEvent.touchEnd(rail);
    expect(track.style.transition).toContain('translate 360ms');
    vi.advanceTimersByTime(360);
    expect(track.style.translate).toBe('');
  }
});

it('does not claim vertical movement, taps, or native scrolling inside the range', () => {
  fireEvent.touchStart(rail, touch(100));
  expect(fireEvent.touchMove(rail, touch(102, 90))).toBe(true);
  expect(motion.isActive()).toBe(false);
  fireEvent.touchEnd(rail);
  rail.scrollLeft = 200;
  fireEvent.touchStart(rail, touch(100));
  expect(fireEvent.touchMove(rail, touch(30))).toBe(true);
  expect(motion.isActive()).toBe(false);
  fireEvent.touchEnd(rail);
  fireEvent.touchStart(rail, touch(100));
  fireEvent.touchEnd(rail);
  expect(track.style.translate).toBe('');
});

it('can reach an edge and pull further in one continuous gesture without jumping', () => {
  rail.scrollLeft = 200;
  fireEvent.touchStart(rail, touch(300));
  fireEvent.touchMove(rail, touch(200));
  rail.scrollLeft = 700;
  fireEvent.touchMove(rail, touch(100));
  expect(motion.isActive()).toBe(false);
  fireEvent.touchMove(rail, touch(60));
  vi.advanceTimersByTime(17);
  expect(parseFloat(track.style.translate)).toBeLessThan(0);
  fireEvent.touchCancel(rail);
  expect(track.style.translate).toBe('');
});

it('coalesces repeated moves and cancels pending work on multitouch and disposal', () => {
  const frame = vi.spyOn(window, 'requestAnimationFrame');
  fireEvent.touchStart(rail, touch(100));
  fireEvent.touchMove(rail, touch(140));
  fireEvent.touchMove(rail, touch(170));
  expect(frame).toHaveBeenCalledTimes(1);
  fireEvent.touchMove(rail, { touches: [{ clientX: 170, clientY: 20 }, { clientX: 200, clientY: 20 }] });
  vi.advanceTimersByTime(17);
  expect(track.style.translate).toBe('');
  motion.wheel(-100);
  vi.advanceTimersByTime(17);
  expect(parseFloat(track.style.translate)).toBeGreaterThan(0);
  motion.dispose();
  vi.advanceTimersByTime(1000);
  expect(track.style.translate).toBe('');
  frame.mockRestore();
});
