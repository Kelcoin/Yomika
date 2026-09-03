import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Heart } from 'lucide-react';
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

export function ArchiveThumbnailRail({ title, archives, scopeId, serverId, progressByArchiveId, headingHidden = false }: { title: string; archives: ArchiveRecord[]; scopeId: string; serverId: string; progressByArchiveId?: ReadonlyMap<string, number>; headingHidden?: boolean }) {
  if (!archives.length) return null;
  return <ArchiveThumbnailRailContent title={title} archives={archives} scopeId={scopeId} serverId={serverId} progressByArchiveId={progressByArchiveId} headingHidden={headingHidden} />;
}

/** `headingHidden` keeps the accessible name but drops the visible heading row,
 * for callers that already label the rail (the detail page's tab strip). */
function ArchiveThumbnailRailContent({ title, archives, scopeId, serverId, progressByArchiveId, headingHidden }: { title: string; archives: ArchiveRecord[]; scopeId: string; serverId: string; progressByArchiveId?: ReadonlyMap<string, number> | undefined; headingHidden: boolean }) {
  const scroller = useHorizontalScroller();
  return <section className="archive-rail" aria-label={title}>{!headingHidden && <div className="archive-rail-heading"><h2>{title}</h2><BookOpen aria-hidden="true" /></div>}<div ref={scroller.ref} className="archive-rail-grid" onMouseDown={scroller.onMouseDown} onClickCapture={scroller.onClickCapture} onDragStart={scroller.onDragStart}>{archives.map((archive) => <ArchiveThumbnailCard key={archive.archiveId} archive={archive} scopeId={scopeId} serverId={serverId} progressPage={progressByArchiveId?.get(archive.archiveId)} />)}</div></section>;
}
