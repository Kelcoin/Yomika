import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookOpen, Bookmark, BookmarkX, Clipboard, EyeOff, FolderPlus, Pencil, Trash2, Download, Heart, HeartOff } from 'lucide-react';

import { getCategoryDisplayName } from '../lib/tags';
import type { ArchiveRecord } from '../domain/library';
import type { Category } from '../repositories/nativeLibraryRepository';

export interface ArchiveContextMenuTarget {
  archive: ArchiveRecord;
  x: number;
  y: number;
}

interface ArchiveContextMenuProps {
  target: ArchiveContextMenuTarget | undefined;
  onClose: () => void;
  onRead: (archive: ArchiveRecord) => void;
  onReadIncognito: (archive: ArchiveRecord) => void;
  onEditMetadata?: ((archive: ArchiveRecord) => void) | undefined;
  onCopyId?: ((archive: ArchiveRecord) => void) | undefined;
  /** Absent when the caller has no reading list, e.g. the dedup workspace. */
  onToggleReadingList?: ((archive: ArchiveRecord, next: boolean) => void) | undefined;
  inReadingList?: boolean | undefined;
  onToggleFavorite?: ((archive: ArchiveRecord, next: boolean) => void) | undefined;
  inFavorites?: boolean | undefined;
  membershipLoading?: boolean | undefined;
  favoriteLoading?: boolean | undefined;
  onDownload?: ((archive: ArchiveRecord) => void) | undefined;
  /** What that item is called. The favourites shelf uses the same slot to remove
   * a favourite, and calling that 移出待看 named the wrong shelf. */
  readingListLabels?: { add: string; remove: string } | undefined;
  /** Static categories only — see the submenu comment. */
  categories?: Category[] | undefined;
  onAddCategory?: ((archive: ArchiveRecord, categoryId: string) => void) | undefined;
  onDelete?: ((archive: ArchiveRecord) => void) | undefined;
}

/** Card-only context menu, anchored at the pointer.
 *
 * Radix needs an element to anchor to; a zero-size virtual anchor at the click
 * point is how a context menu is positioned without wrapping every card in a
 * trigger. */
export function ArchiveContextMenu({
  target,
  onClose,
  onRead,
  onReadIncognito,
  onEditMetadata,
  onCopyId,
  onToggleReadingList,
  inReadingList = false,
  onToggleFavorite,
  inFavorites = false,
  membershipLoading = false,
  favoriteLoading = false,
  onDownload,
  readingListLabels = { add: '加入待看', remove: '移出待看' },
  categories,
  onAddCategory,
  onDelete,
}: ArchiveContextMenuProps) {
  if (!target) return null;
  const archive = target.archive;
  return (
    <DropdownMenu.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DropdownMenu.Trigger asChild>
        <span
          aria-hidden="true"
          style={{ position: 'fixed', left: target.x, top: target.y, width: 0, height: 0 }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="archive-context-menu" align="start" sideOffset={2} aria-label={`${archive.title} 操作`}>
          <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => onRead(archive)}>
            <BookOpen aria-hidden="true" />阅读
          </DropdownMenu.Item>
          <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => onReadIncognito(archive)}>
            <EyeOff aria-hidden="true" />无痕阅读
          </DropdownMenu.Item>
          {onToggleReadingList && (
            <DropdownMenu.Item className="archive-context-menu-item" disabled={membershipLoading} onSelect={() => onToggleReadingList(archive, !inReadingList)}>
              {inReadingList ? <BookmarkX aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
              {inReadingList ? readingListLabels.remove : readingListLabels.add}
            </DropdownMenu.Item>
          )}
          {onToggleFavorite && <DropdownMenu.Item className="archive-context-menu-item" disabled={favoriteLoading} onSelect={() => onToggleFavorite(archive, !inFavorites)}>
            {inFavorites ? <HeartOff aria-hidden="true" /> : <Heart aria-hidden="true" />}
            {inFavorites ? '移出收藏夹' : '加入收藏夹'}
          </DropdownMenu.Item>}
          {onDownload && <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => onDownload(archive)}>
            <Download aria-hidden="true" />下载档案
          </DropdownMenu.Item>}
          {onEditMetadata && (
            <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => onEditMetadata(archive)}>
              <Pencil aria-hidden="true" />编辑元数据
            </DropdownMenu.Item>
          )}
          {onCopyId && (
            <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => onCopyId(archive)}>
              <Clipboard aria-hidden="true" />复制档案 ID
            </DropdownMenu.Item>
          )}
          {onAddCategory && categories && categories.length > 0 && (
            // A labelled group in the same menu rather than a submenu: one click
            // instead of a hover path, and the list is short because callers
            // pass static categories only — a dynamic category's membership
            // comes from its search expression, so there is nothing to assign
            // into.
            <>
              <DropdownMenu.Separator className="archive-context-menu-separator" />
              <DropdownMenu.Label className="archive-context-menu-label">
                <FolderPlus aria-hidden="true" />加入分类
              </DropdownMenu.Label>
              {categories.map((category) => (
                <DropdownMenu.Item
                  key={category.id}
                  className="archive-context-menu-item is-nested"
                  disabled={category.archives.includes(archive.archiveId)}
                  onSelect={() => onAddCategory(archive, category.id)}
                >
                  {getCategoryDisplayName(category.name)}
                </DropdownMenu.Item>
              ))}
            </>
          )}
          {onDelete && (
            <>
              <DropdownMenu.Separator className="archive-context-menu-separator" />
              <DropdownMenu.Item className="archive-context-menu-item is-danger" onSelect={() => onDelete(archive)}>
                <Trash2 aria-hidden="true" />删除档案
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
