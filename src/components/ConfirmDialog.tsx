import * as Dialog from '@radix-ui/react-dialog';
import { Check, CircleHelp, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePageActive } from '../app/RetainedPage';

import { useOverlayBackGuard } from '../lib/overlayBackGuard';

/** 一次「确认 / 取消」：一个标题、一句说明、两颗按钮。
 *
 * 与文档里其它对话框同一套外观（图标 + 文字、`.dialog-actions` 平分宽度），
 * 危险的动作只体现在确认键的色调上。动作失败由调用方报错（toast），对话框不关，
 * 让用户可以直接再点一次。 */
export function ConfirmDialog(props: Parameters<typeof ConfirmDialogContent>[0]) {
  const pageActive = usePageActive();
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useLayoutEffect(() => { if (!pageActive) closeRef.current(); }, [pageActive]);
  return pageActive ? <ConfirmDialogContent {...props} /> : null;
}

function ConfirmDialogContent({ title, description, confirmLabel = '确认', danger, onClose, onConfirm }: {
  title: string;
  description: string;
  confirmLabel?: string | undefined;
  danger?: boolean | undefined;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = () => { if (!busyRef.current) onClose(); };
  const confirm = async () => {
    if (busyRef.current || !mounted.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onConfirm();
      if (mounted.current) onClose();
    } catch {
      // The caller reports the failure; retain this confirmation for retry.
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  // 返回手势先关这一层（规矩见 lib/overlayBackGuard）；忙的时候拒绝，守卫会自己补回去。
  useOverlayBackGuard(true, close);
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">{danger ? <Trash2 aria-hidden="true" /> : <CircleHelp aria-hidden="true" />}{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <div className="dialog-actions">
            <button className="secondary-action" type="button" disabled={busy} onClick={close}><X aria-hidden="true" />取消</button>
            <button
              className={`primary-action${danger ? ' is-danger' : ''}`}
              type="button"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void confirm()}
            ><Check aria-hidden="true" />{confirmLabel}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
