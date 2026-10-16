import * as Dialog from '@radix-ui/react-dialog';
import { Download, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { openExternalUrl } from '../bridge/externalUrl';
import { availableModelUpdates, modelUpdateFingerprint } from '../lib/modelUpdates';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { NativeAppInfoRepository } from '../repositories/nativeAppInfoRepository';
import { NativeInferenceRepository } from '../repositories/nativeInferenceRepository';
import { useToast } from './Toast';

/** 「跳过」记在这里而不是偏好设置里：偏好会参与同步与导出，而「这台机器上看过
 * 哪个版本」不该跟着账号跑到别的机器上（`yomika.tagcount.*` 是同一个先例）。 */
const SKIPPED_APP_VERSION_KEY = 'yomika.update.skipped-version';
const SKIPPED_MODEL_SET_KEY = 'yomika.update.skipped-models';

interface UpdatePrompt {
  /** 在同一次检查里唯一：跳过一个之后接着看下一个。 */
  key: string;
  title: string;
  description: string;
  confirmLabel: string;
  /** 「跳过」要写进 localStorage 的那一对。 */
  skipKey: string;
  skipValue: string;
  /** 本体：要打开的 release 页；模型：没有地址，确认键跳到高级设置。 */
  url?: string;
}

function readSkipped(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    // 隐私模式之类读不到：当作没跳过，最多再问一次。
    return undefined;
  }
}

function rememberSkipped(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 记不住就算了：这一次的弹窗还是会关掉，只是下次启动会再问一遍。
  }
}

/** 启动时问一次「本体 / 模型有没有新版本」。
 *
 * 两件事各自独立，谁查到算谁：本体走原生命令（CSP 不让网页直连 api.github.com），
 * 模型是「目录里的版本」对比「盘上装的版本」。检查失败一律静默——离线不是用户要
 * 处理的问题，启动时蹦一句网络错误只会添乱。
 *
 * 本体在前：它是整包升级，模型更新通常顺带就带上了。 */
export function UpdateNotice() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [prompts, setPrompts] = useState<UpdatePrompt[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const check = async () => {
      const found: UpdatePrompt[] = [];
      const release = await new NativeAppInfoRepository().appReleaseLatest();
      if (
        release.ok
        && release.value.updateAvailable
        && readSkipped(SKIPPED_APP_VERSION_KEY) !== release.value.latest
      ) {
        found.push({
          key: `app:${release.value.latest}`,
          title: `有新版本 ${release.value.latest}`,
          description: `当前版本 ${release.value.current}。前往 GitHub 的发布页下载新版。`,
          confirmLabel: '前往下载',
          skipKey: SKIPPED_APP_VERSION_KEY,
          skipValue: release.value.latest,
          url: release.value.pageUrl,
        });
      }
      const inference = new NativeInferenceRepository();
      const [models, catalog] = await Promise.all([inference.listModels(), inference.listUpscaleCatalog()]);
      if (models.ok && catalog.ok) {
        const updates = availableModelUpdates(models.value, catalog.value.models);
        const fingerprint = modelUpdateFingerprint(updates);
        if (updates.length && readSkipped(SKIPPED_MODEL_SET_KEY) !== fingerprint) {
          found.push({
            key: `model:${fingerprint}`,
            title: updates.length === 1 ? '有模型可以更新' : `有 ${updates.length} 个模型可以更新`,
            description: `高级设置里这些模型的下载键会变成更新：${updates.map((update) => update.label).join('、')}。`,
            confirmLabel: '去更新',
            skipKey: SKIPPED_MODEL_SET_KEY,
            skipValue: fingerprint,
          });
        }
      }
      if (active) setPrompts(found);
    };
    void check();
    return () => { active = false; };
  }, []);

  const prompt = prompts.find((item) => !dismissed.includes(item.key));
  const close = useCallback((item: UpdatePrompt) => {
    setDismissed((current) => (current.includes(item.key) ? current : [...current, item.key]));
  }, []);

  // 返回手势先关这一层（规矩见 lib/overlayBackGuard）；忙的时候拒绝，守卫会自己补回去。
  useOverlayBackGuard(Boolean(prompt), () => {
    if (busy || !prompt) return;
    rememberSkipped(prompt.skipKey, prompt.skipValue);
    close(prompt);
  });

  if (!prompt) return null;
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) close(prompt); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>{prompt.title}</Dialog.Title>
          <Dialog.Description>{prompt.description}</Dialog.Description>
          <div className="dialog-actions">
            {/* 跳过记的是「这个版本」，不是「永远别再问」：下一版还会来说一声。 */}
            <button
              className="secondary-action"
              type="button"
              disabled={busy}
              onClick={() => { rememberSkipped(prompt.skipKey, prompt.skipValue); close(prompt); }}
            ><X aria-hidden="true" />跳过该版本</button>
            <button
              className="primary-action"
              type="button"
              disabled={busy}
              aria-busy={busy}
              onClick={() => {
                setBusy(true);
                const done = prompt.url
                  ? openExternalUrl(prompt.url).then((result) => { if (!result.ok) showToast(result.error.message, 'error'); })
                  // `replace`：这一步正好把浮层那条守卫条目换成设置页，历史里不留没人认领的一格
                  // （守卫关掉时看见地址变了就不会再退一格，见 `overlayBackGuard`）。
                  : Promise.resolve(navigate('/settings?section=advanced', { replace: true }));
                void done.then(() => close(prompt), () => {}).finally(() => setBusy(false));
              }}
            >{prompt.url ? <Download aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{prompt.confirmLabel}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
