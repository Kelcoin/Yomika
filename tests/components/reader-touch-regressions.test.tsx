import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import * as platform from '../../src/bridge/platform';
import { Profiler } from 'react';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  // Fixture blob URLs represent decoded pages; jsdom never loads them itself.
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(128);
});
function mount() {
  render(<MemoryRouter><ReaderScreen archiveId="touch" title="Touch" pages={['blob:a']} layout="single" /></MemoryRouter>);
  return screen.getByRole('main', { name: '漫画阅读器' });
}
it.each([1, window.innerWidth - 1])('summons the top bar across the whole upper band at x=%s', (clientX) => {
  const reader = mount();
  const point = { clientX, clientY: 150 };
  fireEvent.touchStart(reader, { touches: [point] });
  fireEvent.touchEnd(reader, { touches: [], changedTouches: [point] });
  expect(document.querySelector('.reader-chrome-top')).toBeInTheDocument();
});

it('keeps a horizontal page drag attached when the finger later moves diagonally', () => {
  vi.useFakeTimers();
  render(<MemoryRouter><ReaderScreen archiveId="diagonal" title="Diagonal" pages={['blob:a', 'blob:b']} layout="single" /></MemoryRouter>);
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  const track = reader.querySelector('.reader-track') as HTMLElement;
  fireEvent.touchStart(reader, { touches: [{ clientX: 600, clientY: 300 }] });
  fireEvent.touchMove(reader, { touches: [{ clientX: 480, clientY: 310 }] });
  act(() => vi.advanceTimersByTime(16));
  expect(track.style.transform).toBe('translate3d(-120px,0,0)');
  fireEvent.touchMove(reader, { touches: [{ clientX: 450, clientY: 500 }] });
  act(() => vi.advanceTimersByTime(16));
  expect(track.style.transform).toBe('translate3d(-150px,0,0)');
  expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
});
it('summons the bottom bar on a touch release at the last canvas pixel without needing a click', () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('pointer: coarse') || query.includes('hover: none'), media: query, addEventListener() {}, removeEventListener() {} }));
  const reader = mount();
  const point = { clientX: window.innerWidth / 2, clientY: window.innerHeight - 1 };
  fireEvent.touchStart(reader, { touches: [point] });
  fireEvent.touchEnd(reader, { touches: [], changedTouches: [point] });
  expect(screen.getByRole('toolbar')).toBeInTheDocument();
  // The compatibility click must not undo what touchend just opened.
  fireEvent.click(reader, { ...point, detail: 1 });
  expect(screen.getByRole('toolbar')).not.toHaveClass('is-leaving');
  expect(document.querySelector('.reader-chrome-top')).toBeNull();
});

it('keeps a bottom-edge swipe from summoning the toolbar', () => {
  vi.useFakeTimers();
  const reader = mount();
  const point = { clientX: 200, clientY: window.innerHeight - 1 };
  fireEvent.touchStart(reader, { touches: [point] });
  fireEvent.touchMove(reader, { touches: [{ ...point, clientY: point.clientY - 80 }] });
  fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ ...point, clientY: point.clientY - 80 }] });
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
});
it('moves the existing track on the first horizontal sample without reconciling the reader', () => {
  vi.useFakeTimers();
  const renders = vi.fn();
  render(<MemoryRouter><Profiler id="reader" onRender={renders}><ReaderScreen archiveId="swipe" title="Swipe" pages={['blob:a', 'blob:b']} layout="single" /></Profiler></MemoryRouter>);
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  const track = reader.querySelector<HTMLElement>('.reader-track')!;
  fireEvent.touchStart(reader, { touches: [{ clientX: 600, clientY: 300 }] });
  renders.mockClear();
  fireEvent.touchMove(reader, { touches: [{ clientX: 480, clientY: 300 }] });
  act(() => vi.advanceTimersByTime(16));
  expect(track.style.transform).toBe('translate3d(-120px,0,0)');
  expect(renders).not.toHaveBeenCalled();
  fireEvent.touchCancel(reader);
});

it('applies the latest pinch sample without scheduling a frame or rendering the reader', () => {
  vi.useFakeTimers();
  const renders = vi.fn();
  render(<MemoryRouter><Profiler id="reader" onRender={renders}><ReaderScreen archiveId="pinch" title="Pinch" pages={['blob:a']} layout="single" /></Profiler></MemoryRouter>);
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
  act(() => vi.advanceTimersByTime(32));
  fireEvent.touchStart(reader, { touches: [{ clientX: 400, clientY: 300 }, { clientX: 600, clientY: 300 }] });
  renders.mockClear();
  const scheduled = vi.spyOn(window, 'requestAnimationFrame');
  for (let step = 1; step <= 16; step++) {
    fireEvent.touchMove(reader, { touches: [{ clientX: 400 - step * 5, clientY: 300 }, { clientX: 600 + step * 5, clientY: 300 }] });
  }
  expect(renders).not.toHaveBeenCalled();
  expect(scheduled).not.toHaveBeenCalled();
  expect(frame.style.transform).toContain('scale(1.8)');
  expect(renders).not.toHaveBeenCalled();
  // Release before the next paint must preserve the latest input, too.
  fireEvent.touchMove(reader, { touches: [{ clientX: 300, clientY: 300 }, { clientX: 700, clientY: 300 }] });
  fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: 300, clientY: 300 }, { clientX: 700, clientY: 300 }] });
  expect(frame.style.transform).toContain('scale(2)');
  act(() => vi.advanceTimersByTime(32));
  expect(frame.style.transform).toContain('scale(2)');
});

it('mounts only the visible continuous-page slots for a long archive', () => {
  vi.useFakeTimers();
  render(<MemoryRouter><ReaderScreen archiveId="long" title="Long" pages={Array.from({ length: 2000 }, () => '')} layout="webtoon" /></MemoryRouter>);
  expect(document.querySelectorAll('.reader-webtoon-slot').length).toBeLessThan(20);
  const scroller = screen.getByRole('region', { name: '连续阅读' });
  const extent = () => [...scroller.querySelectorAll<HTMLElement>('.reader-webtoon-slot, .reader-webtoon-spacer')].reduce((sum, item) => sum + parseFloat(item.style.height), 0);
  const total = extent();
  scroller.scrollTop = total / 2;
  fireEvent.scroll(scroller);
  act(() => vi.advanceTimersByTime(32));
  expect(scroller.scrollTop).toBe(total / 2);
  expect(extent()).toBe(total);
  expect(document.querySelectorAll('.reader-webtoon-slot').length).toBeLessThan(20);
  expect(parseFloat(scroller.querySelector<HTMLElement>('.reader-webtoon-spacer')!.style.height)).toBeGreaterThan(0);
});

it('lets a pinch take over an unfinished page-turn animation immediately', () => {
  vi.useFakeTimers();
  render(<MemoryRouter><ReaderScreen archiveId="takeover" title="Takeover" pages={['blob:a', 'blob:b']} layout="single" /></MemoryRouter>);
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  const track = reader.querySelector('.reader-track') as HTMLElement;
  const animation = { cancel: vi.fn(), onfinish: undefined };
  const animate = vi.fn(() => animation);
  Object.defineProperty(track, 'animate', { value: animate });
  fireEvent.touchStart(reader, { touches: [{ clientX: 600, clientY: 300 }] });
  fireEvent.touchMove(reader, { touches: [{ clientX: 300, clientY: 300 }] });
  fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: 300, clientY: 300 }] });
  expect(animate).toHaveBeenCalledTimes(1);
  fireEvent.touchStart(reader, { touches: [{ clientX: 400, clientY: 300 }, { clientX: 600, clientY: 300 }] });
  expect(animation.cancel).toHaveBeenCalled();
  fireEvent.touchMove(reader, { touches: [{ clientX: 300, clientY: 300 }, { clientX: 700, clientY: 300 }] });
  act(() => vi.advanceTimersByTime(16));
  expect((reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement).style.transform).toContain('scale(2)');
  expect(track.style.transform).toBe('translate3d(0,0,0)');
  expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
  fireEvent.touchEnd(reader, { touches: [] });
});
it('applies a precision-touchpad pinch to the incoming page before the slide ends', () => {
  vi.useFakeTimers();
  render(<MemoryRouter><ReaderScreen archiveId="touchpad-takeover" title="Takeover" pages={['blob:a', 'blob:b']} layout="single" /></MemoryRouter>);
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  const track = reader.querySelector<HTMLElement>('.reader-track')!;
  const animation = { cancel: vi.fn(), onfinish: undefined };
  track.animate = vi.fn().mockReturnValue(animation);
  fireEvent.touchStart(reader, { touches: [{ clientX: 600, clientY: 300 }] });
  fireEvent.touchMove(reader, { touches: [{ clientX: 300, clientY: 300 }] });
  fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: 300, clientY: 300 }] });
  expect(track.animate).toHaveBeenCalledTimes(1);
  act(() => { fireEvent.wheel(reader, { ctrlKey: true, deltaY: -120, clientX: 500, clientY: 300 }); });
  act(() => vi.advanceTimersByTime(16));
  expect(animation.cancel).toHaveBeenCalledOnce();
  const frame = reader.querySelector<HTMLElement>('[aria-label="分页阅读"] > div')!;
  expect(Number(frame.style.transform.match(/scale\(([^)]+)\)/)?.[1])).toBeGreaterThan(1);
});

it('starts a pinch at the displayed zoom instead of the double-tap animation target', () => {
  vi.useFakeTimers();
  const reader = mount();
  const frame = reader.querySelector<HTMLElement>('.reader-single')!;
  const animation = { cancel: vi.fn(), onfinish: null };
  frame.animate = vi.fn().mockReturnValue(animation);
  fireEvent.doubleClick(reader);
  expect(frame.style.transform).toContain('scale(1.75)');

  vi.stubGlobal('DOMMatrixReadOnly', class { a = 1.1; e = 0; f = 0; });
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (element === frame) return { transform: 'matrix(1.1, 0, 0, 1.1, 0, 0)' } as CSSStyleDeclaration;
    return computedStyle(element, pseudo);
  });
  fireEvent.touchStart(frame, { touches: [{ clientX: 400, clientY: 300 }, { clientX: 600, clientY: 300 }] });
  fireEvent.touchMove(frame, { touches: [{ clientX: 390, clientY: 300 }, { clientX: 610, clientY: 300 }] });
  // The touch sample must be visible before an extra animation-frame callback.
  expect(animation.cancel).toHaveBeenCalledOnce();
  expect(Number(frame.style.transform.match(/scale\(([^)]+)\)/)?.[1])).toBeCloseTo(1.21);
});

it('toggles a landscape page with large black borders between fit and cover on a portrait screen', () => {
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 576);
  vi.stubGlobal('innerHeight', 922);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1920);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(1080);
  const reader = mount();
  const frame = reader.querySelector<HTMLElement>('.reader-single')!;
  const point = { clientX: 288, clientY: 461 };
  const tap = () => {
    fireEvent.touchStart(frame, { touches: [point] });
    fireEvent.touchEnd(frame, { touches: [], changedTouches: [point] });
  };
  tap();
  act(() => vi.advanceTimersByTime(90));
  tap();
  expect(Number(frame.style.transform.match(/scale\(([^)]+)\)/)?.[1])).toBeCloseTo(922 / 324);
  act(() => vi.advanceTimersByTime(350));
  tap();
  act(() => vi.advanceTimersByTime(90));
  tap();
  expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
});

it('keeps a touch double zoom after the compatibility dblclick', () => {
  vi.useFakeTimers();
  const reader = mount();
  const point = { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 };
  const tap = () => {
    fireEvent.touchStart(reader, { touches: [point] });
    fireEvent.touchEnd(reader, { touches: [], changedTouches: [point] });
  };
  tap(); act(() => vi.advanceTimersByTime(90)); tap();
  fireEvent.doubleClick(reader, point);
  expect(reader.querySelector('[aria-label="分页阅读"] > div')).toHaveStyle({ transform: 'scale(1.75) translate(0px, 0px)' });
  act(() => vi.advanceTimersByTime(700)); tap();
  act(() => vi.advanceTimersByTime(90)); tap();
  fireEvent.doubleClick(reader, point);
  expect(reader.querySelector('[aria-label="分页阅读"] > div')).toHaveStyle({ transform: 'scale(3) translate(0px, 0px)' });
  act(() => vi.advanceTimersByTime(700)); tap();
  act(() => vi.advanceTimersByTime(90)); tap();
  expect(reader.querySelector('[aria-label="分页阅读"] > div')).toHaveStyle({ transform: 'scale(1) translate(0px, 0px)' });
});

it('restores the system status bar with the top bar and when leaving the reader', () => {
  vi.useFakeTimers();
  const status = vi.spyOn(platform, 'setStatusBarVisible').mockResolvedValue({ ok: true, value: undefined });
  const reader = mount();
  expect(status).toHaveBeenLastCalledWith(false);
  fireEvent.mouseMove(reader, { clientY: 20, buttons: 0 });
  expect(status).toHaveBeenLastCalledWith(true);
  act(() => vi.advanceTimersByTime(4_500));
  act(() => vi.advanceTimersByTime(300));
  expect(status).toHaveBeenLastCalledWith(false);
  cleanup();
  expect(status).toHaveBeenLastCalledWith(true);
  status.mockRestore();
});
it('auto hides a bottom bar after compatibility mouse movement', () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('pointer: coarse') || query.includes('hover: none'), media: query, addEventListener() {}, removeEventListener() {} }));
  const reader = mount();
  const point = { clientY: window.innerHeight - 50, clientX: 100 };
  fireEvent.mouseMove(reader, { ...point, buttons: 0 });
  fireEvent.click(reader, point);
  expect(screen.getByRole('toolbar')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(4_500));
  act(() => vi.advanceTimersByTime(300));
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
});

it('does not let a canvas touch activate the back button revealed under that finger', () => {
  vi.useFakeTimers();
  render(<MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
    <Routes><Route path="/library" element={<p>back destination</p>} />
      <Route path="/reader" element={<ReaderScreen archiveId="back" title="Back" pages={['blob:a']} />} />
    </Routes>
  </MemoryRouter>);
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  const point = { clientX: 24, clientY: 24 };
  fireEvent.touchStart(reader, { touches: [point] });
  fireEvent.touchEnd(reader, { touches: [], changedTouches: [point] });
  const back = screen.getByRole('button', { name: '返回上一页' });
  // Android WebView may hit-test its delayed compatibility click against
  // the newly mounted toolbar rather than the original canvas.
  fireEvent.mouseDown(back, { ...point, button: 0 });
  fireEvent.mouseUp(back, { ...point, button: 0 });
  fireEvent.click(back, { ...point, detail: 1 });
  expect(screen.queryByText('back destination')).not.toBeInTheDocument();
  expect(reader).toBeInTheDocument();
  // A distinct touch must work immediately, without waiting for a cooldown.
  fireEvent.touchStart(back, { touches: [point] });
  fireEvent.touchEnd(back, { touches: [], changedTouches: [point] });
  fireEvent.click(back, { ...point, detail: 1 });
  expect(screen.getByText('back destination')).toBeInTheDocument();
});

it('keeps the back control mounted during a press near the auto-hide deadline', () => {
  vi.useFakeTimers();
  render(<MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
    <Routes><Route path="/library" element={<p>back destination</p>} />
      <Route path="/reader" element={<ReaderScreen archiveId="back" title="Back" pages={['blob:a']} />} />
    </Routes>
  </MemoryRouter>);
  fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }), { clientY: 20 });
  act(() => vi.advanceTimersByTime(4490));
  const back = screen.getByRole('button', { name: '返回上一页' });
  fireEvent.pointerDown(back, { pointerType: 'touch' });
  act(() => vi.advanceTimersByTime(300));
  expect(back).toBeInTheDocument();
  fireEvent.click(back);
  expect(screen.getByText('back destination')).toBeInTheDocument();
});

it('warms the next paged image while idle and reuses it on landing', async () => {
  vi.useFakeTimers();
  const decode = vi.fn(async function(this: HTMLImageElement) {});
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('pointer: coarse'), media: query, addEventListener() {}, removeEventListener() {} }));
  const previousDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: decode });
  try {
    render(<MemoryRouter><ReaderScreen archiveId="warm" title="Warm" pages={['blob:a', 'blob:b', 'blob:c', 'blob:d']} initialPage={1} layout="single" /></MemoryRouter>);
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const incoming = reader.querySelector<HTMLImageElement>('img[src="blob:c"]')!;
    const touches = [{ clientX: 400, clientY: 300 }, { clientX: 600, clientY: 300 }];
    fireEvent.touchStart(reader, { touches });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(decode).not.toHaveBeenCalled();
    fireEvent.touchEnd(reader, { touches: [], changedTouches: touches });
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(decode.mock.contexts).toEqual([incoming]);
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: '第 3 页' })).toBe(incoming);
  } finally {
    if (previousDecode) Object.defineProperty(HTMLImageElement.prototype, 'decode', previousDecode);
    else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
  }
});
