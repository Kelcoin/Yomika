import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type { ArchiveRecord } from '../domain/library';
import { NativeSettingsRepository, type PreferenceSnapshot } from '../repositories/nativeSettingsRepository';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { deleteArchiveWithFavoriteSync } from '../lib/archiveDeletion';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { useToast } from './Toast';
import { SwitchControl } from './SettingsControls';

export function ArchiveDeleteDialog({ archive, onClose, onDeleted }: {
  archive: Pick<ArchiveRecord, 'serverId' | 'archiveId' | 'title'>;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { showToast } = useToast();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <ArchiveDeletionConfirmation description={`将永久删除「${archive.title}」，此操作不可撤销。`} onClose={onClose} onConfirm={async (syncFavorite) => {
    await deleteArchiveWithFavoriteSync(archive, syncFavorite);
    showToast('档案已删除', 'success');
    if (mounted.current) onDeleted();
  }} />;
}

export function ArchiveDeletionConfirmation({ description, onClose, onConfirm }: {
  description: string;
  onClose: () => void;
  onConfirm: (syncFavorite: boolean) => Promise<void>;
}) {
  const { showToast } = useToast();
  const [preferences, setPreferences] = useState<PreferenceSnapshot>();
  const [syncFavorite, setSyncFavorite] = useState<boolean>();
  /** 有没有可用的 E-Hentai 账户；undefined 表示还没读到（或读失败，按可用处理）。 */
  const [ehReady, setEhReady] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  // 挂载即打开；返回手势先关这一层（忙的时候拒绝，守卫会自己补回去）。
  useOverlayBackGuard(true, () => { if (!busy) onClose(); });
  useEffect(() => {
    let active = true;
    void (async () => {
      const [saved, accounts] = await Promise.all([
        new NativeSettingsRepository().load(),
        new NativeEhRepository().listAccounts(),
      ]);
      if (!active) return;
      if (!saved.ok) { showToast(saved.error.message, 'error'); return; }
      // 收藏同步需要一个已登录的账户：读不到列表就当没登录（先别勾上），读列表本身
      // 失败则按可用处理——不因为一次读取失败把功能挡掉。
      const ready = accounts.ok ? accounts.value.some((account) => account.isActive) : true;
      setPreferences(saved.value);
      setEhReady(ready);
      // 开关只是默认值：删除始终需要确认，这里决定的是它的初始勾选。
      setSyncFavorite(saved.value.ehFavoriteDeleteSync && saved.value.confirmEhFavoriteDelete && ready);
    })();
    return () => { active = false; };
  }, [showToast]);
  const syncAvailable = Boolean(preferences?.ehFavoriteDeleteSync) && ehReady !== false;
  const remove = async () => {
    if (!preferences || syncFavorite === undefined || busy) return;
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
        {/* 没登录 E-Hentai 就整行不出现（Readoshi 也这么做）：摆一个按不动的开关
            只会让人以为功能坏了，而这次删除确实没有收藏可同步。 */}
        {syncAvailable && (
          /* The whole row toggles: a label cannot activate a button, so the
             handler lives on the label and the shared switch is its control. It
             carries no aria-label of its own here — the label text next to it is
             the name, and two names for one control is one too many. */
          <label className="preference-toggle" onClick={() => { if (!busy) setSyncFavorite(!syncFavorite); }}>
            <SwitchControl label="本次同步删除 E-Hentai 收藏" checked={Boolean(syncFavorite)} disabled={busy} tabIndex={-1} />
            <span>同步删除 E-Hentai 收藏</span>
          </label>
        )}
        <div className="dialog-actions">
          <button className="secondary-action" type="button" disabled={busy} onClick={onClose}><X aria-hidden="true" />取消</button>
          <button className="primary-action" type="button" disabled={busy || syncFavorite === undefined} onClick={() => void remove()}><Trash2 aria-hidden="true" />{busy ? '删除中…' : '确认删除'}</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
