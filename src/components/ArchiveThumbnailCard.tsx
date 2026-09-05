import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Heart, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ArchiveRecord } from '../domain/library';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { translateRawTag } from '../lib/tags';
import { formatArchiveDate, formatArchivePageMeta, isWideCoverRatio, pickCardTags } from '../lib/archiveCardPresentation';
import { useHorizontalScroller } from '../lib/horizontalScroller';

const imageCache = getNativeImageCache();

export function ArchiveThumbnailCard({ archive, scopeId, serverId, favorite = false, onOpen, progressPage }: { archive: ArchiveRecord; scopeId: string; serverId: string; favorite?: boolean; onOpen?: () => void; progressPage?: number | null | undefined }) {
  const [src, setSrc] = useState<string>();
  const [aspectRatio, setAspectRatio] = useState<number>();
  const [node, setNode] = useState<HTMLAnchorElement | null>(null);
  const tags = useMemo(() => pickCardTags(archive.tags, 6), [archive.tags]);
  const isWide = isWideCoverRatio(aspectRatio);
  useEffect(() => {
    if (!node) return undefined;
    const controller = new AbortController();
    let handle: import('../lib/unifiedImageCache').ImageHandle | undefined;
    const load = () => void imageCache.load({ scopeId, serverId, archiveId: archive.archiveId, rendition: 'cover', pageIndex: 0 }, { signal: controller.signal }).then((value) => { handle = value; setSrc(value.url); }).catch(() => undefined);
    if (typeof IntersectionObserver === 'undefined') load();
    else {
      const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) { observer.disconnect(); load(); } }, { rootMargin: '280px' });
      observer.observe(node);
      return () => { observer.disconnect(); controller.abort(); if (handle) imageCache.release(handle); };
    }
    return () => { controller.abort(); if (handle) imageCache.release(handle); };
  }, [archive.archiveId, node, scopeId, serverId]);
  return <Link ref={setNode} className={`archive-thumb-card${isWide ? ' is-wide' : ''}`} to={`/library/${archive.archiveId}`} onClick={onOpen}>
    <div className="archive-thumb-card-media">{src ? <img src={src} alt="" loading="lazy" onLoad={(event) => {
      const image = event.currentTarget;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) setAspectRatio(image.naturalWidth / image.naturalHeight);
    }} /> : <span className="archive-thumb-card-skeleton" aria-hidden="true" />}</div>
    <div className="archive-thumb-card-body"><div className="archive-thumb-card-title"><strong>{archive.title}</strong>{favorite && <Heart aria-hidden="true" fill="currentColor" />}</div><div className="archive-thumb-card-tags">{tags.map((tag) => <span className="metadata-chip" key={tag}>{translateRawTag(tag)}</span>)}</div><div className="archive-thumb-card-meta"><span>{formatArchiveDate(archive.addedAt)}</span><span>{formatArchivePageMeta(archive.pageCount, progressPage)}</span></div></div>
  </Link>;
}

export function ArchiveThumbnailRail({ title, archives, scopeId, serverId, progressByArchiveId, headingHidden = false, headingContent, onRefresh, refreshing = false, loading = false, skeletonCount = 6 }: { title: string; archives: ArchiveRecord[]; scopeId: string; serverId: string; progressByArchiveId?: ReadonlyMap<string, number>; headingHidden?: boolean; headingContent?: ReactNode; onRefresh?: (() => void) | undefined; refreshing?: boolean; loading?: boolean; skeletonCount?: number }) {
  // A rail that will have content shows its shape while loading. One that has
  // finished with nothing to show is not a rail at all.
  if (!archives.length && !loading) return null;
  return <ArchiveThumbnailRailContent title={title} archives={archives} scopeId={scopeId} serverId={serverId} progressByArchiveId={progressByArchiveId} headingHidden={headingHidden} headingContent={headingContent} onRefresh={onRefresh} refreshing={refreshing} loading={loading} skeletonCount={skeletonCount} />;
}

/** `headingHidden` keeps the accessible name but drops the visible heading row,
 * for callers that already label the rail. `headingContent` replaces the title
 * with arbitrary controls — the recommendation tabs used to sit in a sibling
 * above the rail, which put them visually outside the panel they belong to. */
function ArchiveThumbnailRailContent({ title, archives, scopeId, serverId, progressByArchiveId, headingHidden, headingContent, onRefresh, refreshing, loading, skeletonCount }: { title: string; archives: ArchiveRecord[]; scopeId: string; serverId: string; progressByArchiveId?: ReadonlyMap<string, number> | undefined; headingHidden: boolean; headingContent: ReactNode; onRefresh: (() => void) | undefined; refreshing: boolean; loading: boolean; skeletonCount: number }) {
  const scroller = useHorizontalScroller();
  return <section className="archive-rail" aria-label={title}>
    {!headingHidden && <div className="archive-rail-heading">
      {headingContent ?? <h2>{title}</h2>}
      {onRefresh && <button className="icon-action" type="button" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing} aria-label={`刷新${title}`} title={`刷新${title}`}>
        <RefreshCw aria-hidden="true" className={refreshing ? 'is-spinning' : undefined} />
      </button>}
    </div>}
    <div ref={scroller.ref} className="archive-rail-grid" onMouseDown={scroller.onMouseDown} onClickCapture={scroller.onClickCapture} onDragStart={scroller.onDragStart}>
      {archives.length === 0 && loading
        ? Array.from({ length: skeletonCount }, (_, index) => <ArchiveThumbnailCardSkeleton key={index} />)
        : archives.map((archive) => <ArchiveThumbnailCard key={archive.archiveId} archive={archive} scopeId={scopeId} serverId={serverId} progressPage={progressByArchiveId?.get(archive.archiveId)} />)}
    </div>
  </section>;
}

/** The card's own shape while the rail waits on data, so the page does not jump
 * once the archives land. */
function ArchiveThumbnailCardSkeleton() {
  return <div className="archive-thumb-card is-skeleton" aria-hidden="true">
    <div className="archive-thumb-card-media"><span className="archive-thumb-card-skeleton" /></div>
    <div className="archive-thumb-card-body">
      <div className="archive-thumb-card-title"><span className="skeleton-line" /></div>
      <div className="archive-thumb-card-tags"><span className="skeleton-line is-chip" /><span className="skeleton-line is-chip" /></div>
      <div className="archive-thumb-card-meta"><span className="skeleton-line" /></div>
    </div>
  </div>;
}
