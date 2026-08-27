import { ArrowLeft, ChevronLeft, ChevronRight, Maximize2, Minimize2, Minus, RotateCcw, ZoomIn } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type TouchEvent } from 'react';
import { Link } from 'react-router-dom';

import { advanceReader, applyZoom, clampZoom, createReaderState, createZoomState, resolveReaderLayout, resetZoom, toggleDoubleTapZoom, toggleReaderChrome, type ReaderLayoutPreference, type ReadingDirection, type ZoomState } from '../domain/reader';

interface ReaderScreenProps {
  archiveId: string;
  title: string;
  pages: string[];
  initialPage?: number;
  direction?: ReadingDirection;
  layout?: ReaderLayoutPreference;
  loadPage?: (pageIndex: number) => Promise<string | undefined>;
  onProgress?: (pageIndex: number) => void;
}

export function ReaderScreen({ archiveId, title, pages, initialPage = 0, direction = 'ltr', layout = 'auto', loadPage, onProgress }: ReaderScreenProps) {
  const reduceMotion = useReducedMotion();
  const [state, setState] = useState(() => createReaderState({ archiveId, pageCount: pages.length, pageIndex: initialPage, direction, layout }));
  const [loadedPages, setLoadedPages] = useState(pages);
  const [zoom, setZoom] = useState<ZoomState>(createZoomState);
  const zoomScaleRef = useRef(1);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapRef = useRef<number>(0);

  useEffect(() => { zoomScaleRef.current = zoom.scale; }, [zoom.scale]);
  const [isFullscreen, setIsFullscreen] = useState(false);

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
      if (next.pageIndex !== current.pageIndex) onProgress?.(next.pageIndex);
      if (!loadedPages[next.pageIndex] && loadPage) {
        void loadPage(next.pageIndex).then((page) => {
          if (page) setLoadedPages((currentPages) => currentPages.map((value, index) => index === next.pageIndex ? page : value));
        });
      }
      return next;
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

  const currentPage = loadedPages[state.pageIndex];
  const visiblePages = state.layout === 'double' ? loadedPages.slice(state.pageIndex, state.pageIndex + 2) : [currentPage];
  const chromeVisible = state.phase === 'chrome-visible';

  return (
    <main
      aria-label="漫画阅读器"
      className="reader-screen"
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
          {visiblePages.map((page, index) => page ? <img key={`${page}-${index}`} className="reader-page" style={{ transform: `scale(${zoom.scale}) translate(${zoom.panX}px, ${zoom.panY}px)`, transformOrigin: 'center center' }} alt={`第 ${state.pageIndex + index + 1} 页`} src={page} onLoad={(event) => {
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
              <button type="button" aria-label="单页" onClick={() => setState((current) => ({ ...current, layout: 'single' }))}>单页</button>
              <button type="button" aria-label="双页" onClick={() => setState((current) => ({ ...current, layout: 'double' }))}>双页</button>
              <button type="button" aria-label="连续滚动" onClick={() => setState((current) => ({ ...current, layout: current.layout === 'webtoon' ? 'single' : 'webtoon' }))}>连续滚动</button>
              <button type="button" aria-label="切换阅读方向" onClick={() => setState((current) => ({ ...current, direction: current.direction === 'ltr' ? 'rtl' : 'ltr' }))}>{state.direction === 'ltr' ? '从左到右' : '从右到左'}</button>
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
    </main>
  );
}
