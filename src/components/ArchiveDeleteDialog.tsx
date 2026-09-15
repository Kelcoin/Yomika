import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ArchiveRecord } from '../domain/library';
import { NativeSettingsRepository, type PreferenceSnapshot } from '../repositories/nativeSettingsRepository';
import { deleteArchiveWithFavoriteSync } from '../lib/archiveDeletion';
import { useToast } from './Toast';

export function ArchiveDeleteDialog({ archive, onClose, onDeleted }: {
  archive: Pick<ArchiveRecord, 'serverId' | 'archiveId' | 'title'>;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { showToast } = useToast();
  return <ArchiveDeletionConfirmation description={`将永久删除「${archive.title}」，此操作不可撤销。`} onClose={onClose} onConfirm={async (syncFavorite) => {
    await deleteArchiveWithFavoriteSync(archive, syncFavorite);
    showToast('档案已删除', 'success');
    onDeleted();
  }} />;
}

export function ArchiveDeletionConfirmation({ description, onClose, onConfirm }: {
  description: string;
  onClose: () => void;
  onConfirm: (syncFavorite: boolean) => Promise<void>;
}) {
  const { showToast } = useToast();
  const [preferences, setPreferences] = useState<PreferenceSnapshot>();
  const [syncFavorite, setSyncFavorite] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void new NativeSettingsRepository().load().then((result) => {
      if (!active) return;
      if (!result.ok) { showToast(result.error.message, 'error'); return; }
      setPreferences(result.value);
      // 开关只是默认值：删除始终需要确认，这里决定的是它的初始勾选。
      setSyncFavorite(result.value.ehFavoriteDeleteSync && result.value.confirmEhFavoriteDelete);
    });
    return () => { active = false; };
  }, [showToast]);
  const remove = async () => {
    if (!preferences || busy) return;
    setBusy(true);
    try {
      await onConfirm(syncFavorite);
      onClose();
    } catch (error) { showToast(error instanceof Error ? error.message : '删除失败', 'error'); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content archive-delete-dialog">
        <Dialog.Title>确认删除</Dialog.Title>
        <Dialog.Description>{description}</Dialog.Description>
        {preferences?.ehFavoriteDeleteSync && (
          /* The whole row toggles: a label cannot activate a button, so the
             handler lives on the label and the switch is its visual control. */
          <label className="preference-toggle" onClick={() => { if (!busy) setSyncFavorite(!syncFavorite); }}>
            <button className="switch-control" type="button" role="switch" aria-label="本次同步删除 E-Hentai 收藏" aria-checked={syncFavorite} disabled={busy} tabIndex={-1}><span /></button>
            <span>同步删除 E-Hentai 收藏</span>
          </label>
        )}
        <div className="dialog-actions">
          <button className="secondary-action" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="primary-action" type="button" disabled={busy || !preferences} onClick={() => void remove()}><Trash2 aria-hidden="true" />{busy ? '删除中…' : '确认删除'}</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
