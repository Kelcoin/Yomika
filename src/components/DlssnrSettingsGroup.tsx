import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Download, ImageUpscale, Layers, Loader2, Plus, Save, Scan, Sparkles, Trash2 } from 'lucide-react';

import { SettingsSwitch } from './SettingsControls';
import { SettingsChoice, SettingsMenu, SettingsNumber } from './SettingsValueControls';
import { SettingsRow } from './SettingsRow';
import { ModelDownloadButton, ModelDownloadSlot } from './ModelDownloadControls';
import { DlssnrIcon } from './DlssnrIcon';
import { useToast } from './Toast';
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';
import {
  DEFAULT_DLSSNR_PASS,
  MAX_DLSSNR_PASSES,
  NativeDlssnrRepository,
  parseDlssnrPasses,
  serializeDlssnrPasses,
  type DlssnrCatalog,
  type DlssnrPass,
  type DlssnrStatus,
} from '../repositories/nativeDlssnrRepository';

/** 风格：NGX 认的 0–2（默认 / 自然 / 电影三档）。 */
const STYLE_OPTIONS = [
  { value: '0', label: '默认' },
  { value: '1', label: '自然' },
  { value: '2', label: '电影' },
];

/** 换片段之后要重启才生效：NGX 一个进程只加载一份片段，这次已经跑过的话，手上这份
 *  还是上一份。这句话跟着两条换片段的提示一起给用户。 */
const RESTART_NOTE = '；若这次已经跑过 DLSSNR，重启应用后才会换成它';

interface Props {
  preferences: PreferenceSnapshot;
  editPreferences: (patch: Partial<PreferenceSnapshot>) => void;
  /** 只有 Windows 桌面端显示这一组（DLSSNR 走 D3D12 + NGX）。 */
  visible: boolean;
}

/** DLSSNR 设置组：组件、开关与 1–5 层参数。 */
export function DlssnrSettingsGroup({ preferences, editPreferences, visible }: Props) {
  const { showToast } = useToast();
  const repository = useMemo(() => new NativeDlssnrRepository(), []);
  const [status, setStatus] = useState<DlssnrStatus | undefined>(() => {
    try {
      const cached = localStorage.getItem('yomika.dlssnr-status');
      return cached ? (JSON.parse(cached) as DlssnrStatus) : undefined;
    } catch { return undefined; }
  });
  const [verified, setVerified] = useState(() => {
    try { return localStorage.getItem('yomika.dlssnr-status') !== null; } catch { return false; }
  });
  const [catalog, setCatalog] = useState<DlssnrCatalog | undefined>(() => {
    try {
      const cached = localStorage.getItem('yomika.dlssnr-catalog');
      return cached ? (JSON.parse(cached) as DlssnrCatalog) : undefined;
    } catch { return undefined; }
  });
  const [catalogError, setCatalogError] = useState<string>();
  /** 正在下载的那一条变体 id（同一时刻只有一条：后端那条下载路径也只跑一件）。 */
  const [downloading, setDownloading] = useState<string>();
  const [download, setDownload] = useState<{ completed: number; total?: number | undefined }>();
  const [selectedLayer, setSelectedLayer] = useState<number | undefined>();
  const [draftPass, setDraftPass] = useState<DlssnrPass>();
  const [layerMenu, setLayerMenu] = useState(false);
  const [variantMenu, setVariantMenu] = useState(false);

  const refresh = useCallback(async () => {
    const result = await repository.status();
    if (result.ok) {
      setStatus(result.value);
      setVerified(true);
      try { localStorage.setItem('yomika.dlssnr-status', JSON.stringify(result.value)); } catch { /* storage unavailable */ }
    } else {
      setVerified(false);
    }
  }, [repository]);

  const loadCatalog = useCallback(async () => {
    const result = await repository.catalog();
    if (result.ok) {
      setCatalog(result.value);
      try { localStorage.setItem('yomika.dlssnr-catalog', JSON.stringify(result.value)); } catch { /* storage unavailable */ }
      setCatalogError(undefined);
    } else {
      setCatalogError(result.error.message);
    }
  }, [repository]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    void loadCatalog();
  }, [loadCatalog, refresh, visible]);
  useEffect(() => {
    window.addEventListener('yomika:dlssnr-imported', refresh);
    return () => window.removeEventListener('yomika:dlssnr-imported', refresh);
  }, [refresh]);

  // 进度走事件而不是那条命令的返回值（命令要等整个文件下完才回）。监听器**挂一次**：
  // 按「正在下载哪一条」去挂的话，命令开始到副作用跑起来之间的那几帧事件就丢掉了，
  // 而首帧恰恰是最该看见的。事件里带着变体 id，换一条下载也不会驱动错行。
  const downloadingRef = useRef<string>();
  downloadingRef.current = downloading;
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ variantId?: string; completed: number; total?: number | null }>('dlssnr-download-progress', (event) => {
      const current = downloadingRef.current;
      if (!active || !current) return;
      if (event.payload.variantId && event.payload.variantId !== current) return;
      setDownload({ completed: event.payload.completed, total: event.payload.total ?? undefined });
    }).then((detach) => { if (active) unlisten = detach; else detach(); }).catch(() => { /* 不在壳里就没有事件 */ });
    return () => { active = false; unlisten?.(); };
  }, []);

  const passes = useMemo(() => parseDlssnrPasses(preferences.dlssnrPasses), [preferences.dlssnrPasses]);
  const updatePasses = (next: DlssnrPass[]) => editPreferences({ dlssnrPasses: serializeDlssnrPasses(next) });
  const updateDraftPass = (patch: Partial<DlssnrPass>) => setDraftPass((current) => current ? { ...current, ...patch } : current);
  const openLayer = (index: number) => { setSelectedLayer(index); setDraftPass({ ...passes[index]! }); };
  const saveLayer = () => {
    if (selectedLayer !== undefined && draftPass) updatePasses(passes.map((pass, index) => index === selectedLayer ? draftPass : pass));
    setSelectedLayer(undefined);
    setDraftPass(undefined);
  };
  const deleteLayer = () => {
    if (selectedLayer === undefined || passes.length <= 1) return;
    updatePasses(passes.filter((_, index) => index !== selectedLayer));
    setSelectedLayer(undefined);
    setDraftPass(undefined);
  };

  async function downloadVariant(variantId: string) {
    setDownloading(variantId);
    setDownload(undefined);
    const result = await repository.downloadVariant(variantId);
    setDownloading(undefined);
    setDownload(undefined);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    // 换成另一种变体之后旧结论作废，状态也得重新读一遍（装的是哪一条由它回答）。
    await refresh();
    showToast(`已装好并启用：${result.value.variantLabel ?? variantId}${RESTART_NOTE}`, 'success');
  }

  if (!visible) return null;
  if (!status) {
    return (
      <div className="settings-group" role="region" aria-label="DLSSNR">
        <SettingsRow icon={<DlssnrIcon />} label="DLSSNR" hint="正在读取这台机器…" control={<Loader2 className="spin" aria-hidden="true" />} />
      </div>
    );
  }
  if (!status.installable) {
    // 不满足条件就连这一组都不画：用户看不到一个永远开不起来的开关（也下不了用不上的片段）。
    return null;
  }

  // 拆成一个变量：直接对着 `status.probe?.supported` 做别名会让 TS 把另一个分支
  // 收窄成 null，`probe.error` 就读不出来了。
  const probed = status.available;
  const layerCount = passes.length;

  return (
    <div className="settings-group" role="region" aria-label="DLSSNR">
      <SettingsSwitch
        icon={<DlssnrIcon />}
        label="启用 DLSSNR"
        hint={
            probed
             ? `${status.variantLabel ?? 'nvngx_dlssnr'} · ${status.gpuName}`
             : '还没有片段：先在下面选择或导入组件'
        }
        disabled={!probed || !verified}
        checked={preferences.dlssnrEnabled}
        onToggle={() => {
          if (!probed) {
            showToast(
              '先在下面选择或导入一种组件',
              'error',
            );
            return;
          }
          editPreferences({ dlssnrEnabled: !preferences.dlssnrEnabled });
        }}
      />
      {/* 片段本身：官方原版与社区版在模型仓库里各一条资产，分开维护，用哪一条用户自己挑。
          装的是哪一条由后端认哈希回答（`status.variant`）。子组标题只写中文：这一行的
          样式会把拉丁字母转成大写，文件名的大小写就丢了（导入那一行里写着原名）。 */}
      <SettingsRow icon={<Download />} label="DLSSNR 组件" value={status.variantLabel ?? '未安装'} onClick={() => setVariantMenu(true)} />
      {variantMenu && <SettingsMenu title="DLSSNR 组件" icon={<DlssnrIcon />} onClose={() => setVariantMenu(false)}>
      <div className="settings-choice-list" role="group" aria-label="DLSSNR 组件">
        {catalog === undefined && (
          <SettingsRow
            icon={<Download />}
            label={catalogError ? '取不到片段清单' : '正在取片段清单…'}
            hint={catalogError ?? '模型仓库里的那份清单，一条变体一条资产'}
            control={catalogError
              ? <button className="secondary-action" type="button" onClick={() => void loadCatalog()}>重试</button>
              : <Loader2 className="spin" aria-hidden="true" />}
          />
        )}
        {catalog?.variants.map((variant) => {
          const installed = status.variant === variant.id;
          const recommended = status.recommendedVariant === variant.id;
          const busy = downloading === variant.id;
          const label = `${variant.label}${recommended ? '（推荐）' : ''}`;
          return <div className={`settings-choice-option${installed ? ' is-active' : ''}`} key={variant.id}>
            {/* 兼容性那句话不占第二行：行里只留变体名，说明挂在这一行的 title 上，
                鼠标停一下还是看得到——和模型菜单那种「一行一个选项」是同一套行式。 */}
            {/* 「已装上」= 「当前就用这一份」，不是不可用：它和档案库/设置里那些选择菜单的
                选中行是同一个状态（SettingsChoice 里选中行也从不 disabled），交给 is-active
                与 aria-pressed 说。一旦写成 disabled，全局那条
                `button:disabled { opacity: .55 }`（base.css:378-384）就会把这一行的字一起
                压暗——用户看见的正是「已选中的那行文字发灰」。真不可用的只有「正在下载」
                这一刻（后端那条下载路径一次只跑一件）。 */}
            <button
              className="settings-choice-option-main"
              type="button"
              disabled={downloading !== undefined}
              aria-pressed={installed}
              title={variant.note || '下载后会被校验再装上'}
              // 已经是这一份就没有要下的东西：直接什么都不做，别把同一条再下一遍。
              onClick={() => { if (installed) return; void downloadVariant(variant.id); }}
            >
              <span>{label}</span>
            </button>
            {/* 行尾走模型菜单那一套动作槽：还没装上的那条挂下载按钮，已装上的那条
                （按钮自己不画）右侧就是空的。装的是哪一条由 is-active 与 aria-pressed
                说，「使用中」与 DLL 体积不再写成行尾那行字。 */}
            <ModelDownloadButton
              option={{ value: variant.id, label }}
              installed={installed}
              pending={downloading !== undefined}
              className="select-option-download"
              onDownload={() => void downloadVariant(variant.id)}
            />
            {/* 进度只挂在正在下载的那一条下面：和其它模型菜单同一个槽，靠 is-open 长出条。 */}
            {busy && <ModelDownloadSlot open label={variant.label} progress={download} />}
          </div>;
        })}
      </div>
      </SettingsMenu>}

      {/* 层数：同一张图串行跑几个 pass（1–5 层，往上收益很小，耗时线性涨）。 */}
      <SettingsRow icon={<Layers />} label="层数" value={`${layerCount} 层`} onClick={() => setLayerMenu(true)} />
      {layerMenu && <SettingsMenu title={selectedLayer === undefined ? 'DLSSNR 层数' : `第 ${selectedLayer + 1} 层`} icon={<Layers />} onClose={() => { if (selectedLayer !== undefined) { setSelectedLayer(undefined); setDraftPass(undefined); } else setLayerMenu(false); }}>
      {selectedLayer === undefined ? <>
        {passes.map((pass, index) => <SettingsRow key={index} icon={<Layers />} label={`第 ${index + 1} 层`} value={STYLE_OPTIONS[pass.style]?.label ?? '默认'} onClick={() => openLayer(index)} />)}
        <button className="secondary-action" type="button" disabled={layerCount >= MAX_DLSSNR_PASSES} onClick={() => updatePasses([...passes, { ...DEFAULT_DLSSNR_PASS }])}><Plus aria-hidden="true" />添加层</button>
      </> : draftPass && (() => {
        const index = selectedLayer;
        const pass = draftPass;
        return <>
        {/* 组里不再重复写「第 N 层」：菜单标题已经写着它，这里再来一行等于同一句话说两遍。
            分组本身留着——那道分界线和 aria-label 是这一组参数的边界。 */}
        <div className="settings-subgroup" role="group" aria-label={`第 ${index + 1} 层`}>
          <SettingsChoice
            icon={<ImageUpscale />}
            label="风格"
            value={String(pass.style)}
            options={STYLE_OPTIONS}
            onChange={(value) => updateDraftPass({ style: Number(value) })}
          />
          <SettingsNumber
            icon={<Sparkles />}
            label="强度"
            hint="网络参与的力度：1 保持原样，越高越“重绘”"
            value={pass.intensity}
            min={0}
            max={2}
            step={0.05}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updateDraftPass({ intensity: value })}
          />
          <SettingsNumber
            icon={<Sparkles />}
            label="局部色调"
            value={pass.localToneStrength}
            min={0}
            max={2}
            step={0.05}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updateDraftPass({ localToneStrength: value })}
          />
          <SettingsNumber
            icon={<Sparkles />}
            label="局部结构"
            value={pass.localStructureStrength}
            min={0}
            max={2}
            step={0.05}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updateDraftPass({ localStructureStrength: value })}
          />
          <SettingsNumber
            icon={<Sparkles />}
            label="皮肤结构"
            hint="默认关闭：漫画里人脸多的时候再开"
            value={pass.skinStructureStrength}
            min={0}
            max={2}
            step={0.05}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updateDraftPass({ skinStructureStrength: value })}
          />
          <SettingsSwitch
            icon={<Scan />}
            label="自动遮罩"
            hint="让网络自己圈出该处理的区域"
            checked={pass.autoMask}
            onToggle={() => updateDraftPass({ autoMask: !pass.autoMask })}
          />
          <SettingsSwitch
            icon={<Scan />}
            label="界面修正"
            hint="文字与线条保持原样（拟声词、边框）"
            checked={pass.uiCorrection}
            onToggle={() => updateDraftPass({ uiCorrection: !pass.uiCorrection })}
          />
          <div className="settings-inline-actions"><button className="secondary-action" type="button" disabled={layerCount <= 1} onClick={deleteLayer}><Trash2 aria-hidden="true" />删除</button><button className="primary-action" type="button" onClick={saveLayer}><Save aria-hidden="true" />保存</button></div>
        </div></>;
      })()}
      </SettingsMenu>}
    </div>
  );
}
