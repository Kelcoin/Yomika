import { usePageActive } from '../app/RetainedPage';
import { ArrowLeft, ArrowLeftToLine, ArrowRightToLine, BookOpen, ChevronLeft, ChevronRight, Copy, Eraser, EyeOff, GalleryVertical, LayoutGrid, Pause, Play, RectangleVertical, RotateCcw, Settings, Sparkles, Square, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, memo, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject, type TouchEvent, type UIEvent } from 'react';
import { Link } from 'react-router-dom';
import { flushSync } from 'react-dom';

import { advanceReader, classifyPageShape, createReaderState, createZoomState, effectiveReaderLayout, fitPageSize, getPrefetchPages, getVisiblePageIndexes, nextReaderLayout, READER_LAYOUT_LABELS, resolveReaderLayout, settleZoom, shouldCommitPageTurn, toggleDoubleTapZoom, toggleReaderChrome, WEBTOON_ESTIMATED_PAGE_RATIO, webtoonWindow, zoomByWheel, type ReaderLayoutPreference, type ReadingDirection, type ZoomState } from '../domain/reader';
import { panZoom, zoomAtPoint, ZOOM_RUBBER_MIN, ZOOM_RUBBER_MAX } from '../domain/reader';
import { ArchiveOverviewPanel } from './ArchiveOverviewPanel';
import { DlssnrIcon } from './DlssnrIcon';
import { LoadingIndicator } from './LoadingIndicator';
import { useWindowControls, useWindowDrag, useWindowMaximized } from './WindowControls';
import { decodeImage } from '../lib/decodeImage';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useReturnNavigation } from '../lib/useReturnNavigation';

/** Pages kept beyond the fetch window. Three either side covers stepping back
 * over a spread without a refetch, and costs a handful of blob URLs. */
const PAGE_RETENTION_MARGIN = 3;
/** Attempts before a page is left alone. */
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
/** Readoshi's page pill only borrows a moment over the artwork after a page
 * turn; long enough to read "3–4 / 82" and short enough to get out of the way. */
const INDICATOR_FLASH_MS = 1_800;
/** 两条栏的出场时长，与 `--duration-exit` 同一个数：CSS 动画播完才把元素摘掉。 */
const CHROME_EXIT_MS = 260;

/** 一条栏的「淡出之后才摘」。
 *
 * 入场是一条 CSS 动画（挂上去就播），出场要先把元素留在树上把动画播完。这件事原来
 * 交给 `motion` 的 `AnimatePresence`，而它为两条淡入淡出把整个动画运行时拉进了阅读器
 * 这一个 chunk（`ReaderRoute-*.js` 实测含 `motion` 的 visualElement / MotionConfig，
 * 约 55KB gzip）。这里只要一个布尔值和一次定时器。 */
function useDelayedUnmount(visible: boolean, ms: number): { mounted: boolean; leaving: boolean } {
  const [state, setState] = useState({ mounted: visible, leaving: false });
  useEffect(() => {
    if (visible) {
      setState((current) => current.mounted && !current.leaving ? current : { mounted: true, leaving: false });
      return undefined;
    }
    setState((current) => current.mounted && !current.leaving ? { mounted: true, leaving: true } : current);
    const timer = window.setTimeout(
      () => setState((current) => current.mounted || current.leaving ? { mounted: false, leaving: false } : current),
      ms,
    );
    return () => window.clearTimeout(timer);
  }, [visible, ms]);
  return state;
}

/** 一根盒子：左/上角在视口里的位置 + 尺寸。量不到（还没布局）时按视口兜底，感应带总得
 * 有个数可用。 */
interface ReaderRootBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function measureReaderRoot(element: HTMLElement | null): ReaderRootBox {
  const rect = element?.getBoundingClientRect();
  return {
    left: rect?.left ?? 0,
    top: rect?.top ?? 0,
    width: rect?.width || element?.clientWidth || window.innerWidth,
    height: rect?.height || element?.clientHeight || window.innerHeight,
  };
}

/** 共享件里的指针事件只用到坐标、`target` 和「别冒泡」，所以按最宽的 `Element` 收：
 * 这样同一份处理器也能交给 `ArchiveOverviewPanel`（它的 `onPanelClick` 就是这个类型），
 * 不必为每一层各自包一层。 */
type ChromePointerEvent = MouseEvent<Element>;

export interface ReaderChromeOptions {
  /** 画布元素；感应带按它的盒子算。 */
  rootRef: RefObject<HTMLElement | null>;
  /** 权威可见性：来自状态机，或加载态自己的状态。 */
  visible: boolean;
  /** 页面在前台时才走自动隐藏（保留页留在后台时不该自己走表）。 */
  active: boolean;
  /** 临时挂起：指针判定与自动隐藏都让位（缩略面板压在上面时）。 */
  suspended?: boolean;
  /** 翻开 / 收起。 */
  onToggle: () => void;
  /** 自动隐藏的时间到了。 */
  onHide: () => void;
}

export interface ReaderChrome {
  topChromeVisible: boolean;
  bottomChromeVisible: boolean;
  topPresence: { mounted: boolean; leaving: boolean };
  bottomPresence: { mounted: boolean; leaving: boolean };
  /** 指针落在哪条带上：栏本身、或上下感应带；画布中部是 `null`。 */
  hoverTarget: (event: ChromePointerEvent) => 'top' | 'bottom' | null;
  setHover: (next: 'top' | 'bottom' | null | undefined) => void;
  /** 画布上的一次点击：栏开着、或点在感应带里，就翻开 / 收起。 */
  handleCanvasClick: (event: ChromePointerEvent) => void;
  /** 栏内部的按下：不要冒泡成「再点一下收起」，并把自动隐藏重新计时。 */
  keepAlive: (event: ChromePointerEvent) => void;
  /** 指针离开画布：别让上一次的 hover 定住一条栏。 */
  clearHover: () => void;
}

/** 顶栏/底栏的可见性、感应带与自动隐藏——阅读态与加载态共用这一套。
 *
 * 为什么必须共用一个件：加载中那条顶栏（`ReaderRoute` 的 `.reader-error-bar`）原来是一块
 * 常显的条，于是同一次进入阅读模式前后是两副样子——先看到一排控件，加载完又学会隐藏。
 * 行为要一致就不能有两份实现，所以指针落点、出场动画、4.5s 自动隐藏都收在这里。
 *
 * 这里**不持有**「有没有被唤出」：加载态根本没有 `ReaderState`。权威可见性由调用方给
 * （阅读态是状态机的 `chrome-visible`，加载态是一个本地 `useState`），hook 只让指针
 * 悬停临时压过它。 */
export function useReaderChrome({ rootRef, visible, active, suspended = false, onToggle, onHide }: ReaderChromeOptions): ReaderChrome {
  // 盒子缓存到 resize 为止：指针事件里做 `getBoundingClientRect()` 会让阅读器每帧同步
  // 布局一次，而鼠标移动事件的密度正好够把它变成可感的卡顿。
  const boxRef = useRef<ReaderRootBox>({ left: 0, top: 0, width: 0, height: 0 });
  const readBox = useCallback(() => {
    boxRef.current = measureReaderRoot(rootRef.current);
    return boxRef.current;
  }, [rootRef]);
  const box = useCallback(() => (boxRef.current.width > 0 ? boxRef.current : readBox()), [readBox]);
  useEffect(() => {
    // 转屏、改窗口大小之后感应带要按新的高度算，所以只把缓存作废，下次指针事件再量。
    const invalidate = () => { boxRef.current = { left: 0, top: 0, width: 0, height: 0 }; };
    window.addEventListener('resize', invalidate);
    return () => window.removeEventListener('resize', invalidate);
  }, []);

  const [hoverChrome, setHoverChrome] = useState<'top' | 'bottom' | null | undefined>();
  const hoverChromeRef = useRef<'top' | 'bottom' | null | undefined>(undefined);
  // 值没变就不写 state：指针在栏内移动时事件很密，每次 setState 都是白重渲染一遍。
  const setHover = useCallback((next: 'top' | 'bottom' | null | undefined) => {
    if (hoverChromeRef.current === next) return;
    hoverChromeRef.current = next;
    setHoverChrome(next);
  }, []);

  const hoverTarget = useCallback((event: ChromePointerEvent): 'top' | 'bottom' | null => {
    const rect = box();
    const height = rect.height;
    const y = event.clientY - rect.top;
    const band = Math.min(CHROME_BAND_HEIGHT, height / 3);
    const target = event.target as Element;
    return target.closest('.reader-toolbar') ? 'bottom'
      : target.closest('.reader-chrome-top, .reader-error-bar') ? 'top'
        : y <= band ? 'top'
          : y >= height - band ? 'bottom'
            : null;
  }, [box]);

  const [keepAliveToken, setKeepAliveToken] = useState(0);
  const keepAlive = useCallback((event: ChromePointerEvent) => {
    event.stopPropagation();
    setKeepAliveToken((value) => value + 1);
  }, []);

  // 定时器和点击回调要拿到**当下**的 onToggle/onHide：调用方每次渲染都会传新函数，
  // 而 4.5s 后才响的定时器不该拿着 4.5s 前那份闭包去改状态。
  const callbacksRef = useRef({ onToggle, onHide });
  callbacksRef.current = { onToggle, onHide };

  useEffect(() => {
    if (!active || !visible || suspended) return undefined;
    const timer = window.setTimeout(() => callbacksRef.current.onHide(), CHROME_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [active, keepAliveToken, suspended, visible]);

  const handleCanvasClick = useCallback((event: ChromePointerEvent) => {
    const rect = box();
    const height = rect.height;
    const offset = event.clientY - rect.top;
    const band = Math.min(CHROME_BAND_HEIGHT, height / 3);
    // 栏开着时点哪儿都收起；栏藏着时只有点在上下感应带里才算唤出，画面中部留给翻页。
    if (!visible && offset > band && offset < height - band) return;
    setHover(undefined);
    callbacksRef.current.onToggle();
  }, [box, setHover, visible]);

  const clearHover = useCallback(() => setHover(null), [setHover]);

  // `undefined` 是「指针还没给过意见」（听权威可见性），`null` 是「指针已经在画面中部 /
  // 离开了画布」（两条栏都收）——两者不能合并。
  const topChromeVisible = hoverChrome === undefined ? visible : hoverChrome === 'top';
  const bottomChromeVisible = hoverChrome === undefined ? visible : hoverChrome === 'bottom';
  const topPresence = useDelayedUnmount(topChromeVisible, CHROME_EXIT_MS);
  const bottomPresence = useDelayedUnmount(bottomChromeVisible, CHROME_EXIT_MS);

  return { topChromeVisible, bottomChromeVisible, topPresence, bottomPresence, hoverTarget, setHover, handleCanvasClick, keepAlive, clearHover };
}

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
  dlssnr?: EnhancementSwitch | undefined;
  /** Bumped by the caller when what `loadPage` would return has changed — a
   * switch above, for instance. Every loaded page is dropped and the window
   * refetched; without it a toggle changed nothing already on screen. */
  reloadToken?: number;
  /** Enhanced renditions by page index. They arrive after the plain page and take
   * its place in the same slot, so nothing about the view changes but the `src` —
   * which is what keeps the zoom from being thrown away mid-read. */
  derivedPages?: ReadonlyMap<number, string> | undefined;
  /** Pages the caller is deriving right now (de-censor / upscale). On CPU a page
   * takes seconds — a 1248×1416 with both models runs ~20 — and until now nothing
   * on screen said so: press 「去码」, see nothing, and the feature reads as broken
   * even though it is working. The pill is that missing sentence. */
  derivingPages?: ReadonlySet<number> | undefined;
  /** What to call the wait: `去码处理中…`, `超分处理中…`, both when both are on. */
  derivingLabel?: string | undefined;
  /** The pages actually on screen, so the caller can enhance those and not the
   * whole prefetch window. */
  onVisiblePages?: ((indexes: readonly number[]) => void) | undefined;
  onDerivedDisplayed?: ((pageIndex: number, url: string) => void) | undefined;
}

/** Why a page is not on screen yet: still coming, or given up on.
 *
 * These used to share a branch — anything not yet loaded rendered as "页面加载
 * 失败" — which is why turning a page announced a failure and then quietly
 * showed the page. They are now distinct, and a page is only called failed once
 * its retries are actually spent. */
/** 一页的图：换 `src` 之前先把新图解好。
 *
 * `<img>` 换 `src` 的那一帧，浏览器会先把旧图扔掉——旧图 → 空 → 新图。超分/去码算完正好
 * 是这个动作（同一页从原图换成处理过的图），中间那一帧空档在阅读器的深色底上就是用户看到
 * 的黑闪。所以这里保留正在显示的那一张，新图 `decode()` 完了再换（见 `lib/decodeImage`）。
 *
 * 包在 `memo` 里：翻一页只该动那一页的图。三个帧（上一页 / 这一页 / 下一页）都在同一个
 * 树里，不拦一下就是每次翻页把三张图的元素与内联样式重新算一遍。
 */
const ReaderPageImage = memo(function ReaderPageImage({ index, source, size, onMeasured, onDisplayed }: {
  index: number;
  source: string;
  size: { width: number; height: number } | undefined;
  onMeasured: (index: number, image: HTMLImageElement) => void;
  onDisplayed?: ((index: number, url: string) => void) | undefined;
}) {
  const [shown, setShown] = useState(source);
  useEffect(() => {
    if (source === shown) return;
    let active = true;
    void decodeImage(source).then(() => { if (active) setShown(source); });
    return () => { active = false; };
  }, [source, shown]);
  return (
    <img
      draggable={false}
      className="reader-page"
      alt={`第 ${index + 1} 页`}
      src={shown}
      decoding="async"
      style={size ? { '--reader-page-fit-width': `${size.width}px`, '--reader-page-fit-height': `${size.height}px` } as CSSProperties : undefined}
      onLoad={(event) => {
        onMeasured(index, event.currentTarget);
        onDisplayed?.(index, shown);
      }}
    />
  );
});

function PageStatus({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  // 同一个 M3 指示器，全应用只此一个（它自己的深色画布由 .reader-page-status 上色）。
  if (!failed) return <div className="reader-page-status"><LoadingIndicator /></div>;
  return (
    <div className="reader-page-status is-failed">
      <button type="button" className="reader-retry-button" aria-label="重试加载" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
      </button>
      <p role="alert">加载失败</p>
    </div>
  );
}

/** The window's own size, read synchronously: the first paint needs it to know
 * whether the viewport can hold a spread. */
function readViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function ReaderScreen({ archiveId, title, pages, initialPage = 0, direction = 'ltr', layout = 'auto', loadPage, loadPageThumbnail, releasePage, onProgress, info, incognito = false, prefetchDistance = 1, upscale, decensor, dlssnr, reloadToken = 0, derivedPages, derivingPages, derivingLabel = '处理中…', onVisiblePages, onDerivedDisplayed }: ReaderScreenProps) {
  const pageActive = usePageActive();
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const goBack = useReturnNavigation();
  const [viewport, setViewport] = useState(readViewport);
  // Built once. A different archive arrives as an unmount, not a prop change:
  // `ReaderRoute` clears `pages` when `archiveId` changes and renders its loading
  // branch, which takes this component down with it. That is what keeps the page
  // index, the zoom and the per-index page shapes from leaking into the next
  // archive — so if that loading branch is ever removed, this needs a `key`.
  const [state, setState] = useState(() => createReaderState({
    archiveId,
    pageCount: pages.length,
    pageIndex: initialPage,
    direction,
    layout,
    resolvedLayout: resolveReaderLayout(layout, { viewportWidth: viewport.width, viewportHeight: viewport.height }),
  }));
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
    const box = rootBox();
    return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 };
  }

  function dragZoom(x: number, y: number) {
    const start = panStart.current;
    if (!start) return;
    gestureMovedRef.current ||= Math.abs(x - start.x) + Math.abs(y - start.y) > 5;
    const box = rootBox();
    setZoom(panZoom(start.zoom, x - start.x, y - start.y, box.width, box.height));
  }
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<number, string>>(() => new Map());
  /** Natural size per page index, recorded as images load. Feeds both the `auto`
   * layout decision and the continuous-scroll slot heights. */
  const [pageSizes, setPageSizes] = useState<ReadonlyMap<number, { width: number; height: number }>>(() => new Map());
  /** Pages whose retries are spent, as state rather than a ref so the slot can
   * actually re-render into its failure state. */
  const [exhaustedPages, setExhaustedPages] = useState<ReadonlySet<number>>(() => new Set());
  const [webtoonWidth, setWebtoonWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const rootRef = useRef<HTMLElement>(null);
  /** 画布自己的盒子，跟着 resize 量一次。
   *
   * 鼠标每移动一像素、每一次拖动、每一个滚轮刻度都要问「指到哪里 / 画布多宽」，
   * 而 `getBoundingClientRect()` 与 `clientWidth` 在样式刚被改过时是一次**强制
   * 布局**——每帧对着三张大图重排一次就是拖动跟手与否的差别。这块盒子只在窗口改
   * 尺寸、换布局时才变，所以量一次存下来（下面那个 rAF 合并过的 resize effect 里）；
   * 拿不到时再退回现场量。 */
  const rootBoxRef = useRef<ReaderRootBox>({ left: 0, top: 0, width: 0, height: 0 });
  const readRootBox = useCallback(() => {
    rootBoxRef.current = measureReaderRoot(rootRef.current);
    return rootBoxRef.current;
  }, []);
  const rootBox = () => {
    const box = rootBoxRef.current;
    return box.width > 0 ? box : readRootBox();
  };
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
  const reportedPageRef = useRef(-1);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapRef = useRef<number>(0);
  const dragPagedRef = useRef(false);
  /** Set on release when the pointer travelled far enough to be a drag, so the
   * click that follows can be ignored. */
  const gestureMovedRef = useRef(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [thumbnailPanelOpen, setThumbnailPanelOpen] = useState(false);
  // 缩略面板是阅读器里的一层：返回手势先收掉它，而不是直接把阅读页带走
  // （返回手势走 webview 历史，见 `lib/overlayBackGuard`）。
  useOverlayBackGuard(thumbnailPanelOpen, () => setThumbnailPanelOpen(false));
  // Undefined keeps tap/keyboard behaviour; mouse movement chooses one edge.
  // 可见性、感应带与自动隐藏都在 `useReaderChrome` 里——加载态的 `ReaderRoute` 用同一个
  // hook，所以「加载中」和「加载完」的顶栏是同一套行为，而不是两处各写一遍的近似。
  const { topChromeVisible, bottomChromeVisible, topPresence, bottomPresence, hoverTarget, setHover, handleCanvasClick, keepAlive: stopChromeToggle, clearHover } = useReaderChrome({
    rootRef,
    visible: state.phase === 'chrome-visible',
    active: pageActive,
    suspended: thumbnailPanelOpen,
    onToggle: () => setState(toggleReaderChrome),
    onHide: () => setState((current) => current.phase === 'chrome-visible' ? { ...current, phase: 'ready' } : current),
  });
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
    if (!pageActive) return;
    // 拖窗口时 resize 事件一秒钟能来上百个，而每一次都 setState 两遍就是上百次重渲染
    // （`auto` 的判定与连续阅读的槽位高度都要跟着重算）。合并到每帧一次，并且只在
    // 尺寸真的变了时才写 state——同样的数字写进去也是一个新对象，照样重渲染。
    let frame: number | undefined;
    const measureNow = () => {
      frame = undefined;
      readRootBox();
      setViewport((current) => (current.width === window.innerWidth && current.height === window.innerHeight
        ? current
        : { width: window.innerWidth, height: window.innerHeight }));
      setWebtoonWidth((current) => {
        const width = webtoonRef.current?.clientWidth ?? 0;
        return current === width ? current : width;
      });
    };
    const measure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(measureNow);
    };
    measureNow();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [effectiveLayout, pageActive, readRootBox]);

  // `auto` used to be decided once, by the first page to load, and then never
  // revisited — so narrowing the window kept the spread it had chosen and
  // squeezed two pages into half the width each. Re-decide whenever the viewport
  // changes, and from the viewport alone: which pages share a slot is
  // `planPageSpreads`'s answer (a wide page takes its own), and resolving from the
  // page on screen made this a global decision that lagged a turn behind.
  useEffect(() => {
    if (state.layout !== 'auto') return;
    const resolved = resolveReaderLayout('auto', { viewportWidth: viewport.width, viewportHeight: viewport.height });
    setState((current) => current.resolvedLayout === resolved ? current : { ...current, resolvedLayout: resolved });
  }, [state.layout, viewport.height, viewport.width]);

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

  // 自动隐藏（4.5s 无人搭理）现在在 `useReaderChrome` 里：它和加载态那条顶栏共用同一条
  // 计时。上面那段注释描述的行为没变，只是搬到了共享件里。

  // What is on screen right now, which is a different question from what the
  // prefetch window holds. Enhancement is expensive enough that it is worth
  // asking only about the pages someone is actually looking at.
  useEffect(() => {
    if (!pageActive || !onVisiblePages) return;
    onVisiblePages(effectiveLayout === 'webtoon' ? [webtoonAnchor] : visibleIndexes);
  }, [effectiveLayout, onVisiblePages, visibleIndexes, webtoonAnchor, pageActive]);

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
    if (!pageActive) {
      if (retryTimerRef.current !== undefined) window.clearTimeout(retryTimerRef.current);
      return;
    }
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
        // Exponential backoff with jitter: a server that just refused is
        // unlikely to answer differently a millisecond later, and hammering
        // it makes it worse.
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
  }, [effectiveLayout, loadPage, loadedPages, neighbourIndexes, prefetchDistance, releasePage, retryTick, visibleIndexes, webtoonFirst, webtoonLast, pageActive]);

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
      // The first measurement is the page's geometry for the rest of the session.
      // An enhanced rendition is the same picture at up to twice the pixels, so
      // letting it redefine the size would redraw the page larger — and a reader
      // who was zoomed in would watch the magnification change the moment
      // inference finished.
      if (current.has(index)) return current;
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
  useEffect(() => { if (pageActive) rootRef.current?.focus({ preventScroll: true }); }, [pageActive]);

  useEffect(() => {
    if (!pageActive || !autoPlay) return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') move('next'); }, 5000);
    return () => window.clearInterval(timer);
  }, [autoPlay, effectiveLayout, state.direction, state.layout, pageActive]);

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
    const width = rootBox().width;
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
    const width = rootBox().width;
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
    // 和鼠标那条同一件事：面板开着的时候整个画布手势都让开（含下面那次
    // `setHover(undefined)`），指针只属于面板那一层。
    if (thumbnailPanelOpen) return;
    setHover(undefined);
    if (sliding.current) return;
    if ((event.target as Element).closest('button, a, input, .reader-chrome, .reader-overview, .reader-overview-backdrop')) return;
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
  }, [thumbnailPanelOpen]);

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
      const box = rootBox();
      setZoom(panZoom(anchored, (first.clientX + second.clientX) / 2 - pinch.x, (first.clientY + second.clientY) / 2 - pinch.y, box.width, box.height));
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
    // 面板那一层（蒙版 + 面板体）是自己的，不是画布：落在它上面的按下不开始画布手势。
    // `.reader-overview` 只匹配面板体，蒙版得自己列出来。
    if ((event.target as Element).closest('button, a, input, .reader-chrome, .reader-overview, .reader-overview-backdrop')) return;
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
    // 缩略面板是压在阅读器上的一层。它在的时候指针既不该唤出/切换两条栏，也不该开始
    // 画布手势：hover 判定只认指针坐标（蒙版挡不住一个 mouseMove），曾经因此能从蒙版
    // 上把底栏划出来、顺带把亮着的顶栏撤掉。面板自己内部的滚动/点击不受影响。
    if (thumbnailPanelOpen) return;
    if (!event.buttons) setHover(hoverTarget(event));
    if (panStart.current && event.buttons === 1) { dragZoom(event.clientX, event.clientY); return; }
    const start = pointerStartRef.current;
    if (!start || event.buttons !== 1) return;
    trackDrag(event.clientX - start.x, event.clientY - start.y, Date.now() - start.time);
  }, [hoverTarget, setHover, trackDrag, thumbnailPanelOpen]);

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
    // The threshold sits just above a resting finger's jitter.
    gestureMovedRef.current = Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP;
    if (zoomScaleRef.current > 1 || layoutRef.current === 'webtoon') return;
    if (Math.abs(dx) <= Math.abs(dy)) { finishDrag(0, 0); return; }
    // A drag is a page turn, not a chrome toggle.
    dragPagedRef.current = true;
    finishDrag(dx, Date.now() - start.time);
  }, []);

  /** 连续阅读的滚动：一帧只认一次。
   *
   * 每次 scroll 事件都 setState 意味着一条惯性滚动会连着渲染几十次，而窗口（`first`
   * 与 `last` 两个页号）在一帧里只可能有一个答案。位置先记进 ref，帧回调再写 state；
   * 同一帧里后来的事件只是覆盖那个数，不再各自排一次渲染。 */
  const webtoonOffsetRef = useRef(0);
  const webtoonScrollFrameRef = useRef<number>();
  const handleWebtoonScroll = useCallback((event: UIEvent<HTMLElement>) => {
    webtoonScrolledRef.current = true;
    webtoonOffsetRef.current = event.currentTarget.scrollTop;
    if (webtoonScrollFrameRef.current !== undefined) return;
    webtoonScrollFrameRef.current = requestAnimationFrame(() => {
      webtoonScrollFrameRef.current = undefined;
      setScrollTop(webtoonOffsetRef.current);
    });
  }, []);
  useEffect(() => () => {
    if (webtoonScrollFrameRef.current !== undefined) cancelAnimationFrame(webtoonScrollFrameRef.current);
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

  // The reader route has no app title bar, so on Windows it carries its own
  // window maximize control, top-right — rendered only inside the chrome
  // header, so an unobstructed read never shows window chrome over the page.
  // 方框走 lucide 的 `Square`/`Copy`（墨色 18/24 与 20/24），和这一排的
  // LayoutGrid/Settings 同一档。外壳标题栏那套 `WindowGlyph` 的方框画在 12/24，
  // 放进阅读器顶栏只有邻居的一半大——「顶栏的最大化按钮尺寸太小」说的就是它
  // （caption 那一排自己的尺寸不动：改了共享字形，那边一分一厘都跟着失衡）。
  const windowApi = useWindowControls();
  const windowMaximized = useWindowMaximized(windowApi);
  // 阅读模式是整屏的：Windows 上系统边框关掉了，而自绘标题栏（唯一能拖窗口的
  // 地方）被这一屏盖住，所以顶栏自己得会拖（用户报的那一条）。
  const windowDrag = useWindowDrag();
  const renderWindowMaximize = () => windowApi ? (
    <button
      type="button"
      className="reader-icon-button reader-chrome-window"
      aria-label={windowMaximized ? '还原窗口' : '最大化窗口'}
      title={windowMaximized ? '还原窗口' : '最大化窗口'}
      onClick={(event) => { event.stopPropagation(); void windowApi.toggleMaximize().catch(() => {}); }}
    >{windowMaximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}</button>
  ) : null;
  /** The bottom bar is three slots: how the pages are arranged, where the reader
   * is, and what is done to the page. 自动翻页 belongs with neither side of that
   * split, so it rides on whichever side has *less* in it: the left slot always
   * holds two (布局、方向), the right slot holds as many as the configured
   * enhancement toggles — so with none or one of them the right side is the empty
   * one, and with two or three the left side is. Counting instead of asking
   * 「有没有超分」 matters: one configured toggle would still leave the left side
   * heavier by a button (user report:「如果用户没有开启超分相关功能，则重新排布
   * 尽量让左右两侧视觉重心一致」). */
  const enhancementCount =
    Number(Boolean(upscale?.configured)) + Number(Boolean(decensor?.configured)) + Number(Boolean(dlssnr?.configured));
  const autoPlayJoinsProcessing = enhancementCount < 2;
  const autoPlayControl = (
    <button type="button" aria-label={autoPlay ? '停止自动翻页' : '自动翻页'} aria-pressed={autoPlay} onClick={() => setAutoPlay((value) => !value)}>{autoPlay ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</button>
  );
  /** The Readoshi page pill: what is on screen and out of how many, spread
   * ranges joined with an en dash. It sits outside the auto-hiding chrome so
   * the number survives immersive reading, and ignores the pointer entirely
   * so a tap meant for the page never lands on it. */
  const indicatorIndexes = effectiveLayout === 'webtoon' ? [webtoonAnchor] : visibleIndexes;
  const shownIndexes = (indicatorIndexes.length > 0 ? indicatorIndexes : [state.pageIndex]).filter((index) => index >= 0 && index < pages.length);
  const pageIndicator = pages.length === 0 ? '' : `${shownIndexes.map((index) => index + 1).join('–')} / ${pages.length}`;
  /** The pill avoids the page the way Readoshi's did: it rests in the bottom
   * letterbox when the image fills the width (top/bottom gaps), drops to the
   * bottom-right corner when the image fills the height (side gaps), and fades
   * out entirely in continuous mode or while zoomed — zooming back to 100%
   * brings it back. Measured off the real images: object-fit means the drawn
   * rect is the element's own.
   *
   * When even the corner still sits on the artwork (the image covers the
   * bottom-right too), no placement can be clear — Readoshi's answer is
   * overlap detection: the pill then only flashes after a page turn and goes
   * quiet until the next one. */
  const [indicatorPlacement, setIndicatorPlacement] = useState<'bottom' | 'corner'>('bottom');
  const [indicatorOverlaps, setIndicatorOverlaps] = useState(false);
  const [indicatorFlash, setIndicatorFlash] = useState(true);
  useEffect(() => {
    if (effectiveLayout === 'webtoon' || zoom.scale > 1 || pages.length === 0) return;
    // Retained readers keep their panels mounted, so every query scopes to this
    // screen's own root — document-level selectors would measure another
    // reader's hidden pill and images.
    const root = rootRef.current;
    const measure = () => {
      const images = Array.from(root?.querySelectorAll<HTMLElement>('.reader-frame[aria-label="分页阅读"] img') ?? []);
      let union: DOMRect | undefined;
      for (const image of images) {
        const rect = image.getBoundingClientRect();
        if (rect.width <= 0) continue;
        union = union ? new DOMRect(Math.min(union.x, rect.x), Math.min(union.y, rect.y), Math.max(union.right, rect.right) - Math.min(union.x, rect.x), Math.max(union.bottom, rect.bottom) - Math.min(union.y, rect.y)) : rect;
      }
      if (!union) return;
      const bottomGap = window.innerHeight - union.bottom;
      setIndicatorPlacement(bottomGap >= 44 ? 'bottom' : 'corner');
      // Overlap is the pill's own rect (whatever placement it settled into —
      // the settle pass below runs after the placement transition) against the
      // drawn image union.
      const pill = root?.querySelector('.reader-page-indicator');
      if (!pill) return;
      const rect = pill.getBoundingClientRect();
      setIndicatorOverlaps(rect.left < union.right && rect.right > union.left && rect.top < union.bottom && rect.bottom > union.top);
    };
    // Two passes: the zoom reset eases the image back over 140ms, so a single
    // frame after the state flip still reads the shrinking rect, and the pill
    // itself slides between placements over ~200ms. A third watch: pages grow
    // to their real size as their images finish loading, which fires this
    // observer — without it the first pass measured an empty slot and the
    // placement stayed stale until the next turn.
    const frame = requestAnimationFrame(measure);
    const settle = window.setTimeout(measure, 240);
    // The img element is what actually resizes when a page finishes loading
    // (its box is the drawn object-fit rect; frames and the track stay
    // viewport-sized), so the observer watches the page images themselves.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (observer && root) for (const img of root.querySelectorAll('.reader-frame img')) observer.observe(img);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); observer?.disconnect(); };
  }, [effectiveLayout, pages.length, viewport.width, viewport.height, visibleIndexes, zoom.scale]);
  // Every page turn re-shows the pill for a moment. Where it rests in a
  // letterbox this changes nothing (it is persistent anyway); over the artwork
  // it is exactly Readoshi's brief flash, after which the pill goes quiet.
  useEffect(() => {
    setIndicatorFlash(true);
    const timer = window.setTimeout(() => setIndicatorFlash(false), INDICATOR_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [state.pageIndex]);
  // The bottom bar answers every page turn (see `reader-toolbar-turn` in
  // reader.css). The cue is a keyed child, not a class or an attribute: React
  // remounting the node is what restarts a CSS animation. Alternating an
  // attribute value looks like it should work and does not — measured in
  // debug_outputs/reader-motion, where the second value ran no animation at all.
  const previousPage = useRef(state.pageIndex);
  const [turnCue, setTurnCue] = useState(0);
  useEffect(() => {
    if (previousPage.current === state.pageIndex) return;
    previousPage.current = state.pageIndex;
    setTurnCue((value) => value + 1);
  }, [state.pageIndex]);
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

  /** 每页的显示尺寸：自然尺寸 contain 进它所在的那一格。
   *
   * 两张表按「这一格站几页」分：单页那一格的宽度是整个视口，双页那一格是半个。
   * 表本身 memo 过，所以翻页时尺寸对象只有真的换了才换——`ReaderPageImage` 是
   * `memo` 的，靠这一点把每次翻页的重渲染收在真正变了的那一两页上。 */
  const fitSizes = useMemo(() => {
    const single = new Map<number, { width: number; height: number }>();
    const pair = new Map<number, { width: number; height: number }>();
    const webtoon = effectiveLayout === 'webtoon';
    // 连续滚动里高度不设限：宽度贴满那一列，高度由比例定，槽位高度用的也是这个式子。
    const singleBox = webtoon
      ? { width: webtoonSlotWidth, height: Number.POSITIVE_INFINITY }
      : { width: viewport.width, height: viewport.height };
    const pairBox = { width: viewport.width / 2, height: viewport.height };
    // 只遍历量过的页：没量到的页没有可算的尺寸，遍历整本只是白走一遍。
    for (const [index, natural] of pageSizes) {
      const one = fitPageSize(natural, singleBox);
      if (one) single.set(index, one);
      if (webtoon) continue;
      const two = fitPageSize(natural, pairBox);
      if (two) pair.set(index, two);
    }
    return { single, pair };
  }, [effectiveLayout, pageSizes, viewport.height, viewport.width, webtoonSlotWidth]);

  /** One page: the image, or why it is not there yet. Always a slot, even when
   * empty — a spread whose halves appeared one at a time used to re-centre when
   * the second arrived, shifting the page under the reader's eyes. */
  const renderSlot = (index: number, pagesInSlot = 1) => {
    const source = derivedPages?.get(index) ?? loadedPages[index];
    // Whatever rendition is on screen, the page draws at the size its first
    // measurement established: an enhanced page must not be drawn larger than the
    // plain one it replaced (see `.reader-page` in reader.css).
    const size = (pagesInSlot > 1 ? fitSizes.pair : fitSizes.single).get(index);
    // `decoding="async"` 与「先解码再换」都在 ReaderPageImage 里：默认的 `auto` 允许"下一
    // 帧就要画它"时在主线程上同步解一张几百万像素的页图，而这一刻屏幕上往往正转着加载圈
    // ——它就是主线程画的。
    return (
      <div className="reader-slot" key={index}>
        {source
          ? <ReaderPageImage index={index} source={source} size={size} onMeasured={measurePage} onDisplayed={onDerivedDisplayed} />
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
        // 缩略面板开着时，关它是面板外面那一层的事：这一次点击只关面板，不顺手把
        // chrome 翻一遍（否则点一次空白会同时收起面板和两条栏）。
        if (thumbnailPanelOpen) return;
        // Showing is restricted to the top and bottom bands, so a tap in the
        // middle of a page cannot flash the bars over what is being read. Hiding
        // is not: the bars swallow their own clicks, so if only the bands
        // dismissed there would be nowhere left to press.
        // 这一句的判断与唤出/收起原来一模一样，只是整段搬到了 `useReaderChrome`
        // （加载态那条顶栏也要同一套，所以不能只留在这一个组件里）。
        handleCanvasClick(event);
      }}
      onDoubleClick={() => { if (effectiveLayout !== 'webtoon') setZoom((current) => toggleDoubleTapZoom(current)); }}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
        onPointerDown={(event) => {
          // 捕获画布上的按下是为了拖拽翻页。可是一旦抓住，Chromium 会把随后的 click
          // 改派给被捕获的 <main>——蒙版自己的 onClick 就永远收不到，面板的「点空白
          // 关闭」因此失效。面板那一层不参与画布手势，也就不该被捕获；输入框同理。
          if (event.pointerType === 'mouse' && event.button === 0 && !(event.target as Element).closest('button, a, input, .reader-overview, .reader-overview-backdrop')) event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerCancel={cancelGesture}
        onPointerUp={(event) => { if (event.pointerType === 'mouse') handleMouseUp(event); }}
        onLostPointerCapture={() => { if (pointerStartRef.current || panStart.current) cancelGesture(); }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      // Pointer capture keeps delivering the gesture after the cursor leaves the
      // canvas. Do not clear the start point here: doing so made a normal edge
      // drag cancel halfway through and made the release look like a jump.
      onMouseLeave={() => { clearHover(); if (!pointerStartRef.current && !panStart.current && drag) finishDrag(0, 0); }}
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
        <div ref={trackRef} className={`reader-track${drag || panning ? ' is-moving' : ''}`} style={dragStyle}>
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
                  {indexes.map((index) => renderSlot(index, indexes.length))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Two bars, two directions. They used to be one animated element, so the
          bottom bar slid in from the top of the screen — which is where it does
          not live. 出入场是纯 CSS（见 reader.css 那四条 keyframes），只留一个
          「播完再摘」的延迟状态；`motion` 的两条淡入淡出不值一个动画运行时。 */}
      <div className="reader-chrome">
        {(effectiveLayout === 'webtoon' ? [webtoonAnchor] : visibleIndexes).some((index) => derivingPages?.has(index)) && (
          <p className="reader-deriving" role="status"><LoadingIndicator label={derivingLabel} size="sm" inline />{derivingLabel}</p>
        )}
        {topPresence.mounted && (
          <header
            className={`reader-chrome-top${topPresence.leaving ? ' is-leaving' : ''}`}
            onClick={stopChromeToggle}
            {...windowDrag}
          >
              <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
            {/* 标题是这条栏的**直接**子项，才落得进中间那条轨道（相对整条栏居中，
                而不是相对返回按钮之后的剩余空间）。尾部控件自己一格。 */}
            <strong>{title}</strong>
            <div className="reader-chrome-actions">
              {incognito && <span className="reader-incognito-badge" title="无痕阅读：不记录进度与历史"><EyeOff aria-hidden="true" />无痕</span>}
              {renderWindowMaximize()}
            {/* 缩略面板从底栏挪上来：它是「这块档案」的一件事，和返回、标题、阅读
                设置同一层；底栏留给翻页与画面处理。 */}
              <button className="reader-icon-button reader-chrome-thumbnails" type="button" aria-label="缩略面板" aria-pressed={thumbnailPanelOpen} onClick={() => setThumbnailPanelOpen((value) => !value)}><LayoutGrid aria-hidden="true" /></button>
              <Link className="reader-icon-button reader-chrome-settings" to="/settings?section=reading" aria-label="阅读设置" title="阅读设置"><Settings aria-hidden="true" /></Link>
            </div>
          </header>
        )}
        {bottomPresence.mounted && (
          <div
            className={`reader-toolbar${bottomPresence.leaving ? ' is-leaving' : ''}`}
            role="toolbar"
            aria-label="阅读控制"
            onClick={stopChromeToggle}
          >
              {/* Re-mounted on every page turn: that is what replays the cue. */}
              {turnCue > 0 && <span key={turnCue} className="reader-toolbar-turn" aria-hidden="true" />}
              {/* Three slots, left to right: how the pages are arranged, where the
                  reader is, what is done to the page. The counter is the middle
                  slot by grid position, not by luck — the sides are equal `1fr`
                  tracks, so it stays centred whatever the two sides hold. */}
              <div className="reader-toolbar-group reader-toolbar-layout"><button type="button" aria-label={`阅读布局：${READER_LAYOUT_LABELS[state.layout]}，点击切换`} title={`阅读布局：${READER_LAYOUT_LABELS[state.layout]}`} onClick={() => setState((current) => ({ ...current, layout: nextReaderLayout(current.layout) }))}>
                {state.layout === 'auto' ? <Wand2 aria-hidden="true" /> : state.layout === 'single' ? <RectangleVertical aria-hidden="true" /> : state.layout === 'double' ? <BookOpen aria-hidden="true" /> : <GalleryVertical aria-hidden="true" />}
              </button>
              {/* One control, cycling 自动 → 单页 → 双页 → webtoon. Three separate
                  buttons spent three toolbar slots to express one choice, and
                  none of them could select 自动 once you left it.
                  No `aria-pressed` on direction either: it is a choice between
                  two, not a switch that is on, and the pressed styling made the
                  button look permanently hovered whenever the answer was
                  right-to-left. */}
              <button type="button" aria-label={state.direction === 'ltr' ? '从左到右' : '从右到左'} onClick={() => setState((current) => ({ ...current, direction: current.direction === 'ltr' ? 'rtl' : 'ltr' }))}>{state.direction === 'ltr' ? <ArrowRightToLine aria-hidden="true" /> : <ArrowLeftToLine aria-hidden="true" />}</button>
              {!autoPlayJoinsProcessing && autoPlayControl}</div>
              <div className="reader-toolbar-group reader-toolbar-pages">
                <button type="button" aria-label="上一页" onClick={() => move('previous')}><ChevronLeft aria-hidden="true" /></button>
                <span>{pages.length === 0 ? '0 / 0' : `${state.pageIndex + 1} / ${pages.length}`}</span>
                <button type="button" aria-label="下一页" onClick={() => move('next')}><ChevronRight aria-hidden="true" /></button>
              </div>
              <div className="reader-toolbar-group reader-toolbar-processing">
              {/* The two derived renditions, switchable from here. Both were
                  settings-only, so there was no way to see what either one did to
                  the page you were looking at. 全屏/退出全屏 去过这里：它和顶栏的
                  最大化窗口长着同一枚方形图标，被当成重复的那一颗，而顶栏那颗
                  本来就在（见 reader.css 那两条栏的注释）。 */}
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
              {dlssnr?.configured && (
                <button type="button" aria-pressed={dlssnr.active} aria-label={dlssnr.active ? '关闭 DLSSNR' : '开启 DLSSNR'} title="DLSSNR" onClick={dlssnr.toggle}><DlssnrIcon /></button>
              )}
              {autoPlayJoinsProcessing && autoPlayControl}
              </div>
          </div>
        )}
      </div>
      {thumbnailPanelOpen && (
        /* Centred overlay rather than a side drawer: it doubles as the archive
           overview (cover, size, tags) plus the page grid. Clicking the blank
           around the panel closes it, and that click has to stop here — main's
           own onClick would otherwise toggle the chrome behind the panel in the
           same dispatch. */
        <div
          className="reader-overview-backdrop"
          onClick={(event) => { event.stopPropagation(); setThumbnailPanelOpen(false); }}
        >
          <ArchiveOverviewPanel
            title={title}
            pageCount={pages.length}
            cover={info?.cover}
            sizeBytes={info?.sizeBytes}
            tags={info?.tags}
            currentPage={state.pageIndex}
            thumbnailAt={(index) => thumbnails.get(index) ?? loadedPages[index]}
            onSelectPage={(index) => { jumpToPage(index); setThumbnailPanelOpen(false); }}
            onClose={() => setThumbnailPanelOpen(false)}
            onPanelClick={stopChromeToggle}
          />
        </div>
      )}
      {pages.length > 0 && (() => {
        // Overlapping artwork + flash expired → the pill goes quiet until the
        // next page turn; letterbox placements stay persistent as before.
        const placement = effectiveLayout === 'webtoon' || zoom.scale > 1 || (indicatorOverlaps && !indicatorFlash)
          ? 'hidden'
          : indicatorPlacement;
        return (
          <div
            className={`reader-page-indicator${bottomChromeVisible ? ' is-raised' : ''}`}
            data-placement={placement}
            aria-hidden="true"
          >{pageIndicator}</div>
        );
      })()}
    </main>
  );
}
