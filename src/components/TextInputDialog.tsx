import * as Dialog from '@radix-ui/react-dialog';
import { Check, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePageActive } from '../app/RetainedPage';

import { useOverlayBackGuard } from '../lib/overlayBackGuard';

/** A drawn prompt, replacing `window.prompt`.
 *
 * The native prompt is unstyled, unpositioned, blocks the whole window, and on
 * Windows it renders as a browser chrome dialog that looks nothing like the app.
 * It also gives no way to validate before accepting.
 */
export function TextInputDialog(props: Parameters<typeof TextInputDialogContent>[0]) {
  const pageActive = usePageActive();
  const closeRef = useRef(props.onOpenChange);
  closeRef.current = props.onOpenChange;
  useLayoutEffect(() => { if (!pageActive && props.open) closeRef.current(false); }, [pageActive, props.open]);
  return pageActive ? <TextInputDialogContent {...props} /> : null;
}

function TextInputDialogContent({
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
  onConfirm: (value: string) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const busyRef = useRef(false);
  const lifetime = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  // 返回手势先关这一层（见 overlayBackGuard）：对话框开着时返回不该把页面带走。
  useOverlayBackGuard(open, () => { if (!busyRef.current) onOpenChange(false); });
  useEffect(() => {
    lifetime.current++;
    busyRef.current = false;
    setBusy(false);
    setSaveError(undefined);
    return () => { lifetime.current++; };
  }, [open]);
  // Reopening starts from the caller's default rather than the last edit.
  useEffect(() => { if (open && !busyRef.current) setValue(defaultValue); }, [defaultValue, open]);

  const problem = validate?.(value.trim());
  const submit = async () => {
    if (problem || busyRef.current || !open) return;
    const version = lifetime.current;
    const current = () => lifetime.current === version && openRef.current;
    busyRef.current = true;
    setBusy(true);
    setSaveError(undefined);
    try {
      await onConfirm(value.trim());
      if (current()) onOpenChange(false);
    } catch (error) {
      if (current()) setSaveError(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      if (current()) { busyRef.current = false; setBusy(false); }
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busyRef.current) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" {...(!description ? { 'aria-describedby': undefined } : {})}>
          <Dialog.Title>{title}</Dialog.Title>
          {description && <Dialog.Description>{description}</Dialog.Description>}
          <label className="text-input-dialog-field">
            {label}
            <input
              autoFocus
              value={value}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => { setValue(event.target.value); setSaveError(undefined); }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter') { event.preventDefault(); void submit(); }
              }}
            />
          </label>
          {/* Says why the button is disabled instead of leaving it inert. */}
          {problem && <p className="form-error" role="alert">{problem}</p>}
          {saveError && <p className="form-error" role="alert">{saveError}</p>}
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary-action" type="button" disabled={busy}><X aria-hidden="true" />取消</button></Dialog.Close>
            <button className="primary-action" type="button" disabled={busy || Boolean(problem)} aria-busy={busy} onClick={() => void submit()}><Check aria-hidden="true" />{confirmLabel}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
