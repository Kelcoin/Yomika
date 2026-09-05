import { ArrowLeft, ArrowLeftToLine, ArrowRightToLine, BookOpen, ChevronLeft, ChevronRight, EyeOff, GalleryVertical, LayoutGrid, Maximize2, Minimize2, RectangleVertical, RotateCcw, Wand2, X, ZoomIn, ZoomOut, Play, Pause } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type TouchEvent } from 'react';
import { Link } from 'react-router-dom';

import { advanceReader, classifyPageShape, createReaderState, createZoomState, effectiveReaderLayout, getPrefetchPages, getVisiblePageIndexes, nextReaderLayout, READER_LAYOUT_LABELS, resolveReaderLayout, resetZoom, settleZoom, toggleDoubleTapZoom, toggleReaderChrome, zoomByStep, zoomByWheel, type ReaderLayoutPreference, type ReadingDirection, type ZoomState } from '../domain/reader';
import { formatByteSize } from '../lib/archiveCardPresentation';
import { categorizeTags } from '../lib/tags';

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
  /** Retry hook for the failure state; the reader itself cannot refetch pages. */
  onRetry?: () => void;
  /** Archive facts for the overview panel (cover, tags, byte size). */
  info?: { cover?: string | undefined; tags?: string[] | undefined; sizeBytes?: number | undefined } | undefined;
  /** Marks the session as unrecorded; the caller skips progress writes. */
  incognito?: boolean;
}

export function ReaderScreen({ archiveId, title, pages, initialPage = 0, direction = 'ltr', layout = 'auto', loadPage, loadPageThumbnail, releasePage, onProgress, onRetry, info, incognito = false, prefetchDistance = 1 }: ReaderScreenProps) {
  const reduceMotion = useReducedMotion();
  // Built once. A different archive arrives as an unmount, not a prop change:
  // `ReaderRoute` clears `pages` when `archiveId` changes and renders its loading
  // branch, which takes this component down with it. That is what keeps the page
  // index, the zoom and the per-index page shapes from leaking into the next
  // archive — so if that loading branch is ever removed, this needs a `key`.
  const [state, setState] = useState(() => createReaderState({ archiveId, pageCount: pages.length, pageIndex: initialPage, direction, layout }));
  // `state.layout` is the preference (which may be `auto`); this is what renders.
  const effectiveLayout = effectiveReaderLayout(state);
  const [loadedPages, setLoadedPages] = useState(pages);
  const [zoom, setZoom] = useState<ZoomState>(createZoomState);
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<number, string>>(() => new Map());
  const rootRef = useRef<HTMLElement>(null);
  const zoomScaleRef = useRef(1);
  const layoutRef = useRef(effectiveLayout);
  const reportedPageRef = useRef(state.pageIndex);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapRef = useRef<number>(0);
  const dragPagedRef = useRef(false);
  /** Set on release when the pointer travelled far enough to be a drag, so the
   * click that follows can be ignored. */
  const gestureMovedRef = useRef(false);

  useEffect(() => { zoomScaleRef.current = zoom.scale; }, [zoom.scale]);
  useEffect(() => { layoutRef.current = effectiveLayout; }, [effectiveLayout]);
  // Report from an effect rather than from inside a state updater: every page
  // change is covered (toolbar, keyboard, swipe, thumbnail jump) and StrictMode
  // cannot double-fire a save.
  useEffect(() => {
    if (reportedPageRef.current === state.pageIndex) return;
    reportedPageRef.current = state.pageIndex;
    onProgress?.(state.pageIndex, { layout: state.layout, direction: state.direction });
  }, [onProgress, state.direction, state.layout, state.pageIndex]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [thumbnailPanelOpen, setThumbnailPanelOpen] = useState(false);
  const loadingPagesRef = useRef(new Set<number>());

  useEffect(() => {
    if (!releasePage) return;
    const keep = new Set<number>();
    if (effectiveLayout === 'webtoon') {
      for (let index = 0; index < loadedPages.length; index += 1) keep.add(index);
    } else {
      for (const index of getVisiblePageIndexes({ pageIndex: state.pageIndex, pageCount: loadedPages.length, layout: state.layout, resolvedLayout: state.resolvedLayout, shapes: state.shapes })) {
        keep.add(index);
        for (const adjacent of getPrefetchPages(index, loadedPages.length, prefetchDistance)) keep.add(adjacent);
      }
    }
    setLoadedPages((current) => {
      let changed = false;
      const next = current.slice();
      for (let index = 0; index < next.length; index += 1) {
        if (!keep.has(index) && next[index]) {
          releasePage(index);
          next[index] = '';
          changed = true;
        }
      }
      return changed ? next : current;
    });
    if (!loadPage) return;
    for (const index of keep) {
      if (loadedPages[index] || loadingPagesRef.current.has(index)) continue;
      loadingPagesRef.current.add(index);
      void loadPage(index).then((page) => {
        if (page) setLoadedPages((current) => current.map((value, pageIndex) => pageIndex === index ? page : value));
      }).finally(() => loadingPagesRef.current.delete(index));
    }
  }, [effectiveLayout, loadPage, loadedPages, prefetchDistance, releasePage, state.layout, state.pageIndex, state.resolvedLayout]);

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
      setZoom((current) => zoomByWheel(current, event.deltaY));
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

  const SWIPE_THRESHOLD = 50;
  /** Past this much travel a gesture is a drag rather than a tap. */
  const TAP_SLOP = 5;

  function move(intent: 'next' | 'previous') {
    setState((current) => {
      const next = advanceReader(current, intent);
      return current.phase === 'chrome-visible' ? { ...next, phase: 'chrome-visible' } : next;
    });
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
  }

  const handleTouchStart = useCallback((event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }, []);

  const handleTouchEnd = useCallback((event: TouchEvent) => {
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
      setZoom((current) => toggleDoubleTapZoom(current));
      return;
    }
    lastTapRef.current = now;

    if (elapsed > 500) return;

    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) move('next');
      else move('previous');
    }
  }, []);

  function zoomIn() {
    setZoom((current) => zoomByStep(current, 1));
  }

  function zoomOut() {
    setZoom((current) => zoomByStep(current, -1));
  }

  function zoomReset() {
    setZoom(resetZoom);
  }

  /** Windows fires mouse events for a trackpad or mouse drag, so paging needs a
   * press-drag-release gesture here; touch keeps its own swipe handler. */
  const pointerStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const handleMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY, time: Date.now() };
  }, []);

  const handleMouseUp = useCallback((event: MouseEvent<HTMLElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || event.button !== 0) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    // Anything past a few pixels was a drag, and a drag is not a tap on the page
    // — drag-scrolling in continuous mode used to toggle the chrome on release.
    // The threshold matches ComicReadScript's (helper/useDrag.ts:101-130).
    gestureMovedRef.current = Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP;
    if (zoomScaleRef.current > 1) return;
    if (Date.now() - start.time > 700) return;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return;
    // A drag is a page turn, not a chrome toggle.
    dragPagedRef.current = true;
    move(dx < 0 ? 'next' : 'previous');
  }, []);

  const visibleIndexes = getVisiblePageIndexes({ pageIndex: state.pageIndex, pageCount: loadedPages.length, layout: state.layout, resolvedLayout: state.resolvedLayout, shapes: state.shapes });
  const visiblePages = visibleIndexes.map((index) => loadedPages[index]);
  const chromeVisible = state.phase === 'chrome-visible';
  // One transform for everything on screen: scaling each image on its own made a
  // double spread overlap, because both grew from their own centre.
  const zoomStyle = {
    transform: `scale(${zoom.scale}) translate(${zoom.panX}px, ${zoom.panY}px)`,
    transformOrigin: 'center center',
    transition: 'transform 140ms ease-out',
  } as const;

  return (
    <main
      aria-label="漫画阅读器"
      className="reader-screen"
      ref={rootRef}
      onClick={(event) => {
        // A drag that turned the page, the second click of a double click, and a
        // drag that merely scrolled must none of them toggle the chrome.
        if (dragPagedRef.current) { dragPagedRef.current = false; return; }
        if (gestureMovedRef.current) { gestureMovedRef.current = false; return; }
        if (event.detail > 1) return;
        setState(toggleReaderChrome);
      }}
      onDoubleClick={() => setZoom((current) => toggleDoubleTapZoom(current))}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      tabIndex={0}
    >
      {effectiveLayout === 'webtoon' ? (
        // No click handler of its own: this bubbles to the canvas, and having
        // both toggle meant two flips per click that cancelled out, so the
        // chrome could not be summoned in this mode at all.
        <section className="reader-webtoon" aria-label="连续阅读">
          <div className="reader-webtoon-inner" style={zoomStyle}>
            {loadedPages.map((page, index) => page ? <img key={`${page}-${index}`} className="reader-page" src={page} alt={`第 ${index + 1} 页`} /> : null)}
          </div>
        </section>
      ) : visiblePages[0] ? (
        <section className={effectiveLayout === 'double' ? 'reader-spread' : 'reader-single'} aria-label="分页阅读" style={zoomStyle}>
          {visiblePages.map((page, index) => page ? <img key={`${page}-${visibleIndexes[index]}`} className="reader-page" alt={`第 ${(visibleIndexes[index] ?? state.pageIndex) + 1} 页`} src={page} onLoad={(event) => {
            const image = event.currentTarget;
            const pageIndex = visibleIndexes[index] ?? state.pageIndex;
            const shape = classifyPageShape(image.naturalWidth, image.naturalHeight);
            setState((current) => {
              // Record what auto resolves to without overwriting the preference,
              // so the layout control can still say — and keep — 自动.
              const resolvedLayout = current.layout === 'auto' && !current.resolvedLayout
                ? resolveReaderLayout('auto', {
                  viewportWidth: window.innerWidth,
                  viewportHeight: window.innerHeight,
                  pageWidth: image.naturalWidth,
                  pageHeight: image.naturalHeight,
                })
                : current.resolvedLayout;
              // A page turning out to be a spread re-pairs the run it sits in.
              if (current.shapes?.[pageIndex] === shape && resolvedLayout === current.resolvedLayout) return current;
              const shapes = [...(current.shapes ?? [])];
              shapes[pageIndex] = shape;
              return { ...current, shapes, ...(resolvedLayout ? { resolvedLayout } : {}) };
            });
          }} /> : null)}
        </section>
      ) : (
        /* JHenTai-style failure state: the message and a retry icon, nothing
           else. Leaving is the top bar's job. */
        <section className="reader-error" onClick={stopChromeToggle}>
          <p role="alert">页面加载失败</p>
          <button type="button" className="reader-retry-button" aria-label="重试加载" onClick={() => onRetry?.()}>
            <RotateCcw aria-hidden="true" />
          </button>
        </section>
      )}

      <AnimatePresence>
        {chromeVisible && (
          <motion.div
            className="reader-chrome"
            initial={reduceMotion ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: reduceMotion ? 0 : 0.22 }}
            onClick={stopChromeToggle}
          >
            <header>
              <Link className="reader-icon-button" to="/library" aria-label="返回档案库"><ArrowLeft aria-hidden="true" /></Link>
              <strong>{title}</strong>
              {incognito && <span className="reader-incognito-badge" title="无痕阅读：不记录进度与历史"><EyeOff aria-hidden="true" />无痕</span>}
            </header>
            <div className="reader-toolbar" role="toolbar" aria-label="阅读控制">
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
              <button type="button" aria-label="缩略面板" aria-pressed={thumbnailPanelOpen} onClick={() => setThumbnailPanelOpen((value) => !value)}><LayoutGrid aria-hidden="true" /></button>
              <button type="button" aria-label={state.direction === 'ltr' ? '从左到右' : '从右到左'} aria-pressed={state.direction === 'rtl'} onClick={() => setState((current) => ({ ...current, direction: current.direction === 'ltr' ? 'rtl' : 'ltr' }))}>{state.direction === 'ltr' ? <ArrowRightToLine aria-hidden="true" /> : <ArrowLeftToLine aria-hidden="true" />}</button>
              <button type="button" aria-label="放大" onClick={zoomIn}><ZoomIn aria-hidden="true" /></button>
              <button type="button" aria-label="缩小" onClick={zoomOut}><ZoomOut aria-hidden="true" /></button>
              {zoom.scale > 1 && <button type="button" aria-label="重置缩放" onClick={zoomReset}><RotateCcw aria-hidden="true" /></button>}
              {zoom.scale > 1 && <span>{Math.round(zoom.scale * 100)}%</span>}
              <button type="button" aria-label={isFullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen}>
                {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
              {info?.cover && <img className="reader-overview-cover" src={info.cover} alt="" />}
              <div className="reader-overview-facts">
                <p className="reader-overview-stats">{[`${pages.length} 页`, info?.sizeBytes ? formatByteSize(info.sizeBytes) : ''].filter(Boolean).join(' · ')}</p>
                {(info?.tags?.length ?? 0) > 0 && (
                  /* Grouped by namespace, the way the detail page shows them: a
                     flat run of chips gave no clue which were artists and which
                     were content tags. */
                  <div className="reader-overview-tags" aria-label="档案标签">
                    {categorizeTags(info?.tags ?? []).map((group) => (
                      <section className={`tag-group tag-group-${group.namespace}`} key={group.namespace}>
                        <h3>{group.label}</h3>
                        <div>{group.values.map((tag, index) => <small className="metadata-chip" key={`${group.namespace}-${tag}-${index}`}>{tag}</small>)}</div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="reader-overview-thumbnails">
              {loadedPages.map((page, index) => {
                const preview = thumbnails.get(index) ?? page;
                return (
                  <button key={index} type="button" aria-label={`跳转到第 ${index + 1} 页`} aria-current={state.pageIndex === index} onClick={(event) => {
                    stopChromeToggle(event);
                    setState((current) => ({ ...current, pageIndex: index, phase: 'ready' }));
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
