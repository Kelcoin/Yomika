import { CardTagRows, ArchiveCardTags } from './CardTagRows';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Heart, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ArchiveRecord } from '../domain/library';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { CARD_TAG_LIMIT_THUMBNAIL, formatArchiveDate, formatArchivePageMeta, isWideCoverRatio } from '../lib/archiveCardPresentation';
import { useHorizontalScroller } from '../lib/horizontalScroller';
import { longPressHandlers } from '../lib/longPressMenu';
import { observeOnce } from '../lib/sharedIntersectionObserver';

const imageCache = getNativeImageCache();

/** The thumbnail card's media + copy stack, shared by the recommendation rail
 * and the library grid so both are literally the same card. The caller supplies
 * the root element (an anchor in the rail, a button in the grid) and the meta
 * line, which carries different facts in each place. The tag slot picks and
 * colours its own tags from the raw list, so a caller cannot pass a differently
 * ordered or differently coloured set by accident. */
export function ArchiveThumbCardBody({ title, tags, meta, favorite = false, limit = CARD_TAG_LIMIT_THUMBNAIL }: { title: string; tags: readonly string[] | undefined; meta: ReactNode; favorite?: boolean; limit?: number }) {
  return <div className="archive-thumb-card-body">
    <div className="archive-thumb-card-title"><strong>{title}</strong>{favorite && <Heart aria-hidden="true" fill="currentColor" />}</div>
    {/* fill: the two rows pack top-down and the rest of the (deliberately
        generous) tag list is dropped, so the slot reads full at any card
        width — the list row's waterfall keeps its own spreading behaviour. */}
    <ArchiveCardTags tags={tags} limit={limit} rowCount={2} fill className="archive-thumb-card-tags" />
    <div className="archive-thumb-card-meta">{meta}</div>
  </div>;
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
  const [src, setSrc] = useState<string>();
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!node) return undefined;
    const controller = new AbortController();
    let handle: import('../lib/unifiedImageCache').ImageHandle | undefined;
    const load = () => void imageCache.load({ scopeId, serverId, archiveId, rendition: 'cover', pageIndex: 0 }, { signal: controller.signal }).then((value) => { handle = value; setSrc(value.url); }).catch(() => undefined);
    // 观察器按 rootMargin 分桶共享：书架/去重页一屏就是几十上百张卡，
    // 每卡一个 observer 实例的开销跟着页数走。
    const stopObserving = observeOnce(node, load, '480px');
    return () => { stopObserving(); controller.abort(); if (handle) imageCache.release(handle); };
  }, [archiveId, node, scopeId, serverId]);
  return <div className="archive-thumb-card-media" ref={setNode}>
    {src ? <img src={src} alt="" loading="lazy" decoding="async" onLoad={(event) => {
      const image = event.currentTarget;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) onAspectRatio?.(image.naturalWidth / image.naturalHeight);
    }} /> : <span className="archive-thumb-card-skeleton" aria-hidden="true" />}
    {children}
  </div>;
}

export function ArchiveThumbnailCard({ archive, scopeId, serverId, favorite = false, onOpen, onContextMenu, progressPage }: { archive: ArchiveRecord; scopeId: string; serverId: string; favorite?: boolean; onOpen?: () => void; onContextMenu?: ((archive: ArchiveRecord, at: { x: number; y: number }) => void) | undefined; progressPage?: number | null | undefined }) {
  const [aspectRatio, setAspectRatio] = useState<number>();
  const isWide = isWideCoverRatio(aspectRatio);
  // The same menu the library list opens, by right click on a desktop and by
  // press-and-hold on a phone.
  const press = onContextMenu ? longPressHandlers((at) => onContextMenu(archive, at)) : {};
  return <Link
    className={`archive-thumb-card${isWide ? ' is-wide' : ''}`}
    to={`/library/${archive.archiveId}?server=${encodeURIComponent(archive.serverId)}`}
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
      onAspectRatio={setAspectRatio}
    />
    <ArchiveThumbCardBody
      title={archive.title}
      tags={archive.tags}
      favorite={favorite}
      meta={<><span>{formatArchivePageMeta(archive.pageCount, progressPage)}</span><span>{formatArchiveDate(archive.addedAt)}</span></>}
    />
  </Link>;
}

export function ArchiveThumbnailRail({ title, archives, scopeId, serverId, progressByArchiveId, headingHidden = false, headingIcon, headingContent, onRefresh, onArchiveContextMenu, refreshing = false, loading = false, skeletonCount = 6 }: { title: string; archives: ArchiveRecord[]; scopeId: string; serverId: string; progressByArchiveId?: ReadonlyMap<string, number>; headingHidden?: boolean; /** Drawn before the rail's name: every rail gets one, so the headings read as one family. */ headingIcon?: ReactNode; headingContent?: ReactNode; onRefresh?: (() => void) | undefined; onArchiveContextMenu?: ((archive: ArchiveRecord, at: { x: number; y: number }) => void) | undefined; refreshing?: boolean; loading?: boolean; skeletonCount?: number }) {
  // A rail that will have content shows its shape while loading. One that has
  // finished with nothing to show is not a rail at all.
  if (!archives.length && !loading) return null;
  return <ArchiveThumbnailRailContent title={title} archives={archives} scopeId={scopeId} serverId={serverId} progressByArchiveId={progressByArchiveId} headingHidden={headingHidden} headingIcon={headingIcon} headingContent={headingContent} onRefresh={onRefresh} onArchiveContextMenu={onArchiveContextMenu} refreshing={refreshing} loading={loading} skeletonCount={skeletonCount} />;
}

/** `headingHidden` keeps the accessible name but drops the visible heading row,
 * for callers that already label the rail. `headingContent` replaces the title
 * with arbitrary controls — the recommendation tabs used to sit in a sibling
 * above the rail, which put them visually outside the panel they belong to. */
function ArchiveThumbnailRailContent({ title, archives, scopeId, serverId, progressByArchiveId, headingHidden, headingIcon, headingContent, onRefresh, onArchiveContextMenu, refreshing, loading, skeletonCount }: { title: string; archives: ArchiveRecord[]; scopeId: string; serverId: string; progressByArchiveId?: ReadonlyMap<string, number> | undefined; headingHidden: boolean; headingIcon: ReactNode; headingContent: ReactNode; onRefresh: (() => void) | undefined; onArchiveContextMenu: ((archive: ArchiveRecord, at: { x: number; y: number }) => void) | undefined; refreshing: boolean; loading: boolean; skeletonCount: number }) {
  const scroller = useHorizontalScroller();
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
        : archives.map((archive) => <ArchiveThumbnailCard key={archive.archiveId} archive={archive} scopeId={scopeId} serverId={serverId} onContextMenu={onArchiveContextMenu} progressPage={progressByArchiveId?.get(archive.archiveId)} />)}
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
