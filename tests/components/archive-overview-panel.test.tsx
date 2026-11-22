import { render, screen } from '@testing-library/react';
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
