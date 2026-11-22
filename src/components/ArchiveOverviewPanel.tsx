import { X } from 'lucide-react';
import { VirtualPageGrid } from './VirtualPageGrid';
import { useLayoutEffect, useRef, type MouseEvent } from 'react';

import { formatByteSize } from '../lib/archiveCardPresentation';
import { categorizeSearchableTags } from '../lib/tags';
import { DetailFactGlyph, useSingleLineTitle, type DetailFact } from './ArchiveDetailSections';
import { TagSearchLink } from './TagSearchLink';

/** The archive overview: cover, facts and the page grid.
 *
 * One component for both places it is needed — the reader's own panel and the
 * duplicate workspace's "look at this archive" dialog. The caller owns where
 * the page previews come from, because the two load them very differently: the
 * reader already holds most of them, the dialog pulls them one at a time as
 * they scroll into view. */
export interface ArchiveOverviewPanelProps {
  title: string;
  pageCount: number;
  cover?: string | undefined;
  sizeBytes?: number | undefined;
  tags?: string[] | undefined;
  /** The page being read; its tile is marked. */
  currentPage?: number | undefined;
  /** A page's preview, or undefined while it is still coming. */
  thumbnailAt: (index: number) => string | undefined;
  /** Hands the caller each tile as it mounts, so it can fetch what is visible. */
  registerTile?: ((index: number, node: HTMLElement | null) => void) | undefined;
  onRangeChange?: ((start: number, end: number) => void) | undefined;
  /** Turning to a page. Without it the grid is reference only — the tiles are
   * still buttons (they hold the number and the frame) but nothing moves. */
  onSelectPage?: ((index: number) => void) | undefined;
  onClose: () => void;
  /** The reader stops its chrome toggle from reading a press on the panel as a
   * tap on the artwork. */
  onPanelClick?: ((event: MouseEvent) => void) | undefined;
}

const OVERVIEW_TITLE_SIZES = ['var(--text-heading)', '20px', '18px', '16px'] as const;

export function ArchiveOverviewPanel({ title, pageCount, cover, sizeBytes, tags, currentPage, thumbnailAt, registerTile, onRangeChange, onSelectPage, onClose, onPanelClick }: ArchiveOverviewPanelProps) {
  const titleRef = useSingleLineTitle(title, OVERVIEW_TITLE_SIZES);
  const grouped = categorizeSearchableTags(tags ?? []);
  const tagViewportRef = useRef<HTMLDivElement>(null);
  const tagRowsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = tagViewportRef.current;
    const rows = tagRowsRef.current;
    if (!viewport || !rows) return;

    const fitRows = () => {
      const limit = Number.parseFloat(getComputedStyle(viewport).maxHeight);
      if (!Number.isFinite(limit)) return;
      const { top } = rows.getBoundingClientRect();
      const items = Array.from(rows.querySelectorAll('h3, .metadata-chip'), (item) => item.getBoundingClientRect());
      // Namespace badges and their first chips can have different heights.
      // Stop before the earliest incomplete row, regardless of group order.
      let cutoff = Infinity;
      for (const item of items) {
        if (item.bottom - top > limit) cutoff = Math.min(cutoff, item.top);
      }
      let height = 0;
      for (const item of items) {
        if (item.bottom <= cutoff) height = Math.max(height, item.bottom - top);
      }
      const nextHeight = Number.isFinite(cutoff) && height > 0 ? `${height}px` : '';
      if (viewport.style.height !== nextHeight) viewport.style.height = nextHeight;
    };

    fitRows();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fitRows);
    // Watch the unclipped rows so wrapping and font changes can grow or shrink the viewport.
    observer?.observe(rows);
    return () => observer?.disconnect();
  }, [tags]);
  // Reuse the detail page's fact glyphs below the cover, leaving the right
  // column entirely available for tags.
  const facts: DetailFact[] = [
    { kind: 'pages', label: '页数', value: `${pageCount} 页` },
    ...(sizeBytes ? [{ kind: 'size' as const, label: '体积', value: formatByteSize(sizeBytes) }] : []),
  ];
  return <aside className="reader-overview" aria-label="档案概览" onClick={onPanelClick}>
    <header className="reader-overview-heading">
      <strong ref={titleRef}>{title}</strong>
      <button type="button" className="reader-icon-button" aria-label="关闭概览" onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="reader-overview-summary">
      {/* Cover and its centered facts stay together beside the tags. */}
      <div className="reader-overview-identity">
        {/* 封面装在一个裁切框里：SFW 的模糊与 1.12 倍放大都会画到元素盒子外面，
            没有 overflow: hidden 就会糊到旁边的页数、标签上。
            SFW 下这张封面在触屏上要"按住才看清"，而 pressFeedback 只标记可点元素：
            这个框自己不是可点元素，所以由它认领这次按压（data-press-surface）。 */}
        {cover && <span className="reader-overview-cover-frame" data-press-surface><img className="reader-overview-cover" src={cover} alt="" decoding="async" /></span>}
        <dl className="reader-overview-stats" aria-label="档案信息">
          {facts.map(({ kind, label, value }) => (
            <div key={kind} data-fact={kind} title={label}>
              <dt aria-label={label}><DetailFactGlyph kind={kind} /><span className="visually-hidden">{label}</span></dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="reader-overview-facts">
        {grouped.length > 0 && (
          /* Grouped by namespace, the way the detail page shows them: a flat run
             of chips gave no clue which were artists and which were content tags. */
          <div className="reader-overview-tags" aria-label="档案标签" ref={tagViewportRef}>
            <div className="reader-overview-tag-rows" ref={tagRowsRef}>
              {grouped.map((group) => (
                <section className={`tag-group tag-group-${group.namespace}`} key={group.namespace}>
                  <h3>{group.label}</h3>
                  <div>{group.values.map((tag, index) => <TagSearchLink label={tag.label} query={tag.query} key={`${group.namespace}-${tag.query}-${index}`} />)}</div>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>

    </div>
    <VirtualPageGrid count={Math.max(0, pageCount)} minWidth={80} className={`reader-overview-thumbnails${onSelectPage ? '' : ' is-preview'}`} onRangeChange={onRangeChange} initialIndex={currentPage} autoHideScrollbar>
      {(index) => {
        const preview = thumbnailAt(index);
        return <button
          key={index}
          ref={registerTile ? (node) => registerTile(index, node) : undefined}
          type="button"
          aria-label={onSelectPage ? `跳转到第 ${index + 1} 页` : `第 ${index + 1} 页`}
          aria-current={currentPage === index}
          onClick={onSelectPage ? () => onSelectPage(index) : undefined}
        >
          {preview ? <img src={preview} alt="" loading="lazy" decoding="async" /> : <span aria-hidden="true">{index + 1}</span>}
          <span className="reader-overview-page-number" aria-hidden="true">{index + 1}</span>
        </button>;
      }}
    </VirtualPageGrid>
  </aside>;
}
