import { describe, expect, it } from 'vitest';

import {
  advanceReader,
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
  settleZoom,
  shouldCommitPageTurn,
  sortArchivesByTitle,
  toggleDoubleTapZoom,
  toggleReaderChrome,
  webtoonWindow,
  zoomByWheel,
  zoomAtPoint,
  panZoom,
} from '../../src/domain/reader';

describe('reader domain', () => {
  it('keeps the image point under the zoom anchor stationary', () => {
    const before = { scale: 1.5, panX: -20, panY: 10 };
    const after = zoomAtPoint(before, 2.2, 200, -100);
    const imageX = 200 / before.scale - before.panX;
    const imageY = -100 / before.scale - before.panY;
    expect((imageX + after.panX) * after.scale).toBeCloseTo(200);
    expect((imageY + after.panY) * after.scale).toBeCloseTo(-100);
  });

  it('pans in screen pixels and bounds movement at the enlarged viewport edges', () => {
    expect(panZoom({ scale: 2, panX: 0, panY: 0 }, 100, -60, 1000, 800)).toEqual({ scale: 2, panX: 50, panY: -30 });
    expect(panZoom({ scale: 2, panX: 0, panY: 0 }, 5000, -5000, 1000, 800)).toEqual({ scale: 2, panX: 250, panY: -200 });
    expect(zoomAtPoint({ scale: 2, panX: 250, panY: -200 }, 1, 200, 100)).toEqual(createZoomState());
  });
  it('uses release velocity and bounded desktop distance for page turns', () => {
    expect(shouldCommitPageTurn(100, 2000, 1600, 0.8)).toBe(true);
    expect(shouldCommitPageTurn(100, 100, 1600, 0)).toBe(false);
    expect(shouldCommitPageTurn(100, 100, 1600, -0.8)).toBe(false);
    expect(shouldCommitPageTurn(190, 2000, 2560, 0)).toBe(true);
  });
  it('commits a page turn on distance or on speed, and ignores twitches', () => {
    // A sixth of the viewport is enough on its own, at any speed. A third — what
    // this asked for — is over 500px on a desktop window, so a slow deliberate
    // drag that was plainly a page turn kept springing back.
    expect(shouldCommitPageTurn(200, 4000, 1024)).toBe(true);
    expect(shouldCommitPageTurn(-200, 4000, 1024)).toBe(true);
    expect(shouldCommitPageTurn(150, 4000, 1024)).toBe(false);
    // Short but fast: 100px in 120ms is 0.83 px/ms, past the flick threshold. The
    // old rule was a flat 50px and ignored speed entirely, so it fired on a
    // twitch and missed a deliberate short flick.
    expect(shouldCommitPageTurn(100, 120, 1024)).toBe(true);
    // Below the floor nothing commits, however fast: an instantaneous six-pixel
    // jitter would otherwise read as an infinitely quick flick.
    expect(shouldCommitPageTurn(6, 0, 1024)).toBe(false);
    expect(shouldCommitPageTurn(30, 0, 1024)).toBe(false);
    expect(shouldCommitPageTurn(31, 0, 1024)).toBe(true);
    // A duration we cannot use is not the same as a fast one, so it asks for
    // double the distance rather than guessing.
    expect(shouldCommitPageTurn(200, Number.NaN, 1024)).toBe(false);
    expect(shouldCommitPageTurn(400, Number.NaN, 1024)).toBe(true);
  });

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

    // A spread at index 3 takes a slot of its own, and the run before it has an
    // even length, so nothing upstream needs moving.
    expect(planPageSpreads([normal, normal, normal, wide, normal, normal, normal]))
      .toEqual([[0], [1, 2], [3], [4, 5], [6]]);

    // Two spreads in a row, and a trailing odd page.
    expect(planPageSpreads([normal, wide, wide, normal]))
      .toEqual([[0], [1], [2], [3]]);
  });

  it('lets a wide page fall back to a single page without re-pairing what came before it', () => {
    const normal = 'normal' as const;
    const wide = 'wide' as const;
    // A spread used to be read as evidence that the run in front of it started on
    // the wrong foot, and the run was re-paired to suit. That inference could
    // reshuffle a whole chapter off one wide page, and it only existed to repair a
    // pairing start that is now fixed. The run keeps its own pairing and the wide
    // page simply takes a slot.
    expect(planPageSpreads([normal, normal, normal, normal, wide, normal, normal]))
      .toEqual([[0], [1, 2], [3], [4], [5, 6]]);

    expect(planPageSpreads([normal, normal, normal, normal, wide]))
      .toEqual([[0], [1, 2], [3], [4]]);
  });

  it('always opens the cover alone', () => {
    const base = createReaderState({ archiveId: 'a1', pageCount: 4, layout: 'double' });
    expect(getVisiblePageIndexes({ ...base, pageIndex: 0 })).toEqual([0]);
    expect(getVisiblePageIndexes({ ...base, pageIndex: 1 })).toEqual([1, 2]);
    expect(advanceReader({ ...base, pageIndex: 0 }, 'next').pageIndex).toBe(1);
  });

  it('windows continuous scroll instead of mounting the whole archive', () => {
    // 200 pages of 1000px in a 800px viewport. Continuous mode used to call every
    // one of them visible, which is one decode per page of the archive at once —
    // with an enhancement enabled, one ONNX run each. That is the freeze.
    const heights = Array.from({ length: 200 }, () => 1000);

    const top = webtoonWindow({ scrollTop: 0, viewportHeight: 800, heights, overscan: 1 });
    expect(top).toEqual({ first: 0, last: 1 });

    // Page 40 spans 40000..41000 and is the only one the viewport touches.
    const middle = webtoonWindow({ scrollTop: 40200, viewportHeight: 800, heights, overscan: 2 });
    expect(middle).toEqual({ first: 38, last: 42 });

    // Overscan cannot run off either end.
    expect(webtoonWindow({ scrollTop: 199_500, viewportHeight: 800, heights, overscan: 3 }))
      .toEqual({ first: 196, last: 199 });
  });

  it('holds the last page when the scroller is past the end, rather than reporting nothing', () => {
    // Measured heights come in shorter than the estimates that sized the
    // scroller, so the offset can briefly exceed the content. Unmounting
    // everything there would throw away the measurements that fix it.
    const heights = [100, 100];
    expect(webtoonWindow({ scrollTop: 9000, viewportHeight: 800, heights, overscan: 0 }))
      .toEqual({ first: 1, last: 1 });
    expect(webtoonWindow({ scrollTop: 0, viewportHeight: 800, heights: [], overscan: 1 }))
      .toEqual({ first: 0, last: -1 });
    // A page of unknown height still occupies a row rather than collapsing the
    // whole window onto index 0.
    expect(webtoonWindow({ scrollTop: -50, viewportHeight: Number.NaN, heights: [0, 0, 0], overscan: 0 }))
      .toEqual({ first: 0, last: 0 });
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

  it('resolves automatic layout from the viewport, and lets each page decide its slot', () => {
    // Room for two pages is a question about the viewport, and only the viewport.
    // Resolving from the page on screen made it a global answer that lagged a turn
    // behind: the frame a swipe reveals is built from the state *before* the turn,
    // so leaving a landscape page towards a pair rendered the incoming frame as a
    // single page and only re-rendered it as a spread once the turn committed.
    expect(resolveReaderLayout('auto', { viewportWidth: 1400, viewportHeight: 900 })).toBe('double');
    expect(resolveReaderLayout('auto', { viewportWidth: 390, viewportHeight: 844 })).toBe('single');
    // A portrait window is not a portrait page: this used to be refused a spread
    // by the landscape page on screen, and nothing needs that rule.
    expect(resolveReaderLayout('auto', { viewportWidth: 1400, viewportHeight: 900 })).toBe('double');
    expect(resolveReaderLayout('webtoon', { viewportWidth: 390, viewportHeight: 844 })).toBe('webtoon');

    // A landscape page in that wide viewport still gets a slot to itself, which is
    // what the old rule was there to guarantee.
    const wide = { ...createReaderState({ archiveId: 'a1', pageCount: 4, layout: 'auto', resolvedLayout: 'double' }), shapes: ['normal', 'wide', 'normal', 'normal'] as const };
    expect(getVisiblePageIndexes({ ...wide, pageIndex: 1 })).toEqual([1]);
    expect(getVisiblePageIndexes({ ...wide, pageIndex: 2 })).toEqual([2, 3]);
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
      expect(clampZoom(0.3)).toBe(1);
      expect(clampZoom(0.5)).toBe(1);
      expect(clampZoom(1.5)).toBe(1.5);
      expect(clampZoom(4)).toBe(3);
      expect(clampZoom(-1)).toBe(1);
    });

    it('sends a double tap back to 1x from any scale, not only from the target', () => {
      const initial = createZoomState();
      const zoomed = toggleDoubleTapZoom(initial);
      expect(zoomed.scale).toBe(2);
      expect(zoomed.panX).toBe(0);
      expect(zoomed.panY).toBe(0);

      const back = toggleDoubleTapZoom(zoomed);
      expect(back.scale).toBe(1);
      expect(back.panX).toBe(0);
      expect(back.panY).toBe(0);

      // Anything the wheel left in between used to be enlarged further, so
      // getting back to 100% took two more gestures.
      expect(toggleDoubleTapZoom({ scale: 1.4, panX: 20, panY: 8 })).toEqual({ scale: 1, panX: 0, panY: 0 });
      expect(toggleDoubleTapZoom({ scale: 0.7, panX: 0, panY: 0 }).scale).toBe(1);
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
      expect(zoomedOut.scale).toBeCloseTo(Math.exp(-0.18 * 0.22), 5);
      expect(settleZoom(zoomedOut).scale).toBe(1);
      expect(zoomByWheel(zoomedOut, -120).scale).toBe(1);

      // Coming back within the snap tolerance lands exactly on 100%, pan cleared.
      expect(zoomByWheel({ scale: 1.03, panX: 12, panY: 8 }, -1)).toEqual({ scale: 1, panX: 0, panY: 0 });

      // Gestures may overshoot the hard limits...
      const overshot = zoomByWheel({ scale: 2.9, panX: 0, panY: 0 }, -600);
      expect(overshot.scale).toBeGreaterThan(3);
      expect(overshot.scale).toBeLessThanOrEqual(4);
      // ...and settling pulls them back in.
      expect(settleZoom(overshot).scale).toBe(3);
      expect(settleZoom({ scale: 0.36, panX: 5, panY: 5 })).toEqual({ scale: 1, panX: 0, panY: 0 });
      expect(settleZoom({ scale: 2, panX: 5, panY: 5 })).toEqual({ scale: 2, panX: 5, panY: 5 });

      expect(zoomByWheel(start, 0)).toBe(start);
    });
  });
});
