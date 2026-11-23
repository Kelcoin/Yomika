import { PositionedMenu } from './PositionedMenu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookOpen, Bookmark, BookmarkX, Clipboard, EyeOff, FolderPlus, Pencil, Trash2, Download, Heart, HeartOff, ExternalLink, RotateCcw } from 'lucide-react';
import type { DETAIL_ACTIONS } from '../repositories/nativeSettingsRepository';
import { archiveSourceUrl } from '../lib/archiveSource';
import { openExternalUrl } from '../bridge/externalUrl';
import { useToast } from './Toast';

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
  detail?: boolean | undefined;
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
  onClearProgress?: (() => void) | undefined;
  hiddenActions?: readonly (typeof DETAIL_ACTIONS)[number][] | undefined;
}

/** Card-only context menu, anchored at the pointer.
 *
 * Radix needs an element to anchor to; a zero-size virtual anchor at the click
 * point is how a context menu is positioned without wrapping every card in a
 * trigger. Keep it nonmodal: locking body scroll changes scrollbar geometry
 * beneath a scrolled virtual grid and can repack/remount the cards behind it. */
export function ArchiveContextMenu({
  detail,
  target,
  onClose,
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
  onClearProgress,
  hiddenActions = [],
}: ArchiveContextMenuProps) {
  const { showToast } = useToast();
  if (!target) return null;
  const archive = target.archive;
  const galleryUrl = archiveSourceUrl(archive.tags);
  return (
    <PositionedMenu at={target} label={`${archive.title} 操作`} {...(detail ? { className: 'is-detail-menu' } : {})} onClose={onClose}>
          <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => onReadIncognito(archive)}>
            <EyeOff aria-hidden="true" />无痕阅读
          </DropdownMenu.Item>
          {!hiddenActions.includes('readingList') && onToggleReadingList && (
            <DropdownMenu.Item className="archive-context-menu-item" disabled={membershipLoading} onSelect={() => onToggleReadingList(archive, !inReadingList)}>
              {inReadingList ? <BookmarkX aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
              {inReadingList ? readingListLabels.remove : readingListLabels.add}
            </DropdownMenu.Item>
          )}
          {!hiddenActions.includes('favorites') && onToggleFavorite && <DropdownMenu.Item className="archive-context-menu-item" disabled={favoriteLoading} onSelect={() => onToggleFavorite(archive, !inFavorites)}>
            {inFavorites ? <HeartOff aria-hidden="true" /> : <Heart aria-hidden="true" />}
            {inFavorites ? '移出收藏夹' : '加入收藏夹'}
          </DropdownMenu.Item>}
          {!hiddenActions.includes('download') && onDownload && <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => onDownload(archive)}>
            <Download aria-hidden="true" />下载档案
          </DropdownMenu.Item>}
          {galleryUrl && <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => {
            void openExternalUrl(galleryUrl).then((result) => { if (!result.ok) showToast(result.error.message, 'error'); });
          }}><ExternalLink aria-hidden="true" />跳转画廊</DropdownMenu.Item>}
          {!hiddenActions.includes('edit') && onEditMetadata && (
            <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => onEditMetadata(archive)}>
              <Pencil aria-hidden="true" />编辑元数据
            </DropdownMenu.Item>
          )}
          {!hiddenActions.includes('clearProgress') && onClearProgress && <DropdownMenu.Item className="archive-context-menu-item" onSelect={onClearProgress}>
            <RotateCcw aria-hidden="true" />清除阅读进度
          </DropdownMenu.Item>}
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
          {!hiddenActions.includes('delete') && onDelete && (
            <>
              <DropdownMenu.Separator className="archive-context-menu-separator" />
              <DropdownMenu.Item className="archive-context-menu-item is-danger" onSelect={() => onDelete(archive)}>
                <Trash2 aria-hidden="true" />删除档案
              </DropdownMenu.Item>
            </>
          )}
        </PositionedMenu>
  );
}

/** 本地档案的右键菜单：同一层壳、同一批条目类（`.archive-context-menu`、
 * `.archive-context-menu-item`、`.is-danger`），能做的事只有这一页真有的两件。
 *
 * 上面那个认的是 ArchiveRecord——阅读要走阅读器和服务器副本、编辑元数据要走
 * 档案库详情、加入待看要拿服务器上的成员关系，而磁盘上这一份的身份是路径：
 * 侧放进来、认不出来源时连 archiveId 都是 null，把 LocalArchiveRecord 硬塞进
 * ArchiveContextMenuTarget 就得编一个假的服务器身份，它还会照着假身份去发
 * 那些 IPC。条目名也会是错的（本地文件没有「无痕阅读」）。所以只能另起一个
 * 薄壳，样式一字不差地复用。 */
export interface LocalArchiveContextMenuTarget {
  detail?: boolean;
  path: string;
  title: string;
  x: number;
  y: number;
}

export function LocalArchiveContextMenu({ target, onClose, onOpen, onDelete }: {
  target: LocalArchiveContextMenuTarget | undefined;
  onClose: () => void;
  onOpen: (target: LocalArchiveContextMenuTarget) => void;
  onDelete: (target: LocalArchiveContextMenuTarget) => void;
}) {
  if (!target) return null;
  return (
    <PositionedMenu at={target} label={`${target.title} 操作`} {...(target.detail ? { className: 'is-detail-menu' } : {})} onClose={onClose}>
          <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => onOpen(target)}>
            <BookOpen aria-hidden="true" />查看详情
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="archive-context-menu-separator" />
          <DropdownMenu.Item className="archive-context-menu-item is-danger" onSelect={() => onDelete(target)}>
            <Trash2 aria-hidden="true" />删除本地档案
          </DropdownMenu.Item>
        </PositionedMenu>
  );
}
