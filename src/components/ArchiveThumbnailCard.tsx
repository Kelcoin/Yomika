import { RefreshIcon as RefreshCw } from './RefreshIcon';
import { CardTagRows, ArchiveCardTags } from './CardTagRows';
import { CardProgressBar } from './CardProgressBar';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Heart } from 'lucide-react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import type { ArchiveRecord } from '../domain/library';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { CARD_TAG_LIMIT_THUMBNAIL, formatArchiveDate, formatArchivePageMeta, isWideCoverMarked, isWideCoverRatio, rememberWideCoverMark } from '../lib/archiveCardPresentation';
import { peekCachedImageUrl } from '../lib/unifiedImageCache';
import { useHorizontalScroller } from '../lib/horizontalScroller';
import { longPressHandlers } from '../lib/longPressMenu';
import { useMediaQuery, COMPACT_WIDTH_QUERY } from '../lib/useMediaQuery';
import { observeOnceInScroll } from '../lib/sharedIntersectionObserver';
import { useProgressBarVisibility } from '../app/preferences';

const imageCache = getNativeImageCache();

/** The thumbnail card's media + copy stack, shared by the recommendation rail
 * and the library grid so both are literally the same card. The caller supplies
 * the root element (an anchor in the rail, a button in the grid) and the meta
 * line, which carries different facts in each place. The tag slot picks and
 * colours its own tags from the raw list, so a caller cannot pass a differently
 * ordered or differently coloured set by accident. */
export function ArchiveProgressBar({ page, pageCount, visibility, scope = 'elsewhere', cornerAware = false }: { page?: number | null | undefined; pageCount: number; visibility?: 'none' | 'history' | 'all' | undefined; /** 这张卡长在哪儿：`history` 只给首页那一排（继续阅读，历史派生出来的）与历史记录页面这两处，别处一律 `elsewhere`。 */ scope?: 'history' | 'elsewhere' | undefined; cornerAware?: boolean }) {
  const preferredVisibility = useProgressBarVisibility();
  const mode = visibility ?? preferredVisibility ?? 'history';
  /** 钩子不能排在早退之后：mode 或 page 一变，钩子数量就跟着变。测量那一半在
   * `CardProgressBar` 里（它自己是个组件，没渲染就没有钩子），这里只剩这一个。 */
  // 「有进度」本身要先成立：`page` 是 1 起算的页号，没有记录时是 null/undefined。
  // 原来只有 `history` 档挡了空值，`all` 档会给没读过的卡画一条 0% 的空条——用户报的
  // 「全部档案卡片都显示有进度条，哪怕没阅读过」。至少读过一页（`page >= 1`）才叫进度。
  const read = typeof page === 'number' && page >= 1;
  // 档位说的不只是「画不画」，还有「在哪儿画」：用户的原话是「仅历史记录是指仅在首页
  // 历史记录组件和历史记录页面内显示进度条，全部是指所有有进度的不管在什么页面都显示」。
  // 所以 `仅历史记录` 要配上「这里算不算那两处」，由调用方用 `scope` 讲清楚——在这里猜
  // 路由（读 location、看组件树）都试过，猜错一次就是「改了设置没反应」这类毛病。
  const allowed = mode === 'all' || (mode === 'history' && scope === 'history');
  const visible = allowed && read;
  if (!visible) return null;
  const percent = pageCount > 0 ? Math.min(100, (page / pageCount) * 100) : 1;
  return <CardProgressBar percent={percent} label="阅读进度" cornerAware={cornerAware} />;
}

export function ArchiveThumbCardBody({ title, tags, meta, favorite = false, limit = CARD_TAG_LIMIT_THUMBNAIL, progressPage, pageCount = 0, progressVisibility, progressScope }: { title: string; tags: readonly string[] | undefined; meta: ReactNode; favorite?: boolean; limit?: number; progressPage?: number | null | undefined; pageCount?: number; progressVisibility?: 'none' | 'history' | 'all' | undefined; progressScope?: 'history' | 'elsewhere' | undefined }) {
  return <div className="archive-thumb-card-body">
    <ArchiveProgressBar page={progressPage} pageCount={pageCount} visibility={progressVisibility} scope={progressScope} />
    <div className="archive-thumb-card-title"><strong>{title}</strong>{favorite && <Heart aria-hidden="true" fill="currentColor" />}</div>
    {/* fill: the two rows pack top-down and the rest of the (deliberately
        generous) tag list is dropped, so the slot reads full at any card
        width — the list row's waterfall keeps its own spreading behaviour. */}
    <ArchiveCardTags tags={tags} limit={limit} rowCount={2} fill className="archive-thumb-card-tags" />
    <ArchiveThumbMeta>{meta}</ArchiveThumbMeta>
  </div>;
}

export function ArchiveThumbMeta({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    let active = true;
    const fit = () => {
      if (!active || node.clientWidth <= 0) return;
      node.style.removeProperty('--archive-thumb-meta-fitted-size');
      const style = getComputedStyle(node);
      const base = parseFloat(style.fontSize) || 11;
      const minimum = parseFloat(style.getPropertyValue('--archive-thumb-meta-min-font-size')) || 10;
      const gap = parseFloat(style.columnGap) || 4;
      const needed = () => [...node.children].reduce((width, child) => width + child.scrollWidth, 0) + gap * Math.max(0, node.children.length - 1);
      for (let size = base; needed() > node.clientWidth && size > minimum;) {
        size = Math.max(minimum, size - 0.5);
        node.style.setProperty('--archive-thumb-meta-fitted-size', `${size}px`);
      }
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
    observer?.observe(node);
    void document.fonts?.ready.then(fit);
    return () => { active = false; observer?.disconnect(); };
  }, [children]);
  return <div ref={root} className="archive-thumb-card-meta">{children}</div>;
}

/** The cover box on its own: lazily loaded cover, a shimmer until it lands, and
 * the slot the selection marker sits in (children). Every card that shows a
 * cover uses this one, so the duplicate workspace's member cards get the same
 * cache handling as the library grid instead of a second implementation. */
export function ArchiveThumbMedia({ scopeId, serverId, archiveId, onAspectRatio, children }: {
  scopeId: string;
  serverId: string;
  archiveId: string;
  onAspectRatio?: ((ratio: number) => void) | undefined;
  children?: ReactNode;
}) {
  /** 这一张封面在缓存里的身份。渲染期（第一帧要不要直接画图）和取图 effect 必须用同一份，
   * 所以在这里拼一次。 */
  const identity = useMemo(() => ({ scopeId, serverId, archiveId, rendition: 'cover' as const, pageIndex: 0 }), [scopeId, serverId, archiveId]);
  /** 第一帧就先看一眼缓存里有没有：切页、回到前台时这张封面**还在缓存里**，只是这个组件
   * 被重新挂载了。以前它一律从 `undefined` 起步、先渲染占位块，等 `load` 的 Promise 落地
   * 才换成 `<img>`——同一张图、同一个 URL，却先闪一下骨架，这就是切换页面时封面闪动的来源。
   * 用只读的 `peekUrl` 而不是 `peek`：渲染可能被丢弃（StrictMode 会把渲染跑两遍），加引用
   * 就会多出没人还的引用、把条目钉在缓存里。 */
  const [src, setSrc] = useState<string | undefined>(() => peekCachedImageUrl(imageCache, identity));
  /** 封面取不回来（服务器 202、图已删、离线）时不是「还在加载」。两者都用同一个
   * 占位块占着位置，但只有真的还在等的那一个该闪——闪动动的是 background-position，
   * 属主线程每帧重画，一屏几十张失败的封面就是几十个元素一直在画，而它们永远不会
   * 变成图。 */
  const [failed, setFailed] = useState(false);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!node) return undefined;
    const controller = new AbortController();
    let handle: import('../lib/unifiedImageCache').ImageHandle | undefined;
    /** 只还一次：取图可能在 cleanup 之后才落地（那时由它自己还），cleanup 也会试着还一次，
     * 两次都还就等于扣掉别人的引用。 */
    let released = false;
    const releaseHandle = () => { if (released || !handle) return; released = true; imageCache.release(handle); };
    // retain: 最后一个消费者放手后这张封面继续留在缓存里，重新挂载的第一帧才有东西可同步拿
    // （见上面的 useState 初值）。它照样受缓存自己的 96MiB / 256 条预算约束，超了就被挤出去。
    const load = () => void imageCache.load(identity, { signal: controller.signal, retain: true }).then((value) => {
      handle = value;
      // 图落地时这张卡已经卸载了：这次引用没人接手，只能当场还掉——不还的话
      // `evictMemory` 会因为 refs > 0 永远跳过这一条，它就再也不会被回收。
      if (controller.signal.aborted) { releaseHandle(); return; }
      setSrc(value.url);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    // 观察器按 rootMargin 分桶共享：书架/去重页一屏就是几十上百张卡，
    // 每卡一个 observer 实例的开销跟着页数走。
    const stopObserving = observeOnceInScroll(node, load, '480px');
    return () => { stopObserving(); controller.abort(); releaseHandle(); };
  }, [identity, node]);
  return <div className="archive-thumb-card-media" ref={setNode}>
    {src ? <img src={src} alt="" loading="lazy" decoding="async" onLoad={(event) => {
      const image = event.currentTarget;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) onAspectRatio?.(image.naturalWidth / image.naturalHeight);
    }} /> : <span className={`archive-thumb-card-skeleton${failed ? ' is-failed' : ''}`} aria-hidden="true" />}
    {children}
  </div>;
}

export function ArchiveThumbnailCard({ archive, scopeId, serverId, favorite = false, onOpen, onContextMenu, progressPage, progressVisibility, progressScope, detailBasePath = '/library' }: { archive: ArchiveRecord; scopeId: string; serverId: string; favorite?: boolean; onOpen?: () => void; onContextMenu?: ((archive: ArchiveRecord, at: { x: number; y: number }) => void) | undefined; progressPage?: number | null | undefined; progressVisibility?: 'none' | 'history' | 'all' | undefined; progressScope?: 'history' | 'elsewhere' | undefined; /** Which page owns the detail this card opens. A rail on the home page keeps
 * the detail on the home page — opening a card from there must not navigate
 * into the library and leave it showing that archive afterwards. */ detailBasePath?: string | undefined }) {
  const [aspectRatio, setAspectRatio] = useState<number>();
  const location = useLocation();
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
  const detailMatch = matchPath(`${detailBasePath}/:archiveId`, location.pathname);
  const detailServer = new URLSearchParams(location.search).get('server');
  const detailOpen = !compact && detailMatch?.params.archiveId === archive.archiveId
    && (!detailServer || detailServer === archive.serverId);
  /** 自然宽高比要等 `<img>` load 才拿得到，而重进档案库时第一帧还没 load；那就先看这份
   * 「上一次量到的宽窄」（见 archiveCardPresentation 里的跨路由记录）。否则第一帧按窄卡排版、
   * 图一落地又翻成宽卡，整屏卡片重排一次——比骨架闪更明显。 */
  const isWide = aspectRatio == null ? isWideCoverMarked(serverId, archive.archiveId) : isWideCoverRatio(aspectRatio);
  // The same menu the library list opens, by right click on a desktop and by
  // press-and-hold on a phone.
  const press = onContextMenu ? longPressHandlers((at) => onContextMenu(archive, at)) : {};
  return <Link
    aria-current={detailOpen ? 'page' : undefined}
    className={`archive-thumb-card${isWide ? ' is-wide' : ''}`}
    to={`${detailBasePath}/${archive.archiveId}?server=${encodeURIComponent(archive.serverId)}`}
    onClick={onOpen}
    // Without the right click a rail card did nothing on a desktop, which is
    // what "the app still has no context menu" was.
    onContextMenu={onContextMenu ? (event) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(archive, { x: event.clientX, y: event.clientY });
    } : undefined}
    {...press}
  >
    <ArchiveThumbMedia
      scopeId={scopeId}
      serverId={serverId}
      archiveId={archive.archiveId}
      onAspectRatio={(ratio) => {
        // 量到真实比例后记一份到跨路由的 store（窄→宽、宽→窄都写），下次进来第一帧就能直接用。
        rememberWideCoverMark(serverId, archive.archiveId, isWideCoverRatio(ratio));
        setAspectRatio(ratio);
      }}
    />
    <ArchiveThumbCardBody
      title={archive.title}
      tags={archive.tags}
      favorite={favorite}
      progressPage={progressPage}
      progressVisibility={progressVisibility}
      progressScope={progressScope}
      pageCount={archive.pageCount}
      meta={<><span>{formatArchivePageMeta(archive.pageCount, progressPage)}</span><span>{formatArchiveDate(archive.addedAt)}</span></>}
    />
  </Link>;
}

export function ArchiveThumbnailRail({ resetScrollKey, title, archives, scopeId, serverId, progressByArchiveId, progressVisibility, progressScope, headingHidden = false, headingIcon, headingContent, onRefresh, onArchiveContextMenu, refreshing = false, loading = false, skeletonCount = 6, detailBasePath = '/library' }: { title: string; archives: ArchiveRecord[]; scopeId: string; serverId: string; progressByArchiveId?: ReadonlyMap<string, number>; progressVisibility?: 'none' | 'history' | 'all' | undefined; progressScope?: 'history' | 'elsewhere' | undefined; headingHidden?: boolean; /** Drawn before the rail's name: every rail gets one, so the headings read as one family. */ headingIcon?: ReactNode; headingContent?: ReactNode; onRefresh?: (() => void) | undefined; onArchiveContextMenu?: ((archive: ArchiveRecord, at: { x: number; y: number }) => void) | undefined; refreshing?: boolean; loading?: boolean; skeletonCount?: number; /** See `ArchiveThumbnailCard`: which page owns the detail these cards open. */ detailBasePath?: string | undefined; resetScrollKey?: string | undefined }) {
  // A rail that will have content shows its shape while loading. One that has
  // finished with nothing to show is not a rail at all.
  if (!archives.length && !loading) return null;
  return <ArchiveThumbnailRailContent resetScrollKey={resetScrollKey} title={title} archives={archives} scopeId={scopeId} serverId={serverId} progressByArchiveId={progressByArchiveId} progressVisibility={progressVisibility} progressScope={progressScope} headingHidden={headingHidden} headingIcon={headingIcon} headingContent={headingContent} onRefresh={onRefresh} onArchiveContextMenu={onArchiveContextMenu} refreshing={refreshing} loading={loading} skeletonCount={skeletonCount} detailBasePath={detailBasePath} />;
}

/** `headingHidden` keeps the accessible name but drops the visible heading row,
 * for callers that already label the rail. `headingContent` replaces the title
 * with arbitrary controls — the recommendation tabs used to sit in a sibling
 * above the rail, which put them visually outside the panel they belong to. */
function ArchiveThumbnailRailContent({ resetScrollKey, title, archives, scopeId, serverId, progressByArchiveId, progressVisibility, progressScope, headingHidden, headingIcon, headingContent, onRefresh, onArchiveContextMenu, refreshing, loading, skeletonCount, detailBasePath }: { title: string; archives: ArchiveRecord[]; scopeId: string; serverId: string; progressByArchiveId?: ReadonlyMap<string, number> | undefined; progressVisibility: 'none' | 'history' | 'all' | undefined; progressScope: 'history' | 'elsewhere' | undefined; headingHidden: boolean; headingIcon: ReactNode; headingContent: ReactNode; onRefresh: (() => void) | undefined; onArchiveContextMenu: ((archive: ArchiveRecord, at: { x: number; y: number }) => void) | undefined; refreshing: boolean; loading: boolean; skeletonCount: number; detailBasePath: string; resetScrollKey: string | undefined }) {
  const scroller = useHorizontalScroller();
  useLayoutEffect(() => {
    if (resetScrollKey !== undefined) scroller.resetScroll();
  }, [resetScrollKey, scroller.resetScroll]);
  const [railWidth, setRailWidth] = useState(0);
  useEffect(() => {
    const element = scroller.elementRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setRailWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller.elementRef]);
  const visibleSkeletonCount = railWidth > 0
    ? Math.max(1, Math.ceil((railWidth + 12) / 162))
    : skeletonCount;
  return <section className="archive-rail" aria-label={title}>
    {!headingHidden && <div className="archive-rail-heading">
      {headingContent ?? <h2>{headingIcon}<span>{title}</span></h2>}
      {onRefresh && <button className="icon-action" type="button" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing} aria-label={`刷新${title}`} title={`刷新${title}`}>
        <RefreshCw aria-hidden="true" className={refreshing ? 'is-spinning' : undefined} />
      </button>}
    </div>}
    <div ref={scroller.ref} className="archive-rail-grid" onMouseDown={scroller.onMouseDown} onClickCapture={scroller.onClickCapture} onDragStart={scroller.onDragStart}>
      {archives.length === 0 && loading
        ? Array.from({ length: visibleSkeletonCount }, (_, index) => <ArchiveThumbnailCardSkeleton key={index} />)
        : archives.map((archive) => <div className="archive-rail-item" key={archive.archiveId}><ArchiveThumbnailCard archive={archive} scopeId={scopeId} serverId={serverId} onContextMenu={onArchiveContextMenu} progressPage={progressByArchiveId?.get(archive.archiveId)} progressVisibility={progressVisibility} progressScope={progressScope} detailBasePath={detailBasePath} /></div>)}
    </div>
  </section>;
}

/** The card's own shape while the rail or the grid waits on data, so the page
 * does not jump once the archives land. */
export function ArchiveThumbnailCardSkeleton() {
  return <div className="archive-thumb-card is-skeleton" aria-hidden="true">
    <div className="archive-thumb-card-media"><span className="archive-thumb-card-skeleton" /></div>
    <div className="archive-thumb-card-body">
      <div className="archive-thumb-card-title"><span className="skeleton-line" /></div>
      <div className="archive-thumb-card-tags"><span className="skeleton-line is-chip" /><span className="skeleton-line is-chip" /></div>
      <div className="archive-thumb-card-meta"><span className="skeleton-line" /></div>
    </div>
  </div>;
}
