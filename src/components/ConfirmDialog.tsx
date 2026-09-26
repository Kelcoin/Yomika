import * as Dialog from '@radix-ui/react-dialog';
import { Check, X } from 'lucide-react';
import { useState } from 'react';

import { useOverlayBackGuard } from '../lib/overlayBackGuard';

/** 一次「确认 / 取消」：一个标题、一句说明、两颗按钮。
 *
 * 与文档里其它对话框同一套外观（图标 + 文字、`.dialog-actions` 平分宽度），
 * 危险的动作只体现在确认键的色调上。动作失败由调用方报错（toast），对话框不关，
 * 让用户可以直接再点一次。 */
export function ConfirmDialog({ title, description, confirmLabel = '确认', danger, onClose, onConfirm }: {
  title: string;
  description: string;
  confirmLabel?: string | undefined;
  danger?: boolean | undefined;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  // 返回手势先关这一层；忙的时候拒绝（守卫会自己补回去）。
  useOverlayBackGuard(true, () => { if (!busy) onClose(); });
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <div className="dialog-actions">
            <button className="secondary-action" type="button" disabled={busy} onClick={onClose}><X aria-hidden="true" />取消</button>
            <button
              className={`primary-action${danger ? ' is-danger' : ''}`}
              type="button"
              disabled={busy}
              aria-busy={busy}
              onClick={() => {
                setBusy(true);
                void onConfirm().then(onClose, () => {}).finally(() => setBusy(false));
              }}
            ><Check aria-hidden="true" />{confirmLabel}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
