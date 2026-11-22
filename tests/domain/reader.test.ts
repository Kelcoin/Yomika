import { describe, expect, it } from 'vitest';

import {
  advanceReader,
  clampZoom,
  classifyPageShape,
  createReaderState,
  createZoomState,
  doubleTapZoomAt,
  readerDoubleTapProfile,
  effectiveReaderLayout,
  filterArchivesByQuery,
  fitPageSize,
  getPrefetchPages,
  getVisiblePageIndexes,
  planPageSpreads,
  pickDerivedEvictionVictim,
  resolveReaderLayout,
  settleZoom,
  elasticPinchScale,
  shouldCommitPageTurn,
  sortArchivesByTitle,
  sweepOrder,
  toggleDoubleTapZoom,
  toggleReaderChrome,
  webtoonPageOffsets,
  webtoonWindow,
  zoomByWheel,
  zoomAtPoint,
  panZoom,
  pageTurnDuration,
} from '../../src/domain/reader';
import type { PageShape, ReaderState } from '../../src/domain/reader';

describe('reader domain', () => {
  it('keeps the image point under the zoom anchor stationary', () => {
    const before = { scale: 1.5, panX: -20, panY: 10 };
    const after = zoomAtPoint(before, 2.2, 200, -100);
    const imageX = 200 / before.scale - before.panX;
    const imageY = -100 / before.scale - before.panY;
    expect((imageX + after.panX) * after.scale).toBeCloseTo(200);
    expect((imageY + after.panY) * after.scale).toBeCloseTo(-100);
  });

  it('keeps a visible landing animation after a fast page flick', () => {
    expect(pageTurnDuration(600, 10)).toBeGreaterThanOrEqual(160);
    expect(pageTurnDuration(20, 10)).toBeLessThan(pageTurnDuration(600, 10));
    expect(pageTurnDuration(20, 10, true)).toBeGreaterThanOrEqual(140);
  });

  it('pans in screen pixels and bounds movement at the enlarged viewport edges', () => {
    expect(panZoom({ scale: 2, panX: 0, panY: 0 }, 100, -60, 1000, 800)).toEqual({ scale: 2, panX: 50, panY: -30 });
    const nearEdge = { scale: 2, panX: 249, panY: -199 };
    expect(panZoom(nearEdge, 0, 0, 1000, 800)).toEqual(nearEdge);
    expect(panZoom(nearEdge, 1, -1, 1000, 800)).toEqual({ scale: 2, panX: 249.5, panY: -199.5 });
    expect(panZoom(nearEdge, 2, -2, 1000, 800)).toEqual({ scale: 2, panX: 250, panY: -200 });
    expect(panZoom(nearEdge, -1, 1, 1000, 800)).toEqual({ scale: 2, panX: 248.5, panY: -198.5 });
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

    const top = webtoonWindow({ scrollTop: 0, viewportHeight: 800, offsets: webtoonPageOffsets(heights), overscan: 1 });
    expect(top).toEqual({ first: 0, last: 1 });

    // Page 40 spans 40000..41000 and is the only one the viewport touches.
    const middle = webtoonWindow({ scrollTop: 40200, viewportHeight: 800, offsets: webtoonPageOffsets(heights), overscan: 2 });
    expect(middle).toEqual({ first: 38, last: 42 });

    // Overscan cannot run off either end.
    expect(webtoonWindow({ scrollTop: 199_500, viewportHeight: 800, offsets: webtoonPageOffsets(heights), overscan: 3 }))
      .toEqual({ first: 196, last: 199 });
  });

  it('holds the last page when the scroller is past the end, rather than reporting nothing', () => {
    // Measured heights come in shorter than the estimates that sized the
    // scroller, so the offset can briefly exceed the content. Unmounting
    // everything there would throw away the measurements that fix it.
    const heights = [100, 100];
    expect(webtoonWindow({ scrollTop: 9000, viewportHeight: 800, offsets: webtoonPageOffsets(heights), overscan: 0 }))
      .toEqual({ first: 1, last: 1 });
    expect(webtoonWindow({ scrollTop: 0, viewportHeight: 800, offsets: [0], overscan: 1 }))
      .toEqual({ first: 0, last: -1 });
    // A page of unknown height still occupies a row rather than collapsing the
    // whole window onto index 0.
    expect(webtoonWindow({ scrollTop: -50, viewportHeight: Number.NaN, offsets: webtoonPageOffsets([0, 0, 0]), overscan: 0 }))
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

  it('fits a page to its slot without ever changing its aspect ratio', () => {
    const box = { width: 1024, height: 768 };
    // 小图放大：宽度由高度定，比例保持。
    expect(fitPageSize({ width: 300, height: 400 }, box)).toEqual({ width: 576, height: 768 });
    // 大图缩小：贴住较紧的那一条边。
    expect(fitPageSize({ width: 2000, height: 1000 }, box)).toEqual({ width: 1024, height: 512 });
    // 刚好同比例时四个数都不动。
    expect(fitPageSize({ width: 1024, height: 768 }, box)).toEqual({ width: 1024, height: 768 });
    // 双页那一格是半个视口宽。
    expect(fitPageSize({ width: 700, height: 1000 }, { width: 512, height: 768 })).toEqual({ width: 512, height: 731 });
    // 连续滚动：高度不设限，只有宽度在起作用。
    expect(fitPageSize({ width: 800, height: 1600 }, { width: 900, height: Number.POSITIVE_INFINITY })).toEqual({ width: 900, height: 1800 });
    // 自然尺寸还不知道的页不该被写死大小。
    expect(fitPageSize(undefined, box)).toBeUndefined();
    expect(fitPageSize({ width: 0, height: 100 }, box)).toBeUndefined();
    // 格子还没量出来（宽度 0）时同理。
    expect(fitPageSize({ width: 100, height: 100 }, { width: 0, height: 768 })).toBeUndefined();
  });

  it('sweeps the whole archive outwards from the page being read', () => {
    // 整本预处理的顺序。可见页 + 预取窗口之外的那些页按这条顺序处理，所以「接着会
    // 读到哪儿」必须排在前面：从当前页往前一直走到卷尾，再回头补前面的。
    expect(sweepOrder(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(sweepOrder(3, 6)).toEqual([3, 4, 5, 2, 1, 0]);
    expect(sweepOrder(5, 6)).toEqual([5, 4, 3, 2, 1, 0]);
    // 每一页都恰好出现一次——预处理漏掉一页，那一页翻到时就要现算。
    for (const anchor of [0, 1, 4, 9]) {
      const order = sweepOrder(anchor, 10);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }
    // 越界的锚点与空档案都不该产生越界的页号。
    expect(sweepOrder(9, 0)).toEqual([]);
    expect(sweepOrder(99, 3)).toEqual([2, 1, 0]);
    expect(sweepOrder(-5, 3)).toEqual([0, 1, 2]);
  });

  it('drops the derived page the reader is least likely to need next', () => {
    // 会话预算不够时先放掉哪一页。预扫从当前页往后由近到远灌进来，所以「最早算出来
    // 的」正好是马上要翻到的那一页——挑它出来丢，用户每翻一页都得重新等模型。
    const visible = new Set([4]);
    // 最远的先丢：这里 11 离第 4 页有 7 页。
    expect(pickDerivedEvictionVictim([3, 4, 5, 6, 11], visible, 4)).toBe(11);
    // 可见页永远不动，哪怕它是离锚点最远的。
    expect(pickDerivedEvictionVictim([0, 4], new Set([0, 4]), 4)).toBeUndefined();
    // 距离相同时先丢身后的：读漫画是一条直线，翻回去是例外。
    expect(pickDerivedEvictionVictim([1, 7], visible, 4)).toBe(1);
    expect(pickDerivedEvictionVictim([7, 1], visible, 4)).toBe(1);
    // 全都可见就没有可丢的。
    expect(pickDerivedEvictionVictim([3, 4, 5], new Set([3, 4, 5]), 4)).toBeUndefined();
    expect(pickDerivedEvictionVictim([], visible, 4)).toBeUndefined();
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

    it('cycles ordinary images through the PhotoView scale levels', () => {
      const initial = createZoomState();
      const middle = toggleDoubleTapZoom(initial);
      expect(middle.scale).toBe(1.75);
      const maximum = toggleDoubleTapZoom(middle);
      expect(maximum.scale).toBe(3);
      expect(toggleDoubleTapZoom(maximum)).toEqual(initial);
      expect(toggleDoubleTapZoom({ scale: 1.4, panX: 20, panY: 8 }).scale).toBe(1.75);
    });

    it('uses fit-to-cover and the native threshold for large images', () => {
      const image = { width: 7680, height: 4320 };
      const viewport = { width: 576, height: 922 };
      const profile = readerDoubleTapProfile(image, viewport);
      expect(profile).toMatchObject({ large: true, duration: 300 });
      const zoomed = doubleTapZoomAt(createZoomState(), 0, 0, profile);
      expect(zoomed.scale).toBeCloseTo((922 / 4320) / (576 / 7680));
      expect(doubleTapZoomAt({ ...zoomed, scale: zoomed.scale * 0.89 }, 0, 0, profile).scale).toBe(zoomed.scale);
      expect(doubleTapZoomAt({ ...zoomed, scale: zoomed.scale * 0.91 }, 0, 0, profile)).toEqual(createZoomState());
      expect(readerDoubleTapProfile({ ...image, animated: true }, viewport).large).toBe(false);
    });

    it('anchors a double tap on the point it landed on', () => {
      const anchored = doubleTapZoomAt(createZoomState(), -100, 40);
      expect(anchored.scale).toBe(1.75);
      expect(anchored.scale * (-100 + anchored.panX)).toBeCloseTo(-100);
      expect(anchored.scale * (40 + anchored.panY)).toBeCloseTo(40);
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
      expect(zoomByWheel({ scale: 1.03, panX: 12, panY: 8 }, 1)).toEqual({ scale: 1, panX: 0, panY: 0 });
      expect(zoomByWheel({ scale: 1.03, panX: 12, panY: 8 }, 1, 3, false).scale).toBeGreaterThan(1);
      let fineWheel = start;
      for (let step = 0; step < 40; step++) fineWheel = zoomByWheel(fineWheel, -2);
      expect(fineWheel.scale).toBeCloseTo(Math.exp(.12), 10);

      // Gestures may overshoot the hard limits...
      expect(zoomByWheel({ scale: 5, panX: 0, panY: 0 }, -120, 6).scale).toBeGreaterThan(5);
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

describe('reader spread plan reuse', () => {
  it('does not rebuild the spread plan for every question one page turn asks', () => {
    // 双页模式下翻一页会问 5~6 次同一份排布：可见页、前一/后一相邻页（预取）、
    // advanceReader 各问一次。每一次都要按页数分配一个数组、再走一遍 O(页数) 的
    // 分组与 findIndex——上千页的档案里这就是「快速连续翻页会卡顿」中属于领域层
    // 的那部分。排布表按「页数 + 形状表引用」缓存，翻页期间必须命中。
    const pageCount = 3000;
    const shapes: PageShape[] = Array.from({ length: pageCount }, () => 'normal');
    let state: ReaderState = {
      ...createReaderState({ archiveId: 'a', pageCount, pageIndex: 0, direction: 'ltr', layout: 'double' }),
      shapes,
    };

    const started = performance.now();
    for (let turn = 0; turn < 200; turn += 1) {
      state = advanceReader(state, 'next');
      getVisiblePageIndexes(state);
      getVisiblePageIndexes({ ...state, pageIndex: state.pageIndex + 1 });
      getVisiblePageIndexes({ ...state, pageIndex: state.pageIndex - 1 });
      advanceReader(state, 'previous');
    }
    const elapsed = performance.now() - started;

    // 阈值留在两档之间很空的地方：命中缓存时实测 ~1ms，去掉缓存（见
    // debug_outputs/fix-round/mutations-item11.ps1 -Mutation 1）会跳到 ~110ms。
    expect(elapsed, '翻一页只该排布一次：缓存命中是毫秒级，未命中是上百毫秒').toBeLessThan(30);
  });

  it('keys the spread plan on the page count and the shape table it came from', () => {
    // 单槽缓存要认得「这是哪一份排布」：页数或形状表换了就是另一份。缓存键少一半的话
    // 上面那条时间判据照样绿，错误只会以「配错页」的形式静默出现。
    const plain: PageShape[] = ['normal', 'normal', 'normal', 'normal', 'normal', 'normal'];
    const withWide: PageShape[] = ['normal', 'normal', 'wide', 'normal', 'normal', 'normal'];
    const six = createReaderState({ archiveId: 'a', pageCount: 6, pageIndex: 1, direction: 'ltr', layout: 'double' });

    expect(getVisiblePageIndexes({ ...six, shapes: plain })).toEqual([1, 2]);
    expect(getVisiblePageIndexes({ ...six, shapes: withWide })).toEqual([1]);
    expect(getVisiblePageIndexes({ ...six, shapes: plain })).toEqual([1, 2]);

    // 同一份形状表、页数变了（连载新一页插进来）也要重新排：最后一页必须落在自己
    // 那一槽上，而不是被当成「没找到」退回第一槽。
    expect(getVisiblePageIndexes({ ...six, pageCount: 8, pageIndex: 7, shapes: plain })).toEqual([7]);
  });
});


test('pinch overshoots both limits even with a large-image zoom maximum', () => {
  const above = elasticPinchScale(7, 6);
  const below = elasticPinchScale(0.5, 6);
  expect(above).toBeGreaterThan(6);
  expect(below).toBeLessThan(1);
  expect(elasticPinchScale(2, 6)).toBe(2);
  expect(settleZoom({ scale: above, panX: 0, panY: 0 }, 6).scale).toBe(6);
  expect(settleZoom({ scale: below, panX: 0, panY: 0 }, 6).scale).toBe(1);
});

it.each(['ltr', 'rtl'] as const)('keeps the original progress when turning past the last spread in %s', (direction) => {
  const state = createReaderState({ archiveId: 'last', pageCount: 3, pageIndex: 2, layout: 'double', direction });
  expect(advanceReader(state, direction === 'ltr' ? 'next' : 'previous').pageIndex).toBe(2);
});
