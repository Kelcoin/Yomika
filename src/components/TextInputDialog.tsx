import * as Dialog from '@radix-ui/react-dialog';
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useOverlayBackGuard } from '../lib/overlayBackGuard';

/** A drawn prompt, replacing `window.prompt`.
 *
 * The native prompt is unstyled, unpositioned, blocks the whole window, and on
 * Windows it renders as a browser chrome dialog that looks nothing like the app.
 * It also gives no way to validate before accepting.
 */
export function TextInputDialog({
  open,
  title,
  description,
  label,
  defaultValue = '',
  confirmLabel = '确定',
  validate,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  defaultValue?: string;
  confirmLabel?: string;
  /** Returns a reason when the value cannot be accepted, otherwise undefined. */
  validate?: (value: string) => string | undefined;
  onConfirm: (value: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  // 返回手势先关这一层（见 overlayBackGuard）：对话框开着时返回不该把页面带走。
  useOverlayBackGuard(open, () => onOpenChange(false));
  // Reopening starts from the caller's default rather than the last edit.
  useEffect(() => { if (open) setValue(defaultValue); }, [defaultValue, open]);

  const problem = validate?.(value);
  const submit = () => {
    if (problem) return;
    onConfirm(value.trim());
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>{title}</Dialog.Title>
          {description && <Dialog.Description>{description}</Dialog.Description>}
          <label className="text-input-dialog-field">
            {label}
            <input
              autoFocus
              value={value}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
            />
          </label>
          {/* Says why the button is disabled instead of leaving it inert. */}
          {problem && <p className="form-error" role="alert">{problem}</p>}
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary-action" type="button"><X aria-hidden="true" />取消</button></Dialog.Close>
            <button className="primary-action" type="button" disabled={Boolean(problem)} onClick={submit}><Check aria-hidden="true" />{confirmLabel}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
