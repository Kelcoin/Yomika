import { X } from 'lucide-react';
import type { MouseEvent } from 'react';

import { formatByteSize } from '../lib/archiveCardPresentation';
import { categorizeSearchableTags } from '../lib/tags';
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
  /** Turning to a page. Without it the grid is reference only — the tiles are
   * still buttons (they hold the number and the frame) but nothing moves. */
  onSelectPage?: ((index: number) => void) | undefined;
  onClose: () => void;
  /** The reader stops its chrome toggle from reading a press on the panel as a
   * tap on the artwork. */
  onPanelClick?: ((event: MouseEvent) => void) | undefined;
}

export function ArchiveOverviewPanel({ title, pageCount, cover, sizeBytes, tags, currentPage, thumbnailAt, registerTile, onSelectPage, onClose, onPanelClick }: ArchiveOverviewPanelProps) {
  const grouped = categorizeSearchableTags(tags ?? []);
  return <aside className="reader-overview" aria-label="档案概览" onClick={onPanelClick}>
    <header className="reader-overview-heading">
      <strong>{title}</strong>
      <button type="button" className="reader-icon-button" aria-label="关闭概览" onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="reader-overview-summary">
      {/* Page count and size sit under the cover rather than beside it: they
          belong to the cover, and putting them in the wide column pushed the
          tag groups down by a line for no reason. */}
      <div className="reader-overview-identity">
        {/* 封面装在一个裁切框里：SFW 的模糊与 1.12 倍放大都会画到元素盒子外面，
            没有 overflow: hidden 就会糊到旁边的页数、标签上。 */}
        {cover && <span className="reader-overview-cover-frame"><img className="reader-overview-cover" src={cover} alt="" /></span>}
        <p className="reader-overview-stats">{[`${pageCount} 页`, sizeBytes ? formatByteSize(sizeBytes) : ''].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="reader-overview-facts">
        {grouped.length > 0 && (
          /* Grouped by namespace, the way the detail page shows them: a flat run
             of chips gave no clue which were artists and which were content tags. */
          <div className="reader-overview-tags" aria-label="档案标签">
            {grouped.map((group) => (
              <section className={`tag-group tag-group-${group.namespace}`} key={group.namespace}>
                <h3>{group.label}</h3>
                <div>{group.values.map((tag, index) => <TagSearchLink label={tag.label} query={tag.query} key={`${group.namespace}-${tag.query}-${index}`} />)}</div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
    <div className={`reader-overview-thumbnails${onSelectPage ? '' : ' is-preview'}`}>
      {Array.from({ length: Math.max(0, pageCount) }, (_, index) => {
        const preview = thumbnailAt(index);
        return <button
          key={index}
          ref={registerTile ? (node) => registerTile(index, node) : undefined}
          type="button"
          aria-label={onSelectPage ? `跳转到第 ${index + 1} 页` : `第 ${index + 1} 页`}
          aria-current={currentPage === index}
          onClick={onSelectPage ? () => onSelectPage(index) : undefined}
        >
          {preview ? <img src={preview} alt="" loading="lazy" /> : <span aria-hidden="true">{index + 1}</span>}
          <span className="reader-overview-page-number" aria-hidden="true">{index + 1}</span>
        </button>;
      })}
    </div>
  </aside>;
}
