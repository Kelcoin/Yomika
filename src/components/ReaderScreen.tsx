import { ArrowLeft, ArrowLeftToLine, ArrowRightToLine, ChevronLeft, ChevronRight, Columns2, File, Maximize2, Minimize2, Minus, RotateCcw, ScrollText, ZoomIn, Play, Pause, PanelRight } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type TouchEvent } from 'react';
import { Link } from 'react-router-dom';

import { advanceReader, applyZoom, clampZoom, createReaderState, createZoomState, getPrefetchPages, getVisiblePageIndexes, resolveReaderLayout, resetZoom, toggleDoubleTapZoom, toggleReaderChrome, type ReaderLayoutPreference, type ReadingDirection, type ZoomState } from '../domain/reader';

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
}

export function ReaderScreen({ archiveId, title, pages, initialPage = 0, direction = 'ltr', layout = 'auto', loadPage, loadPageThumbnail, releasePage, onProgress, prefetchDistance = 1 }: ReaderScreenProps) {
  const reduceMotion = useReducedMotion();
  const [state, setState] = useState(() => createReaderState({ archiveId, pageCount: pages.length, pageIndex: initialPage, direction, layout }));
  const [loadedPages, setLoadedPages] = useState(pages);
  const [zoom, setZoom] = useState<ZoomState>(createZoomState);
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<number, string>>(() => new Map());
  const rootRef = useRef<HTMLElement>(null);
  const zoomScaleRef = useRef(1);
  const layoutRef = useRef(state.layout);
  const reportedPageRef = useRef(state.pageIndex);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapRef = useRef<number>(0);

  useEffect(() => { zoomScaleRef.current = zoom.scale; }, [zoom.scale]);
  useEffect(() => { layoutRef.current = state.layout; }, [state.layout]);
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
    if (state.layout === 'webtoon') {
      for (let index = 0; index < loadedPages.length; index += 1) keep.add(index);
    } else {
      for (const index of getVisiblePageIndexes({ pageIndex: state.pageIndex, pageCount: loadedPages.length, layout: state.layout })) {
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
  }, [loadPage, loadedPages, prefetchDistance, releasePage, state.layout, state.pageIndex]);

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
    const onWheel = (event: globalThis.WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (layoutRef.current === 'webtoon' || target?.closest('input, textarea, select, [contenteditable="true"], .reader-comments, .horizontal-scroller')) return;
      if (event.deltaY === 0) return;
      if (event.cancelable) event.preventDefault();
      setZoom((current) => applyZoom(current, current.scale - event.deltaY * 0.002, current.panX, current.panY));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // Arrow keys are bound to the canvas, so it has to own focus from the start;
  // otherwise the user must click first, and that click toggles the chrome.
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    if (!autoPlay) return undefined;
    const timer = window.setInterval(() => move('next'), 5000);
    return () => window.clearInterval(timer);
  }, [autoPlay, state.direction, state.layout]);

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
    setZoom((current) => applyZoom(current, current.scale + 0.5, current.panX, current.panY));
  }

  function zoomOut() {
    setZoom((current) => applyZoom(current, current.scale - 0.5, current.panX, current.panY));
  }

  function zoomReset() {
    setZoom(resetZoom);
  }

  const visibleIndexes = getVisiblePageIndexes({ pageIndex: state.pageIndex, pageCount: loadedPages.length, layout: state.layout });
  const visiblePages = visibleIndexes.map((index) => loadedPages[index]);
  const chromeVisible = state.phase === 'chrome-visible';

  return (
    <main
      aria-label="漫画阅读器"
      className="reader-screen"
      ref={rootRef}
      onClick={() => setState(toggleReaderChrome)}
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      tabIndex={0}
    >
      {state.layout === 'webtoon' ? (
        <section className="reader-webtoon" aria-label="连续阅读">
          {loadedPages.map((page, index) => page ? <img key={`${page}-${index}`} className="reader-page" style={{ transform: `scale(${zoom.scale}) translate(${zoom.panX}px, ${zoom.panY}px)`, transformOrigin: 'center center' }} src={page} alt={`第 ${index + 1} 页`} /> : null)}
        </section>
      ) : visiblePages[0] ? (
        <section className={state.layout === 'double' ? 'reader-spread' : 'reader-single'} aria-label="分页阅读">
          {visiblePages.map((page, index) => page ? <img key={`${page}-${visibleIndexes[index]}`} className="reader-page" style={{ transform: `scale(${zoom.scale}) translate(${zoom.panX}px, ${zoom.panY}px)`, transformOrigin: 'center center' }} alt={`第 ${(visibleIndexes[index] ?? state.pageIndex) + 1} 页`} src={page} onLoad={(event) => {
            if (state.layout === 'auto') {
              const image = event.currentTarget;
              setState((current) => ({ ...current, layout: resolveReaderLayout('auto', {
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                pageWidth: image.naturalWidth,
                pageHeight: image.naturalHeight,
              }) }));
            }
          }} /> : null)}
        </section>
      ) : (
        <section className="reader-error" onClick={stopChromeToggle}>
          <h1>档案页尚未载入</h1>
          <p>返回档案详情并重新加载页面列表。</p>
          <Link to="/library"><ArrowLeft aria-hidden="true" />返回档案库</Link>
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
            </header>
            <div className="reader-toolbar" role="toolbar" aria-label="阅读控制">
              <button type="button" aria-label="上一页" onClick={() => move('previous')}><ChevronLeft aria-hidden="true" /></button>
              <span>{pages.length === 0 ? '0 / 0' : `${state.pageIndex + 1} / ${pages.length}`}</span>
              <button type="button" aria-label="下一页" onClick={() => move('next')}><ChevronRight aria-hidden="true" /></button>
              <button type="button" aria-label="单页" aria-pressed={state.layout === 'single' || state.layout === 'auto'} onClick={() => setState((current) => ({ ...current, layout: 'single' }))}><File aria-hidden="true" /></button>
              <button type="button" aria-label="双页" aria-pressed={state.layout === 'double'} onClick={() => setState((current) => ({ ...current, layout: 'double' }))}><Columns2 aria-hidden="true" /></button>
              <button type="button" aria-label="连续滚动" aria-pressed={state.layout === 'webtoon'} onClick={() => setState((current) => ({ ...current, layout: 'webtoon' }))}><ScrollText aria-hidden="true" /></button>
              <button type="button" aria-label={autoPlay ? '停止自动翻页' : '自动翻页'} aria-pressed={autoPlay} onClick={() => setAutoPlay((value) => !value)}>{autoPlay ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</button>
              <button type="button" aria-label="缩略面板" aria-pressed={thumbnailPanelOpen} onClick={() => setThumbnailPanelOpen((value) => !value)}><PanelRight aria-hidden="true" /></button>
              <button type="button" aria-label={state.direction === 'ltr' ? '从左到右' : '从右到左'} aria-pressed={state.direction === 'rtl'} onClick={() => setState((current) => ({ ...current, direction: current.direction === 'ltr' ? 'rtl' : 'ltr' }))}>{state.direction === 'ltr' ? <ArrowRightToLine aria-hidden="true" /> : <ArrowLeftToLine aria-hidden="true" />}</button>
              <button type="button" aria-label="放大" onClick={zoomIn}><ZoomIn aria-hidden="true" /></button>
              <button type="button" aria-label="缩小" onClick={zoomOut}><Minus aria-hidden="true" /></button>
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
        <aside className="reader-thumbnail-panel" aria-label="页面缩略图">
          {loadedPages.map((page, index) => {
            const preview = thumbnails.get(index) ?? page;
            return (
              <button key={index} type="button" aria-label={`跳转到第 ${index + 1} 页`} aria-current={state.pageIndex === index} onClick={(event) => {
                stopChromeToggle(event);
                setState((current) => ({ ...current, pageIndex: index, phase: 'ready' }));
              }}>
                {preview ? <img src={preview} alt="" loading="lazy" /> : <span>{index + 1}</span>}
              </button>
            );
          })}
        </aside>
      )}
    </main>
  );
}
