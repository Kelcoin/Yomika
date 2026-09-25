import * as Dialog from '@radix-ui/react-dialog';
import { Eye, EyeOff, FileDown, FileUp, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

import { MIN_PASSPHRASE_CHARS } from '../domain/credentialWire';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';

/** 一个口令输入框：标签在左上、眼睛在框**里面**的右端。
 *
 * 用 `type="text"` + `-webkit-text-security: disc` 遮住，而不是 `type="password"`：
 * 后者会让浏览器在框里再画一个自己的「显示口令」按钮，和我们这个重复（桌面 WebView2 上
 * 就是一里一外两个眼睛），而那个按钮只在有内容时才出现，两个框看起来还不一致。自己遮罩
 * 之后只有一个按钮、两个框都有它，顺带也不会触发浏览器的密码管理器——这个口令是文件的
 * 口令，不是某个网站的登录口令。 */
function PassphraseInput({ label, value, reveal, onChange, onBlur, onToggleReveal }: {
  label: string;
  value: string;
  reveal: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
  onToggleReveal: () => void;
}) {
  return (
    <label className="passphrase-input">
      <span className="passphrase-input-label">{label}</span>
      <span className="passphrase-box">
        <input
          type="text"
          className={reveal ? '' : 'is-masked'}
          aria-label={label}
          value={value}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
        <button
          type="button"
          className="passphrase-reveal"
          aria-pressed={reveal}
          aria-label={reveal ? '隐藏口令' : '显示口令'}
          title={reveal ? '隐藏口令' : '显示口令'}
          onClick={onToggleReveal}
        >
          {reveal ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      </span>
    </label>
  );
}

/** 凭据文件的口令。导出要输两遍、导入只输一遍。
 *
 * 口令是这份文件唯一的防线（不上传、不落盘、不进日志），所以默认遮住、想核对就打开；
 * 而且**不边写边教训人**——「太短」「不一致」要等离开输入框或按了按钮才说。
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
  /** 提示的闸门：**那个框被离开**或者按过按钮之后才开口。
   *
   * 分两个框记：在第二个框里打字时第一个框早就失焦了，用「有人失焦过」当闸门会让
   * 「两次不一致」在还差最后一个字符时就跳出来——那正是要避免的。 */
  const [blurred, setBlurred] = useState({ pass: false, confirm: false });
  const [submitted, setSubmitted] = useState(false);
  const reduceMotion = useReducedMotion();
  // 每次打开都是一张白纸：上一次输到一半的口令不该留在输入框里。
  useEffect(() => {
    if (!open) return;
    setPassphrase('');
    setConfirm('');
    setReveal(false);
    setBlurred({ pass: false, confirm: false });
    setSubmitted(false);
  }, [open]);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_CHARS;
  const mismatch = mode === 'export' && confirm.length > 0 && confirm !== passphrase;
  const incomplete = passphrase.length < MIN_PASSPHRASE_CHARS || (mode === 'export' && confirm !== passphrase);
  const complaint = tooShort
    ? (blurred.pass || submitted ? `口令至少 ${MIN_PASSPHRASE_CHARS} 个字符` : undefined)
    : mismatch
      ? (blurred.confirm || submitted ? '两次输入的口令不一致' : undefined)
      : undefined;
  // 原生侧的失败原因不设闸门：那是发生了一件事，不是「你还没写完」。
  const message = complaint ?? problem;

  const submit = () => {
    setSubmitted(true);
    if (incomplete) return;
    onConfirm(passphrase);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content passphrase-dialog">
          <Dialog.Title>{mode === 'export' ? '给凭据文件设个口令' : '输入凭据文件的口令'}</Dialog.Title>
          <Dialog.Description>
            {mode === 'export'
              ? `文件里有${contents ?? '服务器 API Key、E-H Cookie 与同步账户口令'}，只有这个口令能打开它——它不上传、也不保存，忘了就打不开了。`
              : `这是导出时设的口令：输错打不开文件${contents ? `；这份文件里有${contents}` : ''}。`}
          </Dialog.Description>
          <PassphraseInput
            label="口令"
            value={passphrase}
            reveal={reveal}
            onChange={setPassphrase}
            onBlur={() => setBlurred((current) => ({ ...current, pass: true }))}
            onToggleReveal={() => setReveal((current) => !current)}
          />
          {mode === 'export' && (
            <PassphraseInput
              label="再输一遍"
              value={confirm}
              reveal={reveal}
              onChange={setConfirm}
              onBlur={() => setBlurred((current) => ({ ...current, confirm: true }))}
              onToggleReveal={() => setReveal((current) => !current)}
            />
          )}
          {/* 出现与消失都走动画：一句话冒出来把按钮顶上顶下，比那句话本身更烦人。高度从 0
              到 auto，只有把内容关进一个 overflow: hidden 的盒子里才动得起来。 */}
          <AnimatePresence initial={false}>
            {message && (
              <motion.div
                className="dialog-message"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.32, 0.72, 0, 1] }}
              >
                <p className="form-error" role="alert">{message}</p>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary-action" type="button"><X aria-hidden="true" />取消</button></Dialog.Close>
            <button className="primary-action" type="button" disabled={pending} aria-busy={pending} onClick={submit}>
              {mode === 'export' ? <FileDown aria-hidden="true" /> : <FileUp aria-hidden="true" />}
              {pending ? '处理中…' : mode === 'export' ? '导出' : '导入'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
