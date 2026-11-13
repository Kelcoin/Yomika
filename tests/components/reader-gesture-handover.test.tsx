import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Profiler } from 'react';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import { setImageDecoderForTests } from '../../src/lib/decodeImage';

afterEach(() => { setImageDecoderForTests(undefined); vi.restoreAllMocks(); });
beforeEach(() => {
  // These tests operate on an already displayed/decoded original image.
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(128);
});
const plain = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const touches = (distance: number) => [{ clientX: 200 - distance / 2, clientY: 300 }, { clientX: 200 + distance / 2, clientY: 300 }];
const view = (derived = new Map<number, string>()) => <MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="single" pages={[plain]} derivedPages={derived} /></MemoryRouter>;

it('keeps the touch target mounted when inference completes mid-pinch, then settles before promoting', async () => {
  setImageDecoderForTests(async () => {});
  const { rerender } = render(view());
  const target = screen.getByRole('img', { name: '第 1 页' });
  fireEvent.touchStart(target, { touches: touches(200) });
  fireEvent.touchMove(target, { touches: touches(40) });
  await act(async () => { await new Promise(requestAnimationFrame); });
  const frame = target.closest('.reader-single') as HTMLElement;
  expect(frame.style.transform).toContain('scale(0.88)');
  await act(async () => { rerender(view(new Map([[0, 'blob:enhanced']]))); });
  // Touch events stay targeted at the element from touchstart, even if removed.
  expect(target.isConnected).toBe(true);
  expect(screen.getByRole('img', { name: '第 1 页' })).toBe(target);
  fireEvent.touchEnd(target, { touches: [], changedTouches: touches(40) });
  expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced');
});

it('does not promote an already decoding candidate while a new pinch owns the displayed image', async () => {
  let complete!: () => void;
  setImageDecoderForTests(() => new Promise(resolve => { complete = resolve; }));
  const { rerender } = render(view());
  const target = screen.getByRole('img', { name: '第 1 页' });
  rerender(view(new Map([[0, 'blob:enhanced']])));
  fireEvent.touchStart(target, { touches: touches(200) });
  await act(async () => { complete(); });
  expect(target.isConnected).toBe(true);
  fireEvent.touchCancel(target);
});

it('runs undershoot recovery from explicit last-painted keyframes without awaiting another render', async () => {
  render(view());
  const target = screen.getByRole('img', { name: '第 1 页' });
  const frame = target.closest('.reader-single') as HTMLElement;
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel, onfinish: null }));
  Object.defineProperty(frame, 'animate', { configurable: true, value: animate });
  fireEvent.touchStart(target, { touches: touches(200) });
  fireEvent.touchMove(target, { touches: touches(40) });
  await act(async () => { await new Promise(requestAnimationFrame); });
  const from = frame.style.transform;
  fireEvent.touchEnd(target, { touches: [], changedTouches: touches(40) });
  expect(animate).toHaveBeenCalledWith([{ transform: from }, { transform: 'scale(1) translate(0px, 0px)' }], { duration: 140, easing: 'ease-out' });
  expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
  fireEvent.touchCancel(target);
  expect(cancel).not.toHaveBeenCalled();
  // A new gesture interrupts recovery immediately instead of chasing its target.
  fireEvent.touchStart(target, { touches: touches(200) });
  fireEvent.touchMove(target, { touches: touches(300) });
  expect(cancel).toHaveBeenCalledOnce();
});

it('keeps the remaining touch pan alive when the other finger loses implicit capture', async () => {
  render(view());
  const target = screen.getByRole('img', { name: '第 1 页' });
  fireEvent.touchStart(target, { touches: touches(200) });
  fireEvent.touchMove(target, { touches: touches(400) });
  await act(async () => { await new Promise(requestAnimationFrame); });
  fireEvent.touchEnd(target, { touches: [{ clientX: 200, clientY: 300 }], changedTouches: [{ clientX: 400, clientY: 300 }] });
  fireEvent.lostPointerCapture(target, { pointerType: 'touch', pointerId: 2 });
  fireEvent.touchMove(target, { touches: [{ clientX: 260, clientY: 330 }] });
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect((target.closest('.reader-single') as HTMLElement).style.transform).toContain('scale(2)');
  expect((target.closest('.reader-single') as HTMLElement).style.transform).not.toContain('translate(0px, 0px)');
  fireEvent.touchEnd(target, { touches: [] });
});

it('coalesces wheel transforms without reconciling the reader for each wheel event', async () => {
  let commits = 0;
  render(<Profiler id="reader" onRender={() => commits++}>{view()}</Profiler>);
  await act(async () => { await new Promise(requestAnimationFrame); });
  commits = 0;
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  for (let i = 0; i < 40; i++) fireEvent.wheel(reader, { deltaY: -2, clientX: 200, clientY: 300 });
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(commits).toBeLessThanOrEqual(3);
  const transform = (screen.getByRole('img', { name: '第 1 页' }).closest('.reader-single') as HTMLElement).style.transform;
  expect(Number(/scale\(([^)]+)/.exec(transform)?.[1])).toBeCloseTo(Math.exp(.12), 10);
});
