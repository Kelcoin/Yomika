import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

import { ArchiveOverviewPanel } from '../../src/components/ArchiveOverviewPanel';

it('ends the tag viewport after the last complete visual row and recalculates on resize', () => {
  const stylesheet = document.createElement('style');
  stylesheet.textContent = '.reader-overview-tags { max-height: 180px }';
  document.head.append(stylesheet);
  let resized: (() => void) | undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top }) as DOMRect;
  const overflowing = { top: 178, bottom: 202 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('.reader-overview-tag-rows')) return rect(50, 260);
    if (this.matches('h3')) return rect(50, 74);
    if (this.textContent === 'one') return rect(50, 72);
    if (this.textContent === 'two') return rect(194, 224);
    if (this.textContent === 'three') return rect(50 + overflowing.top, 50 + overflowing.bottom);
    return rect(0, 0);
  });
  try {
    render(<MemoryRouter><ArchiveOverviewPanel title="Test" pageCount={0} tags={['artist:one', 'artist:two', 'artist:three']} thumbnailAt={() => undefined} onClose={() => {}} /></MemoryRouter>);
    const viewport = screen.getByLabelText('档案标签');
    expect(viewport.style.height).toBe('174px');

    // A wider viewport puts the last two chips on the same row.
    overflowing.top = 144;
    overflowing.bottom = 174;
    resized?.();
    expect(viewport.style.height).toBe('');
  } finally {
    stylesheet.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it('keeps the page grid reference only until the caller offers a page to open', () => {
  // 同一份面板在阅读器里是「跳页按钮」、在去重概览里是「只读图」：差别只在 onSelectPage。
  // 两条都要钉住——只钉一边的话，另一边退化成另一种元素也没人发现。
  const registerTile = vi.fn();
  const onSelectPage = vi.fn();
  const props = { title: 'Test', pageCount: 4, thumbnailAt: () => undefined, onClose: () => {} };
  const view = render(<MemoryRouter><ArchiveOverviewPanel {...props} registerTile={registerTile} /></MemoryRouter>);
  const tile = screen.getByRole('figure', { name: '第 1 页' });
  expect(tile).toHaveAttribute('tabindex', '0');
  expect(tile).toHaveAttribute('data-press-surface', 'true');
  expect(registerTile).toHaveBeenCalledWith(0, tile);
  expect(screen.queryByRole('button', { name: /跳转到第/ })).toBeNull();

  view.rerender(<MemoryRouter><ArchiveOverviewPanel {...props} registerTile={registerTile} onSelectPage={onSelectPage} /></MemoryRouter>);
  const jump = screen.getByRole('button', { name: '跳转到第 1 页' });
  expect(jump).toHaveAttribute('type', 'button');
  expect(screen.queryByRole('figure', { name: '第 1 页' })).toBeNull();
  fireEvent.click(jump);
  expect(onSelectPage).toHaveBeenCalledWith(0);
});
