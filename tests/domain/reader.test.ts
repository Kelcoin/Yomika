import { describe, expect, it } from 'vitest';

import {
  advanceReader,
  applyZoom,
  clampZoom,
  createReaderState,
  createZoomState,
  filterArchivesByQuery,
  getPrefetchPages,
  getVisiblePageIndexes,
  resolveReaderLayout,
  resetZoom,
  sortArchivesByTitle,
  toggleDoubleTapZoom,
  toggleReaderChrome,
  type ZoomState,
} from '../../src/domain/reader';

describe('reader domain', () => {
  it('resolves automatic layout from viewport and page shape', () => {
    expect(resolveReaderLayout('auto', { viewportWidth: 1400, viewportHeight: 900, pageWidth: 700, pageHeight: 1000 })).toBe('double');
    expect(resolveReaderLayout('auto', { viewportWidth: 390, viewportHeight: 844, pageWidth: 700, pageHeight: 1000 })).toBe('single');
    expect(resolveReaderLayout('auto', { viewportWidth: 1400, viewportHeight: 900, pageWidth: 1400, pageHeight: 800 })).toBe('single');
    expect(resolveReaderLayout('webtoon', { viewportWidth: 390, viewportHeight: 844, pageWidth: 700, pageHeight: 1000 })).toBe('webtoon');
  });

  it('advances in reading direction and clamps to valid pages', () => {
    const ltr = createReaderState({ archiveId: 'a1', pageCount: 5, pageIndex: 0, direction: 'ltr' });
    expect(advanceReader(ltr, 'next').pageIndex).toBe(1);
    expect(advanceReader(ltr, 'previous').pageIndex).toBe(0);

    const rtl = createReaderState({ archiveId: 'a1', pageCount: 5, pageIndex: 2, direction: 'rtl' });
    expect(advanceReader(rtl, 'next').pageIndex).toBe(1);
    expect(advanceReader(rtl, 'previous').pageIndex).toBe(3);
  });

  it('uses one chrome state instead of a second immersive mode', () => {
    const state = createReaderState({ archiveId: 'a1', pageCount: 2 });
    expect(state.phase).toBe('ready');
    expect(toggleReaderChrome(state).phase).toBe('chrome-visible');
    expect(toggleReaderChrome(toggleReaderChrome(state)).phase).toBe('ready');
  });

  it('prefetches adjacent pages without crossing archive bounds', () => {
    expect(getPrefetchPages(0, 5, 2)).toEqual([1, 2]);
    expect(getPrefetchPages(3, 5, 2)).toEqual([1, 2, 4]);
  });

  it('keeps the cover standalone and pairs all subsequent pages', () => {
    const state = createReaderState({ archiveId: 'a1', pageCount: 6, layout: 'double' });
    expect(getVisiblePageIndexes(state)).toEqual([0]);
    expect(advanceReader(state, 'next').pageIndex).toBe(1);
    expect(getVisiblePageIndexes({ ...state, pageIndex: 1 })).toEqual([1, 2]);
    expect(advanceReader({ ...state, pageIndex: 1 }, 'next').pageIndex).toBe(3);
    expect(getVisiblePageIndexes({ ...state, pageIndex: 3 })).toEqual([3, 4]);
    expect(advanceReader({ ...state, pageIndex: 3 }, 'next').pageIndex).toBe(5);
    expect(getVisiblePageIndexes({ ...state, pageIndex: 5 })).toEqual([5]);
    expect(advanceReader({ ...state, pageIndex: 5 }, 'previous').pageIndex).toBe(3);
    expect(advanceReader({ ...state, pageIndex: 1 }, 'previous').pageIndex).toBe(0);
  });

  describe('zoom domain', () => {
    it('creates initial zoom state at 1x with no pan offset', () => {
      const zoom = createZoomState();
      expect(zoom.scale).toBe(1);
      expect(zoom.panX).toBe(0);
      expect(zoom.panY).toBe(0);
    });

    it('clamps zoom level to min and max bounds', () => {
      expect(clampZoom(0.3)).toBe(0.5);
      expect(clampZoom(0.5)).toBe(0.5);
      expect(clampZoom(1.5)).toBe(1.5);
      expect(clampZoom(4)).toBe(3);
      expect(clampZoom(-1)).toBe(0.5);
    });

    it('toggles double-tap zoom between 1x and 2x', () => {
      const initial = createZoomState();
      const zoomed = toggleDoubleTapZoom(initial);
      expect(zoomed.scale).toBe(2);
      expect(zoomed.panX).toBe(0);
      expect(zoomed.panY).toBe(0);

      const back = toggleDoubleTapZoom(zoomed);
      expect(back.scale).toBe(1);
      expect(back.panX).toBe(0);
      expect(back.panY).toBe(0);
    });

    it('resets zoom to 1x and clears pan', () => {
      const state: ZoomState = { scale: 2.5, panX: 50, panY: -30 };
      const reset = resetZoom(state);
      expect(reset.scale).toBe(1);
      expect(reset.panX).toBe(0);
      expect(reset.panY).toBe(0);
    });

    it('applies zoom with pan offset and clamps the result', () => {
      const zoomed = applyZoom(createZoomState(), 1.5, 10, -5);
      expect(zoomed.scale).toBe(1.5);
      expect(zoomed.panX).toBe(10);
      expect(zoomed.panY).toBe(-5);

      const clamped = applyZoom(createZoomState(), 5, 0, 0);
      expect(clamped.scale).toBe(3);

      const negative = applyZoom(createZoomState(), -0.1, 0, 0);
      expect(negative.scale).toBe(0.5);
    });
  });

  describe('archive filtering and sorting', () => {
    const items = [
      { title: 'Alpha' },
      { title: 'Beta' },
      { title: 'Alpha Beta' },
      { title: 'Gamma' },
    ];

    it('filters archives by case-insensitive title match', () => {
      expect(filterArchivesByQuery(items, 'alpha')).toHaveLength(2);
      expect(filterArchivesByQuery(items, 'Beta')).toHaveLength(2);
      expect(filterArchivesByQuery(items, 'xyz')).toHaveLength(0);
      expect(filterArchivesByQuery(items, '')).toHaveLength(4);
      expect(filterArchivesByQuery(items, '   ')).toHaveLength(4);
    });

    it('sorts archives by title ascending and descending', () => {
      const asc = sortArchivesByTitle(items, 'asc');
      expect(asc.map((i) => i.title)).toEqual(['Alpha', 'Alpha Beta', 'Beta', 'Gamma']);

      const desc = sortArchivesByTitle(items, 'desc');
      expect(desc.map((i) => i.title)).toEqual(['Gamma', 'Beta', 'Alpha Beta', 'Alpha']);
    });
  });
});
