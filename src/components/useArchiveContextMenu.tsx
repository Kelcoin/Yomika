import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ArchiveContextMenu, type ArchiveContextMenuTarget } from './ArchiveContextMenu';
import { useToast } from './Toast';
import type { ArchiveRecord } from '../domain/library';
import type { Category } from '../repositories/nativeLibraryRepository';

/** The card context menu plus the state and the surface-independent actions it
 * needs, so every place that draws archive cards can answer a right click.
 *
 * The library used to be the only one wired up, which read as "the app has no
 * context menu": the home rails, the recommendation rail and the history,
 * favourites and to-read shelves all ignored the click. Reading, incognito
 * reading, editing metadata and copying the id need nothing but the router, so
 * they live here; a caller adds whatever else it can actually do — categories
 * need a server list, the reading-list item needs the membership the caller
 * already tracks.
 */
export function useArchiveContextMenu(options: {
  inReadingList?: ((archiveId: string) => boolean) | undefined;
  onToggleReadingList?: ((archive: ArchiveRecord, next: boolean) => void) | undefined;
  /** Renames that menu item, for a shelf that is not the reading list. */
  readingListLabels?: { add: string; remove: string } | undefined;
  categories?: Category[] | undefined;
  onAddCategory?: ((archive: ArchiveRecord, categoryId: string) => void) | undefined;
} = {}): {
  /** Pass as `onArchiveContextMenu` / `onContextMenu` to a card list. */
  open: (archive: ArchiveRecord, at: { x: number; y: number }) => void;
  /** Render once, anywhere in the same tree. */
  menu: JSX.Element;
} {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [target, setTarget] = useState<ArchiveContextMenuTarget>();
  const open = useCallback(
    (archive: ArchiveRecord, at: { x: number; y: number }) => setTarget({ archive, ...at }),
    [],
  );

  const menu = (
    <ArchiveContextMenu
      target={target}
      onClose={() => setTarget(undefined)}
      onRead={(archive) => navigate(`/reader/${encodeURIComponent(archive.archiveId)}`)}
      onReadIncognito={(archive) => navigate(`/reader/${encodeURIComponent(archive.archiveId)}?incognito=1`)}
      onEditMetadata={(archive) => navigate(`/library/${encodeURIComponent(archive.archiveId)}/edit`)}
      onCopyId={(archive) => {
        void navigator.clipboard?.writeText(archive.archiveId).then(
          () => showToast('档案 ID 已复制', 'success'),
          () => showToast('复制失败', 'error'),
        );
      }}
      inReadingList={target ? options.inReadingList?.(target.archive.archiveId) ?? false : false}
      {...(options.onToggleReadingList ? { onToggleReadingList: options.onToggleReadingList } : {})}
      {...(options.readingListLabels ? { readingListLabels: options.readingListLabels } : {})}
      {...(options.categories ? { categories: options.categories } : {})}
      {...(options.onAddCategory ? { onAddCategory: options.onAddCategory } : {})}
    />
  );

  return { open, menu };
}
