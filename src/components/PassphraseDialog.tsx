import * as Dialog from '@radix-ui/react-dialog';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';

import { MIN_PASSPHRASE_CHARS } from '../domain/credentialWire';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';

/** 凭据文件的口令。导出要输两遍、导入只输一遍。
 *
 * 用 `type="password"` 而不是明文：这个口令是文件唯一的防线，屏幕上也一样。想核对
 * 就打开发挥按钮——输错的口令会让导出的文件再也打不开，所以核对比藏严实更重要。
 *
 * 组件自己不保存任何东西：关掉就清空，明文只在这一次输入里存在。 */
export function PassphraseDialog({
  open,
  mode,
  contents,
  pending = false,
  problem,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  /** 导出＝设一个新口令（要两遍）；导入＝输文件的口令（一遍）。 */
  mode: 'export' | 'import';
  /** 导入导出范围里勾中的凭据类名字，用来说清这个文件里装了什么。 */
  contents?: string | undefined;
  pending?: boolean | undefined;
  /** 原生侧带回来的失败原因（口令不对、文件损坏…）。 */
  problem?: string | undefined;
  onConfirm: (passphrase: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  // 返回手势先关这一层（见 overlayBackGuard）：口令框开着时返回不该把页面带走。
  useOverlayBackGuard(open, () => onOpenChange(false));
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  // 每次打开都是一张白纸：上一次输到一半的口令不该留在输入框里。
  useEffect(() => {
    if (!open) return;
    setPassphrase('');
    setConfirm('');
    setReveal(false);
  }, [open]);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_CHARS;
  const mismatch = mode === 'export' && confirm.length > 0 && confirm !== passphrase;
  const incomplete = passphrase.length < MIN_PASSPHRASE_CHARS || (mode === 'export' && confirm !== passphrase);
  const message = tooShort
    ? `口令至少 ${MIN_PASSPHRASE_CHARS} 个字符`
    : mismatch
      ? '两次输入的口令不一致'
      : problem;

  const submit = () => {
    if (incomplete) return;
    onConfirm(passphrase);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>{mode === 'export' ? '给凭据文件设个口令' : '输入凭据文件的口令'}</Dialog.Title>
          <Dialog.Description>
            {mode === 'export'
              ? `文件里有${contents ?? '服务器 API Key、E-H Cookie 与同步账户口令'}，只有这个口令能打开它——它不上传、也不保存，忘了就打不开了。`
              : `这是导出时设的口令：输错打不开文件${contents ? `；这份文件里有${contents}` : ''}。`}
          </Dialog.Description>
          <div className="passphrase-field">
            <label className="text-input-dialog-field">
              <span>口令</span>
              <input
                autoFocus
                aria-label="口令"
                type={reveal ? 'text' : 'password'}
                value={passphrase}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setPassphrase(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
              />
            </label>
            <button
              type="button"
              className="passphrase-reveal"
              aria-pressed={reveal}
              aria-label={reveal ? '隐藏口令' : '显示口令'}
              onClick={() => setReveal((current) => !current)}
            >
              {reveal ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
          {mode === 'export' && (
            <label className="text-input-dialog-field">
              <span>再输一遍</span>
              <input
                aria-label="确认口令"
                type={reveal ? 'text' : 'password'}
                value={confirm}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setConfirm(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
              />
            </label>
          )}
          {/* 有话说的时候只显示最该说的那句：口令太短、两次不一致、或者原生侧的失败原因。 */}
          {message && <p className="form-error" role="alert">{message}</p>}
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary-action" type="button">取消</button></Dialog.Close>
            <button className="primary-action" type="button" disabled={incomplete || pending} aria-busy={pending} onClick={submit}>
              {pending ? '处理中…' : mode === 'export' ? '导出' : '导入'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
