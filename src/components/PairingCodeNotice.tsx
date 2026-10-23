import * as Dialog from '@radix-ui/react-dialog';
import { listen } from '@tauri-apps/api/event';
import { Check, Copy, Link2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { writeClipboardText } from '../bridge/clipboard';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { useToast } from './Toast';
import {
  COMPUTE_CENTER_PAIRING_CODE_EVENT,
  PairingCodeNoticeSchema,
  type PairingCodeNotice as PairingCodePayload,
} from '../repositories/nativeComputeCenterRepository';

/** 屏上这份配对码：对面报的来历，加上本机自己数的倒计时。 */
type Shown = PairingCodePayload & { secondsLeft: number; expiresAt: number };

/** 有人请求配对时，本机要显示六位码。
 *
 * 以前这一屏是 `tauri_plugin_dialog` 的系统消息框：一张 Windows 原生白底窗体，深浅色、
 * 字体、配色都跟应用无关，而且它在**另一台设备**发起配对的那一刻弹出来，用户往往正停在
 * 阅读器里——Rust 侧现在把码广播成事件（`PAIRING_CODE_EVENT`），这里画成主题内的弹窗，
 * 并且挂在所有页面之外（见 `App.tsx`），所以在哪一页都弹得出来。
 *
 * 码有 90 秒寿命，倒计时归零就自己收起：留着一条已经作废的数字，比不显示更让人误以为
 * 还能输入。 */
export function PairingCodeNotice() {
  const { showToast } = useToast();
  const [shown, setShown] = useState<Shown>();

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen(COMPUTE_CENTER_PAIRING_CODE_EVENT, (event) => {
      const parsed = PairingCodeNoticeSchema.safeParse(event.payload);
      if (active && parsed.success) setShown({ ...parsed.data, secondsLeft: parsed.data.expiresInSeconds, expiresAt: Date.now() + parsed.data.expiresInSeconds * 1000 });
    })
      .then((detach) => { if (active) unlisten = detach; else detach(); })
      .catch(() => { /* 不在壳里（网页调试）就没有这条事件 */ });
    return () => { active = false; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!shown) return;
    // Timers are throttled while the WebView is backgrounded. Count wall time,
    // not timer callbacks, so returning to the app never presents an expired code.
    const update = () => setShown((current) => {
      if (!current) return current;
      const secondsLeft = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
      return secondsLeft > 0 ? { ...current, secondsLeft } : undefined;
    });
    update();
    const timer = window.setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [shown?.expiresAt]);

  const close = useCallback(() => setShown(undefined), []);
  // 开着的时候返回手势先关这一层，不该把页面带走（手机上的返回走的是 webview 历史）。
  useOverlayBackGuard(Boolean(shown), close);

  if (!shown) return null;
  const code = shown.code.padStart(6, '0');
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content pairing-code-dialog">
          <Dialog.Title className="dialog-title"><Link2 aria-hidden="true" />远端配对</Dialog.Title>
          <Dialog.Description>
            {shown.name ? `「${shown.name}」` : '一台设备'}（{shown.address}）请求与这台设备配对，
            请在<strong>发起配对的设备</strong>上输入下面的配对码。
          </Dialog.Description>
          {/* 分两组读：六位连在一起时，人眼要数两遍才知道自己输到第几位。 */}
          <p className="pairing-code-value" aria-label={`配对码 ${code.split('').join(' ')}`}>
            <span>{code.slice(0, 3)}</span>
            <span>{code.slice(3)}</span>
          </p>
          <p className="pairing-code-expiry" role="timer" aria-live="polite">还剩 {shown.secondsLeft} 秒有效</p>
          <div className="dialog-actions">
            <button className="secondary-action" type="button" onClick={() => {
              void writeClipboardText(code).then(
                () => showToast('配对码已复制', 'success'),
                () => showToast('复制失败，请手动输入', 'error'),
              );
            }}>
              <Copy aria-hidden="true" />复制配对码
            </button>
            <button className="primary-action" type="button" onClick={close}><Check aria-hidden="true" />确定</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
