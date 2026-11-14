import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReaderScreen } from '../../src/components/ReaderScreen';
import { RetainedPage } from '../../src/app/RetainedPage';

const pages = Array.from({ length: 8 }, () => 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=');

function readyImages(container: HTMLElement) {
  for (const image of container.querySelectorAll('img')) {
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 128 },
      naturalHeight: { configurable: true, value: 192 },
    });
    fireEvent.load(image);
  }
}

function mount(direction: 'ltr' | 'rtl' = 'ltr', layout: 'single' | 'double' | 'webtoon' = 'single', initialPage = 0) {
  const progress = vi.fn();
  const view = render(<MemoryRouter><ReaderScreen archiveId="auto-turn" title="Auto" pages={pages} direction={direction} layout={layout} initialPage={initialPage} onProgress={progress} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
  fireEvent.click(screen.getByRole('button', { name: '自动翻页' }));
  return { ...view, progress };
}

const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  vi.useRealTimers();
  if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
  else delete (document as { visibilityState?: string }).visibilityState;
});

describe('reader auto turn', () => {
  it.each(['ltr', 'rtl'] as const)('advances in reading order in %s single and double page layouts', (direction) => {
    for (const layout of ['single', 'double'] as const) {
      const view = mount(direction, layout);
      readyImages(view.container);
      act(() => vi.advanceTimersByTime(5_000));
      expect(view.progress).toHaveBeenLastCalledWith(1, { layout, direction });
      readyImages(view.container);
      act(() => vi.advanceTimersByTime(5_000));
      expect(view.progress).toHaveBeenLastCalledWith(layout === 'double' ? 3 : 2, { layout, direction });
      view.unmount();
    }
  });

  it('waits for the current image, then gives it a full countdown', () => {
    const view = mount();
    act(() => vi.advanceTimersByTime(10_000));
    expect(view.progress).toHaveBeenLastCalledWith(0, expect.anything());
    expect(screen.getByRole('progressbar', { name: '自动翻页进度' })).toHaveAttribute('data-running', 'false');
    readyImages(view.container);
    expect(screen.getByRole('progressbar', { name: '自动翻页进度' })).toHaveAttribute('data-running', 'true');
    act(() => vi.advanceTimersByTime(4_999));
    expect(view.progress).toHaveBeenLastCalledWith(0, expect.anything());
    act(() => vi.advanceTimersByTime(1));
    expect(view.progress).toHaveBeenLastCalledWith(1, expect.anything());
  });

  it('does not restart the countdown when a neighbouring or enhanced image loads', () => {
    const view = mount();
    readyImages(view.container);
    act(() => vi.advanceTimersByTime(3_000));
    readyImages(view.container);
    act(() => vi.advanceTimersByTime(2_000));
    expect(view.progress).toHaveBeenLastCalledWith(1, expect.anything());
  });

  it('waits for both halves of a spread before starting', () => {
    const view = mount('rtl', 'double', 1);
    const left = screen.getByRole('img', { name: '第 2 页' });
    const right = screen.getByRole('img', { name: '第 3 页' });
    for (const image of [left, right]) {
      Object.defineProperties(image, { complete: { configurable: true, value: false }, naturalWidth: { configurable: true, value: 0 } });
    }
    Object.defineProperties(left, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 128 }, naturalHeight: { configurable: true, value: 192 } });
    fireEvent.load(left);
    act(() => vi.advanceTimersByTime(5_000));
    expect(view.progress).toHaveBeenLastCalledWith(1, expect.anything());
    readyImages(view.container);
    act(() => vi.advanceTimersByTime(5_000));
    expect(view.progress).toHaveBeenLastCalledWith(3, expect.anything());
  });

  it('cancels its timer while the reader is cached behind another page', () => {
    const progress = vi.fn();
    const content = (active: boolean) => <MemoryRouter><RetainedPage active={active}><ReaderScreen archiveId="cached-auto" title="Auto" pages={pages} layout="single" onProgress={progress} /></RetainedPage></MemoryRouter>;
    const view = render(content(true));
    readyImages(view.container);
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '自动翻页' }));
    act(() => vi.advanceTimersByTime(3_000));
    view.rerender(content(false));
    act(() => vi.advanceTimersByTime(10_000));
    expect(progress).toHaveBeenLastCalledWith(0, expect.anything());
    view.rerender(content(true));
    act(() => vi.advanceTimersByTime(5_000));
    expect(progress).toHaveBeenLastCalledWith(1, expect.anything());
  });

  it('restarts after a manual page turn and uses a changed reading direction', () => {
    const view = mount();
    readyImages(view.container);
    act(() => vi.advanceTimersByTime(4_000));
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    readyImages(view.container);
    fireEvent.click(screen.getByRole('button', { name: '从左到右' }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole('button', { name: '从右到左' })).toBeInTheDocument();
    expect(view.progress).toHaveBeenLastCalledWith(1, expect.anything());
    act(() => vi.advanceTimersByTime(4_000));
    expect(view.progress).toHaveBeenLastCalledWith(2, { layout: 'single', direction: 'rtl' });
  });

  it('pauses in the background, restarts on return, and removes the countdown when stopped', () => {
    const view = mount();
    readyImages(view.container);
    act(() => vi.advanceTimersByTime(3_000));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(10_000));
    expect(view.progress).toHaveBeenLastCalledWith(0, expect.anything());
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(4_999));
    expect(view.progress).toHaveBeenLastCalledWith(0, expect.anything());
    act(() => vi.advanceTimersByTime(1));
    expect(view.progress).toHaveBeenLastCalledWith(1, expect.anything());
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '停止自动翻页' }));
    expect(screen.queryByRole('progressbar', { name: '自动翻页进度' })).not.toBeInTheDocument();
  });

  it('stops at the last page without exiting or moving backwards', () => {
    const view = mount('rtl', 'single', 7);
    readyImages(view.container);
    act(() => vi.advanceTimersByTime(5_000));
    expect(view.progress).toHaveBeenLastCalledWith(7, expect.anything());
    expect(screen.getByRole('main', { name: '漫画阅读器' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: '自动翻页进度' })).not.toBeInTheDocument();
  });

  it.each(['ltr', 'rtl'] as const)('retains automatic forward scrolling in %s continuous reading mode', (direction) => {
    const view = mount(direction, 'webtoon');
    readyImages(view.container);
    expect(screen.getByRole('progressbar', { name: '自动翻页进度' })).toHaveAttribute('data-running', 'true');
    act(() => vi.advanceTimersByTime(5_000));
    expect(view.progress).toHaveBeenLastCalledWith(1, { layout: 'webtoon', direction });
    expect(screen.getByRole('region', { name: '连续阅读' }).scrollTop).toBeGreaterThan(0);
  });
});
