import { VirtualPageGrid } from './VirtualPageGrid';
import type { ReactNode } from 'react';

export const DETAIL_THUMBNAIL_WIDTH = 100;
export const DETAIL_THUMBNAIL_FOOTER = 20;

/** Both remote galleries and local archives use the same frame and caption. */
export function DetailPageThumbnail({ page, loading = false, onOpen, children, mediaRef }: {
  page: number;
  loading?: boolean;
  onOpen?: (() => void) | undefined;
  children: ReactNode;
  mediaRef?: ((node: HTMLSpanElement | null) => void) | undefined;
}) {
  const content = <><span ref={mediaRef} className={`archive-page-thumbnail-media${loading ? ' is-skeleton' : ''}`}>{children}</span><span className="archive-page-thumbnail-number" aria-hidden="true">{page}</span></>;
  return onOpen
    ? <button className="archive-page-thumbnail" type="button" aria-label={`查看第 ${page} 页`} onClick={onOpen}>{content}</button>
    : <figure className="archive-page-thumbnail" aria-label={`第 ${page} 页缩略图`}>{content}</figure>;
}

export function DetailPageThumbnailGrid({ count, children, onRangeChange, label = '页面缩略图' }: {
  count: number;
  label?: string;
  children: (index: number) => ReactNode;
  onRangeChange?: ((start: number, end: number) => void) | undefined;
}) {
  return <section className="archive-page-thumbnails" aria-label={label}>
    <VirtualPageGrid count={count} className="archive-page-thumbnails-grid" minWidth={DETAIL_THUMBNAIL_WIDTH} footerHeight={DETAIL_THUMBNAIL_FOOTER} onRangeChange={onRangeChange}>
      {children}
    </VirtualPageGrid>
  </section>;
}
