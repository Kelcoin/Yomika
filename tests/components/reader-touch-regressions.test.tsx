import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import * as platform from '../../src/bridge/platform';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount() {
  render(<MemoryRouter><ReaderScreen archiveId="touch" title="Touch" pages={['blob:a']} layout="single" /></MemoryRouter>);
  return screen.getByRole('main', { name: '漫画阅读器' });
}
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
