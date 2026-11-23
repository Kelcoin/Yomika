import { ReaderTitle } from './ReaderTitle';
import { StateIcon } from './StateIcon';
import { ReaderSettingsPause, usePageActive } from '../app/RetainedPage';
import { ArrowLeft, ArrowRight, BookOpen, Copy, EyeOff, File, GalleryVerticalEnd, LogOut, RotateCcw, ScanText, Settings, Square } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, Fragment, memo, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject, type TouchEvent, type UIEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { flushSync } from 'react-dom';

import { advanceReader, classifyPageShape, createReaderState, createZoomState, boundLargeImageZoom, doubleTapZoomAt, readerDoubleTapProfile, effectiveReaderLayout, fitPageSize, getPrefetchPages, getVisiblePageIndexes, nextReaderLayout, READER_LAYOUT_LABELS, resolveReaderLayout, settleZoom, pageTurnDuration, shouldCommitPageTurn, toggleReaderChrome, WEBTOON_ESTIMATED_PAGE_RATIO, webtoonPageOffsets, webtoonWindow, zoomByWheel, type ReaderLayoutPreference, type ReadingDirection, type ZoomState } from '../domain/reader';
import { elasticPinchScale, panZoom, zoomAtPoint } from '../domain/reader';
import { ArchiveOverviewPanel } from './ArchiveOverviewPanel';
import { DlssnrIcon } from './DlssnrIcon';
import { SvgIcon } from './SvgIcon';
import { UpscaleIcon } from './UpscaleIcon';
import { LoadingIndicator } from './LoadingIndicator';
import { useWindowControls, useWindowDrag, useWindowMaximized } from './WindowControls';
import { getPlatformCapabilities, setStatusBarVisible } from '../bridge/platform';
import { decodeImageElementStrict } from '../lib/decodeImage';
import { logError } from '../lib/errorLog';
import { hapticFeedback } from '../lib/haptics';
import { isIosBackEdge } from '../lib/layoutMode';
import { EDGE_SETTLE_EASING, EDGE_SETTLE_MS, rubberBand } from '../lib/motion';
import { ThumbnailScheduler } from '../lib/thumbnailScheduler';
import { useDelayedUnmount } from '../lib/useDelayedUnmount';
import { COARSE_POINTER_QUERY } from '../lib/horizontalScroller';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useReturnNavigation } from '../lib/useReturnNavigation';
import { allocateNativeReaderSession, configureNativePinchInput, configureNativeContinuousInput, repositionNativeContinuousInput, trackNativeContinuousInput, NativeReaderSession, canPresentNativePage, hasNativeReaderTiles, hasNativeWheelZoom, sampleNativeWheelZoom, invalidateContinuousReaderLayout, hasAndroidReaderTileSource, ReaderTileSlot, readerUsesShellGestures, rememberNativeReaderZoom, requestNativeReaderDoubleTap, requestNativeReaderViewport, settleNativeReaderFitForTurn, updateNativeReaderEdge, updateNativeReaderSlide, updateNativeReaderTransform, type ReaderTileViewport, type ReaderTilePageSize, type WheelZoomSample } from '../lib/readerNativeTiles';
import { useReaderImageHandover } from '../lib/useReaderImageHandover';

/** Pages kept beyond the fetch window. Three either side covers stepping back
 * over a spread without a refetch, and costs a handful of blob URLs. */
const PAGE_RETENTION_MARGIN = 3;
/** Attempts before a page is left alone. */
const MAX_PAGE_LOAD_ATTEMPTS = 3;
const LARGE_READER_TEXTURE_PIXELS = 8_000_000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const DISTANT_PREFETCH_IDLE_MS = 120;
const NEIGHBOUR_DECODE_IDLE_MS = 64;
const AUTO_TURN_INTERVAL_MS = 5_000;
/** Height of the bands at the top and bottom of the canvas that summon the
 * chrome. A tap anywhere used to raise the bars over what was being read; the
 * bands sit where the bars themselves appear, so the target is where the result
 * will be. */
const CHROME_BAND_HEIGHT = 160;
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

const PAGE_SWIPE_MAX_ZOOM = 1.04;

function lastPageExitDistance(width: number): number {
  return Math.min(210, Math.max(80, width * 0.23));
}

/** 共享件里的指针事件只用到坐标、`target` 和「别冒泡」，所以按最宽的 `Element` 收：
 * 这样同一份处理器也能交给 `ArchiveOverviewPanel`（它的 `onPanelClick` 就是这个类型），
 * 不必为每一层各自包一层。 */
type ChromePointerEvent = Pick<MouseEvent<Element>, 'clientY' | 'target' | 'stopPropagation'>;

export interface ReaderChromeOptions {
  /** 画布元素；感应带按它的盒子算。 */
  rootRef: RefObject<HTMLElement | null>;
  /** 权威可见性：来自状态机，或加载态自己的状态。 */
  visible: boolean;
  /** 页面在前台时才走自动隐藏（保留页留在后台时不该自己走表）。 */
  active: boolean;
  /** 临时挂起：指针判定与自动隐藏都让位（缩略面板压在上面时）。 */
  suspended?: boolean;
  /** 唤出时只点亮落点那一侧（用户报的「点一侧触发两侧」）。只有两条栏都在的实现能
   *  这么干：加载态那层只有顶栏一条，点哪儿都该把它叫出来，所以那边不传。 */
  pinTappedBand?: boolean;
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
export function useReaderChrome({ rootRef, visible, active, suspended = false, pinTappedBand = false, onToggle, onHide }: ReaderChromeOptions): ReaderChrome {
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
  const [tappedBands, setTappedBands] = useState({ top: false, bottom: false });
  useEffect(() => {
    if (!visible || !active) setTappedBands(current => current.top || current.bottom ? { top: false, bottom: false } : current);
    if (!active) setHover(null);
  }, [visible, active, setHover]);
  const keepAlive = useCallback((event: ChromePointerEvent) => {
    event.stopPropagation();
    setKeepAliveToken((value) => value + 1);
  }, []);

  // 定时器和点击回调要拿到**当下**的 onToggle/onHide：调用方每次渲染都会传新函数，
  // 而 4.5s 后才响的定时器不该拿着 4.5s 前那份闭包去改状态。
  const callbacksRef = useRef({ onToggle, onHide });
  callbacksRef.current = { onToggle, onHide };

  useEffect(() => {
    if (!active || (!visible && !hoverChrome) || suspended) return undefined;
    const timer = window.setTimeout(() => {
      // 钉住的那一侧比 `visible` 强势（见下面 topChromeVisible 的算法），自动收起时
      // 不把意见清掉，被钉住的那条栏就再也摘不下来。
      setHover(null);
      setTappedBands({ top: false, bottom: false });
      callbacksRef.current.onHide();
    }, CHROME_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [active, keepAliveToken, setHover, suspended, visible, hoverChrome]);

  const handleCanvasClick = useCallback((event: ChromePointerEvent) => {
    const side = hoverTarget(event);
    if (pinTappedBand) {
      if (!visible && side === null) return;
      const next = side === null ? { top: false, bottom: false }
        : { ...(visible ? tappedBands : { top: false, bottom: false }), [side]: !visible || !tappedBands[side] };
      setTappedBands(next);
      setHover(undefined);
      setKeepAliveToken((value) => value + 1);
      if (visible !== (next.top || next.bottom)) callbacksRef.current.onToggle();
      return;
    }
    if (!visible) {
      // 栏藏着时只有点在上下感应带里才算唤出，画面中部留给翻页。
      if (side === null) return;
      setHover(undefined);
      setKeepAliveToken((value) => value + 1);
      callbacksRef.current.onToggle();
      return;
    }
    setHover(null);
    callbacksRef.current.onToggle();
  }, [hoverTarget, pinTappedBand, setHover, visible, tappedBands]);

  const clearHover = useCallback(() => setHover(null), [setHover]);

  // `undefined` 是「指针还没给过意见」（听权威可见性），`null` 是「指针已经在画面中部 /
  // 离开了画布」（两条栏都收）——两者不能合并。
  const hasTappedBand = tappedBands.top || tappedBands.bottom;
  const topChromeVisible = active && (pinTappedBand && visible && hasTappedBand ? tappedBands.top : hoverChrome === undefined ? visible : hoverChrome === 'top');
  const bottomChromeVisible = active && (pinTappedBand && visible && hasTappedBand ? tappedBands.bottom : hoverChrome === undefined ? visible : hoverChrome === 'bottom');
  const topPresence = useDelayedUnmount(topChromeVisible, CHROME_EXIT_MS);
  const bottomPresence = useDelayedUnmount(bottomChromeVisible, CHROME_EXIT_MS);
  useEffect(() => {
    if (!active) return;
    void setStatusBarVisible(topPresence.mounted);
  }, [active, topPresence.mounted]);
  useEffect(() => active ? () => { void setStatusBarVisible(true); } : undefined, [active]);

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
  readerSession?: number;
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
  /** Reader-side switches for the derived renditions, so their effect can be
   * seen on the page in front of you instead of only in settings. */
  upscale?: EnhancementSwitch | undefined;
  dlssnr?: EnhancementSwitch | undefined;
  /** Bumped by the caller when what `loadPage` would return has changed — a
   * switch above, for instance. Every loaded page is dropped and the window
   * refetched; without it a toggle changed nothing already on screen. */
  reloadToken?: number;
  /** Enhanced renditions by page index. They arrive after the plain page and take
   * its place in the same slot, so nothing about the view changes but the `src` —
   * which is what keeps the zoom from being thrown away mid-read. */
  derivedPages?: ReadonlyMap<number, string> | undefined;
  /** Pages the caller is deriving right now (upscale / DLSSNR). On CPU a page
   * takes seconds — a 1248×1416 with both models runs ~20 — and until now nothing
   * on screen said so: press a switch, see nothing, and the feature reads as
   * broken even though it is working. The pill is that missing sentence. */
  derivingPages?: ReadonlySet<number> | undefined;
  /** What to call the wait: `超分处理中…`, `DLSSNR 处理中…`, …. */
  derivingLabel?: string | undefined;
  /** The pages actually on screen, so the caller can enhance those and not the
   * whole prefetch window. */
  onVisiblePages?: ((indexes: readonly number[]) => void) | undefined;
  onDerivedDisplayed?: ((pageIndex: number, url: string) => void) | undefined;
  onDerivedRejected?: ((pageIndex: number, url: string) => void) | undefined;
}

/** Why a page is not on screen yet: still coming, or given up on.
 *
 * These used to share a branch — anything not yet loaded rendered as "页面加载
 * 失败" — which is why turning a page announced a failure and then quietly
 * showed the page. They are now distinct, and a page is only called failed once
 * its retries are actually spent. */
/** 一页的图：换 `src` 之前先把新图解好。
 *
 * `<img>` 换 `src` 的那一帧，浏览器会先把旧图扔掉——旧图 → 空 → 新图。超分/DLSSNR 算完正好
 * 是这个动作（同一页从原图换成处理过的图），中间那一帧空档在阅读器的深色底上就是用户看到
 * 的黑闪。所以这里保留正在显示的那一张，新图 `decode()` 完了再换（见 `lib/decodeImage`）。
 *
 * 包在 `memo` 里：翻一页只该动那一页的图。三个帧（上一页 / 这一页 / 下一页）都在同一个
 * 树里，不拦一下就是每次翻页把三张图的元素与内联样式重新算一遍。
 */
const ReaderPageImage = memo(function ReaderPageImage({ tileEnabled, tileCurrent, tileVisible, continuous, tileTurnTargets, index, source, fitWidth, fitHeight, onMeasured, onDisplayed, onFailed, onRejected, handoverPaused, canPromote, readDomViewport, applyNativeViewport }: {
  tileEnabled: boolean;
  tileCurrent: boolean;
  tileVisible: boolean;
  continuous: boolean;
  tileTurnTargets?: { left: number; right: number; reduceMotion: boolean } | undefined;
  index: number;
  source: string;
  fitWidth?: number | undefined;
  fitHeight?: number | undefined;
  onMeasured: (index: number, image: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>) => void;
  onDisplayed?: ((index: number, url: string) => void) | undefined;
  onFailed: (index: number, url: string) => void;
  onRejected: ((index: number, url: string) => void) | undefined;
  handoverPaused: boolean;
  canPromote: () => boolean;
  readDomViewport: (image: HTMLImageElement) => ReaderTileViewport | undefined;
  applyNativeViewport: (viewport?: ReaderTileViewport, element?: HTMLElement) => void;
}) {
  const session = useContext(NativeReaderSession);
  const [shown, setShown] = useState(source);
  const [nativeReady, setNativeReady] = useState<Record<string, { naturalWidth: number; naturalHeight: number }>>({});
  const [nativeFailed, setNativeFailed] = useState<Record<string, boolean>>({});
  const ready = tileEnabled ? nativeReady[shown] : undefined;
  const shownIsNative = tileEnabled && !nativeFailed[shown] && canPresentNativePage(shown);
  const canTransferNativeViewport = !continuous && tileEnabled && !nativeFailed[shown] && hasAndroidReaderTileSource(shown);
  const [admitted, setAdmitted] = useState(source);
  const [decoded, setDecoded] = useState<{ url: string; image: HTMLImageElement }>();
  // Only start new decode work while idle. An already mounted image keeps
  // its decode and DOM identity through a swipe or pinch.
  useEffect(() => {
    if (handoverPaused || !canPromote() || source === admitted) return;
    setDecoded(undefined);
    setAdmitted(source);
  }, [source, admitted, handoverPaused, canPromote]);
  const candidateRef = useRef<HTMLImageElement>(null);
  // Keep this same full-resolution image through gestures. Switching to a
  // reduced canvas changes halftone sampling even before the zoom moves.
  const displayedRef = useRef<HTMLImageElement>(null);
  const displayTimeout = useRef<number>();
  const loadedUrl = useRef<string>();
  const displayedFailed = useRef(false);
  const handover = useRef<{ url: string; image: HTMLImageElement }>();
  const nativePredecessor = useRef<string>();
  const retireAfterWebFrame = useCallback((url: string) => {
    if (nativePredecessor.current !== url) return false;
    nativePredecessor.current = undefined;
    return true;
  }, []);
  const callbacks = useRef({ onMeasured, onDisplayed, onFailed, onRejected });
  callbacks.current = { onMeasured, onDisplayed, onFailed, onRejected };
  useEffect(() => {
    const image = displayedRef.current;
    if (ready || loadedUrl.current === shown || (image?.complete && image.naturalWidth > 0)) return;
    displayTimeout.current = window.setTimeout(() => {
      if (loadedUrl.current === shown || (image?.complete && image.naturalWidth > 0)) return;
      if (shownIsNative) {
        setNativeFailed(current => ({ ...current, [shown]: true }));
        return;
      }
      displayedFailed.current = true;
      callbacks.current.onFailed(index, shown);
    }, PAGE_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(displayTimeout.current);
  }, [shown, index, ready, shownIsNative]);
  useEffect(() => {
    const candidate = candidateRef.current;
    if (admitted === shown) return;
    if (!candidate && tileEnabled && canPresentNativePage(admitted) && !nativeFailed[admitted] && !nativeReady[admitted]) {
      const timeout = window.setTimeout(() => {
        setNativeFailed(current => ({ ...current, [admitted]: true }));
      }, PAGE_LOAD_TIMEOUT_MS);
      return () => window.clearTimeout(timeout);
    }
    if (!candidate) return;
    let active = true;
    const failed = (error: unknown) => {
      if (!active) return;
      logError('reader/page-image', '替换图片解码失败', { page: index + 1, url: admitted, error: String(error), recovery: displayedFailed.current });
      if (displayedFailed.current) callbacks.current.onFailed(index, admitted);
      callbacks.current.onRejected?.(index, admitted);
    };
    const timeout = window.setTimeout(() => {
      failed(new Error('图片解码超时'));
      active = false;
    }, PAGE_LOAD_TIMEOUT_MS);
    void decodeImageElementStrict(candidate).then(() => {
      if (!active) return;
      window.clearTimeout(timeout);
      setDecoded({ url: admitted, image: candidate });
    }, (error) => {
      window.clearTimeout(timeout);
      failed(error);
    });
    return () => { active = false; window.clearTimeout(timeout); };
  }, [admitted, shown, index, tileEnabled, nativeFailed[admitted], nativeReady[admitted]]);
  useEffect(() => {
    if (handoverPaused || !canPromote() || !decoded || decoded.url !== source || decoded.image !== candidateRef.current) return;
    const commit = (viewport?: ReaderTileViewport) => {
      if (!canPromote() || decoded.image !== candidateRef.current) return;
      displayedFailed.current = false;
      loadedUrl.current = source;
      handover.current = decoded;
      nativePredecessor.current = (shownIsNative || canTransferNativeViewport) && tileVisible ? shown : undefined;
      if (viewport) applyNativeViewport(viewport, decoded.image);
      setShown(source);
      setDecoded(undefined);
    };
    if (canTransferNativeViewport && tileVisible) return requestNativeReaderViewport(index + 1, session, commit);
    commit();
  }, [source, handoverPaused, canPromote, decoded, shown, shownIsNative, canTransferNativeViewport, tileVisible, index, session, applyNativeViewport]);
  // Decode readiness does not mean the Android underlay is visible. Keep the
  // previous image mounted until the host acknowledges the new presentation.
  const nativeReplacementReady = tileEnabled && admitted === source && admitted !== shown &&
    canPresentNativePage(admitted) && Boolean(nativeReady[admitted]) && !nativeFailed[admitted];
  const presentingReplacement = tileVisible && !handoverPaused && canPromote() && nativeReplacementReady;
  useEffect(() => {
    // An offscreen page has no visible predecessor to retire. Arm its decoded
    // rendition now so the next native swipe and pinch use the same version.
    if (!tileVisible && nativeReplacementReady) setShown(admitted);
  }, [tileVisible, nativeReplacementReady, admitted]);
  useLayoutEffect(() => {
    if (!ready || !shownIsNative || loadedUrl.current === shown) return;
    loadedUrl.current = shown;
    displayedFailed.current = false;
    callbacks.current.onMeasured(index, ready);
    callbacks.current.onDisplayed?.(index, shown);
  }, [shown, index, ready, shownIsNative]);
  // Handle release belongs after the DOM commit that makes the candidate visible.
  useLayoutEffect(() => {
    const next = handover.current;
    if (!next || next.url !== shown) return;
    handover.current = undefined;
    callbacks.current.onMeasured(index, next.image);
    callbacks.current.onDisplayed?.(index, next.url);
  }, [shown, index]);
  const fitStyle = fitWidth !== undefined && fitHeight !== undefined
    ? { '--reader-page-fit-width': `${fitWidth}px`, '--reader-page-fit-height': `${fitHeight}px` } as CSSProperties
    : undefined;
  return <>{(admitted === shown ? [shown] : [shown, admitted]).map((url) => {
    const candidate = url !== shown;
    return <Fragment key={url}>
    {tileEnabled && !nativeFailed[url] && <ReaderTileSlot url={url} index={index}
      current={tileCurrent && !candidate}
      continuous={continuous}
      nativeOnly={canPresentNativePage(url)}
      committed={!continuous && canPresentNativePage(url) && !candidate}
      turnTargets={canPresentNativePage(url) && !candidate ? tileTurnTargets : undefined}
      present={canPresentNativePage(url) && tileVisible && (!candidate || presentingReplacement)}
      replacement={candidate}
      readViewport={candidate && !shownIsNative ? () => displayedRef.current ? readDomViewport(displayedRef.current) : undefined : undefined}
      retireAfterWebFrame={retireAfterWebFrame}
      onPresented={() => {
        if (candidate && presentingReplacement && canPromote()) {
          if (!shownIsNative && !readerUsesShellGestures()) applyNativeViewport();
          setShown(url);
        }
      }}
      onReady={(naturalWidth, naturalHeight) => setNativeReady(current => ({ ...current, [url]: { naturalWidth, naturalHeight } }))}
      onError={() => {
        // Let the candidate image decode through the compatibility renderer
        // while the original remains visible. Reject only if that also fails.
        setNativeFailed(current => ({ ...current, [url]: true }));
      }} />}
    {tileEnabled && canPresentNativePage(url) && !nativeFailed[url] ? <div
      role={candidate ? undefined : 'img'}
      aria-label={candidate ? undefined : `第 ${index + 1} 页`}
      aria-hidden={candidate || undefined}
      data-native-reader-visible={tileVisible && !candidate && Boolean(nativeReady[url]) || undefined}
      data-native-reader-ready={Boolean(nativeReady[url]) && !candidate || undefined}
    /> : <img
      ref={candidate ? candidateRef : displayedRef}
      draggable={false}
      className={`reader-page${candidate ? ' is-candidate' : ''}`}
      aria-hidden={candidate || undefined}
      alt={candidate ? '' : `第 ${index + 1} 页`}
      src={url}
      decoding="async"
      style={fitStyle}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (candidate) return;
        window.clearTimeout(displayTimeout.current);
        loadedUrl.current = url;
        onMeasured(index, image);
        onDisplayed?.(index, url);
      }}
      onError={(event) => {
        if (candidate) return;
        window.clearTimeout(displayTimeout.current);
        displayedFailed.current = true;
        const image = event.currentTarget;
        logError('reader/page-image', '阅读器的图片没加载出来', { page: index + 1, url, naturalWidth: image.naturalWidth, complete: image.complete });
        onFailed(index, url);
      }}
    />}
    </Fragment>;
  })}</>;

});

function PageStatus({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  // 同一个 M3 指示器，全应用只此一个；形状由 `.reader-page-status` 那几条规则收（去轨道、
  // 只留一段伸缩的弧，2026-10-16 起中间不再压 LOGO）。
  if (!failed) return <div className="reader-page-status"><LoadingIndicator /></div>;
  return (
    <div className="reader-page-status is-failed">
      <button type="button" className="reader-retry-button" aria-label="重试加载" onClick={(event) => { event.stopPropagation(); onRetry(); }}>
        <RotateCcw aria-hidden="true" />
      </button>
      <p role="alert">点击重新加载</p>
    </div>
  );
}

/** The window's own size, read synchronously: the first paint needs it to know
 * whether the viewport can hold a spread. */
function readViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

const ignoreStagedPageFailure = () => {};

type NativeSpreadSource = { urls: readonly [string, string]; aspect: number };

function NativeReaderSpread({ source, nativeTarget, indexes, rtl, visible, interactive, turnTargets, paused, canPromote, onMeasured, onDisplayed, onRejected, applyNativeViewport, fallback }: {
  source: NativeSpreadSource;
  nativeTarget: boolean;
  indexes: readonly [number, number];
  rtl: boolean;
  visible: boolean;
  interactive: boolean;
  turnTargets: { left: number; right: number; reduceMotion: boolean } | undefined;
  paused: boolean;
  canPromote: () => boolean;
  onMeasured: (index: number, size: ReaderTilePageSize) => void;
  onDisplayed: ((index: number, url: string) => void) | undefined;
  onRejected: ((index: number, url: string) => void) | undefined;
  applyNativeViewport: (viewport?: ReaderTileViewport, element?: HTMLElement) => void;
  fallback: (staging?: boolean) => React.ReactNode;
}) {
  const keyFor = (value: NativeSpreadSource) => JSON.stringify([value.urls, value.aspect, rtl]);
  const targetKey = keyFor(source);
  const [shown, setShown] = useState(source);
  const shownKey = keyFor(shown);
  const [ready, setReady] = useState<string[]>([]);
  const [failed, setFailed] = useState<string>();
  const targetReady = ready.includes(targetKey);
  const shownReady = ready.includes(shownKey);
  const [webDecoded, setWebDecoded] = useState<{ key: string; images: HTMLImageElement[] }>();
  const [usingWeb, setUsingWeb] = useState(!nativeTarget);
  const staging = !usingWeb && visible && (!nativeTarget || failed === targetKey) && shownKey !== targetKey;
  // Keep the original underlay while both mounted web images decode. The
  // same DOM nodes become visible when Android hands over the viewport.
  const webSpread = useRef<HTMLDivElement>(null);
  const retireNative = useRef(false);
  const retireAfterWebFrame = useCallback(() => retireNative.current, []);
  const session = useContext(NativeReaderSession);
  const [firstUrl, secondUrl] = source.urls;
  const [firstIndex, secondIndex] = indexes;
  const rejectChanged = useRef<() => void>();
  rejectChanged.current = () => {
    indexes.forEach((index, position) => {
      const url = source.urls[position];
      if (url && url !== shown.urls[position]) onRejected?.(index, url);
    });
  };
  useEffect(() => {
    if (!staging) {
      setWebDecoded(undefined);
      return;
    }
    const images = Array.from(webSpread.current?.querySelectorAll<HTMLImageElement>('img.reader-page:not(.is-candidate)') ?? []);
    if (images.length !== 2 || images[0]?.getAttribute('src') !== firstUrl || images[1]?.getAttribute('src') !== secondUrl) return;
    let active = true;
    const reject = () => {
      if (!active) return;
      active = false;
      rejectChanged.current?.();
    };
    const timeout = window.setTimeout(reject, PAGE_LOAD_TIMEOUT_MS);
    void Promise.all(images.map(decodeImageElementStrict)).then(() => {
      if (active) setWebDecoded({ key: targetKey, images });
    }, reject).finally(() => window.clearTimeout(timeout));
    return () => { active = false; window.clearTimeout(timeout); };
  }, [staging, targetKey, firstUrl, secondUrl]);
  useEffect(() => {
    if (!staging || webDecoded?.key !== targetKey || paused || !canPromote()) return;
    const commit = (viewport?: ReaderTileViewport) => {
      const spread = webSpread.current;
      if (!canPromote() || !spread || webDecoded.images.some(image => !spread.contains(image))) return;
      if (viewport && spread.parentElement) applyNativeViewport(viewport, spread.parentElement);
      retireNative.current = true;
      setUsingWeb(true);
    };
    if (!readerUsesShellGestures() && shownReady) return requestNativeReaderViewport(firstIndex + 1, session, commit);
    commit();
  }, [staging, webDecoded, targetKey, paused, canPromote, shownReady, firstIndex, session, applyNativeViewport]);
  const reportedWebHandover = useRef(false);
  useLayoutEffect(() => {
    if (!usingWeb || !retireNative.current || reportedWebHandover.current) return;
    reportedWebHandover.current = true;
    onDisplayed?.(firstIndex, firstUrl);
    onDisplayed?.(secondIndex, secondUrl);
    // Subsequent changes are reported by the mounted ReaderPageImage instances.
  }, [usingWeb, onDisplayed, firstIndex, firstUrl, secondIndex, secondUrl]);
  useEffect(() => {
    if (!usingWeb && !visible && targetReady && shownKey !== targetKey) setShown(source);
  }, [usingWeb, visible, targetReady, shownKey, targetKey, source]);
  useEffect(() => {
    if (usingWeb || !visible || !shownReady) return;
    indexes.forEach((index, position) => onDisplayed?.(index, shown.urls[position]!));
  }, [usingWeb, visible, shownReady, shownKey, indexes[0], indexes[1], onDisplayed]);
  if (failed === shownKey) return fallback();
  const versions = nativeTarget && targetKey !== shownKey && failed !== targetKey ? [shown, source] : [shown];
  return <>
    {!usingWeb && versions.map((value) => {
      const key = keyFor(value);
      const candidate = key !== shownKey;
      const [left, right] = rtl ? [value.urls[1], value.urls[0]] : value.urls;
      const present = visible && (!candidate || (targetReady && !paused && canPromote()));
      return <ReaderTileSlot key={key} url={left} spread={{ rightUrl: right, aspect: value.aspect }} index={indexes[0]}
        nativeOnly committed={!candidate} current={!candidate && interactive} turnTargets={!candidate ? turnTargets : undefined}
        present={present} replacement={candidate} retireAfterWebFrame={retireAfterWebFrame}
        onReady={(_width, _height, pages) => {
          if (!candidate && pages?.length === 2) {
            indexes.forEach((index, position) => onMeasured(index, pages[rtl ? 1 - position : position]!));
          }
          setReady((previous) => previous.includes(key) ? previous : [...previous.slice(-2), key]);
        }}
        onPresented={() => { if (candidate && present) setShown(value); }}
        onError={() => setFailed(key)} />;
    })}
    {!usingWeb && indexes.map((index) => <div key={index} role="img" aria-label={`第 ${index + 1} 页`}
      data-native-reader-ready={shownReady || undefined}
      data-native-reader-visible={visible && shownReady || undefined} />)}
    {(usingWeb || staging) && <div className="reader-spread-web" ref={webSpread}
      aria-hidden={staging || undefined} style={{ visibility: staging ? 'hidden' : undefined }}>
      {fallback(staging)}
    </div>}
  </>;
}

export function ReaderScreen({ readerSession, archiveId, title, pages, initialPage = 0, direction = 'ltr', layout = 'auto', loadPage, loadPageThumbnail, releasePage, onProgress, info, incognito = false, prefetchDistance = 1, upscale, dlssnr, reloadToken = 0, derivedPages, derivingPages, derivingLabel = '处理中…', onVisiblePages, onDerivedDisplayed, onDerivedRejected }: ReaderScreenProps) {
  const nativeSession = useMemo(() => readerSession ?? allocateNativeReaderSession(), [archiveId, readerSession]);
  const pageActive = usePageActive();
  const keepNativeSlots = useContext(ReaderSettingsPause) || pageActive;
  const { paused: handoverPaused, canPromote, pause: pauseHandover, resume: resumeHandover, setNativeBusy } = useReaderImageHandover(pageActive);
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  /** 手指点的设备：页码胶囊在手机上只走居中那一档（见下面量底缝的那一处）。
   *
   * 用的是 `horizontalScroller.ts` 里那一条（`(hover: none), (pointer: coarse)`），
   * 不是光一个 `(hover: none)`：这条判据在仓库里只留一份，理由是 Readoshi 那边就是
   * 这么写的（`ArchiveCard.jsx` 的 `getTouchScrollStyle` 用它分流滚轮与触摸），而两种
   * 写法在真机上确实分得出设备——有的触屏设备 `hover: none` 不成立但 `pointer: coarse`
   * 成立，反过来也有。分成两份写法时，横轨按一份分流、阅读器按另一份分流，同一台设备
   * 就会在两处得到不同的结论。 */
  const coarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
  const goBack = useReturnNavigation();
  const { pathname, search } = useLocation();
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
  // Saved progress can open on the second page of a spread. The native
  // surface is addressed by the first logical page, independent of RTL.
  const nativePage = (getVisiblePageIndexes(state)[0] ?? state.pageIndex) + 1;
  const nativePageRef = useRef(nativePage);
  nativePageRef.current = nativePage;
  const [loadedPages, setLoadedPages] = useState(() => {
    const loaded = new Map<number, string>();
    pages.forEach((url, index) => { if (url) loaded.set(index, url); });
    return loaded;
  });
  const [zoom, setZoomState] = useState<ZoomState>(createZoomState);
  const zoomRef = useRef(zoom);
  const zoomScaleRef = useRef(1);
  const zoomElementRef = useRef<HTMLDivElement>(null);
  const canZoomCurrentImage = useCallback(() => {
    const frame = zoomElementRef.current;
    if (readerUsesShellGestures() && frame?.querySelector('[data-native-reader-visible]')) return true;
    const images = frame?.querySelectorAll<HTMLImageElement>('img.reader-page:not(.is-candidate)');
    return !!images?.length && images.length === frame?.querySelectorAll('.reader-slot').length
      && Array.from(images).every((image) => image.complete && image.naturalWidth > 0);
  }, []);
  const hideChromeForZoomRef = useRef<() => void>();
  const zoomFrameRef = useRef<number>();
  const zoomAnimationRef = useRef<Animation>();
  const maxSettledZoom = useRef(3);
  const setZoom = useCallback((next: ZoomState, syncNative = true) => {
    zoomAnimationRef.current?.cancel();
    zoomAnimationRef.current = undefined;
    if (zoomFrameRef.current !== undefined) cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = undefined;
    zoomRef.current = next;
    zoomScaleRef.current = next.scale;
    setZoomState(next);
    if (syncNative && readerUsesShellGestures()) {
      updateNativeReaderTransform(nativePageRef.current, next, nativeSession);
    }
  }, [nativeSession]);
  const readDomViewport = useCallback((image: HTMLImageElement): ReaderTileViewport | undefined => {
    const { scale, panX, panY } = zoomRef.current;
    if (scale <= 1 || !image.offsetWidth || !image.offsetHeight) return undefined;
    return { scale, x: 0.5 - panX / image.offsetWidth, y: 0.5 - panY / image.offsetHeight };
  }, []);
  const applyNativeViewport = useCallback((viewport?: ReaderTileViewport, image?: HTMLElement) => {
    if (!viewport || !image || viewport.scale <= 1 || ![viewport.scale, viewport.x, viewport.y].every(Number.isFinite)) {
      if (zoomRef.current.scale !== 1) setZoom(createZoomState());
      return;
    }
    maxSettledZoom.current = Math.max(maxSettledZoom.current, viewport.scale);
    // The fitted image is centred and CSS applies pan in unscaled pixels.
    setZoom({ scale: viewport.scale, panX: (0.5 - viewport.x) * image.offsetWidth, panY: (0.5 - viewport.y) * image.offsetHeight });
  }, [setZoom]);
  const readLiveZoom = useCallback(() => {
    const animation = zoomAnimationRef.current;
    const element = zoomElementRef.current;
    if (!animation || !element) return zoomRef.current;
    // Read the compositor only when taking over an in-flight animation.
    // Its underlying DOM transform and the ref already contain the target.
    const transform = getComputedStyle(element).transform;
    const matrix = typeof DOMMatrixReadOnly !== 'undefined' && transform.startsWith('matrix')
      ? new DOMMatrixReadOnly(transform) : undefined;
    animation.cancel();
    zoomAnimationRef.current = undefined;
    if (matrix && matrix.a > 0) {
      const next = { scale: matrix.a, panX: matrix.e / matrix.a, panY: matrix.f / matrix.a };
      zoomRef.current = next;
      zoomScaleRef.current = next.scale;
      element.style.transition = 'none';
      element.style.transform = transform;
    }
    return zoomRef.current;
  }, []);
  const paintLiveZoom = useCallback(() => {
    const element = zoomElementRef.current;
    if (!element) return;
    const { scale, panX, panY } = zoomRef.current;
    if (element.style.transition !== 'none') element.style.transition = 'none';
    element.style.transform = `scale(${scale}) translate(${panX}px, ${panY}px)`;
    if (readerUsesShellGestures()) {
      updateNativeReaderTransform(nativePageRef.current, zoomRef.current, nativeSession);
    }
  }, [nativeSession]);
  const followZoom = useCallback((next: ZoomState, direct = false) => {
    if (next.scale !== zoomRef.current.scale) hideChromeForZoomRef.current?.();
    // Gesture input must not wait for reconciliation of pages, chrome or thumbnails.
    zoomRef.current = next;
    zoomScaleRef.current = next.scale;
    if (direct) {
      // Chrome already aligns continuous touch input with rendering. Apply each
      // sample in that dispatch, before the compositor takes the next frame.
      if (zoomFrameRef.current !== undefined) cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = undefined;
      paintLiveZoom();
      return;
    }
    if (zoomFrameRef.current !== undefined) return;
    zoomFrameRef.current = requestAnimationFrame(() => {
      zoomFrameRef.current = undefined;
      paintLiveZoom();
    });
  }, [paintLiveZoom]);
  /**
   * 手势收势：把橡皮比例收回默认比例，并让这一拍有过渡。
   *
   * 收势同时直写 DOM 与对齐 React 状态：手势期间 `followZoom` 是直接写元素
   * `style.transform` 的，而收势这一拍 React 未必会写（算出来的 transform 与上一次
   * 渲染值相同就跳过），两条路都走一遍最稳。
   */
  const settleZoomNow = useCallback((resetToFit = false, nativeSlideWillSettle = false) => {
    const element = zoomElementRef.current;
    const from = element?.style.transform;
    const next = resetToFit ? createZoomState() : settleZoom(zoomRef.current, maxSettledZoom.current);
    // Pointer cancellation and touch cancellation can describe the same release.
    // Don't cancel an already running return just because its target is settled.
    if (zoomAnimationRef.current && next.scale === zoomRef.current.scale
      && next.panX === zoomRef.current.panX && next.panY === zoomRef.current.panY) return;
    const start = zoomRef.current;
    const animateNative = readerUsesShellGestures() && !reduceMotion
      && (start.scale !== next.scale || start.panX !== next.panX || start.panY !== next.panY);
    setZoom(next, !animateNative && !nativeSlideWillSettle);
    if (animateNative && !nativeSlideWillSettle) {
      updateNativeReaderTransform(nativePageRef.current, next, nativeSession, start);
    }
    // React may still remember scale(1) while gesture frames changed the DOM.
    // Set the transition before restoring the transform, without scheduling a
    // frame that setZoom would immediately cancel.
    if (element) {
      const to = `scale(${next.scale}) translate(${next.panX}px, ${next.panY}px)`;
      // Explicit keyframes survive a busy React commit coalescing both style
      // writes into one frame. The compositor runs the return independently.
      const animate = !reduceMotion && from && from !== to && element.animate;
      element.style.transition = reduceMotion || animate ? 'none' : 'transform 140ms ease-out';
      element.style.transform = to;
      if (animate) {
        const animation = element.animate([{ transform: from }, { transform: to }], { duration: 140, easing: 'ease-out' });
        zoomAnimationRef.current = animation;
        animation.onfinish = () => { if (zoomAnimationRef.current === animation) zoomAnimationRef.current = undefined; };
      }
    }
  }, [nativeSession, reduceMotion, setZoom]);
  useEffect(() => () => {
    if (zoomFrameRef.current !== undefined) cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = undefined;
    zoomAnimationRef.current?.cancel();
    zoomAnimationRef.current = undefined;
  }, [pageActive]);
  const [panning, setPanning] = useState(false);
  const nativePinchPage = useRef<number>();
  const nativePinchTouches = useRef(false);
  const panStart = useRef<{ x: number; y: number; zoom: ZoomState; lastX?: number; lastY?: number }>();
  const pinchStart = useRef<{ distance: number; x: number; y: number; zoom: ZoomState; waitingForImage: boolean }>();

  function viewportPoint(x: number, y: number) {
    const box = rootBox();
    return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 };
  }

  function dragZoom(x: number, y: number, direct = false) {
    const start = panStart.current;
    if (!start) return;
    gestureMovedRef.current ||= Math.abs(x - start.x) + Math.abs(y - start.y) > 5;
    if (zoomAnimationRef.current) start.zoom = readLiveZoom();
    const box = rootBox();
    // Consume each movement even when it is clamped at the edge. A reversal
    // then moves immediately instead of retracing the discarded travel.
    start.zoom = panZoom(start.zoom, x - (start.lastX ?? start.x), y - (start.lastY ?? start.y), box.width, box.height);
    start.lastX = x;
    start.lastY = y;
    followZoom(start.zoom, direct);
  }
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<number, string>>(() => new Map());
  /** Natural size per page index, recorded as images load. Feeds both the `auto`
   * layout decision and the continuous-scroll slot heights. */
  const [pageSizes, setPageSizes] = useState<ReadonlyMap<number, { width: number; height: number }>>(() => new Map());
  const [pageMeasurement, setPageMeasurement] = useState(0);
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
  const layoutRef = useRef(effectiveLayout);
  const heightsRef = useRef<readonly number[]>([]);
  const anchorRef = useRef(0);
  /** Whether the scroller has been positioned for the page being read. Until a
   * real scroll has happened the anchor must not write progress, or entering
   * continuous mode at page 40 would immediately save page 1. */
  const webtoonScrolledRef = useRef(false);
  const webtoonEnteredRef = useRef(false);
  const reportedPageRef = useRef(-1);
  const touchStartRef = useRef<{ x: number; y: number; time: number; toolbar: boolean } | null>(null);
  const lastTapRef = useRef<{ x: number; y: number; time: number }>();
  const quickScale = useRef<{ x: number; y: number; lastY: number; span: number; moved: boolean; profile: Extract<ReturnType<typeof readerDoubleTapProfile>, { large: true }> }>();
  const touchZoomAt = useRef(-Infinity);
  const touchEndAt = useRef(-Infinity);
  const chromeTouchAt = useRef(-Infinity);
  /** Set on release when the pointer travelled far enough to be a drag, so the
   * click that follows can be ignored. */
  const gestureMovedRef = useRef(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [autoTurnReadyKey, setAutoTurnReadyKey] = useState<string>();
  const [autoTurnForeground, setAutoTurnForeground] = useState(() => document.visibilityState !== 'hidden');
  const [thumbnailPanelOpen, setThumbnailPanelOpen] = useState(false);
  /** The grid's mounted window plus the rows actually on screen: freed slots
   * serve the visible rows first and the buffer with what is left. */
  const [thumbnailRange, setThumbnailRange] = useState({ start: 0, end: 0, visibleStart: 0, visibleEnd: 0 });
  const onThumbnailRange = useCallback((start: number, end: number, visible: { start: number; end: number }) => {
    setThumbnailRange((range) => range.start === start && range.end === end
      && range.visibleStart === visible.start && range.visibleEnd === visible.end
      ? range : { start, end, visibleStart: visible.start, visibleEnd: visible.end });
  }, []);
  useLayoutEffect(() => {
    if (!pageActive) {
      pinchStart.current = undefined;
      quickScale.current = undefined;
      panStart.current = undefined;
      setPanning(false);
      settleZoomNow();
      setAutoPlay(false);
      setAutoTurnReadyKey(undefined);
      setThumbnailPanelOpen(false);
      // The queue dies with the visit: whatever is still loading must not land
      // in the next archive's cache.
      thumbnailScheduler.current?.dispose();
      thumbnailScheduler.current = undefined;
      setThumbnails((current) => current.size === 0 ? current : new Map());
    }
  }, [pageActive, settleZoomNow]);
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
    // 手指（`COARSE_POINTER_QUERY`，即 `(hover: none), (pointer: coarse)`）点哪条感应带
    // 就只亮哪条：触屏没有悬停，两条栏本来只能一起亮一起灭。鼠标留着旧行为——桌面用
    // 悬停选边，点一下两条都出来也无所谓。
    pinTappedBand: coarsePointer,
    onToggle: () => setState(toggleReaderChrome),
    onHide: () => setState((current) => current.phase === 'chrome-visible' ? { ...current, phase: 'ready' } : current),
  });
  hideChromeForZoomRef.current = topChromeVisible || bottomChromeVisible ? () => {
    hideChromeForZoomRef.current = undefined;
    clearHover();
    setState((current) => current.phase === 'chrome-visible' ? { ...current, phase: 'ready' } : current);
  } : undefined;
  const loadingPagesRef = useRef(new Map<number, AbortController>());
  /** Failed loads, with their attempt count and the earliest time to try again.
   * A page that simply failed used to be retried on every render — or, once the
   * window moved past it, never. */
  const failedPagesRef = useRef(new Map<number, { attempts: number; nextAt: number }>());
  const [retryTick, setRetryTick] = useState(0);
  const fetchAnchorRef = useRef('');
  const distantPrefetchAt = useRef(0);

  /** Slot height for one continuous-scroll page. Unmeasured pages get an estimate
   * so the scroller has a length from the start; a measured height replaces it
   * and is never given up again, which is what keeps the geometry stable. */
  const webtoonSlotWidth = Math.min(webtoonWidth || viewport.width, WEBTOON_MAX_WIDTH);
  const estimatedPageHeight = Math.max(240, Math.round(viewport.height * WEBTOON_ESTIMATED_PAGE_RATIO));
  const slotHeightFor = useCallback((size: { width: number; height: number } | undefined) => (
    size && size.width > 0 ? Math.max(1, Math.round((webtoonSlotWidth * size.height) / size.width)) : estimatedPageHeight
  ), [estimatedPageHeight, webtoonSlotWidth]);
  const heights = useMemo(
    () => effectiveLayout !== 'webtoon' ? [] : Array.from({ length: pages.length }, (_, index) => slotHeightFor(pageSizes.get(index))),
    [effectiveLayout, pageSizes, pages.length, slotHeightFor],
  );
  const pageOffsets = useMemo(() => webtoonPageOffsets(heights), [heights]);
  const pageOffsetsRef = useRef(pageOffsets);
  pageOffsetsRef.current = pageOffsets;
  useLayoutEffect(() => {
    if (effectiveLayout === 'webtoon') invalidateContinuousReaderLayout();
  }, [effectiveLayout, pageOffsets, viewport.width, viewport.height]);
  /** What continuous scroll keeps mounted. Held as two numbers rather than an
   * object so that scrolling within the same window does not re-run the fetch
   * effect on every scroll event. */
  const { first: webtoonFirst, last: webtoonLast } = useMemo(
    () => webtoonWindow({ scrollTop, viewportHeight: viewport.height, offsets: pageOffsets, overscan: Math.max(1, prefetchDistance) }),
    [pageOffsets, prefetchDistance, scrollTop, viewport.height],
  );
  const webtoonAnchor = useMemo(
    () => webtoonWindow({ scrollTop, viewportHeight: viewport.height, offsets: pageOffsets, overscan: 0 }).first,
    [pageOffsets, scrollTop, viewport.height],
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
    const neighbour = (destination: typeof state) => {
      const indexes = getVisiblePageIndexes(destination);
      return indexes[0] === visibleIndexes[0] ? [] : indexes;
    };
    return { previous: neighbour(previous), next: neighbour(next) };
  }, [state, visibleIndexes]);
  const neighboursRef = useRef(neighbourIndexes);
  neighboursRef.current = neighbourIndexes;

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

  useEffect(() => { layoutRef.current = effectiveLayout; }, [effectiveLayout]);
  useLayoutEffect(() => {
    maxSettledZoom.current = 3;
    if (zoomRef.current.scale !== 1 || zoomRef.current.panX !== 0 || zoomRef.current.panY !== 0 || zoomAnimationRef.current || zoomFrameRef.current !== undefined) {
      const element = zoomElementRef.current;
      if (element) {
        element.style.transition = 'none';
        element.style.transform = 'scale(1) translate(0px, 0px)';
      }
      setZoom(createZoomState());
    } else if (effectiveLayout !== 'webtoon' && readerUsesShellGestures()) {
      updateNativeReaderTransform(nativePage, createZoomState(), nativeSession);
    }
  }, [archiveId, effectiveLayout, nativePage, setZoom, nativeSession]);
  useEffect(() => { heightsRef.current = heights; }, [heights]);
  useEffect(() => { anchorRef.current = webtoonAnchor; }, [webtoonAnchor]);
  useEffect(() => () => {
    for (const controller of loadingPagesRef.current.values()) controller.abort();
    loadingPagesRef.current.clear();
  }, []);

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
    const offset = pageOffsetsRef.current[state.pageIndex] ?? 0;
    container.scrollTop = offset;
    repositionNativeContinuousInput(container, offset);
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
  const pageRequestGeneration = useRef(0);
  useEffect(() => {
    if (reloadedRef.current === reloadToken) return;
    reloadedRef.current = reloadToken;
    pageRequestGeneration.current += 1;
    for (const controller of loadingPagesRef.current.values()) controller.abort();
    loadingPagesRef.current.clear();
    setRetryTick((value) => value + 1);
    failedPagesRef.current.clear();
    setExhaustedPages((current) => current.size === 0 ? current : new Set());
    for (const index of loadedPages.keys()) releasePage?.(index);
    setLoadedPages((current) => current.size ? new Map() : current);
  }, [loadedPages, releasePage, reloadToken]);

  useEffect(() => {
    if (!pageActive) return;
    const pageCount = pages.length;
    const fetchSet = new Set<number>();
    const retainSet = new Set<number>();
    const immediate = new Set<number>();
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
      const forward = state.direction === 'rtl' ? neighbourIndexes.previous : neighbourIndexes.next;
      const backward = state.direction === 'rtl' ? neighbourIndexes.next : neighbourIndexes.previous;
      for (const index of [...visibleIndexes, ...forward, ...backward]) {
        add(immediate, index);
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

    // Retire stale demand before submitting the new current page. Cancellation
    // is not a failure and must not leave a backoff/exhausted entry behind.
    const anchor = `${effectiveLayout}:${visibleIndexes.join(',')}`;
    const now = Date.now();
    const changedWindow = fetchAnchorRef.current !== anchor;
    const needsForeground = changedWindow && visibleIndexes.some(index => !loadedPages.has(index));
    if (changedWindow && fetchAnchorRef.current && effectiveLayout !== 'webtoon') {
      distantPrefetchAt.current = now + DISTANT_PREFETCH_IDLE_MS;
    }
    fetchAnchorRef.current = anchor;
    for (const [index, controller] of loadingPagesRef.current) {
      // Keep immediate neighbours in flight: cancelling a still-relevant
      // download on each turn starves the next swipe. Only distant speculation
      // yields its slot when the visible page is missing.
      if (fetchSet.has(index) && (!needsForeground || effectiveLayout === 'webtoon' || immediate.has(index))) continue;
      loadingPagesRef.current.delete(index);
      controller.abort();
      releasePage?.(index);
    }

    if (releasePage) {
      const released: number[] = [];
      for (const index of loadedPages.keys()) {
        if (!retainSet.has(index)) released.push(index);
      }
      if (released.length > 0) {
        for (const index of released) releasePage(index);
        setLoadedPages((current) => {
          const next = new Map(current);
          for (const index of released) next.delete(index);
          return next;
        });
      }
    }
    if (!loadPage) return;
    let soonest = Infinity;
    for (const index of fetchSet) {
      if (loadedPages.has(index) || loadingPagesRef.current.has(index)) continue;
      const failure = failedPagesRef.current.get(index);
      if (failure && failure.attempts >= MAX_PAGE_LOAD_ATTEMPTS) continue;
      // The visible frame and its swipe neighbours never wait for this quiet
      // period. Only the rest of the configured look-ahead is coalesced.
      const speculative = effectiveLayout !== 'webtoon' && !immediate.has(index);
      const nextAt = Math.max(failure?.nextAt ?? 0, speculative ? distantPrefetchAt.current : 0);
      if (nextAt > now) {
        soonest = Math.min(soonest, nextAt);
        continue;
      }
      const controller = new AbortController();
      loadingPagesRef.current.set(index, controller);
      const generation = pageRequestGeneration.current;
      const startedAt = Date.now();
      let timedOut = false;
      let failureMessage: string | undefined;
      let timeout: number | undefined;
      const aborted = new Promise<undefined>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(undefined), { once: true });
        timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, PAGE_LOAD_TIMEOUT_MS);
      });
      void Promise.race([Promise.resolve().then(() => loadPage(index, controller.signal)).catch((error: unknown) => {
        failureMessage = error instanceof Error ? error.message : String(error);
        return undefined;
      }), aborted]).then((page) => {
        if (generation !== pageRequestGeneration.current || loadingPagesRef.current.get(index) !== controller) return;
        // Retire ownership BEFORE notifying React. Otherwise a retry render can
        // see the settled request as still loading, skip its backoff timer and
        // leave the spinner there until navigating away changes dependencies.
        loadingPagesRef.current.delete(index);
        if (page) {
          failedPagesRef.current.delete(index);
          setLoadedPages((current) => current.get(index) === page ? current : new Map(current).set(index, page));
          return;
        }
        // Exponential backoff with jitter: a server that just refused is
        // unlikely to answer differently a millisecond later, and hammering
        // it makes it worse.
        const attempts = (failedPagesRef.current.get(index)?.attempts ?? 0) + 1;
        const delay = (2 ** attempts + Math.random() * 2) * 1000;
        logError('reader/page-load', timedOut ? '阅读页请求超时' : '阅读页请求未取得图片', {
          page: index + 1, attempts, elapsedMs: Date.now() - startedAt,
          retryInMs: attempts < MAX_PAGE_LOAD_ATTEMPTS ? delay : null,
          ...(failureMessage ? { reason: failureMessage } : {}),
        }, 'warn');
        failedPagesRef.current.set(index, { attempts, nextAt: Date.now() + delay });
        if (attempts < MAX_PAGE_LOAD_ATTEMPTS) setRetryTick((value) => value + 1);
        // Only now is the page a failure rather than a page still on its way.
        else setExhaustedPages((current) => current.has(index) ? current : new Set(current).add(index));
      }).finally(() => {
        if (timeout !== undefined) window.clearTimeout(timeout);
        // A canceled predecessor must never erase its replacement's ownership.
        if (loadingPagesRef.current.get(index) === controller) loadingPagesRef.current.delete(index);
      });
    }
    if (soonest !== Infinity) {
      const timer = window.setTimeout(() => setRetryTick((value) => value + 1), Math.max(1, soonest - Date.now()));
      return () => window.clearTimeout(timer);
    }
  }, [effectiveLayout, loadPage, loadedPages, neighbourIndexes, pages.length, prefetchDistance, releasePage, retryTick, visibleIndexes, webtoonFirst, webtoonLast, pageActive, state.direction]);

  const retryPage = useCallback((index: number) => {
    const pending = loadingPagesRef.current.get(index);
    loadingPagesRef.current.delete(index);
    pending?.abort();
    releasePage?.(index);
    setLoadedPages((current) => {
      if (!current.has(index)) return current;
      const next = new Map(current);
      next.delete(index);
      return next;
    });
    failedPagesRef.current.delete(index);
    setExhaustedPages((current) => {
      if (!current.has(index)) return current;
      const next = new Set(current);
      next.delete(index);
      return next;
    });
    setRetryTick((value) => value + 1);
  }, [releasePage]);

  const [rejectedDerived, setRejectedDerived] = useState<Map<number, string>>(() => new Map());
  const failPage = useCallback((index: number, url: string) => {
    // The displayed rendition may be a predecessor of the newest derived
    // candidate while that candidate is still decoding.
    if (loadedPages.get(index) !== url) {
      setRejectedDerived((current) => new Map(current).set(index, url));
      return;
    }
    failedPagesRef.current.set(index, { attempts: MAX_PAGE_LOAD_ATTEMPTS, nextAt: Infinity });
    setExhaustedPages((current) => new Set(current).add(index));
  }, [loadedPages]);

  /** Records what a page actually is, once the browser knows.
   *
   * Two consumers: the `auto` layout decision and the continuous-scroll slot
   * height. In continuous mode a page *above* the viewport turning out taller
   * than its estimate would push everything below it down — i.e. move the page
   * being read — so the scroller is compensated by the same delta.
   */
  const measurePage = useCallback((index: number, image: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>) => {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return;
    // Loading or promoting an equal-size rendition need not resize its box, so
    // ResizeObserver alone cannot invalidate an old overlap measurement.
    setPageMeasurement((value) => value + 1);
    const shape = classifyPageShape(width, height);
    setState((current) => {
      // A new rendition belongs to the same logical page. Using its pixel
      // dimensions to regroup the spread would unmount the current viewport.
      if (current.shapes?.[index] !== undefined) return current;
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
    repositionNativeContinuousInput(container, delta, true);
    setScrollTop(container.scrollTop);
  }, [slotHeightFor]);

  /** One preview queue for the whole visit. The panel unmounts on close, so a
   * queue built inside its effect started four more while the first four were
   * still in the air, and a page that failed once was never asked again. This
   * one keeps its slots and its successes across close/reopen, and a page that
   * leaves the window and comes back gets a fresh chance. */
  const thumbnailScheduler = useRef<ThumbnailScheduler>();
  const thumbnailLive = useRef(pageActive);
  thumbnailLive.current = pageActive;
  useEffect(() => {
    if (!pageActive || !loadPageThumbnail) return undefined;
    const scheduler: ThumbnailScheduler = new ThumbnailScheduler({
      load: (index) => loadPageThumbnail(index),
      // A result from a previous archive or reading session must not paint this
      // one's tiles.
      onLoaded: (index, url) => setThumbnails((current) => current.has(index) ? current : new Map(current).set(index, url)),
      isLive: (): boolean => thumbnailLive.current && thumbnailScheduler.current === scheduler,
    });
    thumbnailScheduler.current = scheduler;
    return () => {
      if (thumbnailScheduler.current === scheduler) thumbnailScheduler.current = undefined;
      scheduler.dispose();
    };
  }, [archiveId, loadPageThumbnail, pageActive]);
  useEffect(() => {
    const scheduler = thumbnailScheduler.current;
    if (!scheduler) return;
    // Closed with requests still in the air: keep their slots, stop starting
    // new ones.
    if (!thumbnailPanelOpen) { scheduler.suspend(); return; }
    scheduler.resume();
    scheduler.setRange(thumbnailRange);
  }, [archiveId, loadPageThumbnail, pageActive, thumbnailPanelOpen, thumbnailRange]);

  // React registers wheel listeners as passive, so preventDefault() inside
  // onWheel is ignored and the canvas would zoom *and* scroll. Bind natively.
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;
    let settleTimer: number | undefined;
    let checkedFrame: number | undefined;
    let checkedElement: HTMLDivElement | null;
    let wheelFrame: number | undefined;
    let wheelPage = 0;
    let wheelInFlight = false;
    let disposed = false;
    let pendingWheel: WheelZoomSample[] = [];
    const settleWheel = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (!panStart.current && !pinchStart.current && !wheelInFlight && !pendingWheel.length) settleZoomNow();
      }, 180);
    };
    const flushNativeWheel = () => {
      wheelFrame = undefined;
      if (disposed || wheelInFlight || !pendingWheel.length) return;
      const page = wheelPage;
      const samples = pendingWheel;
      pendingWheel = [];
      if (page !== nativePageRef.current || panStart.current || pinchStart.current || pointerStartRef.current) return;
      wheelInFlight = true;
      const maximum = Math.min(14, maxSettledZoom.current);
      void sampleNativeWheelZoom(nativeSession, page, maximum, samples).then((next) => {
        wheelInFlight = false;
        if (disposed) return;
        if (page === nativePageRef.current && !panStart.current && !pinchStart.current) {
          if (next) {
            if (next.scale !== zoomRef.current.scale) hideChromeForZoomRef.current?.();
            zoomRef.current = next;
            zoomScaleRef.current = next.scale;
            const visible = zoomElementRef.current;
            if (visible) {
              zoomAnimationRef.current?.cancel();
              zoomAnimationRef.current = undefined;
              visible.style.transition = 'none';
              visible.style.transform = `scale(${next.scale}) translate(${next.panX}px, ${next.panY}px)`;
            }
          } else {
            const fallback = samples.reduce((zoom, [x, y, delta, snap]) => zoomAtPoint(zoom, zoomByWheel(zoom, delta, maximum, snap === 1).scale, x, y), zoomRef.current);
            followZoom(fallback);
          }
          settleWheel();
        }
        if (pendingWheel.length && wheelFrame === undefined) wheelFrame = requestAnimationFrame(flushNativeWheel);
      });
    };
    const onWheel = (event: globalThis.WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const inControl = Boolean(target?.closest('input, textarea, select, [contenteditable="true"], .reader-comments, .horizontal-scroller, .reader-overview'));
      // 触控板的双指捏合在 WebView 里就是 ctrl+wheel，而它同时是**浏览器的页面缩放**
      // 手势。阅读器自己管缩放（分页档）或压根不管（条漫档），两种都不该让浏览器把整页
      // 缩放掉：页面缩放不在阅读器的收势里，用户看到的是「缩小到小于默认比例后松手不
      // 复位，过一会儿又瞬间复位」——复位的那一下正是 WebView 把页面缩放扔掉的时候。
      if (event.ctrlKey && !inControl && event.cancelable) event.preventDefault();
      if (layoutRef.current === 'webtoon' || inControl) return;
      if (event.deltaY === 0) return;
      if (event.cancelable) event.preventDefault();
      if (panStart.current || pinchStart.current) return;
      // Precision touchpad pinches arrive as wheel events. Give the new page
      // the first sample, just as the direct touchscreen path does.
      if (sliding.current) finishSlideRef.current?.();
      const currentElement = zoomElementRef.current;
      const alreadyChecked = checkedFrame !== undefined && checkedFrame === zoomFrameRef.current && checkedElement === currentElement;
      if (!alreadyChecked && !canZoomCurrentImage()) return;
      const point = viewportPoint(event.clientX, event.clientY);
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
      if (hasNativeWheelZoom() && currentElement?.querySelector('[data-native-reader-visible]')) {
        if (wheelPage !== nativePageRef.current) pendingWheel = [];
        wheelPage = nativePageRef.current;
        if (pendingWheel.length === 32) pendingWheel.shift();
        pendingWheel.push([point.x, point.y, delta, event.ctrlKey ? 0 : 1]);
        if (wheelFrame === undefined && !wheelInFlight) wheelFrame = requestAnimationFrame(flushNativeWheel);
        pauseHandover();
        resumeHandover(380);
        return;
      }
      const current = readLiveZoom();
      followZoom(zoomAtPoint(current, zoomByWheel(current, delta, maxSettledZoom.current, !event.ctrlKey).scale, point.x, point.y));
      if (alreadyChecked) return;
      checkedFrame = zoomFrameRef.current;
      checkedElement = currentElement;
      pauseHandover();
      resumeHandover(380);
      // Springs an overshoot back once the wheel goes quiet, so the limits feel
      // elastic instead of hard-stopping mid-gesture.
      settleWheel();
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      disposed = true;
      if (wheelFrame !== undefined) cancelAnimationFrame(wheelFrame);
      window.clearTimeout(settleTimer);
      element.removeEventListener('wheel', onWheel);
    };
  }, [settleZoomNow, followZoom, pauseHandover, resumeHandover, canZoomCurrentImage, readLiveZoom, nativeSession]);

  // Arrow keys are bound to the canvas, so it has to own focus from the start;
  // otherwise the user must click first, and that click toggles the chrome.
  useEffect(() => { if (pageActive) rootRef.current?.focus({ preventScroll: true }); }, [pageActive]);

  /** Past this much travel a gesture is a drag rather than a tap. */
  const TAP_SLOP = 5;

  /** 到末页还往下一页翻，就是「这本书读完了」。
   *
   * 用户报 13（2026-10-18）：「在阅读模式时，在最后一页继续往下一页方向翻页无法退出
   * 阅读模式。」`advanceReader` 在边界上被 `clampPage` 夹住，`pageIndex` 原地不动，于是
   * 那一下翻页什么也没发生。现在它接到顶栏返回键的**同一条路径**（`goBack`，见本组件
   * 顶部那颗返回按钮）——连「有没有上一页可回」这种历史语义都跟着一起对，不再另造
   * 一条退出。只在阅读的前进方向上退出（RTL 为 `previous`）：往回翻到头停在第 1 页。
   *
   * `allowExit: false` 是自动翻页：读到最后一页它该停下来等读者，不能自己把书合上。
   * 条漫档（`webtoon`）不进来：连续滚动档的纵向手势根本到不了这里（wheel 监听在
   * `webtoon` 上提前返回，滚动由容器自己管），而在末页继续往下滚属于滚动，不是翻页
   * ——所以 `effectiveLayout` 那一关是手势分流，不是退出条件。 */
  function move(intent: 'next' | 'previous', allowExit = true) {
    if (sliding.current) finishSlideRef.current?.();
    const current = readerStateRef.current;
    const advanced = advanceReader(current, intent);
    if (allowExit && intent === (current.direction === 'rtl' ? 'previous' : 'next') && advanced.pageIndex === current.pageIndex && effectiveLayout !== 'webtoon') {
      goBack();
      return;
    }
    const next = current.phase === 'chrome-visible' ? { ...advanced, phase: current.phase } : advanced;
    if (next.pageIndex !== current.pageIndex && effectiveLayout !== 'webtoon' && needsStableZoomLayer([next.pageIndex])) {
      // Let the newly visible texture paint before a decoded rendition can
      // replace it. A pinch started in this interval extends the same pause.
      pauseHandover();
      resumeHandover(320);
    }
    readerStateRef.current = next;
    setState(next);
    scrollToPage(next.pageIndex);
  }

  // Touch handlers survive layout/direction changes; their exit must use the current route.
  const moveRef = useRef(move);
  moveRef.current = move;

  // Like Readoshi, count time spent reading a loaded page, not time waiting for
  // its image. A neighbour/derived-image measurement must not reset the clock.
  const autoTurnPageKey = `${effectiveLayout}:${visibleIndexes.join(',')}`;
  useEffect(() => {
    if (!pageActive || !autoPlay) {
      if (autoTurnReadyKey !== undefined) setAutoTurnReadyKey(undefined);
      return;
    }
    const image = effectiveLayout === 'webtoon' ? webtoonRef.current?.querySelector<HTMLImageElement>(`img.reader-page:not(.is-candidate)[alt="第 ${state.pageIndex + 1} 页"]`) : undefined;
    const ready = effectiveLayout === 'webtoon'
      ? !!image?.complete && image.naturalWidth > 0
      : Boolean(zoomElementRef.current?.querySelector('[data-native-reader-ready]')) || canZoomCurrentImage();
    const next = ready ? autoTurnPageKey : undefined;
    if (autoTurnReadyKey !== next) setAutoTurnReadyKey(next);
  }, [autoPlay, autoTurnReadyKey, pageActive, effectiveLayout, autoTurnPageKey, state.pageIndex, pageMeasurement, loadedPages, exhaustedPages, canZoomCurrentImage]);
  useEffect(() => {
    if (!autoPlay || !pageActive) return;
    const update = () => setAutoTurnForeground(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [autoPlay, pageActive]);
  const autoTurnInterval = AUTO_TURN_INTERVAL_MS * (effectiveLayout === 'double' ? 2 : 1);
  const autoTurnRunning = autoPlay && pageActive && autoTurnForeground && autoTurnReadyKey === autoTurnPageKey;
  useEffect(() => {
    if (!autoTurnRunning) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'hidden') return;
      const current = readerStateRef.current;
      // advanceReader's intents describe physical left/right, so forward in an
      // RTL book is `previous`. Always advance the logical page/spread index.
      const intent = current.direction === 'rtl' ? 'previous' : 'next';
      if (advanceReader(current, intent).pageIndex === current.pageIndex) setAutoPlay(false);
      else moveRef.current(intent, false);
    }, autoTurnInterval);
    return () => window.clearTimeout(timer);
  }, [autoTurnRunning, autoTurnPageKey, state.direction, autoTurnInterval]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest('input, textarea, select, [contenteditable], [role="slider"]')) return;
      // Space on a focused toolbar button belongs to that button. Letting it
      // bubble into the canvas used to turn a page before activating the control.
      if (event.key !== 'Escape' && target.closest('button, a, [role="button"]')) return;
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault();
      move('next');
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      move('previous');
    } else if (event.key === 'Escape' && state.phase === 'chrome-visible') {
      // 收起时也要把「钉在哪一侧」清掉，否则被钉住的那条栏不认这次收起。
      setHover(undefined);
      setState(toggleReaderChrome);
    }
  }

  useEffect(() => {
    if (!pageActive) return;
    const turn = (event: Event) => {
      const { session, from, to, left } = (event as CustomEvent<{ session: number; from: number; to: number; left: boolean }>).detail;
      if (session !== nativeSession) return;
      const intent = left ? 'next' : 'previous';
      const current = readerStateRef.current;
      const destination = advanceReader(current, intent);
      if (nativePageRef.current !== from || (getVisiblePageIndexes(destination)[0] ?? destination.pageIndex) + 1 !== to) return;
      flushSync(() => moveRef.current(intent, false));
    };
    const exit = (event: Event) => {
      const { session, page, left } = (event as CustomEvent<{ session: number; page: number; left: boolean }>).detail;
      const current = readerStateRef.current;
      const intent = left ? 'next' : 'previous';
      if (session === nativeSession && page === nativePageRef.current
        && intent === (current.direction === 'rtl' ? 'previous' : 'next')
        && advanceReader(current, intent).pageIndex === current.pageIndex) flushSync(() => moveRef.current(intent));
    };
    window.addEventListener('yomika-reader-native-turn', turn);
    window.addEventListener('yomika-reader-native-exit', exit);
    return () => {
      window.removeEventListener('yomika-reader-native-turn', turn);
      window.removeEventListener('yomika-reader-native-exit', exit);
    };
  }, [pageActive, nativeSession]);

  const trackRef = useRef<HTMLDivElement>(null);
  const warmedNeighbourImages = useRef(new WeakSet<HTMLImageElement>());
  const neighbourDecodeInFlight = useRef(false);
  const forwardIndexes = state.direction === 'rtl' ? neighbourIndexes.previous : neighbourIndexes.next;
  const forwardFrameKey = forwardIndexes.join(',');
  useEffect(() => {
    if (!pageActive || handoverPaused || effectiveLayout === 'webtoon' || !forwardFrameKey) return;
    let disposed = false;
    const timer = window.setTimeout(async () => {
      // Decode the mounted image itself. Avoid competing with the current page,
      // actively moving images, or a second prewarm for another spread.
      if (!canPromote() || !canZoomCurrentImage() || neighbourDecodeInFlight.current) return;
      const frame = trackRef.current?.querySelector(`[data-reader-neighbour="${forwardFrameKey}"]`);
      if (!frame) return;
      neighbourDecodeInFlight.current = true;
      try {
        for (const image of frame.querySelectorAll<HTMLImageElement>('img.reader-page:not(.is-candidate)')) {
          if (disposed || !canPromote() || !image.isConnected || frame.getAttribute('data-reader-neighbour') !== forwardFrameKey) break;
          if (!image.complete || !image.naturalWidth || !image.decode || warmedNeighbourImages.current.has(image)) continue;
          warmedNeighbourImages.current.add(image);
          // The regular image load/error handlers still own retries and failures.
          await image.decode().catch(() => warmedNeighbourImages.current.delete(image));
        }
      } finally {
        neighbourDecodeInFlight.current = false;
      }
    }, NEIGHBOUR_DECODE_IDLE_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [canPromote, canZoomCurrentImage, effectiveLayout, forwardFrameKey, handoverPaused, pageActive, pageMeasurement]);
  const exitHintRef = useRef<HTMLDivElement>(null);
  const exitHintDrag = useRef<{ progress: number; ready: boolean; side: 'left' | 'right' }>();
  const hideExitHint = useCallback(() => {
    exitHintDrag.current = undefined;
    if (exitHintRef.current) {
      exitHintRef.current.dataset.visible = 'false';
      exitHintRef.current.setAttribute('aria-hidden', 'true');
    }
  }, []);
  const dragOffset = useRef(0);
  const nativeEdgePage = useRef<number>();
  const dragSample = useRef<{ dx: number; elapsed: number; velocity: number }>();
  const horizontalDrag = useRef(false);
  const dragFrame = useRef<number>();
  const slideAnimation = useRef<Animation>();
  const finishSlideRef = useRef<(() => void)>();
  const sliding = useRef(false);
  const reducedMotionRef = useRef(reduceMotion);
  reducedMotionRef.current = reduceMotion;

  useEffect(() => {
    if (!pageActive || effectiveLayout === 'webtoon') hideExitHint();
  }, [effectiveLayout, hideExitHint, pageActive]);
  useLayoutEffect(() => {
    if (!pageActive) return;
    dragOffset.current = 0;
    dragSample.current = undefined;
    if (trackRef.current) trackRef.current.style.transform = 'translate3d(0,0,0)';
  }, [pageActive]);

  useEffect(() => () => {
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    slideAnimation.current?.cancel();
    slideAnimation.current = undefined;
    finishSlideRef.current = undefined;
    sliding.current = false;
    dragOffset.current = 0;
  }, [archiveId]);

  function finishDrag(dx: number, elapsed: number, touchRelease = false) {
    hideExitHint();
    if (sliding.current) return;
    if (dx === 0 && dragOffset.current === 0) return;
    const dragFramePending = dragFrame.current !== undefined;
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = undefined;
    const track = trackRef.current;
    const width = rootBox().width;
    const intent = dx < 0 ? 'next' : 'previous';
    const current = readerStateRef.current;
    const sample = dragSample.current;
    const velocity = sample ? (elapsed - sample.elapsed < 100 ? sample.velocity : 0) : undefined;
    const boundary = advanceReader(current, intent).pageIndex === current.pageIndex;
    const crossedLastPage = boundary && intent === (current.direction === 'rtl' ? 'previous' : 'next') && layoutRef.current !== 'webtoon';
    // Fast flicks still turn pages, but exiting needs a deliberate pull.
    const commit = crossedLastPage ? Math.abs(dx) >= lastPageExitDistance(width)
      : !boundary && shouldCommitPageTurn(dx, elapsed, width, velocity);
    // Only uncommitted boundary drags spring back. A committed final-page
    // gesture exits on pointer-up instead of waiting for the spring to finish.
    const outgoingNativePage = nativePageRef.current;
    const returnToFit = commit && !boundary && zoomScaleRef.current !== 1;
    const shellSlide = !boundary && readerUsesShellGestures();
    const slideZoomFrom = returnToFit && shellSlide && track?.animate && !reducedMotionRef.current
      ? zoomRef.current : undefined;
    if (returnToFit) settleZoomNow(true, Boolean(slideZoomFrom));
    if (commit && !boundary && touchRelease && zoomElementRef.current?.querySelector('[data-native-reader-visible]')) {
      settleNativeReaderFitForTurn(outgoingNativePage, nativeSession, reducedMotionRef.current);
    }
    const target = commit && !boundary ? (dx < 0 ? -width : width) : 0;
    const neighbourPage = (neighboursRef.current[intent][0] ?? -1) + 1;
    const nextFrame = touchRelease && commit && !boundary && !returnToFit && !shellSlide
      ? track?.querySelector(`[data-reader-neighbour="${(intent === 'next' ? neighboursRef.current.next : neighboursRef.current.previous).join(',')}"]`)
      : undefined;
    const largePageReady = Boolean(nextFrame?.querySelector('[data-native-reader-ready]')) || Array.from(nextFrame?.querySelectorAll<HTMLImageElement>('img.reader-page:not(.is-candidate)') ?? [])
      .some(image => image.complete && image.naturalWidth * image.naturalHeight >= LARGE_READER_TEXTURE_PIXELS);
    // Rebase a prepared large page on release. The two frames keep their
    // screen coordinates, while the next touch already belongs to the new page.
    if (largePageReady) flushSync(() => moveRef.current(intent));
    const from = dragOffset.current - (largePageReady ? target : 0);
    const to = largePageReady ? 0 : target;
    let finished = false;
    const finish = () => {
      if (finished || finishSlideRef.current !== finish) return;
      finished = true;
      if (shellSlide) updateNativeReaderSlide(outgoingNativePage,
        commit ? neighbourPage || undefined : undefined, to / Math.max(1, width), nativeSession);
      finishSlideRef.current = undefined;
      slideAnimation.current?.cancel();
      slideAnimation.current = undefined;
      sliding.current = false;
      dragOffset.current = 0;
      dragSample.current = undefined;
      if (track) track.style.transform = 'translate3d(0,0,0)';
      if (commit && !largePageReady) flushSync(() => moveRef.current(intent));
    };
    const edgePage = nativeEdgePage.current;
    nativeEdgePage.current = undefined;
    if (edgePage !== undefined && dragFramePending) {
      // A quick release can arrive before the queued drag frame. Apply its
      // offset before asking the native view to spring back or exit.
      updateNativeReaderEdge(edgePage, dragOffset.current / Math.max(1, width), 0, nativeSession);
    }
    const remaining = Math.abs(target - dragOffset.current);
    const measuredSpeed = velocity ?? (elapsed > 0 ? dx / elapsed : 0);
    const duration = boundary ? EDGE_SETTLE_MS : commit ? pageTurnDuration(remaining, measuredSpeed, returnToFit) : 200;
    if (edgePage !== undefined && !(commit && crossedLastPage)) {
      const nativeDuration = reducedMotionRef.current ? 0 : duration;
      updateNativeReaderEdge(edgePage, target / Math.max(1, width), nativeDuration, nativeSession);
    }
    if (commit && crossedLastPage) {
      // RetainedPage keeps the reader visible during its exit transition.
      // Preserve the dragged artwork until that surface is hidden.
      flushSync(() => moveRef.current(intent));
      return;
    }
    // Keep both neighbouring frames mounted until the outgoing page has left.
    finishSlideRef.current = finish;
    if (!track?.animate || reducedMotionRef.current) { finish(); return; }
    sliding.current = true;
    // A fast flick or an almost-completed drag should not wait a fixed 240ms.
    slideAnimation.current = track.animate([
      { transform: `translate3d(${from}px,0,0)` },
      { transform: `translate3d(${to}px,0,0)` },
    ], { duration,
      easing: boundary ? EDGE_SETTLE_EASING : 'cubic-bezier(.22,.45,.28,1)', fill: 'forwards' });
    slideAnimation.current.onfinish = finish;
    if (shellSlide) {
      const normalizer = Math.max(1, width);
      updateNativeReaderSlide(outgoingNativePage, neighbourPage || undefined, to / normalizer, nativeSession,
        {
          from: Math.max(-1, Math.min(1, from / normalizer)),
          durationMs: Math.round(duration),
          ...(slideZoomFrom ? { zoomFrom: slideZoomFrom } : {}),
        });
    }
  }

  const trackDrag = useCallback((dx: number, dy: number, elapsed: number) => {
    if (sliding.current) return;
    // Preview the first horizontal pixels. Slop only locks the axis and
    // distinguishes taps at release, so it cannot delay visual tracking.
    if (zoomScaleRef.current > PAGE_SWIPE_MAX_ZOOM || layoutRef.current === 'webtoon' || (!horizontalDrag.current && Math.abs(dx) <= Math.abs(dy))) {
      hideExitHint();
      dragOffset.current = 0;
      if (nativeEdgePage.current !== undefined) updateNativeReaderEdge(nativeEdgePage.current, 0, 0, nativeSession);
      nativeEdgePage.current = undefined;
      if (readerUsesShellGestures()) updateNativeReaderSlide(nativePageRef.current, undefined, 0, nativeSession);
      if (trackRef.current) trackRef.current.style.transform = 'translate3d(0,0,0)';
      return;
    }
    horizontalDrag.current ||= Math.abs(dx) > TAP_SLOP;
    const width = rootBox().width;
    const previous = dragSample.current;
    const dt = elapsed - (previous?.elapsed ?? 0);
    dragSample.current = { dx, elapsed, velocity: dt > 0 ? (dx - (previous?.dx ?? 0)) / dt : (previous?.velocity ?? 0) };
    const current = readerStateRef.current;
    const boundary = neighboursRef.current[dx < 0 ? 'next' : 'previous'].length === 0;
    const exits = boundary && (dx < 0 ? 'next' : 'previous') === (current.direction === 'rtl' ? 'previous' : 'next');
    const exitDistance = lastPageExitDistance(width);
    exitHintDrag.current = exits ? {
      progress: Math.min(1, Math.abs(dx) / exitDistance),
      ready: Math.abs(dx) >= exitDistance,
      side: dx < 0 ? 'right' : 'left',
    } : undefined;
    dragOffset.current = boundary ? rubberBand(dx, exits ? Math.min(360, width * 0.82) : Math.min(64, width * 0.16)) : Math.max(-width, Math.min(width, dx));
    // Android gives the DOM the swipe when the neighbour has no ready tile.
    // Its outgoing artwork is still native, so move it with the DOM track.
    if (boundary || (!readerUsesShellGestures() && zoomElementRef.current?.querySelector('[data-native-reader-visible]'))) {
      nativeEdgePage.current = nativePageRef.current;
    }
    else if (nativeEdgePage.current !== undefined) {
      updateNativeReaderEdge(nativeEdgePage.current, 0, 0, nativeSession);
      nativeEdgePage.current = undefined;
    }
    if (dragFrame.current === undefined) dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = undefined;
      if (trackRef.current) trackRef.current.style.transform = `translate3d(${dragOffset.current}px,0,0)`;
      if (nativeEdgePage.current !== undefined) updateNativeReaderEdge(nativeEdgePage.current, dragOffset.current / Math.max(1, width), 0, nativeSession);
      else if (readerUsesShellGestures()) {
        const nextIndex = neighboursRef.current[dragOffset.current < 0 ? 'next' : 'previous'][0];
        updateNativeReaderSlide(nativePageRef.current, nextIndex === undefined ? undefined : nextIndex + 1,
          dragOffset.current / Math.max(1, width), nativeSession);
      }
      const hint = exitHintRef.current;
      const cue = exitHintDrag.current;
      if (hint) {
        hint.dataset.visible = cue ? 'true' : 'false';
        hint.setAttribute('aria-hidden', cue ? 'false' : 'true');
        if (cue) {
          const ready = String(cue.ready);
          if (hint.dataset.ready !== ready) {
            hint.dataset.ready = ready;
            hint.setAttribute('aria-label', cue.ready ? '松手退出阅读' : '继续拖动退出');
          }
          hint.dataset.side = cue.side;
          hint.style.setProperty('--reader-exit-progress', String(cue.progress));
          hint.style.setProperty('--reader-exit-midpoint', `${Math.abs(dragOffset.current) / 2}px`);
        }
      }
    });
  }, [hideExitHint]);

  useLayoutEffect(() => {
    if (!pageActive || effectiveLayout === 'webtoon' || thumbnailPanelOpen) return;
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<ZoomState & { session: number; page: number }>).detail;
      if (detail.session !== nativeSession || detail.page !== nativePageRef.current) return;
      const zoom = { scale: detail.scale, panX: detail.panX, panY: detail.panY };
      rememberNativeReaderZoom(detail.page, detail.session, zoom);
      setZoom(zoom, false);
    };
    const gesture = (event: Event) => {
      const detail = (event as CustomEvent<{ session: number; page: number; active: boolean }>).detail;
      if (detail.session !== nativeSession || detail.page !== nativePageRef.current) return;
      if (detail.active) {
        hideChromeForZoomRef.current?.();
        // UIKit may have accepted the newly presented neighbour while its
        // WebKit configuration is still in flight.
        pinchStart.current = undefined;
        setPanning(false);
        touchStartRef.current = null;
        panStart.current = undefined;
        nativePinchTouches.current = true;
      } else {
        nativePinchTouches.current = false;
        resumeHandover(180);
      }
      setNativeBusy(detail.active);
    };
    const zoomStart = (event: Event) => {
      const { session, page } = (event as CustomEvent<{ session: number; page: number }>).detail;
      if (session === nativeSession && page === nativePageRef.current) hideChromeForZoomRef.current?.();
    };
    window.addEventListener('yomika-reader-native-zoom-start', zoomStart);
    window.addEventListener('yomika-reader-native-zoom', sync);
    window.addEventListener('yomika-reader-native-pinch', gesture);
    return () => {
      nativePinchPage.current = undefined;
      nativePinchTouches.current = false;
      window.removeEventListener('yomika-reader-native-zoom-start', zoomStart);
      window.removeEventListener('yomika-reader-native-zoom', sync);
      window.removeEventListener('yomika-reader-native-pinch', gesture);
      hideExitHint();
      setNativeBusy(false);
      void configureNativePinchInput(nativeSession, nativePageRef.current, false, 3, reduceMotion);
    };
  }, [effectiveLayout, hideExitHint, nativeSession, pageActive, reduceMotion, resumeHandover, setNativeBusy, setZoom, thumbnailPanelOpen]);

  useLayoutEffect(() => { setNativeBusy(false); }, [nativePage, nativeSession, setNativeBusy]);

  // The bars share the reader's swipe surface. Keep the native neighbours armed
  // while chrome is visible, so native artwork still follows the finger.
  const nativeCanTurn = !thumbnailPanelOpen && !autoPlay;
  const nativeLeftPage = nativeCanTurn ? (neighbourIndexes.next[0] ?? -1) + 1 : 0;
  const nativeRightPage = nativeCanTurn ? (neighbourIndexes.previous[0] ?? -1) + 1 : 0;
  useLayoutEffect(() => {
    if (!pageActive || effectiveLayout === 'webtoon' || thumbnailPanelOpen) return;
    let mounted = true;
    void configureNativePinchInput(nativeSession, nativePage, true, Math.min(14, maxSettledZoom.current), reduceMotion, nativeLeftPage, nativeRightPage).then((ready) => {
      if (mounted && ready) nativePinchPage.current = nativePage;
    });
    return () => { mounted = false; };
  }, [effectiveLayout, nativeLeftPage, nativePage, nativeRightPage, nativeSession, pageActive, reduceMotion, thumbnailPanelOpen]);

  const getDoubleTapProfile = useCallback(() => {
    const frame = zoomElementRef.current;
    const image = frame?.querySelector<HTMLImageElement>('img.reader-page:not(.is-candidate)');
    if (!frame?.classList.contains('reader-single')) return readerDoubleTapProfile(undefined, rootBox());
    const sourceSize = pageSizes.get(readerStateRef.current.pageIndex);
    const animated = image ? /(?:^data:image\/gif[;,]|\.gif(?:[?#]|$))/i.test(image.src) : false;
    return readerDoubleTapProfile(sourceSize ? { ...sourceSize, animated } : image ? {
      width: image.naturalWidth,
      height: image.naturalHeight,
      animated,
    } : undefined, rootBox());
  }, [pageSizes]);

  const animateDoubleTap = useCallback((clientX: number, clientY: number, profile = getDoubleTapProfile()) => {
    if (layoutRef.current === 'webtoon') return false;
    if (!readerUsesShellGestures() && zoomElementRef.current?.querySelector('[data-native-reader-visible]')) {
      const accepted = requestNativeReaderDoubleTap(nativePageRef.current, clientX, clientY, reduceMotion, nativeSession);
      if (accepted) hideChromeForZoomRef.current?.();
      return accepted;
    }
    if (!canZoomCurrentImage()) return false;
    const element = zoomElementRef.current;
    const current = readLiveZoom();
    const point = viewportPoint(clientX, clientY);
    const next = doubleTapZoomAt(current, point.x, point.y, profile);
    if (profile.large) {
      maxSettledZoom.current = Math.max(3, profile.cropScale);
      if (nativePinchPage.current === nativePageRef.current) void configureNativePinchInput(nativeSession, nativePageRef.current, true, Math.min(14, maxSettledZoom.current), reduceMotion,
        nativeLeftPage, nativeRightPage);
    }
    const animateNative = readerUsesShellGestures() && !reduceMotion && next.scale !== current.scale;
    if (next.scale !== current.scale) hideChromeForZoomRef.current?.();
    setZoom(next, !animateNative);
    if (animateNative) updateNativeReaderTransform(nativePageRef.current, next, nativeSession, current, profile.duration);
    if (element) {
      element.style.transition = 'none';
      element.style.transform = `scale(${next.scale}) translate(${next.panX}px, ${next.panY}px)`;
    }
    if (element?.animate && !reduceMotion && next.scale !== current.scale) {
      // Interpolate the screen-space translation so the content under the tap
      // stays there throughout the zoom, including the intermediate frames.
      const transform = ({ scale, panX, panY }: ZoomState) => `translate(${panX * scale}px, ${panY * scale}px) scale(${scale})`;
      const animation = element.animate([{ transform: transform(current) }, { transform: transform(next) }], {
        duration: profile.duration,
        easing: profile.large ? 'cubic-bezier(.455,.03,.515,.955)' : 'ease-in-out',
      });
      zoomAnimationRef.current = animation;
      animation.onfinish = () => { if (zoomAnimationRef.current === animation) zoomAnimationRef.current = undefined; };
    }
    resumeHandover(profile.duration + 32);
    return true;
  }, [canZoomCurrentImage, getDoubleTapProfile, nativeLeftPage, nativeRightPage, nativeSession, readLiveZoom, reduceMotion, resumeHandover, setZoom]);

  const touchDoubleTap = useCallback((x: number, y: number, time: number) => {
    const previous = lastTapRef.current;
    if (!previous || time - previous.time >= 300 || Math.hypot(x - previous.x, y - previous.y) > 40) {
      lastTapRef.current = { x, y, time };
      return;
    }
    lastTapRef.current = undefined;
    if (animateDoubleTap(previous.x, previous.y)) touchZoomAt.current = time;
  }, [animateDoubleTap]);

  const handleTouchStart = useCallback((event: TouchEvent) => {
    // 和鼠标那条同一件事：面板开着的时候整个画布手势都让开，指针只属于面板那一层。
    if (thumbnailPanelOpen) return;
    const firstTouch = event.touches[0];
    if (event.touches.length === 1 && firstTouch && isIosBackEdge(firstTouch.clientX)) return;
    const target = event.target as Element;
    const toolbar = Boolean(target.closest('.reader-toolbar'));
    if (!toolbar && target.closest('button, a, input, .reader-chrome, .reader-overview, .reader-overview-backdrop')) return;
    if (toolbar && (event.touches.length > 1 || layoutRef.current === 'webtoon' || zoomScaleRef.current > PAGE_SWIPE_MAX_ZOOM)) return;
    // Commit the previous landing before accepting the next gesture. Dropping
    // touches throughout the animation made rapid consecutive swipes feel late.
    if (sliding.current) finishSlideRef.current?.();
    dragSample.current = undefined;
    horizontalDrag.current = false;
    const touch = event.touches[0];
    if (!touch) return;
    pauseHandover();
    // Two fingers are a pinch, never a page turn: a zoom gesture used to leave a
    // drag offset behind and could commit a turn on release.
    if (event.touches.length > 1) {
      lastTapRef.current = undefined;
      quickScale.current = undefined;
      hideExitHint();
      touchStartRef.current = null;
      // A second finger takes ownership immediately, including during a swipe's
      // settling animation. Starting another 200ms snap-back delayed the pinch.
      if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
      dragFrame.current = undefined;
      slideAnimation.current?.cancel();
      slideAnimation.current = undefined;
      finishSlideRef.current = undefined;
      sliding.current = false;
      dragOffset.current = 0;
      nativeEdgePage.current = undefined;
      if (readerUsesShellGestures()) updateNativeReaderSlide(nativePageRef.current, undefined, 0, nativeSession);
      if (trackRef.current) trackRef.current.style.transform = 'translate3d(0,0,0)';
      if (layoutRef.current !== 'webtoon') {
        gestureMovedRef.current = true;
        if (nativePinchPage.current === nativePageRef.current && zoomElementRef.current?.querySelector('[data-native-reader-visible]')) {
          nativePinchTouches.current = true;
          panStart.current = undefined;
          return;
        }
        const waitingForImage = !canZoomCurrentImage();
        const second = event.touches[1]!;
        pinchStart.current = { distance: Math.max(1, Math.hypot(second.clientX - touch.clientX, second.clientY - touch.clientY)), x: (touch.clientX + second.clientX) / 2, y: (touch.clientY + second.clientY) / 2, zoom: readLiveZoom(), waitingForImage };
        panStart.current = undefined;
        if (!waitingForImage) setPanning(true);
        gestureMovedRef.current = true;
      }
      return;
    }
    const previousTap = lastTapRef.current;
    if (!toolbar && previousTap && Date.now() - previousTap.time < 300 && Math.hypot(touch.clientX - previousTap.x, touch.clientY - previousTap.y) <= 40
      && layoutRef.current !== 'webtoon' && canZoomCurrentImage()) {
      const profile = getDoubleTapProfile();
      if (profile.large) {
        lastTapRef.current = undefined;
        quickScale.current = { x: previousTap.x, y: previousTap.y, lastY: touch.clientY, span: 20, moved: false, profile };
        return;
      }
    }
    if (zoomRef.current.scale > PAGE_SWIPE_MAX_ZOOM && layoutRef.current !== 'webtoon') {
      panStart.current = { x: touch.clientX, y: touch.clientY, zoom: zoomRef.current };
      setPanning(true);
    }
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now(), toolbar };
  }, [hideExitHint, thumbnailPanelOpen, pauseHandover, canZoomCurrentImage, getDoubleTapProfile, readLiveZoom]);

  const handleTouchMove = useCallback((event: TouchEvent) => {
    const quick = quickScale.current;
    const finger = event.touches[0];
    if (quick && finger && event.touches.length === 1) {
      const span = Math.abs(quick.y - finger.clientY) * 2 + 20;
      const delta = Math.abs(1 - span / quick.span) * 0.5;
      if (delta > 0.03 || quick.moved) {
        if (!quick.moved) {
          readLiveZoom();
          setPanning(true);
        }
        quick.moved = true;
        maxSettledZoom.current = Math.max(3, quick.profile.cropScale);
        const scale = Math.max(1, Math.min(maxSettledZoom.current, zoomRef.current.scale * (finger.clientY > quick.lastY ? 1 + delta : 1 - delta)));
        const point = viewportPoint(quick.x, quick.y);
        followZoom(boundLargeImageZoom(zoomAtPoint(zoomRef.current, scale, point.x, point.y), quick.profile), true);
      }
      quick.span = span;
      quick.lastY = finger.clientY;
      return;
    }
    const pinch = pinchStart.current;
    if (pinch && event.touches.length >= 2) {
      const first = event.touches[0]!;
      const second = event.touches[1]!;
      const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
      if (pinch.waitingForImage) {
        // Hold the most recent finger positions while the new page loads. This
        // keeps the gesture alive without accumulating a jump while it was blank.
        if (!canZoomCurrentImage()) {
          pinch.distance = Math.max(1, distance);
          pinch.x = (first.clientX + second.clientX) / 2;
          pinch.y = (first.clientY + second.clientY) / 2;
          return;
        }
        pinch.waitingForImage = false;
        setPanning(true);
      }
      const raw = pinch.zoom.scale * distance / pinch.distance;
      const scale = elasticPinchScale(raw, maxSettledZoom.current);
      const point = viewportPoint(pinch.x, pinch.y);
      const anchored = zoomAtPoint(pinch.zoom, scale, point.x, point.y);
      const box = rootBox();
      followZoom(panZoom(anchored, (first.clientX + second.clientX) / 2 - pinch.x, (first.clientY + second.clientY) / 2 - pinch.y, box.width, box.height), true);
      return;
    }
    if (panStart.current && event.touches[0]) {
      dragZoom(event.touches[0].clientX, event.touches[0].clientY, true);
      return;
    }
    const start = touchStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch || event.touches.length > 1) {
      if (dragOffset.current !== 0) finishDrag(0, 0);
      touchStartRef.current = null;
      return;
    }
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    gestureMovedRef.current ||= Math.hypot(dx, dy) > TAP_SLOP;
    trackDrag(dx, dy, Date.now() - start.time);
  }, [canZoomCurrentImage, trackDrag]);

  const handleChromeTouchTap = useCallback((event: TouchEvent, clientY: number) => {
    const pointer = { clientY, target: event.target, stopPropagation: () => event.stopPropagation() };
    if (hoverTarget(pointer) === null) return false;
    chromeTouchAt.current = Date.now();
    touchZoomAt.current = Date.now();
    lastTapRef.current = undefined;
    gestureMovedRef.current = false;
    handleCanvasClick(pointer);
    return true;
  }, [handleCanvasClick, hoverTarget]);

  const handleTouchEnd = useCallback((event: TouchEvent) => {
    touchEndAt.current = Date.now();
    if (nativePinchTouches.current) {
      if (event.touches.length === 0) {
        nativePinchTouches.current = false;
        touchZoomAt.current = Date.now();
        resumeHandover(180);
      }
      return;
    }
    if (event.touches.length === 0) {
      resumeHandover(pinchStart.current || panStart.current ? 180 : EDGE_SETTLE_MS + 32);
    }
    const quick = quickScale.current;
    if (quick && event.touches.length === 0) {
      quickScale.current = undefined;
      touchStartRef.current = null;
      touchZoomAt.current = Date.now();
      if (quick.moved) {
        gestureMovedRef.current = true;
        setPanning(false);
        settleZoomNow();
      } else animateDoubleTap(quick.x, quick.y, quick.profile);
      return;
    }
    if (pinchStart.current || panStart.current) {
      const start = touchStartRef.current;
      const end = event.changedTouches[0];
      const tap = !pinchStart.current && start && end && event.touches.length === 0
        && Math.hypot(end.clientX - start.x, end.clientY - start.y) < 10;
      if (tap) {
        if (handleChromeTouchTap(event, end.clientY)) {
          panStart.current = undefined;
          touchStartRef.current = null;
          setPanning(false);
          settleZoomNow();
          return;
        }
        touchDoubleTap(end.clientX, end.clientY, Date.now());
        panStart.current = undefined;
        touchStartRef.current = null;
        setPanning(false);
        return;
      }
      pinchStart.current = undefined;
      quickScale.current = undefined;
      touchStartRef.current = null;
      const remaining = event.touches[0];
      if (remaining && zoomRef.current.scale > 1) {
        panStart.current = { x: remaining.clientX, y: remaining.clientY, zoom: zoomRef.current };
        return;
      }
      panStart.current = undefined;
      setPanning(false);
      settleZoomNow();
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

    gestureMovedRef.current ||= Math.hypot(dx, dy) > TAP_SLOP;
    if (!gestureMovedRef.current || (start.toolbar && !horizontalDrag.current)) finishDrag(0, 0);
    if (start.toolbar && !horizontalDrag.current) return;
    if (!gestureMovedRef.current && event.touches.length === 0 && elapsed < 500 && handleChromeTouchTap(event, touch.clientY)) return;

    if (zoomScaleRef.current > PAGE_SWIPE_MAX_ZOOM) return;

    if (!gestureMovedRef.current && event.touches.length === 0 && elapsed < 500) {
      touchDoubleTap(touch.clientX, touch.clientY, Date.now());
      return;
    }
    lastTapRef.current = undefined;

    // Continuous scroll pages by scrolling; a horizontal flick there used to move
    // the page index behind the scroller's back.
    if (layoutRef.current === 'webtoon') return;
    if (!horizontalDrag.current && Math.abs(dx) <= Math.abs(dy)) { finishDrag(0, 0); return; }
    // Same distance and recent-velocity rule as the mouse.
    finishDrag(dx, elapsed, true);
  }, [animateDoubleTap, handleChromeTouchTap, settleZoomNow, resumeHandover, touchDoubleTap]);

  /** Windows fires mouse events for a trackpad or mouse drag, so paging needs a
   * press-drag-release gesture here; touch keeps its own swipe handler. */
  const pointerStartRef = useRef<{ x: number; y: number; time: number; toolbar: boolean } | null>(null);

  const handleMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    if (Date.now() - touchEndAt.current < 600) return;
    // 面板那一层（蒙版 + 面板体）是自己的，不是画布：落在它上面的按下不开始画布手势。
    // `.reader-overview` 只匹配面板体，蒙版得自己列出来。
    const target = event.target as Element;
    const toolbar = Boolean(target.closest('.reader-toolbar'));
    if (!toolbar && target.closest('button, a, input, .reader-chrome, .reader-overview, .reader-overview-backdrop')) return;
    if (toolbar && (layoutRef.current === 'webtoon' || zoomScaleRef.current > PAGE_SWIPE_MAX_ZOOM)) return;
    if (sliding.current) finishSlideRef.current?.();
    dragSample.current = undefined;
    horizontalDrag.current = false;
    if (event.button !== 0) return;
    pauseHandover();
    gestureMovedRef.current = false;
    if (zoomRef.current.scale > PAGE_SWIPE_MAX_ZOOM && layoutRef.current !== 'webtoon') {
      panStart.current = { x: event.clientX, y: event.clientY, zoom: zoomRef.current };
      setPanning(true);
      return;
    }
    pointerStartRef.current = { x: event.clientX, y: event.clientY, time: Date.now(), toolbar };
  }, [pauseHandover]);

  const handleMouseMove = useCallback((event: MouseEvent<HTMLElement>) => {
    // 缩略面板是压在阅读器上的一层。它在的时候指针既不该唤出/切换两条栏，也不该开始
    // 画布手势：hover 判定只认指针坐标（蒙版挡不住一个 mouseMove），曾经因此能从蒙版
    // 上把底栏划出来、顺带把亮着的顶栏撤掉。面板自己内部的滚动/点击不受影响。
    if (thumbnailPanelOpen) return;
    if (!event.buttons && !window.matchMedia?.(COARSE_POINTER_QUERY).matches) setHover(hoverTarget(event));
    if (panStart.current && event.buttons === 1) { dragZoom(event.clientX, event.clientY); return; }
    const start = pointerStartRef.current;
    if (!start || event.buttons !== 1) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    gestureMovedRef.current ||= Math.hypot(dx, dy) > TAP_SLOP;
    trackDrag(dx, dy, Date.now() - start.time);
  }, [hoverTarget, setHover, trackDrag, thumbnailPanelOpen]);

  const handleMouseUp = useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.button === 0) resumeHandover(EDGE_SETTLE_MS + 32);
    if (panStart.current) {
      dragZoom(event.clientX, event.clientY);
      panStart.current = undefined;
      setPanning(false);
      settleZoomNow();
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
    gestureMovedRef.current ||= Math.hypot(dx, dy) > TAP_SLOP;
    if (zoomScaleRef.current > PAGE_SWIPE_MAX_ZOOM || layoutRef.current === 'webtoon') return;
    if (!gestureMovedRef.current || (start.toolbar && !horizontalDrag.current) || (!horizontalDrag.current && Math.abs(dx) <= Math.abs(dy))) {
      finishDrag(0, 0);
      return;
    }
    finishDrag(dx, Date.now() - start.time);
  }, [resumeHandover, settleZoomNow]);

  /** 连续阅读的滚动：一帧只认一次。
   *
   * 每次 scroll 事件都 setState 意味着一条惯性滚动会连着渲染几十次，而窗口（`first`
   * 与 `last` 两个页号）在一帧里只可能有一个答案。位置先记进 ref，帧回调再写 state；
   * 同一帧里后来的事件只是覆盖那个数，不再各自排一次渲染。 */
  const webtoonOffsetRef = useRef(0);
  const webtoonScrollFrameRef = useRef<number>();
  const syncWebtoonScroll = useCallback((offset: number) => {
    pauseHandover();
    resumeHandover();
    webtoonScrolledRef.current = true;
    webtoonOffsetRef.current = offset;
    if (webtoonScrollFrameRef.current !== undefined) return;
    webtoonScrollFrameRef.current = requestAnimationFrame(() => {
      webtoonScrollFrameRef.current = undefined;
      setScrollTop(webtoonOffsetRef.current);
    });
  }, [pauseHandover, resumeHandover]);
  const handleWebtoonScroll = useCallback((event: UIEvent<HTMLElement>) => {
    syncWebtoonScroll(event.currentTarget.scrollTop);
  }, [syncWebtoonScroll]);
  useLayoutEffect(() => {
    const container = webtoonRef.current;
    if (!pageActive || effectiveLayout !== 'webtoon' || !container) return;
    return trackNativeContinuousInput(container, allocateNativeReaderSession(), syncWebtoonScroll);
  }, [pageActive, effectiveLayout, nativeSession, syncWebtoonScroll]);
  const continuousExtent = pageOffsets[pageOffsets.length - 1] ?? 0;
  useLayoutEffect(() => {
    const container = webtoonRef.current;
    if (!pageActive || effectiveLayout !== 'webtoon' || !container) return;
    configureNativeContinuousInput(container,
      !topPresence.mounted && !bottomPresence.mounted && !thumbnailPanelOpen,
      continuousExtent, reduceMotion);
  }, [pageActive, effectiveLayout, nativeSession, syncWebtoonScroll, continuousExtent, viewport.height, reduceMotion, topPresence.mounted, bottomPresence.mounted, thumbnailPanelOpen]);
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
    const offset = pageOffsetsRef.current[index] ?? 0;
    container.scrollTop = offset;
    repositionNativeContinuousInput(container, offset);
    setScrollTop(offset);
  }, []);

  function cancelGesture() {
    if (touchStartRef.current || pointerStartRef.current || panStart.current) gestureMovedRef.current = true;
    resumeHandover();
    touchStartRef.current = null;
    pointerStartRef.current = null;
    pinchStart.current = undefined;
    quickScale.current = undefined;
    panStart.current = undefined;
    setPanning(false);
    if (nativePinchTouches.current) {
      nativePinchTouches.current = false;
      resumeHandover(180);
      return;
    }
    settleZoomNow();
    if (!sliding.current) finishDrag(0, 0);
  }

  useEffect(() => {
    if (!pageActive) return;
    const cancel = () => {
      setNativeBusy(false);
      cancelGesture();
    };
    const visibility = () => { if (document.visibilityState === 'hidden') cancel(); };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [pageActive, resumeHandover, settleZoomNow]);

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
  // 「是不是桌面窗口」要正向问平台：Tauri 桥在 Android/iOS 上一样存在，只看桥
  // 就会在手机上画出这颗按钮——而 `plugin:window|toggle_maximize` 在那边没有意义
  // （点了没反应，错还被 `.catch` 吞掉），用户报的「移动端下阅读模式顶栏不应该有
  // 最大化/最小化按钮」就是它。首帧先不画，等平台问回来；阅读态的顶栏本来就要
  // 唤出，晚一拍看不见（外壳的标题栏用的是同一条判据）。
  const [platform, setPlatform] = useState<string>();
  useEffect(() => {
    void getPlatformCapabilities().then((result) => {
      if (result.ok) setPlatform(result.value.platform);
    });
  }, []);
  const renderWindowMaximize = () => windowApi && platform === 'windows' ? (
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
    Number(Boolean(upscale?.configured)) + Number(Boolean(dlssnr?.configured));
  const autoPlayJoinsProcessing = enhancementCount < 2;
  const autoPlayControl = (
    <button type="button" aria-label={autoPlay ? '停止自动翻页' : '自动翻页'} aria-pressed={autoPlay} onClick={() => { hapticFeedback('light'); setAutoPlay((value) => !value); }}><SvgIcon data-icon="auto-turn" data-icon-state={autoPlay ? 'filled' : 'outline'}>
      <rect x="2" y="3" width="20" height="18" rx="2.5" />
      {autoPlay ? <path d="M8.5 8.5H11v7H8.5zm4.5 0h2.5v7H13z" fill="currentColor" stroke="none" /> : <path d="m9.5 8.5 6 3.5-6 3.5z" />}
    </SvgIcon></button>
  );
  /** The Readoshi page pill: what is on screen and out of how many, spread
   * ranges joined with an en dash. It sits outside the auto-hiding chrome so
   * the number survives immersive reading, and ignores the pointer entirely
   * so a tap meant for the page never lands on it. */
  const indicatorIndexes = effectiveLayout === 'webtoon' ? [webtoonAnchor] : visibleIndexes;
  const shownIndexes = (indicatorIndexes.length > 0 ? indicatorIndexes : [state.pageIndex]).filter((index) => index >= 0 && index < pages.length);
  const pageIndicator = pages.length === 0 ? '' : `${shownIndexes.map((index) => index + 1).join('–')} / ${pages.length}`;
  /** Desktop keeps the pill in the bottom-right corner; touch devices keep it
   * centred at the bottom, including the first paint before image measurement.
   * It fades
   * out entirely in continuous mode or while zoomed — zooming back to 100%
   * brings it back. Measured off the real images: object-fit means the drawn
   * rect is the element's own.
   *
   * When even the corner still sits on the artwork (the image covers the
   * bottom-right too), no placement can be clear — Readoshi's answer is
   * overlap detection: the pill then only flashes after a page turn and goes
   * quiet until the next one. */
  const indicatorPlacement = coarsePointer ? 'bottom' : 'corner';
  const [indicatorOverlaps, setIndicatorOverlaps] = useState(false);
  const [indicatorFlash, setIndicatorFlash] = useState(true);
  /** 上一趟量到的结论（胶囊该在哪一档、当时的缩放）。第二趟只在它变了的时候才需要：
   *  变了才意味着胶囊正在两档之间滑、图片正在回弹，第一帧读到的是过渡中的位置。 */
  const measuredIndicator = useRef<{ placement: 'bottom' | 'corner'; scale: number }>({ placement: 'bottom', scale: 1 });
  useEffect(() => {
    if (!pageActive || handoverPaused || panning || effectiveLayout === 'webtoon' || zoom.scale > 1 || pages.length === 0) return;
    // Retained readers keep their panels mounted, so every query scopes to this
    // screen's own root — document-level selectors would measure another
    // reader's hidden pill and images.
    const root = rootRef.current;
    /** `remember` 只由「下一帧那一趟」传：`ResizeObserver` 与它回调里那一趟不能改写
     *  「上一次量到的结论」，否则图片 load 触发的那一趟会把结论提前记下，紧接着的下一帧
     *  那一趟就误判成「什么都没变」，该来的第二趟就不来了。 */
    const measure = (remember = false) => {
      if (!canPromote()) return true;
      const images = Array.from(root?.querySelectorAll<HTMLImageElement>('.reader-frame[aria-label="分页阅读"] img:not(.is-candidate)') ?? []);
      let union: DOMRect | undefined;
      for (const image of images) {
        // 还没解码完的那一页量到的是**盒子**（`min(100%, 100dvh)`），不是画出来的那一块：
        // 拿它算底缝，得到的永远是 0，胶囊于是先跳去右下角，等图片 load 完再跳回来——用户
        // 报的就是翻页那一下的闪动。跳过它，等于「还没量到就沿用上一次的结论」。
        if (image.naturalWidth === 0) continue;
        const rect = image.getBoundingClientRect();
        if (rect.width <= 0) continue;
        union = union ? new DOMRect(Math.min(union.x, rect.x), Math.min(union.y, rect.y), Math.max(union.right, rect.right) - Math.min(union.x, rect.x), Math.max(union.bottom, rect.bottom) - Math.min(union.y, rect.y)) : rect;
      }
      if (!union) return true;
      // 手机上不取右下角那一档：竖着把屏幕占满的页在桌面上会把胶囊推到右边缝里，可手指
      // 也在右下角，而且手机上那半格本来就不宽——用户报「移动端应该居中而不是在右下角」。
      const placement = coarsePointer ? 'bottom' : 'corner';
      const settled = measuredIndicator.current.placement === placement && measuredIndicator.current.scale === zoom.scale;
      if (remember) measuredIndicator.current = { placement, scale: zoom.scale };
      // Overlap is the pill's own rect (whatever placement it settled into —
      // the settle pass below runs after the placement transition) against the
      // drawn image union.
      const pill = root?.querySelector('.reader-page-indicator');
      if (!pill) return settled;
      const rect = pill.getBoundingClientRect();
      setIndicatorOverlaps(rect.left < union.right && rect.right > union.left && rect.top < union.bottom && rect.bottom > union.top);
      return settled;
    };
    // 第一趟在下一帧量。第二趟（240ms 后）只在结论会变或缩放还在缓动时才有意义——
    // 那时胶囊正从一档滑向另一档、图片正被缩放缓动拉回去，第一帧读到的是过渡中的
    // 位置。翻页本身常常不改结论，这一趟就是白读一次同步布局：用户报的「快速连续
    // 翻页卡顿」里每轮都有它。图片解码晚到那一档不靠它兜底——页图尺寸一变，下面的
    // observer 就会再量一次。
    let settle: number | undefined;
    const frame = requestAnimationFrame(() => {
      if (!measure(true)) settle = window.setTimeout(() => { measure(true); }, 240);
    });
    // The img element is what actually resizes when a page finishes loading
    // (its box is the drawn object-fit rect; frames and the track stay
    // viewport-sized), so the observer watches the page images themselves.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => { measure(); });
    if (observer && root) {
      for (const img of root.querySelectorAll('.reader-frame[aria-label] img:not(.is-candidate)')) observer.observe(img);
    }
    return () => { cancelAnimationFrame(frame); if (settle !== undefined) window.clearTimeout(settle); observer?.disconnect(); };
  }, [canPromote, coarsePointer, effectiveLayout, handoverPaused, pageActive, panning, pages.length, pageMeasurement, bottomPresence.mounted, bottomPresence.leaving, viewport.width, viewport.height, visibleIndexes, zoom.scale]);
  // Every page turn re-shows the pill for a moment. Where it rests in a
  // letterbox this changes nothing (it is persistent anyway); over the artwork
  // it is exactly Readoshi's brief flash, after which the pill goes quiet.
  useEffect(() => {
    setIndicatorFlash(true);
    const timer = window.setTimeout(() => setIndicatorFlash(false), INDICATOR_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [state.pageIndex]);
  // One transform for the slots on screen: scaling each image on its own made a
  // double spread overlap, because both grew from their own centre. It sits
  // *inside* the current frame rather than on the track that carries all three —
  // on the track, zooming out shrank the distance to the neighbours and brought
  // them into view beside the page being read.
  const needsStableZoomLayer = (indexes: readonly number[]) => indexes.some((index) => {
    const size = pageSizes.get(index);
    return derivedPages?.has(index) || (size !== undefined && size.width * size.height >= LARGE_READER_TEXTURE_PIXELS);
  });
  // Prepare the visible touch layer while the page is still at fit scale.
  // Once a gesture settles at a larger scale, release the hint so the WebView
  // can rasterize at the final scale with normal sampling.
  const warmZoomLayer = pageActive && zoom.scale === 1 && (coarsePointer || needsStableZoomLayer(visibleIndexes));
  const zoomStyle = {
    transform: `scale(${zoom.scale}) translate(${zoom.panX}px, ${zoom.panY}px)`,
    transformOrigin: 'center center',
    willChange: panning || warmZoomLayer ? 'transform' : undefined,
    cursor: zoom.scale > 1 ? (panning ? 'grabbing' : 'grab') : undefined,
  } as const;
  /** The track follows the finger, and eases back or through on release. */
  const dragStyle = {
    transform: 'translate3d(0,0,0)',
  } as const;

  /** One page: the image, or why it is not there yet. Always a slot, even when
   * empty — a spread whose halves appeared one at a time used to re-centre when
   * the second arrived, shifting the page under the reader's eyes. */
  const renderSlot = (index: number, pagesInSlot = 1, staging = false) => {
    const derived = derivedPages?.get(index);
    const source = derived && rejectedDerived.get(index) !== derived ? derived : loadedPages.get(index);
    // Whatever rendition is on screen, the page draws at the size its first
    // measurement established: an enhanced page must not be drawn larger than the
    // plain one it replaced (see `.reader-page` in reader.css).
    const natural = pageSizes.get(index);
    const size = natural && fitPageSize(natural, effectiveLayout === 'webtoon'
      ? { width: webtoonSlotWidth, height: Number.POSITIVE_INFINITY }
      : { width: viewport.width / pagesInSlot, height: viewport.height });
    // `decoding="async"` 与「先解码再换」都在 ReaderPageImage 里：默认的 `auto` 允许"下一
    // 帧就要画它"时在主线程上同步解一张几百万像素的页图，而这一刻屏幕上往往正转着加载圈
    // ——它就是主线程画的。
    const continuous = effectiveLayout === 'webtoon';
    const visible = pageActive && !continuous && visibleIndexes.includes(index);
    const tileCanTurn = visible && nativeCanTurn && zoom.scale === 1;
    return (
      <div className={`reader-slot${exhaustedPages.has(index) ? ' is-failed' : ''}`} key={index}>
        {source && !exhaustedPages.has(index)
          ? <ReaderPageImage continuous={continuous} tileEnabled={(!continuous || hasNativeReaderTiles()) && pagesInSlot === 1 && keepNativeSlots} tileVisible={continuous ? pageActive : visible} tileTurnTargets={tileCanTurn ? { left: (neighbourIndexes.next[0] ?? -1) + 1, right: (neighbourIndexes.previous[0] ?? -1) + 1, reduceMotion } : undefined} tileCurrent={visible && !thumbnailPanelOpen && zoom.scale === 1} index={index} source={source} fitWidth={size?.width} fitHeight={size?.height} onMeasured={measurePage} onDisplayed={staging ? undefined : onDerivedDisplayed} onFailed={staging ? ignoreStagedPageFailure : failPage} onRejected={onDerivedRejected} handoverPaused={handoverPaused || staging} canPromote={canPromote} readDomViewport={readDomViewport} applyNativeViewport={applyNativeViewport} />
          : <PageStatus failed={exhaustedPages.has(index)} onRetry={() => retryPage(index)} />}
      </div>
    );
  };

  const spreadClass = (indexes: readonly number[]) => (
    indexes.length > 1 ? `reader-spread${state.direction === 'rtl' ? ' is-rtl' : ''}` : 'reader-single'
  );

  return (
    <NativeReaderSession.Provider value={nativeSession}><main
      aria-label="漫画阅读器"
      className="reader-screen"
      data-image-interaction={handoverPaused}
      style={{ touchAction: effectiveLayout === 'webtoon' ? 'pan-y' : 'none' }}
      ref={rootRef}
      onPointerDownCapture={() => { gestureMovedRef.current = false; chromeTouchAt.current = -Infinity; }}
      onTouchStartCapture={(event) => {
        if (event.touches.length === 1) {
          gestureMovedRef.current = false;
          chromeTouchAt.current = -Infinity;
        }
      }}
      onClickCapture={(event) => {
        // WebViews can dispatch a compatibility click after releasing a swipe,
        // including on whichever toolbar control is under the finger.
        if (event.detail > 0 && (gestureMovedRef.current || Date.now() - chromeTouchAt.current < 600)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClick={(event) => {
        if (Date.now() - chromeTouchAt.current < 600) return;
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
      // 两条栏是压在画布上的自己的界面，落在它们上面的双击不是画布手势。以前这里
      // 只认「target 是不是按钮/输入框」，于是顶栏标题那一行、底栏三条分组之间的空处
      // 上双击会一路冒到这里，把它下面的图放大一次。顶栏上那两下手势（`windowDrag`）
      // 靠 `stopPropagation` 挡住了自己那一半，可它碰到控件就早退，底栏又根本没铺它，
      // 所以这一句必须落在画布这一层——两条栏都盖在 `.reader-chrome` 里。
      onDoubleClick={(event) => {
        if (Date.now() - touchZoomAt.current < 600) return;
        const target = event.target;
        if (target instanceof Element && target.closest('button, a, input, .reader-chrome, .reader-overview, .reader-overview-backdrop')) return;
        animateDoubleTap(event.clientX, event.clientY);
      }}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
        onPointerDown={(event) => {
          // 捕获画布上的按下是为了拖拽翻页。可是一旦抓住，Chromium 会把随后的 click
          // 改派给被捕获的 <main>——蒙版自己的 onClick 就永远收不到，面板的「点空白
          // 关闭」因此失效。面板那一层不参与画布手势，也就不该被捕获；输入框同理。
          if (event.pointerType === 'mouse' && event.button === 0 && !(event.target as Element).closest('button, a, input, .reader-chrome, .reader-overview, .reader-overview-backdrop')) event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerCancel={cancelGesture}
        onPointerUp={(event) => { if (event.pointerType === 'mouse') handleMouseUp(event); }}
        onLostPointerCapture={(event) => { if (event.pointerType === 'mouse' && (pointerStartRef.current || panStart.current)) cancelGesture(); }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      // Pointer capture keeps delivering the gesture after the cursor leaves the
      // canvas. Do not clear the start point here: doing so made a normal edge
      // drag cancel halfway through and made the release look like a jump.
      onMouseLeave={() => { clearHover(); if (!pointerStartRef.current && !panStart.current && dragOffset.current !== 0) finishDrag(0, 0); }}
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
            {/* Two spacers preserve the scroll extent without thousands of empty nodes. */}
            <div className="reader-webtoon-spacer" aria-hidden="true" style={{ height: pageOffsets[webtoonFirst] ?? 0 }} />
            {heights.slice(webtoonFirst, webtoonLast + 1).map((height, offset) => {
              const index = webtoonFirst + offset;
              return (
                <div className="reader-webtoon-slot" key={index} style={{ height: `${height}px` }}>
                  {renderSlot(index)}
                </div>
              );
            })}
            <div className="reader-webtoon-spacer" aria-hidden="true" style={{ height: pageOffsets[heights.length]! - pageOffsets[webtoonLast + 1]! }} />
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
            const sources = indexes.map((index) => {
              if (exhaustedPages.has(index)) return undefined;
              const derived = derivedPages?.get(index);
              return derived && rejectedDerived.get(index) !== derived ? derived : loadedPages.get(index);
            });
            const aspect = viewport.height > 0 ? viewport.width / viewport.height : 0;
            const nativeTarget = sources.every((url) => Boolean(url && canPresentNativePage(url)));
            // Keep the spread owner mounted while a compatibility rendition takes
            // over. Its predecessor still owns the viewport and pinch gestures.
            const nativeSpread = keepNativeSlots && indexes.length === 2 && aspect >= 0.1 && aspect <= 10 &&
              sources.every(Boolean) && (nativeTarget || indexes.every((index) => {
                const original = loadedPages.get(index);
                return original && canPresentNativePage(original);
              }));
            const spreadInteractive = pageActive && offset === 0 && !thumbnailPanelOpen && zoom.scale === 1;
            const spreadTurnTargets = spreadInteractive && nativeCanTurn
              ? { left: (neighbourIndexes.next[0] ?? -1) + 1, right: (neighbourIndexes.previous[0] ?? -1) + 1, reduceMotion }
              : undefined;
            const renderPages = (staging?: boolean) => indexes.map((index) => renderSlot(index, indexes.length, staging));
            return (
              <section
                key={indexes.join(',')}
                className="reader-frame"
                style={{ transform: `translateX(${offset * 100}%)` }}
                {...(offset === 0 ? { 'aria-label': '分页阅读' } : { 'aria-hidden': true, 'data-reader-neighbour': indexes.join(',') })}
              >
                {/* The layout class has to sit on the same element as the slots,
                    or the spread's two columns are declared on a parent the
                    halves are no longer children of. The zoom rides along here so
                    it scales the page and not the distance to the neighbours. */}
                <div
                  ref={offset === 0 ? zoomElementRef : undefined}
                  className={spreadClass(indexes)}
                  // Preserve the compositing hint as an oversized neighbour
                  // slides in and its existing frame becomes the active one.
                  style={offset === 0 ? zoomStyle : pageActive && coarsePointer && needsStableZoomLayer(indexes)
                    ? { transform: 'scale(1) translate(0px, 0px)', transformOrigin: 'center center', willChange: 'transform' } : undefined}
                >
                  {nativeSpread ? <NativeReaderSpread key={state.direction} source={{ urls: sources as [string, string], aspect }} nativeTarget={nativeTarget}
                    indexes={[indexes[0]!, indexes[1]!]} rtl={state.direction === 'rtl'} visible={pageActive && offset === 0}
                    interactive={spreadInteractive} turnTargets={spreadTurnTargets} paused={handoverPaused}
                    canPromote={canPromote} onMeasured={measurePage} onDisplayed={onDerivedDisplayed} onRejected={onDerivedRejected} applyNativeViewport={applyNativeViewport} fallback={renderPages} /> : renderPages()}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {autoPlay && pageActive && (
        <div className="reader-auto-turn-progress" role="progressbar" aria-label="自动翻页进度" aria-valuetext={autoTurnRunning ? `每次停留 ${autoTurnInterval / 1000} 秒` : '等待当前页加载或返回前台'} data-running={autoTurnRunning} data-direction={state.direction}>
          <span key={`${autoTurnPageKey}:${state.direction}:${autoTurnRunning}`} style={{ '--reader-auto-turn-duration': `${autoTurnInterval}ms` } as CSSProperties} />
        </div>
      )}

      {effectiveLayout !== 'webtoon' && <div ref={exitHintRef} className="reader-exit-hint" data-visible="false" data-ready="false" data-side="right" role="status" aria-label="继续拖动退出" aria-hidden="true">
        <LogOut className="reader-exit-hint-icon" aria-hidden="true" />
        <span className="reader-exit-hint-fill" aria-hidden="true">
          <LogOut className="reader-exit-hint-icon" />
        </span>
      </div>}

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
            onPointerDown={stopChromeToggle}
            {...windowDrag}
          >
              <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
            {/* 标题是这条栏的**直接**子项，才落得进中间那条轨道（相对整条栏居中，
                而不是相对返回按钮之后的剩余空间）。尾部控件自己一格。 */}
            <ReaderTitle title={title} />
            <div className="reader-chrome-actions">
              {incognito && <span className="reader-incognito-badge" title="无痕阅读：不记录进度与历史"><EyeOff aria-hidden="true" />无痕</span>}
              {renderWindowMaximize()}
            {/* 缩略面板从底栏挪上来：它是「这块档案」的一件事，和返回、标题、阅读
                设置同一层；底栏留给翻页与画面处理。 */}
              <button className="reader-icon-button reader-chrome-thumbnails" type="button" aria-label="缩略面板" aria-pressed={thumbnailPanelOpen} onClick={() => { hapticFeedback('light'); setThumbnailPanelOpen((value) => !value); }}><StateIcon name="grid" selected={thumbnailPanelOpen} /></button>
              <Link className="reader-icon-button reader-chrome-settings" to="/settings?section=reading" state={{ returnTo: `${pathname}${search}`, returnViaHistory: true }} aria-label="阅读设置" title="阅读设置"><Settings aria-hidden="true" /></Link>
            </div>
          </header>
        )}
        {bottomPresence.mounted && (
          <div
            className={`reader-toolbar${bottomPresence.leaving ? ' is-leaving' : ''}`}
            role="toolbar"
            aria-label="阅读控制"
            data-animated-press
            data-page-swipe={effectiveLayout !== 'webtoon' || undefined}
            onPointerDown={stopChromeToggle}
            onClick={stopChromeToggle}
          >
              {/* Re-mounted on every page turn: that is what replays the cue. Gated
                  on `showTurnCue` rather than `turnCue > 0` so that a bar which
                  mounts for a different reason (chrome coming back) carries no cue
                  with it — see `playedCue`. */}
              {/* Three slots, left to right: how the pages are arranged, where the
                  reader is, what is done to the page. The counter is the middle
                  slot by grid position, not by luck — the sides are equal `1fr`
                  tracks, so it stays centred whatever the two sides hold. */}
              <div className="reader-toolbar-group reader-toolbar-layout"><button type="button" aria-label={`阅读布局：${READER_LAYOUT_LABELS[state.layout]}，点击切换`} title={`阅读布局：${READER_LAYOUT_LABELS[state.layout]}`} onClick={() => { hapticFeedback('light'); setState((current) => ({ ...current, layout: nextReaderLayout(current.layout) })); }}>
                {state.layout === 'auto' ? <ScanText aria-hidden="true" /> : state.layout === 'single' ? <File aria-hidden="true" /> : state.layout === 'double' ? <BookOpen aria-hidden="true" /> : <GalleryVerticalEnd aria-hidden="true" />}
              </button>
              {/* One control, cycling 自动 → 单页 → 双页 → webtoon. Three separate
                  buttons spent three toolbar slots to express one choice, and
                  none of them could select 自动 once you left it.
                  No `aria-pressed` on direction either: it is a choice between
                  two, not a switch that is on, and the pressed styling made the
                  button look permanently hovered whenever the answer was
                  right-to-left. */}
              <button type="button" aria-label={state.direction === 'ltr' ? '从左到右' : '从右到左'} onClick={() => { hapticFeedback('light'); setState((current) => ({ ...current, direction: current.direction === 'ltr' ? 'rtl' : 'ltr' })); }}><ArrowRight aria-hidden="true" style={state.direction === 'rtl' ? { transform: 'scaleX(-1)' } : undefined} /></button>
              {!autoPlayJoinsProcessing && autoPlayControl}</div>
              <div className="reader-toolbar-group reader-toolbar-pages">
                <span className="reader-toolbar-counter">{pages.length === 0 ? '0 / 0' : `${state.pageIndex + 1} / ${pages.length}`}</span>
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
                  onClick={() => { hapticFeedback('light'); upscale.toggle(); }}
                ><UpscaleIcon enabled={upscale.configured && upscale.active} /></button>
              )}
              {dlssnr?.configured && (
                <button type="button" aria-pressed={dlssnr.active} aria-label={dlssnr.active ? '关闭 DLSSNR' : '开启 DLSSNR'} title="DLSSNR" onClick={() => { hapticFeedback('light'); dlssnr.toggle(); }}><DlssnrIcon enabled={dlssnr.active} /></button>
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
            thumbnailAt={(index) => thumbnails.get(index) ?? loadedPages.get(index)}
            onRangeChange={onThumbnailRange}
            onSelectPage={(index) => { jumpToPage(index); setThumbnailPanelOpen(false); }}
            onClose={() => setThumbnailPanelOpen(false)}
            onPanelClick={stopChromeToggle}
          />
        </div>
      )}
      {pages.length > 0 && (() => {
        // Overlapping artwork + flash expired → the pill goes quiet until the
        // next page turn; letterbox placements stay persistent as before.
        //
        // 底栏在的时候也安静下来（2026-10-15 用户要求：底栏一出现，页码就让位）。
        // 原来是把胶囊抬到栏顶（`.is-raised`）——那只是把重叠换了个高度：两块小台面
        // 在同一段时间里抢同一块地方，用户看到的仍是「底栏上面还挂着一块东西」。
        // 现在整段「栏在（含退场那 260ms）」都算安静，栏摘掉之后按原来那条
        // `--motion-standard` 淡回来。`is-leaving` 留着：它管的是退场那一刻的落位
        // 时序，与胶囊现在动不动位置无关。
        const quiet = effectiveLayout === 'webtoon' || panning || zoom.scale > 1 || (indicatorOverlaps && !indicatorFlash) || bottomPresence.mounted || bottomPresence.leaving;
        return (
          <div
            className={`reader-page-indicator${bottomPresence.leaving ? ' is-leaving' : ''}`}
            data-placement={indicatorPlacement}
            data-visible={!quiet}
            aria-hidden="true"
          >{pageIndicator}</div>
        );
      })()}
    </main></NativeReaderSession.Provider>
  );
}
