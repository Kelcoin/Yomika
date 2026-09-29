import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, Download, FileText, ImageUpscale, Layers, Loader2, Minus, Plus, RefreshCw, Scan, Sparkles, Upload } from 'lucide-react';

import { SettingsSwitch } from './SettingsControls';
import { SettingsChoice, SettingsMenu, SettingsNumber } from './SettingsValueControls';
import { SettingsRow } from './SettingsRow';
import { useToast } from './Toast';
import { pickDllFile } from '../bridge/filePicker';
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

const STYLE_LABELS: Record<number, string> = { 0: '默认', 1: '自然', 2: '电影' };

const MEGABYTE = 1024 * 1024;

function megabytes(bytes: number): string {
  return `${(bytes / MEGABYTE).toFixed(1)} MB`;
}

/** 换片段之后要重启才生效：NGX 一个进程只加载一份片段，这次已经跑过的话，手上这份
 *  还是上一份。这句话跟着两条换片段的提示一起给用户。 */
const RESTART_NOTE = '；若这次已经跑过 DLSS5，重启应用后才会换成它';

interface Props {
  preferences: PreferenceSnapshot;
  editPreferences: (patch: Partial<PreferenceSnapshot>) => void;
  /** 只有 Windows 桌面端显示这一组（DLSS5 走 D3D12 + NGX）。 */
  visible: boolean;
}

/** DLSS5 设置组：组件、开关与 1–3 层参数。检测是可选的诊断操作。 */
export function DlssnrSettingsGroup({ preferences, editPreferences, visible }: Props) {
  const { showToast } = useToast();
  const repository = useMemo(() => new NativeDlssnrRepository(), []);
  const [status, setStatus] = useState<DlssnrStatus>();
  const [probing, setProbing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [catalog, setCatalog] = useState<DlssnrCatalog>();
  const [catalogError, setCatalogError] = useState<string>();
  /** 正在下载的那一条变体 id（同一时刻只有一条：后端那条下载路径也只跑一件）。 */
  const [downloading, setDownloading] = useState<string>();
  const [download, setDownload] = useState<{ completed: number; total?: number | undefined }>();
  const [selectedLayer, setSelectedLayer] = useState<number | undefined>();
  const [layerMenu, setLayerMenu] = useState(false);
  const [variantMenu, setVariantMenu] = useState(false);

  const refresh = useCallback(async () => {
    const result = await repository.status();
    if (result.ok) {
      setStatus(result.value);
    } else {
      setStatus(undefined);
    }
  }, [repository]);

  const loadCatalog = useCallback(async () => {
    const result = await repository.catalog();
    if (result.ok) {
      setCatalog(result.value);
      setCatalogError(undefined);
    } else {
      setCatalog(undefined);
      setCatalogError(result.error.message);
    }
  }, [repository]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    void loadCatalog();
  }, [loadCatalog, refresh, visible]);

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
  const updatePass = (index: number, patch: Partial<DlssnrPass>) => {
    updatePasses(passes.map((pass, at) => (at === index ? { ...pass, ...patch } : pass)));
  };

  async function runProbe() {
    setProbing(true);
    const result = await repository.probe(true);
    setProbing(false);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    await refresh();
    showToast(
      result.value.supported
        ? `DLSS5 跑通了（${result.value.elapsedMs}ms）`
        : result.value.error ?? 'DLSS5 在这台机器上跑不起来',
      result.value.supported ? 'success' : 'error',
    );
  }

  async function importDll() {
    const selected = await pickDllFile();
    if (!selected) return;
    setImporting(true);
    const result = await repository.importDll(selected);
    setImporting(false);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    await refresh();
    showToast(result.value.variantLabel ? `已导入：${result.value.variantLabel}${RESTART_NOTE}` : `已导入 DLL（认不出是哪种变体）${RESTART_NOTE}`, 'success');
  }

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
      <div className="settings-group" role="region" aria-label="DLSS5">
        <SettingsRow icon={<Sparkles />} label="DLSS5" hint="正在检测这台机器…" control={<Loader2 className="spin" aria-hidden="true" />} />
      </div>
    );
  }
  if (!status.installable) {
    // 不满足条件就连这一组都不画：用户看不到一个永远开不起来的开关（也下不了用不上的片段）。
    return null;
  }

  // 拆成一个变量：直接对着 `status.probe?.supported` 做别名会让 TS 把另一个分支
  // 收窄成 null，`probe.error` 就读不出来了。
  const probe = status.probe ?? undefined;
  const probed = status.available;
  const layerCount = passes.length;

  return (
    <div className="settings-group" role="region" aria-label="DLSS5">
      <SettingsSwitch
        icon={<Sparkles />}
        label="启用 DLSS5"
        hint={
            probed
             ? `${status.variantLabel ?? 'nvngx_dlssnr'} · ${status.gpuName}`
             : '还没有片段：先在下面选择或导入组件'
        }
        disabled={!probed}
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
      <SettingsRow
        icon={<Scan />}
        label="检测 DLSS5"
        hint={probe
          ? probe.supported
            ? `跑通：${probe.width}×${probe.height}，${probe.elapsedMs}ms`
            : probe.error ?? '跑不起来'
          : '用一张合成图跑完整条链路'}
        control={
          <button className="secondary-action" type="button" disabled={probing} aria-busy={probing} onClick={() => void runProbe()}>
            <RefreshCw aria-hidden="true" />
            {probing ? '检测中…' : '检测'}
          </button>
        }
      />

      {/* 片段本身：官方原版与社区版在模型仓库里各一条资产，分开维护，用哪一条用户自己挑。
          装的是哪一条由后端认哈希回答（`status.variant`）。子组标题只写中文：这一行的
          样式会把拉丁字母转成大写，文件名的大小写就丢了（导入那一行里写着原名）。 */}
      <SettingsRow icon={<Download />} label="DLSS5 组件" value={status.variantLabel ?? '未安装'} onClick={() => setVariantMenu(true)} />
      {variantMenu && <SettingsMenu title="DLSS5 组件" onClose={() => setVariantMenu(false)}>
      <div className="settings-subgroup" role="group" aria-label="DLSS5 片段">
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
          const percent = download?.total ? Math.round((download.completed / download.total) * 100) : undefined;
          return (
            <SettingsRow
              key={variant.id}
              icon={<Download />}
              label={`${variant.label}${recommended ? '（推荐）' : ''}`}
              hint={installed
                ? `使用中${status.dllBytes ? ` · ${megabytes(status.dllBytes)}` : ''}`
                : busy
                  ? `下载中 ${megabytes(download?.completed ?? 0)}${download?.total ? ` / ${megabytes(download.total)} · ${percent}%` : ''}`
                  : variant.note || `${megabytes(variant.size)} · 下载后会被校验再装上`}
              control={installed
                ? <span className="settings-row-note">当前这一份</span>
                : <button
                    className="secondary-action"
                    type="button"
                    disabled={downloading !== undefined}
                    aria-busy={busy}
                    onClick={() => void downloadVariant(variant.id)}
                  >
                    {busy ? '下载中…' : '下载并使用'}
                  </button>}
            />
          );
        })}
        <SettingsRow
          icon={<Upload />}
          label="导入本地的 nvngx_dlssnr.dll"
          hint={status.dllPresent
            ? `已装：${status.variantLabel ?? '认不出是哪一种变体'}${status.dllBytes ? ` · ${megabytes(status.dllBytes)}` : ''}`
            : `也可以自己找一份来导入；建议：${status.recommendedLabel ?? '按显卡系列选一种变体'}`}
          control={
            <button className="secondary-action" type="button" disabled={importing} aria-busy={importing} onClick={() => void importDll()}>
              {importing ? '导入中…' : '选择 DLL…'}
            </button>
          }
        />
        {catalog?.license && (
          <SettingsRow
            icon={<FileText />}
            label="片段许可"
            hint={`${catalog.license.name}：片段内嵌 NVIDIA 的 DLSS SDK，许可全文随 Release 一起发布（${catalog.license.asset}）`}
            control={<span className="settings-row-note">下载前先读一遍</span>}
          />
        )}
      </div>
      </SettingsMenu>}

      {probe && !probe.supported && probe.error && (
        <SettingsRow
          icon={<AlertTriangle />}
          label="上一次检测的结论"
          hint={probe.error}
          control={<span className="settings-row-note">修好之后再检测一次</span>}
        />
      )}

      {/* 层数：同一张图串行跑几个 pass（1–3 层，往上收益很小）。 */}
      <SettingsRow icon={<Layers />} label="层数" value={`${layerCount} 层`} onClick={() => setLayerMenu(true)} />
      {layerMenu && <SettingsMenu title="DLSS5 层数" onClose={() => setLayerMenu(false)}>
          <div className="settings-menu-stepper">
            <button
              className="icon-action"
              type="button"
              aria-label="减少一层"
              disabled={layerCount <= 1}
              onClick={() => updatePasses(passes.slice(0, layerCount - 1))}
            >
              <Minus aria-hidden="true" />
            </button>
            <input
              className="settings-number"
              aria-label="DLSS5 层数"
              type="number"
              min={1}
              max={MAX_DLSSNR_PASSES}
              value={layerCount}
              readOnly
            />
            <button
              className="icon-action"
              type="button"
              aria-label="增加一层"
              disabled={layerCount >= MAX_DLSSNR_PASSES}
              onClick={() => updatePasses([...passes, { ...DEFAULT_DLSSNR_PASS }])}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>

        <div className="settings-inline-actions">
          {passes.map((_, index) => (
            <button key={index} className="secondary-action" type="button" onClick={() => { setLayerMenu(false); setSelectedLayer(index); }}>
              第 {index + 1} 层
            </button>
          ))}
        </div>
      </SettingsMenu>}

      {selectedLayer !== undefined && passes[selectedLayer] && (() => {
        const index = selectedLayer;
        const pass = passes[index]!;
        return <SettingsMenu title={`第 ${index + 1} 层`} onClose={() => setSelectedLayer(undefined)}>
        <div className="settings-subgroup" role="group" aria-label={`第 ${index + 1} 层`}>
          <p className="settings-subgroup-title">第 {index + 1} 层{index === 0 ? '（起点）' : ''}</p>
          <SettingsChoice
            icon={<ImageUpscale />}
            label="风格"
            value={String(pass.style)}
            options={STYLE_OPTIONS}
            onChange={(value) => updatePass(index, { style: Number(value) })}
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
            onChange={(value) => updatePass(index, { intensity: value })}
          />
          <SettingsNumber
            icon={<Sparkles />}
            label="局部色调"
            value={pass.localToneStrength}
            min={0}
            max={2}
            step={0.05}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updatePass(index, { localToneStrength: value })}
          />
          <SettingsNumber
            icon={<Sparkles />}
            label="局部结构"
            value={pass.localStructureStrength}
            min={0}
            max={2}
            step={0.05}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updatePass(index, { localStructureStrength: value })}
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
            onChange={(value) => updatePass(index, { skinStructureStrength: value })}
          />
          <SettingsSwitch
            icon={<Scan />}
            label="自动遮罩"
            hint="让网络自己圈出该处理的区域"
            checked={pass.autoMask}
            onToggle={() => updatePass(index, { autoMask: !pass.autoMask })}
          />
          <SettingsSwitch
            icon={<Scan />}
            label="界面修正"
            hint="文字与线条保持原样（拟声词、边框）"
            checked={pass.uiCorrection}
            onToggle={() => updatePass(index, { uiCorrection: !pass.uiCorrection })}
          />
          <button className="secondary-action" type="button" onClick={() => setSelectedLayer(undefined)}>完成</button>
        </div></SettingsMenu>;
      })()}
      <SettingsRow
        icon={<Sparkles />}
        label="当前配方"
        hint={`${passes.map((pass) => `${STYLE_LABELS[pass.style] ?? pass.style}·${pass.intensity.toFixed(2)}`).join(' → ')}`}
        control={<span className="settings-row-note">设置里开了它在阅读器里就会生效</span>}
      />
    </div>
  );
}
