import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Heart, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ArchiveRecord } from '../domain/library';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { translateRawTag } from '../lib/tags';
import { normalizeMyTagKey, readableInkOnHex } from '../lib/ehMyTags';
import { formatArchiveDate, formatArchivePageMeta, isWideCoverRatio, pickCardTags } from '../lib/archiveCardPresentation';
import { useHorizontalScroller } from '../lib/horizontalScroller';
import { useEhMyTags } from './useEhMyTags';

const imageCache = getNativeImageCache();

/** The thumbnail card's media + copy stack, shared by the recommendation rail
 * and the library grid so both are literally the same card. The caller supplies
 * the root element (an anchor in the rail, a button in the grid) and the meta
 * line, which carries different facts in each place. `colorFor` recolours a
 * chip when the E-Hentai account's My Tags holds a preset for the tag. */
export function ArchiveThumbCardBody({ title, tags, meta, favorite = false, colorFor }: { title: string; tags: string[]; meta: ReactNode; favorite?: boolean; colorFor?: ((tag: string) => string | undefined) | undefined }) {
  return <div className="archive-thumb-card-body">
    <div className="archive-thumb-card-title"><strong>{title}</strong>{favorite && <Heart aria-hidden="true" fill="currentColor" />}</div>
    <div className="archive-thumb-card-tags">{tags.map((tag) => {
      const color = colorFor?.(tag);
      return <span className="metadata-chip" key={tag} style={color ? { background: color, color: readableInkOnHex(color) } : undefined}>{translateRawTag(tag)}</span>;
    })}</div>
    <div className="archive-thumb-card-meta">{meta}</div>
  </div>;
}

export function ArchiveThumbnailCard({ archive, scopeId, serverId, favorite = false, onOpen, onContextMenu, progressPage }: { archive: ArchiveRecord; scopeId: string; serverId: string; favorite?: boolean; onOpen?: () => void; onContextMenu?: ((archive: ArchiveRecord, at: { x: number; y: number }) => void) | undefined; progressPage?: number | null | undefined }) {
  const [src, setSrc] = useState<string>();
  const [aspectRatio, setAspectRatio] = useState<number>();
  const [node, setNode] = useState<HTMLAnchorElement | null>(null);
  const myTags = useEhMyTags();
  const myTagKeys = useMemo(() => new Set(myTags.priority), [myTags.priority]);
  const tags = useMemo(() => pickCardTags(archive.tags, 6, myTagKeys), [archive.tags, myTagKeys]);
  const colorFor = useMemo(() => (tag: string) => myTags.colors.get(normalizeMyTagKey(tag)), [myTags.colors]);
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
  return <Link
    ref={setNode}
    className={`archive-thumb-card${isWide ? ' is-wide' : ''}`}
    to={`/library/${archive.archiveId}`}
    onClick={onOpen}
    // The same menu the library list opens. Without this a right click on a rail
    // card did nothing, which is what "the app still has no context menu" was.
    onContextMenu={onContextMenu ? (event) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(archive, { x: event.clientX, y: event.clientY });
    } : undefined}
  >
    <div className="archive-thumb-card-media">{src ? <img src={src} alt="" loading="lazy" onLoad={(event) => {
      const image = event.currentTarget;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) setAspectRatio(image.naturalWidth / image.naturalHeight);
    }} /> : <span className="archive-thumb-card-skeleton" aria-hidden="true" />}</div>
    <ArchiveThumbCardBody
      title={archive.title}
      tags={tags}
      favorite={favorite}
      colorFor={colorFor}
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
