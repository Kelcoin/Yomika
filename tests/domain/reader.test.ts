import { describe, expect, it } from 'vitest';

import {
  advanceReader,
  applyZoom,
  clampZoom,
  classifyPageShape,
  createReaderState,
  createZoomState,
  effectiveReaderLayout,
  filterArchivesByQuery,
  getPrefetchPages,
  getVisiblePageIndexes,
  planPageSpreads,
  resolveReaderLayout,
  resetZoom,
  settleZoom,
  sortArchivesByTitle,
  toggleDoubleTapZoom,
  toggleReaderChrome,
  zoomByStep,
  zoomByWheel,
  type ZoomState,
} from '../../src/domain/reader';

describe('reader domain', () => {
  it('keeps the automatic preference separate from what it resolves to', () => {
    // Resolving used to overwrite `layout`, so the first image to load turned
    // 自动 into 单页 or 双页 and the preference could not be held or shown.
    const auto = createReaderState({ archiveId: 'a1', pageCount: 6, layout: 'auto' });
    expect(auto.layout).toBe('auto');
    expect(effectiveReaderLayout(auto)).toBe('single');

    const resolved = { ...auto, resolvedLayout: 'double' as const };
    expect(resolved.layout).toBe('auto');
    expect(effectiveReaderLayout(resolved)).toBe('double');
    // Pairing and paging follow the resolved layout, not the literal preference.
    expect(getVisiblePageIndexes({ ...resolved, pageIndex: 1 })).toEqual([1, 2]);
    expect(advanceReader({ ...resolved, pageIndex: 1 }, 'next').pageIndex).toBe(3);

    // An explicit choice ignores whatever auto had settled on.
    expect(effectiveReaderLayout({ ...resolved, layout: 'single' })).toBe('single');
  });

  it('classifies a page as wide only when it exceeds a spread slot', () => {
    // The threshold is half a 16:9 viewport: anything wider than the slot it
    // would occupy in a spread has to stand alone.
    expect(classifyPageShape(700, 1000)).toBe('normal');
    expect(classifyPageShape(1400, 1000)).toBe('wide');
    // A page exactly as wide as its slot still fits in it.
    expect(classifyPageShape(960, 1080)).toBe('normal');
    // Nothing measured yet, or a broken image: assume it pairs. Guessing wide
    // wastes a slot; guessing normal costs one re-pair when it loads.
    expect(classifyPageShape(0, 0)).toBe('normal');
    expect(classifyPageShape(Number.NaN, 100)).toBe('normal');
  });

  it('gives a wide page its own slot and re-pairs the run after it', () => {
    const normal = 'normal' as const;
    const wide = 'wide' as const;
    // Cover alone, then pairs — the old fixed-parity behaviour, unchanged when
    // nothing is wide.
    expect(planPageSpreads([normal, normal, normal, normal, normal]))
      .toEqual([[0], [1, 2], [3, 4]]);

    // A spread at index 3 takes a slot of its own. What matters is that page 4
    // starts a fresh pair instead of every later pair being off by one.
    expect(planPageSpreads([normal, normal, normal, wide, normal, normal, normal]))
      .toEqual([[0], [1, 2], [3], [4, 5], [6]]);

    // Two spreads in a row, and a trailing odd page.
    expect(planPageSpreads([normal, wide, wide, normal]))
      .toEqual([[0], [1], [2], [3]]);
  });

  it('steps a spread by one page and a pair by two', () => {
    const shapes = ['normal', 'normal', 'normal', 'wide', 'normal', 'normal'] as const;
    const base = { ...createReaderState({ archiveId: 'a1', pageCount: 6, layout: 'double' }), shapes };
    // Slots are [0], [1,2], [3], [4,5].
    expect(getVisiblePageIndexes({ ...base, pageIndex: 1 })).toEqual([1, 2]);
    expect(getVisiblePageIndexes({ ...base, pageIndex: 2 })).toEqual([1, 2]);
    expect(getVisiblePageIndexes({ ...base, pageIndex: 3 })).toEqual([3]);

    expect(advanceReader({ ...base, pageIndex: 0 }, 'next').pageIndex).toBe(1);
    expect(advanceReader({ ...base, pageIndex: 1 }, 'next').pageIndex).toBe(3);
    // Leaving the spread lands on the start of the next pair, not one page into it.
    expect(advanceReader({ ...base, pageIndex: 3 }, 'next').pageIndex).toBe(4);
    expect(advanceReader({ ...base, pageIndex: 4 }, 'previous').pageIndex).toBe(3);
    expect(advanceReader({ ...base, pageIndex: 3 }, 'previous').pageIndex).toBe(1);
    // The ends hold instead of running past the archive.
    expect(advanceReader({ ...base, pageIndex: 0 }, 'previous').pageIndex).toBe(0);
    expect(advanceReader({ ...base, pageIndex: 4 }, 'next').pageIndex).toBe(4);
  });

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

  it('spends the prefetch budget ahead of the reader, not behind', () => {
    // Reading runs forward, so pages already passed get half as many slots as
    // pages coming up. A symmetric window spent half the budget behind.
    expect(getPrefetchPages(0, 5, 2)).toEqual([1, 2]);
    expect(getPrefetchPages(3, 8, 2)).toEqual([2, 4, 5]);
    expect(getPrefetchPages(5, 20, 4)).toEqual([3, 4, 6, 7, 8, 9]);
    // A distance of one has nothing to spare for looking back.
    expect(getPrefetchPages(3, 8, 1)).toEqual([4]);
    expect(getPrefetchPages(3, 8, 0)).toEqual([]);
    // Bounds still hold at both ends.
    expect(getPrefetchPages(7, 8, 4)).toEqual([5, 6]);
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

  describe('zoom curve', () => {
    it('zooms multiplicatively, snaps onto 100%, and springs back after a gesture', () => {
      const start = createZoomState();

      // A wheel notch scales by exp(-delta * 0.0015) rather than a fixed step, so
      // the curve feels the same at 50% and at 300%.
      const zoomedOut = zoomByWheel(start, 120);
      expect(zoomedOut.scale).toBeCloseTo(Math.exp(-0.18), 5);
      expect(zoomByWheel(zoomedOut, -120).scale).toBe(1);

      // Coming back within the snap tolerance lands exactly on 100%, pan cleared.
      expect(zoomByWheel({ scale: 1.03, panX: 12, panY: 8 }, -1)).toEqual({ scale: 1, panX: 0, panY: 0 });

      // Gestures may overshoot the hard limits...
      const overshot = zoomByWheel({ scale: 2.9, panX: 0, panY: 0 }, -600);
      expect(overshot.scale).toBeGreaterThan(3);
      expect(overshot.scale).toBeLessThanOrEqual(4);
      // ...and settling pulls them back in.
      expect(settleZoom(overshot).scale).toBe(3);
      expect(settleZoom({ scale: 0.36, panX: 5, panY: 5 })).toEqual({ scale: 0.5, panX: 0, panY: 0 });
      expect(settleZoom({ scale: 2, panX: 5, panY: 5 })).toEqual({ scale: 2, panX: 5, panY: 5 });

      // Button steps share the ratio and clamp hard.
      expect(zoomByStep(start, 1).scale).toBeCloseTo(1.25, 5);
      expect(zoomByStep({ scale: 2.8, panX: 0, panY: 0 }, 1).scale).toBe(3);
      expect(zoomByStep({ scale: 0.5, panX: 0, panY: 0 }, -1).scale).toBe(0.5);
      expect(zoomByWheel(start, 0)).toBe(start);
    });
  });
});
