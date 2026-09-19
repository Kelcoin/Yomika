import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { writeClipboardText } from '../bridge/clipboard';
import { ArchiveContextMenu, type ArchiveContextMenuTarget } from './ArchiveContextMenu';
import { ArchiveDeleteDialog } from './ArchiveDeleteDialog';
import { useToast } from './Toast';
import type { ArchiveRecord } from '../domain/library';
import { NativeLibraryRepository, type Category } from '../repositories/nativeLibraryRepository';
import { downloadResultMessage, downloadResultTone } from '../lib/downloadResult';
import { FAVORITES_CATEGORY_NAME } from '../lib/tags';

const repository = new NativeLibraryRepository();

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
  onMembershipChange?: ((archiveId: string, list: 'reading' | 'favorites', next: boolean) => void) | undefined;
  onDeleted?: ((archiveId: string) => void) | undefined;
} = {}): {
  /** Pass as `onArchiveContextMenu` / `onContextMenu` to a card list. */
  open: (archive: ArchiveRecord, at: { x: number; y: number }) => void;
  /** Render once, anywhere in the same tree. */
  menu: JSX.Element;
  requestDelete: (archive: ArchiveRecord) => void;
} {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();
  const [target, setTarget] = useState<ArchiveContextMenuTarget>();
  const [deleteTarget, setDeleteTarget] = useState<ArchiveRecord>();
  const [membership, setMembership] = useState<{ scopeId: string; reading: boolean | undefined; favorites: boolean | undefined }>();
  const membershipRequest = useRef(0);
  useEffect(() => {
    const request = ++membershipRequest.current;
    setMembership(undefined);
    if (!target) return;
    void (async () => {
      const servers = await repository.listServers();
      const server = servers.ok ? servers.value.find((server) => server.id === target.archive.serverId) : undefined;
      if (!server) return;
      const status = await repository.archiveMembership(server.scopeId, target.archive.archiveId);
      if (request !== membershipRequest.current) return;
      if (!status.ok) showToast('待看或收藏状态读取失败', 'error');
      setMembership({ scopeId: server.scopeId, reading: status.ok ? status.value.reading : undefined, favorites: status.ok ? status.value.favorites : undefined });
    })();
    return () => { membershipRequest.current += 1; };
  }, [target, showToast]);
  const toggleMembership = (archive: ArchiveRecord, list: 'reading' | 'favorites', next: boolean) => {
    if (!membership) return;
    const update = list === 'reading' ? repository.setReadingList(membership.scopeId, archive.archiveId, next) : repository.setWatchlist(membership.scopeId, archive.archiveId, next);
    void update.then((result) => {
      if (!result.ok) { showToast(result.error.message, 'error'); return; }
      options.onMembershipChange?.(archive.archiveId, list, next);
      showToast(`${next ? '已加入' : '已移出'}${list === 'reading' ? '待看' : '收藏夹'}`, 'success');
      // 收藏夹 reads the LANraragi 🔖 Favorites category, so the heart mirrors
      // the write there too — best effort, the local row stays as the offline
      // mirror and for WebDAV sync either way.
      if (list === 'favorites') {
        void repository.listCategories(archive.serverId).then((categories) => {
          const favorites = categories.ok ? categories.value.find((category) => category.name === FAVORITES_CATEGORY_NAME) : undefined;
          if (!favorites) return;
          const mirrored = next
            ? repository.addArchiveToCategory(archive.serverId, favorites.id, archive.archiveId)
            : repository.removeArchiveFromCategory(archive.serverId, favorites.id, archive.archiveId);
          void mirrored.then((mirrorResult) => { if (!mirrorResult.ok) showToast('未能同步到服务器收藏夹', 'error'); });
        });
      }
    });
  };
  const open = useCallback(
    (archive: ArchiveRecord, at: { x: number; y: number }) => setTarget({ archive, ...at }),
    [],
  );

  const menu = (<>
    <ArchiveContextMenu
      target={target}
      onClose={() => setTarget(undefined)}
      onRead={(archive) => navigate(`/reader/${encodeURIComponent(archive.archiveId)}?server=${encodeURIComponent(archive.serverId)}`)}
      onDelete={setDeleteTarget}
      onReadIncognito={(archive) => navigate(`/reader/${encodeURIComponent(archive.archiveId)}?incognito=1&server=${encodeURIComponent(archive.serverId)}`)}
      onEditMetadata={(archive) => navigate(`/library/${encodeURIComponent(archive.archiveId)}/edit?server=${encodeURIComponent(archive.serverId)}`, { state: { returnTo: `${location.pathname}${location.search}` } })}
      onCopyId={(archive) => {
        void writeClipboardText(archive.archiveId).then(
          () => showToast('档案 ID 已复制', 'success'),
          () => showToast('复制失败', 'error'),
        );
      }}
      inReadingList={target ? options.inReadingList?.(target.archive.archiveId) ?? membership?.reading ?? false : false}
      membershipLoading={!options.onToggleReadingList && membership?.reading === undefined}
      favoriteLoading={membership?.favorites === undefined}
      inFavorites={membership?.favorites ?? false}
      onToggleReadingList={options.onToggleReadingList ?? ((archive, next) => toggleMembership(archive, 'reading', next))}
      onToggleFavorite={(archive, next) => toggleMembership(archive, 'favorites', next)}
      onDownload={(archive) => {
        showToast('正在下载档案', 'info');
        void repository.downloadArchive(archive.serverId, archive.archiveId).then((result) => {
          showToast(result.ok ? downloadResultMessage(result.value) : result.error.message, result.ok ? downloadResultTone(result.value) : 'error');
        });
      }}
      {...(options.readingListLabels ? { readingListLabels: options.readingListLabels } : {})}
      {...(options.categories ? { categories: options.categories } : {})}
      {...(options.onAddCategory ? { onAddCategory: options.onAddCategory } : {})}
    />
    {deleteTarget && <ArchiveDeleteDialog archive={deleteTarget} onClose={() => setDeleteTarget(undefined)} onDeleted={() => options.onDeleted?.(deleteTarget.archiveId)} />}
  </>);

  return { open, menu, requestDelete: setDeleteTarget };
}
