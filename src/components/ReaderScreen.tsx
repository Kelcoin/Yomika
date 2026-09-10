import { ArrowLeft, ArrowLeftToLine, ArrowRightToLine, BookOpen, ChevronLeft, ChevronRight, Eraser, EyeOff, GalleryVertical, LayoutGrid, Maximize2, Minimize2, Pause, Play, RectangleVertical, RotateCcw, Settings, Sparkles, Wand2, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type TouchEvent, type UIEvent } from 'react';
import { Link } from 'react-router-dom';
import { flushSync } from 'react-dom';

import { advanceReader, classifyPageShape, createReaderState, createZoomState, effectiveReaderLayout, getPrefetchPages, getVisiblePageIndexes, nextReaderLayout, READER_LAYOUT_LABELS, resolveReaderLayout, settleZoom, shouldCommitPageTurn, toggleDoubleTapZoom, toggleReaderChrome, WEBTOON_ESTIMATED_PAGE_RATIO, webtoonWindow, zoomByWheel, type ReaderLayoutPreference, type ReadingDirection, type ZoomState } from '../domain/reader';
import { LoadingIndicator } from './LoadingIndicator';
import { panZoom, zoomAtPoint, ZOOM_RUBBER_MIN, ZOOM_RUBBER_MAX } from '../domain/reader';
import { formatByteSize } from '../lib/archiveCardPresentation';
import { categorizeSearchableTags } from '../lib/tags';
import { useReturnNavigation } from '../lib/useReturnNavigation';
import { TagSearchLink } from './TagSearchLink';

/** Pages kept beyond the fetch window. Three either side covers stepping back
 * over a spread without a refetch, and costs a handful of blob URLs. */
const PAGE_RETENTION_MARGIN = 3;
/** Attempts before a page is left alone. Matches ComicReadScript's ceiling
 * (imageLoad/reactor.ts:22-29). */
const MAX_PAGE_LOAD_ATTEMPTS = 8;
/** Height of the bands at the top and bottom of the canvas that summon the
 * chrome. A tap anywhere used to raise the bars over what was being read; the
 * bands sit where the bars themselves appear, so the target is where the result
 * will be. */
const CHROME_BAND_HEIGHT = 128;
/** Widest a continuous-scroll page is drawn. Matches `.reader-webtoon
 * .reader-page` in reader.css — the slot heights are computed from it, so the
 * two have to agree or the scroll arithmetic drifts from what is on screen. */
const WEBTOON_MAX_WIDTH = 900;
/** How long the bars stay up once nothing is touching them. They used to stay
 * until dismissed, sitting over the page for the rest of the session if the
 * dismissing click was forgotten. Every press inside them starts the count
 * again. */
const CHROME_AUTO_HIDE_MS = 4_500;

/** One of the two derived renditions, as the reader sees it. */
export interface EnhancementSwitch {
  /** False when no model is installed for it. The button then says so rather
   * than silently doing nothing, which is how this went unverifiable. */
  configured: boolean;
  active: boolean;
  toggle: () => void;
}

interface ReaderScreenProps {
  archiveId: string;
  title: string;
  pages: string[];
  initialPage?: number;
  direction?: ReadingDirection;
  layout?: ReaderLayoutPreference;
  loadPage?: (pageIndex: number, signal?: AbortSignal) => Promise<string | undefined>;
  loadPageThumbnail?: (pageIndex: number) => Promise<string | undefined>;
  /** How many pages either side to keep loaded (preference-driven). */
  prefetchDistance?: number;
  releasePage?: (pageIndex: number) => void;
  onProgress?: (pageIndex: number, reading: { layout: ReaderLayoutPreference; direction: ReadingDirection }) => void;
  /** Archive facts for the overview panel (cover, tags, byte size). */
  info?: { cover?: string | undefined; tags?: string[] | undefined; sizeBytes?: number | undefined } | undefined;
  /** Marks the session as unrecorded; the caller skips progress writes. */
  incognito?: boolean;
  /** Reader-side switches for the two derived renditions, so their effect can be
   * seen on the page in front of you instead of only in settings. */
  upscale?: EnhancementSwitch | undefined;
  decensor?: EnhancementSwitch | undefined;
  /** Bumped by the caller when what `loadPage` would return has changed — a
   * switch above, for instance. Every loaded page is dropped and the window
   * refetched; without it a toggle changed nothing already on screen. */
  reloadToken?: number;
  /** Enhanced renditions by page index. They arrive after the plain page and take
   * its place in the same slot, so nothing about the view changes but the `src` —
   * which is what keeps the zoom from being thrown away mid-read. */
  derivedPages?: ReadonlyMap<number, string> | undefined;
  /** The pages actually on screen, so the caller can enhance those and not the
   * whole prefetch window. */
  onVisiblePages?: ((indexes: readonly number[]) => void) | undefined;
}

/** Why a page is not on screen yet: still coming, or given up on.
 *
 * These used to share a branch — anything not yet loaded rendered as "页面加载
 * 失败" — which is why turning a page announced a failure and then quietly
 * showed the page. They are now distinct, and a page is only called failed once
 * its retries are actually spent.
 *
 * Loading is the app's own indicator rather than a second animation invented for
 * the reader: two different spinners for the same idea, one of them a bare circle,
 * only raised the question of what the circle meant. */
function PageStatus({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  if (!failed) return <div className="reader-page-status"><LoadingIndicator label="正在加载" /></div>;
  return (
    <div className="reader-page-status is-failed">
      <button type="button" className="reader-retry-button" aria-label="重试加载" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
      </button>
      <p role="alert">加载失败</p>
    </div>
  );
}

export function ReaderScreen({ archiveId, title, pages, initialPage = 0, direction = 'ltr', layout = 'auto', loadPage, loadPageThumbnail, releasePage, onProgress, info, incognito = false, prefetchDistance = 1, upscale, decensor, reloadToken = 0, derivedPages, onVisiblePages }: ReaderScreenProps) {
  const reduceMotion = useReducedMotion();
  const goBack = useReturnNavigation();
  // Built once. A different archive arrives as an unmount, not a prop change:
  // `ReaderRoute` clears `pages` when `archiveId` changes and renders its loading
  // branch, which takes this component down with it. That is what keeps the page
  // index, the zoom and the per-index page shapes from leaking into the next
  // archive — so if that loading branch is ever removed, this needs a `key`.
  const [state, setState] = useState(() => createReaderState({ archiveId, pageCount: pages.length, pageIndex: initialPage, direction, layout }));
  const readerStateRef = useRef(state);
  readerStateRef.current = state;
  // `state.layout` is the preference (which may be `auto`); this is what renders.
  const effectiveLayout = effectiveReaderLayout(state);
  const [loadedPages, setLoadedPages] = useState(pages);
  const [zoom, setZoom] = useState<ZoomState>(createZoomState);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; zoom: ZoomState }>();
  const pinchStart = useRef<{ distance: number; x: number; y: number; zoom: ZoomState }>();

  function viewportPoint(x: number, y: number) {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: x - (rect?.left ?? 0) - (rect?.width || window.innerWidth) / 2, y: y - (rect?.top ?? 0) - (rect?.height || window.innerHeight) / 2 };
  }

  function dragZoom(x: number, y: number) {
    const start = panStart.current;
    if (!start) return;
    gestureMovedRef.current ||= Math.abs(x - start.x) + Math.abs(y - start.y) > 5;
    setZoom(panZoom(start.zoom, x - start.x, y - start.y, rootRef.current?.clientWidth || window.innerWidth, rootRef.current?.clientHeight || window.innerHeight));
  }
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<number, string>>(() => new Map());
  /** Natural size per page index, recorded as images load. Feeds both the `auto`
   * layout decision and the continuous-scroll slot heights. */
  const [pageSizes, setPageSizes] = useState<ReadonlyMap<number, { width: number; height: number }>>(() => new Map());
  /** Pages whose retries are spent, as state rather than a ref so the slot can
   * actually re-render into its failure state. */
  const [exhaustedPages, setExhaustedPages] = useState<ReadonlySet<number>>(() => new Set());
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [webtoonWidth, setWebtoonWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const rootRef = useRef<HTMLElement>(null);
  const webtoonRef = useRef<HTMLElement>(null);
  const zoomScaleRef = useRef(1);
  const layoutRef = useRef(effectiveLayout);
  const heightsRef = useRef<readonly number[]>([]);
  const anchorRef = useRef(0);
  /** Whether the scroller has been positioned for the page being read. Until a
   * real scroll has happened the anchor must not write progress, or entering
   * continuous mode at page 40 would immediately save page 1. */
  const webtoonScrolledRef = useRef(false);
  const webtoonEnteredRef = useRef(false);
  const reportedPageRef = useRef(state.pageIndex);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapRef = useRef<number>(0);
  const dragPagedRef = useRef(false);
  /** Set on release when the pointer travelled far enough to be a drag, so the
   * click that follows can be ignored. */
  const gestureMovedRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [thumbnailPanelOpen, setThumbnailPanelOpen] = useState(false);
  // Undefined keeps tap/keyboard behaviour; mouse movement chooses one edge.
  const [hoverChrome, setHoverChrome] = useState<'top' | 'bottom' | null | undefined>();
  /** Bumped by any press inside the chrome, which restarts its auto-hide. */
  const [chromeKeepAlive, setChromeKeepAlive] = useState(0);
  const loadingPagesRef = useRef(new Set<number>());
  /** Failed loads, with their attempt count and the earliest time to try again.
   * A page that simply failed used to be retried on every render — or, once the
   * window moved past it, never. */
  const failedPagesRef = useRef(new Map<number, { attempts: number; nextAt: number }>());
  const [retryTick, setRetryTick] = useState(0);
  const retryTimerRef = useRef<number>();

  /** Slot height for one continuous-scroll page. Unmeasured pages get an estimate
   * so the scroller has a length from the start; a measured height replaces it
   * and is never given up again, which is what keeps the geometry stable. */
  const webtoonSlotWidth = Math.min(webtoonWidth || viewport.width, WEBTOON_MAX_WIDTH);
  const estimatedPageHeight = Math.max(240, Math.round(viewport.height * WEBTOON_ESTIMATED_PAGE_RATIO));
  const slotHeightFor = useCallback((size: { width: number; height: number } | undefined) => (
    size && size.width > 0 ? Math.max(1, Math.round((webtoonSlotWidth * size.height) / size.width)) : estimatedPageHeight
  ), [estimatedPageHeight, webtoonSlotWidth]);
  const heights = useMemo(
    () => Array.from({ length: pages.length }, (_, index) => slotHeightFor(pageSizes.get(index))),
    [pageSizes, pages.length, slotHeightFor],
  );
  /** What continuous scroll keeps mounted. Held as two numbers rather than an
   * object so that scrolling within the same window does not re-run the fetch
   * effect on every scroll event. */
  const { first: webtoonFirst, last: webtoonLast } = useMemo(
    () => webtoonWindow({ scrollTop, viewportHeight: viewport.height, heights, overscan: Math.max(1, prefetchDistance) }),
    [heights, prefetchDistance, scrollTop, viewport.height],
  );
  const webtoonAnchor = useMemo(
    () => webtoonWindow({ scrollTop, viewportHeight: viewport.height, heights, overscan: 0 }).first,
    [heights, scrollTop, viewport.height],
  );
  const visibleIndexes = useMemo(
    () => getVisiblePageIndexes({ pageIndex: state.pageIndex, pageCount: pages.length, layout: state.layout, resolvedLayout: state.resolvedLayout, shapes: state.shapes }),
    [pages.length, state.layout, state.pageIndex, state.resolvedLayout, state.shapes],
  );
  /** The slots a swipe reveals. Rendering only the current one left the gesture
   * with nothing to slide in from either side, so a drag looked like the page was
   * being dragged off a blank background. Sides are by *intent*, not by page
   * number: dragging left always uncovers the "next" slot, in both directions. */
  const neighbourIndexes = useMemo(() => {
    const previous = advanceReader(state, 'previous');
    const next = advanceReader(state, 'next');
    return {
      previous: previous.pageIndex === state.pageIndex ? [] : getVisiblePageIndexes(previous),
      next: next.pageIndex === state.pageIndex ? [] : getVisiblePageIndexes(next),
    };
  }, [state]);

  // The caller can learn the layout and direction *after* the first paint — the
  // preferences load asynchronously, and the archive's own record later still —
  // and the reader used to notice only by being unmounted, which happened as a
  // side effect of the route clearing its page list. Whether the right layout was
  // on screen therefore depended on timing, and that is what made this the
  // flakiest corner of the suite. A prop change is now enough.
  useEffect(() => {
    setState((current) => current.layout === layout && current.direction === direction
      ? current
      : { ...current, layout, direction });
  }, [direction, layout]);

  useEffect(() => { zoomScaleRef.current = zoom.scale; }, [zoom.scale]);
  useEffect(() => { layoutRef.current = effectiveLayout; }, [effectiveLayout]);
  useEffect(() => { heightsRef.current = heights; }, [heights]);
  useEffect(() => { anchorRef.current = webtoonAnchor; }, [webtoonAnchor]);
  useEffect(() => () => { if (retryTimerRef.current !== undefined) window.clearTimeout(retryTimerRef.current); }, []);

  // Report from an effect rather than from inside a state updater: every page
  // change is covered (toolbar, keyboard, swipe, thumbnail jump, continuous
  // scroll) and StrictMode cannot double-fire a save.
  useEffect(() => {
    if (reportedPageRef.current === state.pageIndex) return;
    reportedPageRef.current = state.pageIndex;
    onProgress?.(state.pageIndex, { layout: state.layout, direction: state.direction });
  }, [onProgress, state.direction, state.layout, state.pageIndex]);

  // The viewport is a live input, not a startup fact: `auto` reads it, and so do
  // the continuous-scroll slot heights.
  useEffect(() => {
    const measure = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      setWebtoonWidth(webtoonRef.current?.clientWidth ?? 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [effectiveLayout]);

  // `auto` used to be decided once, by the first page to load, and then never
  // revisited — so narrowing the window kept the spread it had chosen and
  // squeezed two pages into half the width each. Re-decide from the page on
  // screen whenever the viewport changes.
  useEffect(() => {
    if (state.layout !== 'auto') return;
    const sample = pageSizes.get(state.pageIndex) ?? [...pageSizes.values()][0];
    if (!sample) return;
    const resolved = resolveReaderLayout('auto', {
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      pageWidth: sample.width,
      pageHeight: sample.height,
    });
    setState((current) => current.resolvedLayout === resolved ? current : { ...current, resolvedLayout: resolved });
  }, [pageSizes, state.layout, state.pageIndex, viewport.height, viewport.width]);

  // Entering continuous mode lands on the page being read, once per entry. The
  // offsets are estimates at that moment, so this is approximate — `measurePage`
  // corrects the error afterwards without moving what is on screen.
  useEffect(() => {
    if (effectiveLayout !== 'webtoon') {
      webtoonEnteredRef.current = false;
      webtoonScrolledRef.current = false;
      return;
    }
    if (webtoonEnteredRef.current) return;
    webtoonEnteredRef.current = true;
    const container = webtoonRef.current;
    if (!container) return;
    let offset = 0;
    for (let index = 0; index < state.pageIndex; index += 1) offset += heightsRef.current[index] ?? 0;
    container.scrollTop = offset;
    setScrollTop(offset);
  }, [effectiveLayout, state.pageIndex]);

  // Continuous scroll owns the page index while it is on screen; without this it
  // never recorded progress at all.
  useEffect(() => {
    if (effectiveLayout !== 'webtoon' || !webtoonScrolledRef.current) return;
    setState((current) => current.pageIndex === webtoonAnchor ? current : { ...current, pageIndex: webtoonAnchor });
  }, [effectiveLayout, webtoonAnchor]);

  // The bars go away on their own. Held open while the overview panel is up,
  // because that is a deliberate stop rather than a glance, and restarted by any
  // press inside them so a run of toolbar taps does not fight the timer.
  useEffect(() => {
    if (state.phase !== 'chrome-visible' || thumbnailPanelOpen) return undefined;
    const timer = window.setTimeout(() => {
      setState((current) => current.phase === 'chrome-visible' ? { ...current, phase: 'ready' } : current);
    }, CHROME_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [chromeKeepAlive, state.phase, thumbnailPanelOpen]);

  // What is on screen right now, which is a different question from what the
  // prefetch window holds. Enhancement is expensive enough that it is worth
  // asking only about the pages someone is actually looking at.
  useEffect(() => {
    if (!onVisiblePages) return;
    onVisiblePages(effectiveLayout === 'webtoon' ? [webtoonAnchor] : visibleIndexes);
  }, [effectiveLayout, onVisiblePages, visibleIndexes, webtoonAnchor]);

  // A switch above the canvas changed what `loadPage` answers with. Everything
  // already held is now the wrong rendition, so drop it and let the window
  // refill: without this, flipping upscaling changed nothing you could see.
  const reloadedRef = useRef(reloadToken);
  useEffect(() => {
    if (reloadedRef.current === reloadToken) return;
    reloadedRef.current = reloadToken;
    failedPagesRef.current.clear();
    setExhaustedPages((current) => current.size === 0 ? current : new Set());
    setLoadedPages((current) => {
      const next = current.slice();
      let changed = false;
      for (let index = 0; index < next.length; index += 1) {
        if (!next[index]) continue;
        releasePage?.(index);
        next[index] = '';
        changed = true;
      }
      return changed ? next : current;
    });
  }, [releasePage, reloadToken]);

  useEffect(() => {
    const pageCount = loadedPages.length;
    const fetchSet = new Set<number>();
    const retainSet = new Set<number>();
    const add = (set: Set<number>, index: number) => { if (index >= 0 && index < pageCount) set.add(index); };
    if (effectiveLayout === 'webtoon') {
      // Continuous mode used to call every page of the archive visible, so opening
      // it fired one decode per page at once — and released none of them. The
      // window is what is on screen plus overscan, and nothing else.
      for (let index = webtoonFirst; index <= webtoonLast; index += 1) {
        add(fetchSet, index);
        add(retainSet, index);
      }
      for (let margin = 1; margin <= PAGE_RETENTION_MARGIN; margin += 1) {
        add(retainSet, webtoonFirst - margin);
        add(retainSet, webtoonLast + margin);
      }
    } else {
      // The slots either side are rendered for the swipe, so they have to be
      // fetched as slots — a spread advances by two pages, which a symmetric
      // distance of one would miss.
      for (const index of [...visibleIndexes, ...neighbourIndexes.previous, ...neighbourIndexes.next]) {
        add(fetchSet, index);
        add(retainSet, index);
      }
      // Retention is deliberately wider than fetching. They used to be the same
      // set, so stepping forward released the page just left and stepping back
      // re-downloaded it — every single turn cost a fresh request.
      for (const index of visibleIndexes) {
        for (const adjacent of getPrefetchPages(index, pageCount, prefetchDistance)) add(fetchSet, adjacent);
        for (const adjacent of getPrefetchPages(index, pageCount, prefetchDistance + PAGE_RETENTION_MARGIN)) add(retainSet, adjacent);
      }
    }

    if (releasePage) {
      for (let index = 0; index < loadedPages.length; index += 1) {
        if (!retainSet.has(index) && loadedPages[index]) releasePage(index);
      }
      setLoadedPages((current) => {
        let changed = false;
        const next = current.slice();
        for (let index = 0; index < next.length; index += 1) {
          if (!retainSet.has(index) && next[index]) {
            next[index] = '';
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }
    if (!loadPage) return;
    const now = Date.now();
    let soonest = Infinity;
    for (const index of fetchSet) {
      if (loadedPages[index] || loadingPagesRef.current.has(index)) continue;
      const failure = failedPagesRef.current.get(index);
      if (failure) {
        if (failure.attempts >= MAX_PAGE_LOAD_ATTEMPTS) continue;
        if (failure.nextAt > now) {
          soonest = Math.min(soonest, failure.nextAt);
          continue;
        }
      }
      loadingPagesRef.current.add(index);
      void loadPage(index).then((page) => {
        if (page) {
          failedPagesRef.current.delete(index);
          setLoadedPages((current) => current.map((value, pageIndex) => pageIndex === index ? page : value));
          return;
        }
        // Exponential backoff with jitter, as ComicReadScript does
        // (imageLoad/reactor.ts:22-29): a server that just refused is unlikely to
        // answer differently a millisecond later, and hammering it makes it worse.
        const attempts = (failedPagesRef.current.get(index)?.attempts ?? 0) + 1;
        const delay = (2 ** attempts + Math.random() * 2) * 1000;
        failedPagesRef.current.set(index, { attempts, nextAt: Date.now() + delay });
        if (attempts < MAX_PAGE_LOAD_ATTEMPTS) setRetryTick((value) => value + 1);
        // Only now is the page a failure rather than a page still on its way.
        else setExhaustedPages((current) => current.has(index) ? current : new Set(current).add(index));
      }).finally(() => loadingPagesRef.current.delete(index));
    }
    if (soonest !== Infinity) {
      if (retryTimerRef.current !== undefined) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => setRetryTick((value) => value + 1), Math.max(50, soonest - now));
    }
  }, [effectiveLayout, loadPage, loadedPages, neighbourIndexes, prefetchDistance, releasePage, retryTick, visibleIndexes, webtoonFirst, webtoonLast]);

  const retryPage = useCallback((index: number) => {
    failedPagesRef.current.delete(index);
    setExhaustedPages((current) => {
      if (!current.has(index)) return current;
      const next = new Set(current);
      next.delete(index);
      return next;
    });
    setRetryTick((value) => value + 1);
  }, []);

  /** Records what a page actually is, once the browser knows.
   *
   * Two consumers: the `auto` layout decision and the continuous-scroll slot
   * height. In continuous mode a page *above* the viewport turning out taller
   * than its estimate would push everything below it down — i.e. move the page
   * being read — so the scroller is compensated by the same delta.
   */
  const measurePage = useCallback((index: number, image: HTMLImageElement) => {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return;
    const shape = classifyPageShape(width, height);
    setState((current) => {
      if (current.shapes?.[index] === shape) return current;
      const shapes = [...(current.shapes ?? [])];
      shapes[index] = shape;
      return { ...current, shapes };
    });
    setPageSizes((current) => {
      const existing = current.get(index);
      if (existing && existing.width === width && existing.height === height) return current;
      const next = new Map(current);
      next.set(index, { width, height });
      return next;
    });
    const container = webtoonRef.current;
    if (layoutRef.current !== 'webtoon' || !container || index >= anchorRef.current) return;
    const delta = slotHeightFor({ width, height }) - (heightsRef.current[index] ?? 0);
    if (!delta) return;
    container.scrollTop += delta;
    setScrollTop(container.scrollTop);
  }, [slotHeightFor]);

  // The thumbnail panel used to pin every page of the archive as a full-size
  // image. Load the small page-thumbnail rendition instead, one at a time so a
  // long archive cannot burst hundreds of requests.
  useEffect(() => {
    if (!thumbnailPanelOpen || !loadPageThumbnail) return undefined;
    let active = true;
    void (async () => {
      for (let index = 0; index < pages.length; index += 1) {
        if (!active) return;
        const url = await loadPageThumbnail(index);
        if (!active) return;
        if (url) setThumbnails((current) => current.get(index) === url ? current : new Map(current).set(index, url));
      }
    })();
    return () => { active = false; };
  }, [loadPageThumbnail, pages.length, thumbnailPanelOpen]);

  // React registers wheel listeners as passive, so preventDefault() inside
  // onWheel is ignored and the canvas would zoom *and* scroll. Bind natively.
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;
    let settleTimer: number | undefined;
    const onWheel = (event: globalThis.WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (layoutRef.current === 'webtoon' || target?.closest('input, textarea, select, [contenteditable="true"], .reader-comments, .horizontal-scroller, .reader-overview')) return;
      if (event.deltaY === 0) return;
      if (event.cancelable) event.preventDefault();
      if (sliding.current || panStart.current || pinchStart.current) return;
      const point = viewportPoint(event.clientX, event.clientY);
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
      setZoom((current) => zoomAtPoint(current, zoomByWheel(current, delta).scale, point.x, point.y));
      // Springs an overshoot back once the wheel goes quiet, so the limits feel
      // elastic instead of hard-stopping mid-gesture.
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => setZoom(settleZoom), 180);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.clearTimeout(settleTimer);
      element.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Arrow keys are bound to the canvas, so it has to own focus from the start;
  // otherwise the user must click first, and that click toggles the chrome.
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    if (!autoPlay) return undefined;
    const timer = window.setInterval(() => move('next'), 5000);
    return () => window.clearInterval(timer);
  }, [autoPlay, effectiveLayout, state.direction, state.layout]);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    }
  }

  /** Past this much travel a gesture is a drag rather than a tap. */
  const TAP_SLOP = 5;

  function move(intent: 'next' | 'previous') {
    if (sliding.current) return;
    const current = readerStateRef.current;
    const advanced = advanceReader(current, intent);
    const next = current.phase === 'chrome-visible' ? { ...advanced, phase: current.phase } : advanced;
    readerStateRef.current = next;
    setState(next);
    scrollToPage(next.pageIndex);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault();
      move('next');
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      move('previous');
    } else if (event.key === 'Escape' && state.phase === 'chrome-visible') {
      setState(toggleReaderChrome);
    }
  }

  function stopChromeToggle(event: MouseEvent) {
    event.stopPropagation();
    setChromeKeepAlive((value) => value + 1);
  }

  /** Whether a click landed in one of the bands that summon the chrome. */
  function isInChromeBand(event: MouseEvent<HTMLElement>): boolean {
    const element = rootRef.current;
    const rect = element?.getBoundingClientRect();
    const height = rect?.height || window.innerHeight;
    const offset = event.clientY - (rect?.top ?? 0);
    const band = Math.min(CHROME_BAND_HEIGHT, height / 3);
    return offset <= band || offset >= height - band;
  }

  /** Live horizontal offset while a drag is in progress, so the page follows the
   * finger. Without it the gesture had no feedback at all until release, which is
   * why it was impossible to tell whether a turn had been triggered. */
  const [drag, setDrag] = useState<{ dx: number; commits: boolean } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef(0);
  const dragSample = useRef<{ dx: number; elapsed: number; velocity: number }>();
  const dragFrame = useRef<number>();
  const slideAnimation = useRef<Animation>();
  const sliding = useRef(false);
  const reducedMotionRef = useRef(reduceMotion);
  reducedMotionRef.current = reduceMotion;

  useEffect(() => () => {
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    slideAnimation.current?.cancel();
    slideAnimation.current = undefined;
    sliding.current = false;
    dragOffset.current = 0;
  }, [archiveId]);

  function finishDrag(dx: number, elapsed: number) {
    if (sliding.current) return;
    if (dx === 0 && dragOffset.current === 0) return;
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = undefined;
    const track = trackRef.current;
    const width = rootRef.current?.clientWidth || window.innerWidth;
    const intent = dx < 0 ? 'next' : 'previous';
    const current = readerStateRef.current;
    const sample = dragSample.current;
    const velocity = sample ? (elapsed - sample.elapsed < 100 ? sample.velocity : 0) : undefined;
    const commit = shouldCommitPageTurn(dx, elapsed, width, velocity) && advanceReader(current, intent).pageIndex !== current.pageIndex;
    const target = commit ? (dx < 0 ? -width : width) : 0;
    const finish = () => {
      slideAnimation.current?.cancel();
      slideAnimation.current = undefined;
      sliding.current = false;
      dragOffset.current = 0;
      dragSample.current = undefined;
      if (track) track.style.transform = 'translate3d(0,0,0)';
      flushSync(() => {
        setDrag(null);
        if (commit) move(intent);
      });
    };
    // Keep both neighbouring frames mounted until the outgoing page has left.
    setDrag({ dx: 0, commits: false });
    if (!track?.animate || reducedMotionRef.current) { finish(); return; }
    sliding.current = true;
    slideAnimation.current = track.animate([
      { transform: `translate3d(${dragOffset.current}px,0,0)` },
      { transform: `translate3d(${target}px,0,0)` },
    ], { duration: commit ? 240 : 200, easing: 'cubic-bezier(.22,.72,.2,1)', fill: 'forwards' });
    slideAnimation.current.onfinish = finish;
  }

  const trackDrag = useCallback((dx: number, dy: number, elapsed: number) => {
    if (sliding.current) return;
    // A vertical drag is a scroll, not a page turn, and zoomed-in drags pan.
    if (zoomScaleRef.current > 1 || layoutRef.current === 'webtoon' || Math.abs(dy) > Math.abs(dx) || Math.abs(dx) <= TAP_SLOP) {
      dragOffset.current = 0;
      if (trackRef.current) trackRef.current.style.transform = 'translate3d(0,0,0)';
      setDrag(null);
      return;
    }
    const width = rootRef.current?.clientWidth || window.innerWidth;
    const previous = dragSample.current;
    const dt = elapsed - (previous?.elapsed ?? 0);
    dragSample.current = { dx, elapsed, velocity: dt > 0 ? (dx - (previous?.dx ?? 0)) / dt : (previous?.velocity ?? 0) };
    const current = readerStateRef.current;
    const boundary = advanceReader(current, dx < 0 ? 'next' : 'previous').pageIndex === current.pageIndex;
    dragOffset.current = Math.max(-width, Math.min(width, dx * (boundary ? 0.22 : 1)));
    setDrag((currentDrag) => currentDrag ?? { dx: 0, commits: false });
    if (dragFrame.current === undefined) dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = undefined;
      if (trackRef.current) trackRef.current.style.transform = `translate3d(${dragOffset.current}px,0,0)`;
    });
  }, []);

  const handleTouchStart = useCallback((event: TouchEvent) => {
    setHoverChrome(undefined);
    if (sliding.current) return;
    if ((event.target as Element).closest('button, a, input, .reader-chrome, .reader-overview')) return;
    dragSample.current = undefined;
    const touch = event.touches[0];
    if (!touch) return;
    // Two fingers are a pinch, never a page turn: a zoom gesture used to leave a
    // drag offset behind and could commit a turn on release.
    if (event.touches.length > 1) {
      touchStartRef.current = null;
      finishDrag(0, 0);
      if (layoutRef.current !== 'webtoon') {
        const second = event.touches[1]!;
        pinchStart.current = { distance: Math.max(1, Math.hypot(second.clientX - touch.clientX, second.clientY - touch.clientY)), x: (touch.clientX + second.clientX) / 2, y: (touch.clientY + second.clientY) / 2, zoom: zoomRef.current };
        panStart.current = undefined;
        setPanning(true);
        gestureMovedRef.current = true;
      }
      return;
    }
    if (zoomRef.current.scale > 1 && layoutRef.current !== 'webtoon') {
      panStart.current = { x: touch.clientX, y: touch.clientY, zoom: zoomRef.current };
      setPanning(true);
    }
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }, []);

  const handleTouchMove = useCallback((event: TouchEvent) => {
    const pinch = pinchStart.current;
    if (pinch && event.touches.length >= 2) {
      const first = event.touches[0]!;
      const second = event.touches[1]!;
      const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
      const raw = pinch.zoom.scale * distance / pinch.distance;
      const scale = Math.min(ZOOM_RUBBER_MAX, Math.max(ZOOM_RUBBER_MIN, raw < 1 ? 1 + (raw - 1) * 0.22 : raw));
      const point = viewportPoint(pinch.x, pinch.y);
      const anchored = zoomAtPoint(pinch.zoom, scale, point.x, point.y);
      setZoom(panZoom(anchored, (first.clientX + second.clientX) / 2 - pinch.x, (first.clientY + second.clientY) / 2 - pinch.y, rootRef.current?.clientWidth || window.innerWidth, rootRef.current?.clientHeight || window.innerHeight));
      return;
    }
    if (panStart.current && event.touches[0]) { dragZoom(event.touches[0].clientX, event.touches[0].clientY); return; }
    const start = touchStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch || event.touches.length > 1) {
      if (dragOffset.current !== 0) finishDrag(0, 0);
      touchStartRef.current = null;
      return;
    }
    trackDrag(touch.clientX - start.x, touch.clientY - start.y, Date.now() - start.time);
  }, [trackDrag]);

  const handleTouchEnd = useCallback((event: TouchEvent) => {
    if (pinchStart.current || panStart.current) {
      pinchStart.current = undefined;
      touchStartRef.current = null;
      const remaining = event.touches[0];
      if (remaining && zoomRef.current.scale > 1) {
        panStart.current = { x: remaining.clientX, y: remaining.clientY, zoom: zoomRef.current };
        return;
      }
      panStart.current = undefined;
      setPanning(false);
      setZoom(settleZoom);
      return;
    }
    const start = touchStartRef.current;
    if (!start) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const elapsed = Date.now() - start.time;
    touchStartRef.current = null;

    if (zoomScaleRef.current > 1) return;

    const now = Date.now();
    if (now - lastTapRef.current < 300 && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      lastTapRef.current = 0;
      if (layoutRef.current !== 'webtoon') setZoom((current) => toggleDoubleTapZoom(current));
      return;
    }
    lastTapRef.current = now;

    // Continuous scroll pages by scrolling; a horizontal flick there used to move
    // the page index behind the scroller's back.
    if (layoutRef.current === 'webtoon') return;
    if (Math.abs(dx) <= Math.abs(dy)) { finishDrag(0, 0); return; }
    // Same distance and recent-velocity rule as the mouse.
    gestureMovedRef.current = true;
    finishDrag(dx, elapsed);
  }, []);

  /** Windows fires mouse events for a trackpad or mouse drag, so paging needs a
   * press-drag-release gesture here; touch keeps its own swipe handler. */
  const pointerStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const handleMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    if (sliding.current) return;
    if ((event.target as Element).closest('button, a, input, .reader-chrome, .reader-overview')) return;
    dragSample.current = undefined;
    if (event.button !== 0) return;
    gestureMovedRef.current = false;
    if (zoomRef.current.scale > 1 && layoutRef.current !== 'webtoon') {
      panStart.current = { x: event.clientX, y: event.clientY, zoom: zoomRef.current };
      setPanning(true);
      return;
    }
    pointerStartRef.current = { x: event.clientX, y: event.clientY, time: Date.now() };
  }, []);

  const handleMouseMove = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!event.buttons) {
      const rect = rootRef.current?.getBoundingClientRect();
      const height = rect?.height || window.innerHeight;
      const y = event.clientY - (rect?.top ?? 0);
      const band = Math.min(CHROME_BAND_HEIGHT, height / 3);
      const target = event.target as Element;
      setHoverChrome(target.closest('.reader-toolbar') ? 'bottom' : target.closest('.reader-chrome-top') ? 'top' : y <= band ? 'top' : y >= height - band ? 'bottom' : null);
    }
    if (panStart.current && event.buttons === 1) { dragZoom(event.clientX, event.clientY); return; }
    const start = pointerStartRef.current;
    if (!start || event.buttons !== 1) return;
    trackDrag(event.clientX - start.x, event.clientY - start.y, Date.now() - start.time);
  }, [trackDrag]);

  const handleMouseUp = useCallback((event: MouseEvent<HTMLElement>) => {
    if (panStart.current) {
      dragZoom(event.clientX, event.clientY);
      panStart.current = undefined;
      setPanning(false);
      return;
    }
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || event.button !== 0) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    // Anything past a few pixels was a drag, and a drag is not a tap on the page
    // — drag-scrolling in continuous mode used to toggle the chrome on release.
    // The threshold matches ComicReadScript's (helper/useDrag.ts:101-130).
    gestureMovedRef.current = Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP;
    if (zoomScaleRef.current > 1 || layoutRef.current === 'webtoon') return;
    if (Math.abs(dx) <= Math.abs(dy)) { finishDrag(0, 0); return; }
    // A drag is a page turn, not a chrome toggle.
    dragPagedRef.current = true;
    finishDrag(dx, Date.now() - start.time);
  }, []);

  const handleWebtoonScroll = useCallback((event: UIEvent<HTMLElement>) => {
    webtoonScrolledRef.current = true;
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  /** Jump to a page from the overview grid. Continuous mode has to be scrolled as
   * well as told, or the index and the scroller disagree and the anchor drags it
   * straight back. */
  const scrollToPage = useCallback((index: number) => {
    if (layoutRef.current !== 'webtoon') return;
    const container = webtoonRef.current;
    if (!container) return;
    let offset = 0;
    for (let before = 0; before < index; before += 1) offset += heightsRef.current[before] ?? 0;
    container.scrollTop = offset;
    setScrollTop(offset);
  }, []);

  function cancelGesture() {
    touchStartRef.current = null;
    pointerStartRef.current = null;
    pinchStart.current = undefined;
    panStart.current = undefined;
    setPanning(false);
    setZoom(settleZoom);
    if (!sliding.current) finishDrag(0, 0);
  }

  const jumpToPage = useCallback((index: number) => {
    setState((current) => ({ ...current, pageIndex: index, phase: 'ready' }));
    scrollToPage(index);
  }, [scrollToPage]);

  const chromeVisible = state.phase === 'chrome-visible';
  const topChromeVisible = hoverChrome === undefined ? chromeVisible : hoverChrome === 'top';
  const bottomChromeVisible = hoverChrome === undefined ? chromeVisible : hoverChrome === 'bottom';
  // One transform for the slots on screen: scaling each image on its own made a
  // double spread overlap, because both grew from their own centre. It sits
  // *inside* the current frame rather than on the track that carries all three —
  // on the track, zooming out shrank the distance to the neighbours and brought
  // them into view beside the page being read.
  const zoomStyle = {
    transform: `scale(${zoom.scale}) translate(${zoom.panX}px, ${zoom.panY}px)`,
    transformOrigin: 'center center',
    transition: panning || reduceMotion ? 'none' : 'transform 140ms ease-out',
    cursor: zoom.scale > 1 ? (panning ? 'grabbing' : 'grab') : undefined,
  } as const;
  /** The track follows the finger, and eases back or through on release. */
  const dragStyle = {
    transform: 'translate3d(0,0,0)',
  } as const;

  /** One page: the image, or why it is not there yet. Always a slot, even when
   * empty — a spread whose halves appeared one at a time used to re-centre when
   * the second arrived, shifting the page under the reader's eyes. */
  const renderSlot = (index: number) => {
    const source = derivedPages?.get(index) ?? loadedPages[index];
    return (
      <div className="reader-slot" key={index}>
        {source
          ? <img draggable={false} className="reader-page" alt={`第 ${index + 1} 页`} src={source} onLoad={(event) => measurePage(index, event.currentTarget)} />
          : <PageStatus failed={exhaustedPages.has(index)} onRetry={() => retryPage(index)} />}
      </div>
    );
  };

  const spreadClass = (indexes: readonly number[]) => (
    indexes.length > 1 ? `reader-spread${state.direction === 'rtl' ? ' is-rtl' : ''}` : 'reader-single'
  );

  return (
    <main
      aria-label="漫画阅读器"
      className="reader-screen"
      style={{ touchAction: effectiveLayout === 'webtoon' ? 'pan-y' : 'none' }}
      ref={rootRef}
      onClick={(event) => {
        // A drag that turned the page, the second click of a double click, and a
        // drag that merely scrolled must none of them toggle the chrome.
        if (dragPagedRef.current) { dragPagedRef.current = false; return; }
        if (gestureMovedRef.current) { gestureMovedRef.current = false; return; }
        if (event.detail > 1) return;
        // Showing is restricted to the top and bottom bands, so a tap in the
        // middle of a page cannot flash the bars over what is being read. Hiding
        // is not: the bars swallow their own clicks, so if only the bands
        // dismissed there would be nowhere left to press.
        if (chromeVisible || isInChromeBand(event)) { setHoverChrome(undefined); setState(toggleReaderChrome); }
      }}
      onDoubleClick={() => { if (effectiveLayout !== 'webtoon') setZoom((current) => toggleDoubleTapZoom(current)); }}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse' && event.button === 0 && !(event.target as Element).closest('button, a, input')) event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerCancel={cancelGesture}
        onPointerUp={(event) => { if (event.pointerType === 'mouse') handleMouseUp(event); }}
        onLostPointerCapture={() => { if (pointerStartRef.current || panStart.current) cancelGesture(); }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      // Pointer capture keeps delivering the gesture after the cursor leaves the
      // canvas. Do not clear the start point here: doing so made a normal edge
      // drag cancel halfway through and made the release look like a jump.
      onMouseLeave={() => { setHoverChrome(null); if (!pointerStartRef.current && !panStart.current && drag) finishDrag(0, 0); }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
        onTouchCancel={cancelGesture}
      tabIndex={0}
    >
      {effectiveLayout === 'webtoon' ? (
        // No click handler of its own: this bubbles to the canvas, and having
        // both toggle meant two flips per click that cancelled out, so the
        // chrome could not be summoned in this mode at all.
        <section className="reader-webtoon" aria-label="连续阅读" ref={webtoonRef} onScroll={handleWebtoonScroll}>
          <div className="reader-webtoon-inner">
            {/* Every page gets a slot of a known height, mounted only inside the
                window. The slot is what keeps the scroller's length honest while
                most of the archive is not loaded. */}
            {heights.map((height, index) => (
              <div className="reader-webtoon-slot" key={index} style={{ height: `${height}px` }}>
                {index >= webtoonFirst && index <= webtoonLast ? renderSlot(index) : null}
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div ref={trackRef} className="reader-track" style={dragStyle}>
          {([
            { offset: -1, indexes: neighbourIndexes.previous },
            { offset: 0, indexes: visibleIndexes },
            { offset: 1, indexes: neighbourIndexes.next },
          ] as const).map(({ offset, indexes }) => {
            // Keep the adjacent frames decoded before a gesture starts. They sit
            // outside the clipped viewport; only the active frame is zoomed.
            // Key by pages so landing reuses the incoming decoded image nodes.
            if (indexes.length === 0) return null;
            return (
              <section
                key={indexes.join(',')}
                className="reader-frame"
                style={{ transform: `translateX(${offset * 100}%)` }}
                {...(offset === 0 ? { 'aria-label': '分页阅读' } : { 'aria-hidden': true })}
              >
                {/* The layout class has to sit on the same element as the slots,
                    or the spread's two columns are declared on a parent the
                    halves are no longer children of. The zoom rides along here so
                    it scales the page and not the distance to the neighbours. */}
                <div
                  className={`${spreadClass(indexes)}${drag ? ' is-dragging' : ''}${drag?.commits ? ' will-turn' : ''}`}
                  {...(offset === 0 ? { style: zoomStyle } : {})}
                >
                  {indexes.map((index) => renderSlot(index))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Two bars, two directions. They used to be one animated element, so the
          bottom bar slid in from the top of the screen — which is where it does
          not live. */}
      <div className="reader-chrome">
        <AnimatePresence>
          {topChromeVisible && (
            <motion.header
              key="reader-chrome-top"
              className="reader-chrome-top"
              initial={reduceMotion ? false : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: reduceMotion ? 0 : 0.22 }}
              onClick={stopChromeToggle}
            >
                <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
              <strong>{title}</strong>
              {incognito && <span className="reader-incognito-badge" title="无痕阅读：不记录进度与历史"><EyeOff aria-hidden="true" />无痕</span>}
              <Link className="reader-icon-button reader-chrome-settings" to="/settings?section=reading" aria-label="阅读设置" title="阅读设置"><Settings aria-hidden="true" /></Link>
            </motion.header>
          )}
          {bottomChromeVisible && (
            <motion.div
              key="reader-chrome-bottom"
              className="reader-toolbar"
              role="toolbar"
              aria-label="阅读控制"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              transition={{ duration: reduceMotion ? 0 : 0.22 }}
              onClick={stopChromeToggle}
            >
              <button type="button" aria-label="上一页" onClick={() => move('previous')}><ChevronLeft aria-hidden="true" /></button>
              <span>{pages.length === 0 ? '0 / 0' : `${state.pageIndex + 1} / ${pages.length}`}</span>
              <button type="button" aria-label="下一页" onClick={() => move('next')}><ChevronRight aria-hidden="true" /></button>
              {/* One control, cycling 自动 → 单页 → 双页 → webtoon. Three separate
                  buttons spent three toolbar slots to express one choice, and
                  none of them could select 自动 once you left it. */}
              <button type="button" aria-label={`阅读布局：${READER_LAYOUT_LABELS[state.layout]}，点击切换`} title={`阅读布局：${READER_LAYOUT_LABELS[state.layout]}`} onClick={() => setState((current) => ({ ...current, layout: nextReaderLayout(current.layout) }))}>
                {state.layout === 'auto' ? <Wand2 aria-hidden="true" /> : state.layout === 'single' ? <RectangleVertical aria-hidden="true" /> : state.layout === 'double' ? <BookOpen aria-hidden="true" /> : <GalleryVertical aria-hidden="true" />}
              </button>
              <button type="button" aria-label={autoPlay ? '停止自动翻页' : '自动翻页'} aria-pressed={autoPlay} onClick={() => setAutoPlay((value) => !value)}>{autoPlay ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</button>
              {/* The two derived renditions, switchable from here. Both were
                  settings-only, so there was no way to see what either one did to
                  the page you were looking at. */}
              {upscale?.configured && (
                <button
                  type="button"
                  disabled={!upscale.configured}
                  aria-pressed={upscale.configured && upscale.active}
                  aria-label={upscale.configured ? (upscale.active ? '关闭超分' : '开启超分') : '超分：未选择模型'}
                  title={upscale.configured ? '超分' : '超分：先在阅读设置里选择模型'}
                  onClick={upscale.toggle}
                ><Sparkles aria-hidden="true" /></button>
              )}
              {decensor?.configured && (
                <button
                  type="button"
                  disabled={!decensor.configured}
                  aria-pressed={decensor.configured && decensor.active}
                  aria-label={decensor.configured ? (decensor.active ? '关闭去码' : '开启去码') : '去码：未选择模型包'}
                  title={decensor.configured ? '去码' : '去码：先在阅读设置里选择模型包'}
                  onClick={decensor.toggle}
                ><Eraser aria-hidden="true" /></button>
              )}
              <button type="button" aria-label="缩略面板" aria-pressed={thumbnailPanelOpen} onClick={() => setThumbnailPanelOpen((value) => !value)}><LayoutGrid aria-hidden="true" /></button>
              {/* No `aria-pressed`: direction is a choice between two, not a
                  switch that is on, and the pressed styling made the button look
                  permanently hovered whenever the answer was right-to-left. */}
              <button type="button" aria-label={state.direction === 'ltr' ? '从左到右' : '从右到左'} onClick={() => setState((current) => ({ ...current, direction: current.direction === 'ltr' ? 'rtl' : 'ltr' }))}>{state.direction === 'ltr' ? <ArrowRightToLine aria-hidden="true" /> : <ArrowLeftToLine aria-hidden="true" />}</button>
              <button type="button" aria-label={isFullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen}>
                {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {thumbnailPanelOpen && (
        /* Centred overlay rather than a side drawer: it doubles as the archive
           overview (cover, size, tags) plus the page grid. */
        <div className="reader-overview-backdrop" onClick={() => setThumbnailPanelOpen(false)}>
          <aside className="reader-overview" aria-label="档案概览" onClick={stopChromeToggle}>
            <header className="reader-overview-heading">
              <strong>{title}</strong>
              <button type="button" className="reader-icon-button" aria-label="关闭概览" onClick={() => setThumbnailPanelOpen(false)}><X aria-hidden="true" /></button>
            </header>
            <div className="reader-overview-summary">
              {/* Page count and size sit under the cover rather than beside it:
                  they belong to the cover, and putting them in the wide column
                  pushed the tag groups down by a line for no reason. */}
              <div className="reader-overview-identity">
                {info?.cover && <img className="reader-overview-cover" src={info.cover} alt="" />}
                <p className="reader-overview-stats">{[`${pages.length} 页`, info?.sizeBytes ? formatByteSize(info.sizeBytes) : ''].filter(Boolean).join(' · ')}</p>
              </div>
              <div className="reader-overview-facts">
                {(info?.tags?.length ?? 0) > 0 && (
                  /* Grouped by namespace, the way the detail page shows them: a
                     flat run of chips gave no clue which were artists and which
                     were content tags. */
                  <div className="reader-overview-tags" aria-label="档案标签">
                    {categorizeSearchableTags(info?.tags ?? []).map((group) => (
                      <section className={`tag-group tag-group-${group.namespace}`} key={group.namespace}>
                        <h3>{group.label}</h3>
                        <div>{group.values.map((tag, index) => <TagSearchLink label={tag.label} query={tag.query} key={`${group.namespace}-${tag.query}-${index}`} />)}</div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="reader-overview-thumbnails">
              {pages.map((_, index) => {
                const preview = thumbnails.get(index) ?? loadedPages[index];
                return (
                  <button key={index} type="button" aria-label={`跳转到第 ${index + 1} 页`} aria-current={state.pageIndex === index} onClick={(event) => {
                    stopChromeToggle(event);
                    jumpToPage(index);
                    setThumbnailPanelOpen(false);
                  }}>
                    {preview ? <img src={preview} alt="" loading="lazy" /> : <span aria-hidden="true">{index + 1}</span>}
                    <span className="reader-overview-page-number" aria-hidden="true">{index + 1}</span>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
