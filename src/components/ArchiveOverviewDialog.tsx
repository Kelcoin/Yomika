import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePageActive } from '../app/RetainedPage';

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
interface ArchiveOverviewDialogProps {
  archive: ArchiveRecord;
  scopeId: string;
  serverId: string;
  onClose: () => void;
}

export function ArchiveOverviewDialog(props: ArchiveOverviewDialogProps) {
  const pageActive = usePageActive();
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useLayoutEffect(() => { if (!pageActive) closeRef.current(); }, [pageActive]);
  if (!pageActive) return null;
  return <ArchiveOverviewContent key={JSON.stringify([props.scopeId, props.serverId, props.archive.archiveId])} {...props} />;
}

function ArchiveOverviewContent({ archive, scopeId, serverId, onClose }: ArchiveOverviewDialogProps) {
  // 挂载即打开；返回手势先关这一层（见 overlayBackGuard）。
  useOverlayBackGuard(true, onClose);
  const [cover, setCover] = useState<string>();
  const [previews, setPreviews] = useState<ReadonlyMap<number, string>>(() => new Map());
  const tiles = useRef(new Map<number, HTMLElement>());
  const registerPreview = useRef<(index: number, node: HTMLElement) => void>();

  useEffect(() => {
    // 每次 effect 都拥有自己的租约，避免 StrictMode 重挂或换档案后接受上一轮图片。
    let active = true;
    const handles: ImageHandle[] = [];
    const pending = new Set<number>();
    setCover(undefined);
    setPreviews(new Map());
    const loadPreview = async (pageIndex: number) => {
      if (pending.has(pageIndex)) return;
      pending.add(pageIndex);
      try {
        const handle = await imageCache.load({ scopeId, serverId, archiveId: archive.archiveId, pageIndex, rendition: 'page-thumbnail' });
        if (!active) { imageCache.release(handle); return; }
        handles.push(handle);
        setPreviews((current) => new Map(current).set(pageIndex, handle.url));
      } catch {
        // 缺失预览留页码占位。
      }
    };
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !active) continue;
        observer?.unobserve(entry.target);
        const index = Number((entry.target as HTMLElement).dataset.pageIndex);
        if (Number.isInteger(index)) void loadPreview(index);
      }
    }, { rootMargin: '240px' });
    registerPreview.current = (index, node) => {
      if (index < EAGER_PREVIEWS) void loadPreview(index);
      else observer?.observe(node);
    };
    tiles.current.forEach((node, index) => registerPreview.current?.(index, node));
    void imageCache.load({ scopeId, serverId, archiveId: archive.archiveId, rendition: 'cover', pageIndex: 0 })
      .then((handle) => {
        if (!active) { imageCache.release(handle); return; }
        handles.push(handle);
        setCover(handle.url);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      observer?.disconnect();
      registerPreview.current = undefined;
      handles.forEach((handle) => imageCache.release(handle));
    };
  }, [archive.archiveId, scopeId, serverId]);

  const registerTile = useCallback((index: number, node: HTMLElement | null) => {
    if (!node) { tiles.current.delete(index); return; }
    tiles.current.set(index, node);
    node.dataset.pageIndex = String(index);
    registerPreview.current?.(index, node);
  }, []);

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
