import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import * as platform from '../../src/bridge/platform';
import { Profiler } from 'react';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
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
it('coalesces pinch moves without rendering the reader for each touch sample', () => {
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
  expect(scheduled).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(16));
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
  expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  fireEvent.touchEnd(reader, { touches: [] });
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
  expect(reader.querySelector('[aria-label="分页阅读"] > div')).toHaveStyle({ transform: 'scale(2) translate(0px, 0px)' });
  act(() => vi.advanceTimersByTime(700)); tap();
  act(() => vi.advanceTimersByTime(90)); tap();
  fireEvent.doubleClick(reader, point);
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
