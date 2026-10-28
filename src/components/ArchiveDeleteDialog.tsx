import { DialogSurface, DialogHeading } from './DialogSurface';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePageActive } from '../app/RetainedPage';
import { Trash2, X } from 'lucide-react';
import type { ArchiveRecord } from '../domain/library';
import { NativeSettingsRepository, type PreferenceSnapshot } from '../repositories/nativeSettingsRepository';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { deleteArchiveWithFavoriteSync } from '../lib/archiveDeletion';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { useToast } from './Toast';
import { SettingsSwitch } from './SettingsControls';
import { CardProgressBar } from './CardProgressBar';

type ArchiveDeleteDialogProps = {
  archive: Pick<ArchiveRecord, 'serverId' | 'archiveId' | 'title'>;
  onClose: () => void;
  onDeleted: () => void;
};

export function ArchiveDeleteDialog(props: ArchiveDeleteDialogProps) {
  const pageActive = usePageActive();
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useLayoutEffect(() => { if (!pageActive) closeRef.current(); }, [pageActive]);
  if (!pageActive) return null;
  return <ArchiveDeleteDialogContent key={JSON.stringify([props.archive.serverId, props.archive.archiveId])} {...props} />;
}

function ArchiveDeleteDialogContent({ archive, onClose, onDeleted }: ArchiveDeleteDialogProps) {
  const { showToast } = useToast();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <ArchiveDeletionConfirmation description={`将永久删除「${archive.title}」，此操作不可撤销。`} onClose={onClose} onConfirm={async (syncFavorite) => {
    await deleteArchiveWithFavoriteSync(archive, syncFavorite);
    if (mounted.current) { showToast('档案已删除', 'success'); onDeleted(); }
  }} />;
}

export function ArchiveDeletionConfirmation(props: Parameters<typeof ArchiveDeletionConfirmationContent>[0]) {
  const pageActive = usePageActive();
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useLayoutEffect(() => { if (!pageActive) closeRef.current(); }, [pageActive]);
  return pageActive ? <ArchiveDeletionConfirmationContent {...props} /> : null;
}

function ArchiveDeletionConfirmationContent({ description, onClose, onConfirm, progress, keepOpenAfterConfirm = false }: {
  description: string;
  onClose: () => void;
  onConfirm: (syncFavorite: boolean) => Promise<void>;
  progress?: { processed: number; total: number; label: string } | undefined;
  keepOpenAfterConfirm?: boolean;
}) {
  const { showToast } = useToast();
  const [preferences, setPreferences] = useState<PreferenceSnapshot>();
  const [syncFavorite, setSyncFavorite] = useState<boolean>();
  /** 有没有可用的 E-Hentai 账户；undefined 表示还没读到（或读失败，按可用处理）。 */
  const [ehReady, setEhReady] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [loadError, setLoadError] = useState<string>();
  const [reload, setReload] = useState(0);
  // 挂载即打开；返回手势先关这一层（规矩见 lib/overlayBackGuard）。忙的时候拒绝，
  // 守卫会自己补回去。
  useOverlayBackGuard(true, () => { if (!busyRef.current) onClose(); });
  useEffect(() => {
    let active = true;
    void (async () => {
      const [saved, accounts] = await Promise.all([
        new NativeSettingsRepository().load(),
        new NativeEhRepository().listAccounts(),
      ]);
      if (!active) return;
      if (!saved.ok) { setLoadError(saved.error.message); return; }
      // 收藏同步需要一个已登录的账户：读不到列表就当没登录（先别勾上），读列表本身
      // 失败则按可用处理——不因为一次读取失败把功能挡掉。
      const ready = accounts.ok ? accounts.value.some((account) => account.isActive) : true;
      setPreferences(saved.value);
      setEhReady(ready);
      // 开关只是默认值：删除始终需要确认，这里决定的是它的初始勾选。
      setSyncFavorite(saved.value.ehFavoriteDeleteSync && saved.value.confirmEhFavoriteDelete && ready);
    })();
    return () => { active = false; };
  }, [reload]);
  const syncAvailable = Boolean(preferences?.ehFavoriteDeleteSync) && ehReady !== false;
  const remove = async () => {
    if (!preferences || syncFavorite === undefined || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onConfirm(syncFavorite);
      if (mounted.current) {
        if (keepOpenAfterConfirm) setFinished(true);
        else onClose();
      }
    } catch (error) { if (mounted.current) showToast(error instanceof Error ? error.message : '删除失败', 'error'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busyRef.current) onClose(); }}>
    
      <DialogSurface className="archive-delete-dialog">
        <DialogHeading icon={<Trash2 aria-hidden="true" />}>确认删除</DialogHeading>
        <Dialog.Description className="visually-hidden">{description}</Dialog.Description>
        {loadError && <div role="alert">
          <p>{loadError}</p>
          <button className="secondary-action" type="button" onClick={() => { setLoadError(undefined); setReload((value) => value + 1); }}>重新加载设置</button>
        </div>}
        {/* 没登录 E-Hentai 就整行不出现（Readoshi 也这么做）：摆一个按不动的开关
            只会让人以为功能坏了，而这次删除确实没有收藏可同步。 */}
        {syncAvailable && !finished && (
          <SettingsSwitch label="本次同步删除 E-Hentai 收藏" checked={Boolean(syncFavorite)} disabled={busy} onToggle={() => setSyncFavorite(!syncFavorite)} />
        )}
        {(busy || finished) && progress && <div className="dedup-execution-progress" role="status">
          <div><strong>{progress.label}</strong><span>{progress.processed} / {progress.total}</span></div>
          <CardProgressBar percent={progress.total > 0 ? progress.processed / progress.total * 100 : 0} indeterminate={progress.total === 0} label="执行进度" />
        </div>}
        <div className="dialog-actions">
          {finished ? <button className="primary-action" type="button" onClick={onClose}>完成</button> : <>
            <button className="secondary-action" type="button" disabled={busy} onClick={onClose}><X aria-hidden="true" />取消</button>
            <button className="primary-action" type="button" disabled={busy || syncFavorite === undefined} onClick={() => void remove()}><Trash2 aria-hidden="true" />{busy ? '删除中…' : '确认删除'}</button>
          </>}
        </div>
      </DialogSurface>
    
  </Dialog.Root>;
}
