import { ArchiveThumbnailCardSkeleton } from './ArchiveThumbnailCard';

export function ArchiveListSkeleton({ mode, timeline = false, exiting = false, label = '正在读取档案' }: { mode: 'thumbnail' | 'wide'; timeline?: boolean; exiting?: boolean; label?: string }) {
  /* A fixed count left tall windows with a strip of bare canvas under the last
     card. Count from the viewport instead: row heights mirror the CSS (158px
     wide rows, 350px thumbnail cards, plus one gap), and the old counts stay
     as the floor so short windows look exactly as before. */
  const count = (() => {
    const minimum = mode === 'thumbnail' ? 8 : 5;
    if (typeof window === 'undefined') return minimum;
    const available = window.innerHeight - 240;
    const rowHeight = mode === 'thumbnail' ? 350 + 12 : 158 + 12;
    if (available <= 0) return minimum;
    return Math.max(minimum, Math.ceil(available / rowHeight));
  })();
  return (
    <div className={`archive-list-skeleton is-${mode}${timeline ? ' has-timeline' : ''}${exiting ? ' is-exiting' : ''}`} role={exiting ? undefined : 'status'} aria-label={exiting ? undefined : label} aria-hidden={exiting || undefined}>
      {mode === 'thumbnail'
        ? Array.from({ length: count }, (_, index) => <ArchiveThumbnailCardSkeleton key={index} />)
        : Array.from({ length: count }, (_, index) => (
          <div className="archive-row-skeleton" key={index}>
            <span className="skeleton-block archive-row-skeleton-cover" />
            <span className="archive-row-skeleton-copy"><span className="skeleton-line" /><span className="skeleton-line" /><span className="skeleton-line" /></span>
            {timeline && <span className="archive-timeline-skeleton"><span className="skeleton-line" /></span>}
          </div>
        ))}
    </div>
  );
}
