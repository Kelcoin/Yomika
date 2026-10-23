import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkMinus, BookmarkPlus, Trash2 } from 'lucide-react';

import type { ArchiveRecord } from '../domain/library';
import { deleteArchiveWithFavoriteSync } from '../lib/archiveDeletion';
import { mirrorFavorites } from '../lib/favoritesMirror';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { ArchiveDeletionConfirmation } from './ArchiveDeleteDialog';
import { useToast } from './Toast';

const repository = new NativeLibraryRepository();

/** Multi-select for a list of archives: the ids, the bulk actions that list can
 * actually perform, and the confirmation guarding the destructive one.
 *
 * The list keeps the selection, so the page can act on it; the range logic
 * stays in the list, because only it knows the row order a shift click extends
 * over. */
export function useArchiveSelection(options: {
  archives: ArchiveRecord[];
  scopeId?: string | undefined;
  /** A shelf that holds one membership: bulk-add or bulk-remove that one. */
  membership?: { list: 'reading' | 'favorites'; label: string; present: boolean } | undefined;
  /** 收藏夹 membership is the LANraragi 🔖 Favorites category, so shelf
   * writes are mirrored to the server when the caller has a server. */
  serverId?: string | undefined;
  /** 这一页的多选能不能就地删除档案。历史页要清的是「看过」这件事，不是档案
   * 本体，所以那一页不给「删除所选」（它的清理入口是「清理所选记录」）。 */
  allowDelete?: boolean | undefined;
  /** Called with the ids the list must stop showing. */
  onRemoved: (archiveIds: string[]) => void;
}): {
  props: {
    selectionMode: boolean;
    onSelectionModeChange: (next: boolean) => void;
    selectedArchiveIds: ReadonlySet<string>;
    onSelectionChange: (next: ReadonlySet<string>) => void;
  };
  /** Buttons for the selection bar. */
  actions: JSX.Element | null;
  /** The delete confirmation, rendered once by the page. */
  dialogs: JSX.Element | null;
} {
  const { archives, scopeId, membership, serverId, onRemoved, allowDelete = true } = options;
  const { showToast } = useToast();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedArchiveIds, setSelectedArchiveIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const identity = `${scopeId ?? ''}:${serverId ?? ''}:${membership?.list ?? ''}`;
  const selectionOwner = useRef({ identity, busy: false, active: true });
  if (selectionOwner.current.identity !== identity) selectionOwner.current = { identity, busy: false, active: true };
  const scopeOwner = selectionOwner.current;
  useEffect(() => {
    scopeOwner.active = true;
    setSelectionMode(false);
    setSelectedArchiveIds(new Set());
    setPendingDelete(false);
    setBusy(false);
    return () => { scopeOwner.active = false; };
  }, [scopeOwner]);

  const selected = useMemo(
    () => archives.filter((archive) => selectedArchiveIds.has(archive.archiveId)),
    [archives, selectedArchiveIds],
  );

  const changeMode = useCallback((next: boolean) => {
    setSelectionMode(next);
    // Leaving the mode drops the selection: a list still marked after the bar
    // is gone has nothing to act on it.
    if (!next) setSelectedArchiveIds(new Set());
  }, []);

  const changeMembership = useCallback(async (next: boolean) => {
    if (!scopeId || selected.length === 0 || !scopeOwner.active || scopeOwner.busy) return;
    scopeOwner.busy = true;
    setBusy(true);
    try {
      const results = await Promise.all(selected.map(async archive => {
        if (membership?.list === 'reading') {
          const result = await repository.setReadingList(scopeId, archive.archiveId, next);
          return { id: archive.archiveId, ok: result.ok };
        }
        return { id: archive.archiveId, ok: (await mirrorFavorites(serverId ?? archive.serverId, [archive.archiveId], next)) === 0 };
      }));
      if (selectionOwner.current !== scopeOwner || !scopeOwner.active) return;
      const failed = results.filter(result => !result.ok).length;
      if (failed) showToast(`${failed} 个档案未能更新`, 'error');
      else showToast(next ? `已加入${membership?.label ?? '收藏夹'}` : `已移出${membership?.label ?? '收藏夹'}`, 'success');
      if (!next && membership) onRemoved(results.filter(result => result.ok).map(result => result.id));
      setSelectedArchiveIds(new Set());
    } finally {
      scopeOwner.busy = false;
      if (selectionOwner.current === scopeOwner && scopeOwner.active) setBusy(false);
    }
  }, [membership, onRemoved, scopeId, scopeOwner, selected, serverId, showToast]);

  // Icon-only, like the list's own selection bar: the words are the accessible
  // name and the tooltip, and the membership's label is the only thing that
  // changes between the two directions.
  const membershipLabel = membership ? (membership.present ? `移出${membership.label}` : `加入${membership.label}`) : '加入收藏';
  const actions = (
    <>
      {membership ? (
        <button className="secondary-action has-action-label" type="button" aria-label={membershipLabel} title={membershipLabel} disabled={selected.length === 0 || busy} onClick={() => void changeMembership(!membership.present)}>
          {membership.present ? <BookmarkMinus aria-hidden="true" /> : <BookmarkPlus aria-hidden="true" />}
        <span className="action-label">{membershipLabel}</span></button>
      ) : (
        <button className="secondary-action has-action-label" type="button" aria-label="加入收藏" title="加入收藏" disabled={selected.length === 0 || busy} onClick={() => void changeMembership(true)}>
          <BookmarkPlus aria-hidden="true" />
        <span className="action-label">加入收藏</span></button>
      )}
      {/* 删除也用同一颗按钮的形状——危险只体现在色调上，底色加文字与其它
          动作一致，不再是一圈红描边。 */}
      {allowDelete && (
        <button className="secondary-action is-danger has-action-label" type="button" aria-label="删除所选" title="删除所选" disabled={selected.length === 0 || busy} onClick={() => setPendingDelete(true)}>
          <Trash2 aria-hidden="true" />
        <span className="action-label">删除所选</span></button>
      )}
    </>
  );

  const dialogs = pendingDelete ? (
    <ArchiveDeletionConfirmation
      description={`将永久删除选中的 ${selected.length} 个档案，此操作不可撤销。`}
      onClose={() => { if (selectionOwner.current === scopeOwner && scopeOwner.active) setPendingDelete(false); }}
      onConfirm={async (syncFavorite) => {
        if (selectionOwner.current !== scopeOwner || !scopeOwner.active || scopeOwner.busy) return;
        scopeOwner.busy = true;
        setBusy(true);
        const removed: string[] = [];
        try {
          for (const archive of selected) {
            await deleteArchiveWithFavoriteSync(archive, syncFavorite);
            removed.push(archive.archiveId);
          }
          if (selectionOwner.current === scopeOwner && scopeOwner.active) showToast(`已删除 ${removed.length} 个档案`, 'success');
        } finally {
          scopeOwner.busy = false;
          if (selectionOwner.current === scopeOwner && scopeOwner.active) {
            setBusy(false);
            // Successful deletions stay successful even if a later one fails.
            // Keep only the remaining selection so confirmation can retry it.
            if (removed.length) {
              onRemoved(removed);
              const deleted = new Set(removed);
              setSelectedArchiveIds((current) => new Set([...current].filter((id) => !deleted.has(id))));
            }
          }
        }
      }}
    />
  ) : null;

  return {
    props: {
      selectionMode,
      onSelectionModeChange: changeMode,
      selectedArchiveIds,
      onSelectionChange: setSelectedArchiveIds,
    },
    actions,
    dialogs,
  };
}
