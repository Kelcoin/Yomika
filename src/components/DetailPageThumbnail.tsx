import { useEffect, useState } from 'react';

import { VirtualPageGrid } from './VirtualPageGrid';
import type { ReactNode } from 'react';

export const DETAIL_THUMBNAIL_WIDTH = 100;
export const DETAIL_THUMBNAIL_FOOTER = 20;

/** Both remote galleries and local archives use the same frame and caption. */
export function DetailPageThumbnail({ page, loading = false, onOpen, children, mediaRef, current, label, tileRef }: {
  page: number;
  loading?: boolean;
  onOpen?: (() => void) | undefined;
  children: ReactNode;
  current?: boolean | undefined;
  label?: string | undefined;
  tileRef?: ((node: HTMLElement | null) => void) | undefined;
  mediaRef?: ((node: HTMLSpanElement | null) => void) | undefined;
}) {
  // 地址拿到了、图却画不出来（截断的响应、解码失败）也要有兜底：撤掉破图，留住框和页码。
  // 只认「重新进入加载态」当一次新的预览——否则失败标记会跟着格子一辈子，
  // 也免得为了一次显示失败去重发已经成功的请求。
  const [broken, setBroken] = useState(false);
  useEffect(() => { if (loading) setBroken(false); }, [loading]);
  const content = <><span ref={mediaRef} className={`archive-page-thumbnail-media${loading ? ' is-skeleton' : ''}${broken ? ' is-broken' : ''}`} onErrorCapture={() => setBroken(true)}>{broken ? null : children}</span><span className="archive-page-thumbnail-number" aria-hidden="true">{page}</span></>;
  return onOpen
    ? <button ref={tileRef} className="archive-page-thumbnail" type="button" aria-label={label ?? `查看第 ${page} 页`} aria-current={current} onClick={onOpen}>{content}</button>
    : <figure ref={tileRef} tabIndex={tileRef ? 0 : undefined} data-press-surface={tileRef ? true : undefined} className="archive-page-thumbnail" aria-label={label ?? `第 ${page} 页缩略图`}>{content}</figure>;
}

export function DetailPageThumbnailGrid({ count, children, onRangeChange, label = '页面缩略图' }: {
  count: number;
  label?: string;
  children: (index: number) => ReactNode;
  onRangeChange?: ((start: number, end: number, visible: { start: number; end: number }) => void) | undefined;
}) {
  return <section className="archive-page-thumbnails" aria-label={label}>
    <VirtualPageGrid count={count} className="archive-page-thumbnails-grid" minWidth={DETAIL_THUMBNAIL_WIDTH} footerHeight={DETAIL_THUMBNAIL_FOOTER} onRangeChange={onRangeChange}>
      {children}
    </VirtualPageGrid>
  </section>;
}
