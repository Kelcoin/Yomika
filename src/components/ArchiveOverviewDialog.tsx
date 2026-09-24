import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ArchiveRecord } from '../domain/library';
import { getNativeImageCache } from '../lib/nativeImageCache';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { ArchiveOverviewPanel } from './ArchiveOverviewPanel';

const imageCache = getNativeImageCache();
/** How many page previews to pull before the grid is even scrolled. */
const EAGER_PREVIEWS = 6;

/** The archive overview as a dialog, for callers that are not the reader.
 *
 * The duplicate workspace wants to see what an archive is without leaving the
 * list it is working through — going to the reader and back for every pair lost
 * the scroll position and the selection it had just made. Same panel as the
 * reader's, but the page previews arrive as they scroll into view, because
 * unlike the reader there is no reading session already holding them. */
export function ArchiveOverviewDialog({ archive, scopeId, serverId, onClose }: {
  archive: ArchiveRecord;
  scopeId: string;
  serverId: string;
  onClose: () => void;
}) {
  // 挂载即打开；返回手势先关这一层（见 overlayBackGuard）。
  useOverlayBackGuard(true, onClose);
  const [cover, setCover] = useState<string>();
  const [previews, setPreviews] = useState<ReadonlyMap<number, string>>(() => new Map());
  const mounted = useRef(true);
  const handles = useRef<ImageHandle[]>([]);
  const pending = useRef(new Set<number>());
  const observerRef = useRef<IntersectionObserver>();

  const loadPreview = useCallback(async (pageIndex: number) => {
    if (pending.current.has(pageIndex)) return;
    pending.current.add(pageIndex);
    try {
      const handle = await imageCache.load({ scopeId, serverId, archiveId: archive.archiveId, pageIndex, rendition: 'page-thumbnail' });
      if (!mounted.current) { imageCache.release(handle); return; }
      handles.current.push(handle);
      setPreviews((current) => new Map(current).set(pageIndex, handle.url));
    } catch {
      // 取不到的那一页留个页码占位：档案概览不该因为缺一张缩略图而空掉。
    }
  }, [archive.archiveId, scopeId, serverId]);

  useEffect(() => {
    mounted.current = true;
    void imageCache.load({ scopeId, serverId, archiveId: archive.archiveId, rendition: 'cover', pageIndex: 0 })
      .then((handle) => {
        if (!mounted.current) { imageCache.release(handle); return; }
        handles.current.push(handle);
        setCover(handle.url);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
      handles.current.forEach((handle) => imageCache.release(handle));
      handles.current = [];
    };
  }, [archive.archiveId, scopeId, serverId]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (a test environment): the first page or two are what the
      // panel opens on, and the rest stay as numbered tiles.
      for (let index = 0; index < Math.min(EAGER_PREVIEWS, archive.pageCount); index += 1) void loadPreview(index);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const index = Number((entry.target as HTMLElement).dataset.pageIndex);
        if (Number.isInteger(index)) void loadPreview(index);
      }
    }, { rootMargin: '240px' });
    observerRef.current = observer;
    return () => { observer.disconnect(); observerRef.current = undefined; };
  }, [archive.pageCount, loadPreview]);

  const registerTile = useCallback((index: number, node: HTMLElement | null) => {
    if (!node) return;
    node.dataset.pageIndex = String(index);
    if (index < EAGER_PREVIEWS) { void loadPreview(index); return; }
    observerRef.current?.observe(node);
  }, [loadPreview]);

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      {/* The panel brings its own heading, so the dialog's title is the archive
          name for assistive tech and the visible header stays the panel's. */}
      <Dialog.Content className="dialog-content archive-overview-dialog" aria-describedby={undefined}>
        <Dialog.Title className="visually-hidden">{archive.title || archive.archiveId}</Dialog.Title>
        <ArchiveOverviewPanel
          title={archive.title || archive.archiveId}
          pageCount={archive.pageCount}
          cover={cover}
          sizeBytes={archive.fileSize}
          tags={archive.tags}
          thumbnailAt={(index) => previews.get(index)}
          registerTile={registerTile}
          onClose={onClose}
        />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
