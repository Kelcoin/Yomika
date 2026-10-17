import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePageActive } from '../app/RetainedPage';
import { listen } from '@tauri-apps/api/event';
import { CircleHelp, Download, ImageUpscale, Layers, Loader2, Plus, Save, Scan, Sparkles, Trash2, Wand } from 'lucide-react';

import { SettingsSwitch } from './SettingsControls';
import { SettingsChoice, SettingsMenu, SettingsNumber } from './SettingsValueControls';
import { SettingsRow } from './SettingsRow';
import { OverlayLayer } from './OverlayLayer';
import { ModelDownloadButton, ModelDownloadSlot } from './ModelDownloadControls';
import { DlssnrIcon } from './DlssnrIcon';
import { useToast } from './Toast';
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';
import { DLSSNR_PRESETS, presetOf } from '../domain/dlssnrPresets';
import { installedDllLabel, formatSeries } from '../domain/dlssnrVersion';
import { availableVariantUpdates, installedVariantId } from '../lib/dlssnrUpdates';
import {
  DEFAULT_DLSSNR_PASS,
  MAX_DLSSNR_PASSES,
  NativeDlssnrRepository,
  DlssnrStatusSchema,
  DlssnrCatalogSchema,
  parseDlssnrPasses,
  serializeDlssnrPasses,
  type DlssnrCatalog,
  type DlssnrPass,
  type DlssnrStatus,
} from '../repositories/nativeDlssnrRepository';
import { readStorageSnapshot } from '../lib/storageSnapshot';

/** 风格：NGX 认的 0–2（默认 / 自然 / 电影三档；OptiScaler 把 0 叫 Standard——同一个
 *  档位，就是模型自带的默认外观）。 */
const STYLE_OPTIONS = [
  { value: '0', label: '默认' },
  { value: '1', label: '自然' },
  { value: '2', label: '电影' },
];

/** 换片段之后要重启才生效：NGX 一个进程只加载一份片段，这次已经跑过的话，手上这份
 *  还是上一份。这句话跟着两条换片段的提示一起给用户。 */
const RESTART_NOTE = '；若这次已经跑过 DLSSNR，重启应用后才会换成它';

/** 每个层参数的说明，供层编辑菜单右上角那枚问号展开。
 *
 *  照说明文档写：一个参数一段，先说它改什么、取值范围与默认值，再说往哪边调会怎样；
 *  不写「依据」「实测」这类过程话——那是 `docs/68` 的事，用户要的是怎么用。 */
const LAYER_HELP: ReadonlyArray<{
  name: string;
  text: string;
  values?: ReadonlyArray<{ value: string; meaning: string }>;
}> = [
  {
    name: '风格',
    text: '重建的外观档位。它只选档位，力度由「强度」决定。',
    values: [
      { value: '0', meaning: '默认｜模型自带的档位' },
      { value: '1', meaning: '自然' },
      { value: '2', meaning: '电影' },
    ],
  },
  {
    name: '强度',
    text: '本层的整体增强强度，0–1，默认 1。1 表示完全采用本层结果；小于 1 与原图混合，可用于轻度降噪；0 表示不处理，本层不产生结果。',
  },
  {
    name: '局部色调',
    text: '低频明暗与光照的重建强度，0–2，默认 1。调高加强局部对比与亮暗层次，调低更平；多层叠加时，后续层建议保持 0。',
  },
  {
    name: '局部结构',
    text: '高频细节与局部对比的重建强度，0–2，默认 1。调高更锐利、纹理更多，调低更柔和干净；画面出现塑料感时调低。',
  },
  {
    name: '皮肤结构',
    text: '皮肤区域的细节重建强度，0–2，默认 0。0 减弱皮肤细节，1 与「局部结构」一致，2 更强。仅在启用「自动遮罩」时生效。',
  },
  {
    name: '自动遮罩',
    text: '由模型检测画面中的皮肤区域，并把「皮肤结构」施加其上。关闭时「皮肤结构」不起作用。',
  },
  {
    name: '界面修正',
    text: '抑制画面中的界面元素（HUD、水印等）被一并重建。',
  },
];

/** 气泡与按钮之间的缝、与窗口边的距离，以及指针跨过那条缝时的宽限期（毫秒）。
 *  没有宽限期的话，指针从按钮移向气泡的途中会经过那条缝，气泡在到达之前就收了。 */
const HELP_GAP = 8;
const HELP_MARGIN = 12;
const HELP_MIN_HEIGHT = 180;
const HELP_GRACE_MS = 160;
/** 气泡的宽度取下方那张菜单面板的宽度。量不到面板时（首帧、或者面板不在 DOM 里）
 *  退回 `HELP_FALLBACK_WIDTH`；面板窄到放不下正文时至少给 `HELP_MIN_WIDTH`；两者
 *  都再受窗口宽度约束，免得气泡被切掉。 */
const HELP_FALLBACK_WIDTH = 340;
const HELP_MIN_WIDTH = 240;

interface HelpAnchor {
  top: number;
  right: number;
  width: number;
  height: number;
}

/** 参数说明气泡：走门户挂到 body 上，位置取问号按钮的 `getBoundingClientRect()`。
 *
 *  为什么不折进菜单里：菜单面板是固定高度的 `overflow: hidden` 弹层
 *  （`tests/design-system-contract.test.ts` 钉住了那条形状），说明块一进内容流，面板就会
 *  被撑高、问号跟着挪位——指针还停在原地，按钮已经从光标下面走开，于是来回抖。门户 +
 *  `position: fixed` 让说明浮在面板之外，面板的几何一点不变。 */
function LayerHelpBubble({ anchor, onEnter, onLeave }: {
  anchor: HelpAnchor;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <OverlayLayer>
      <aside
        className="settings-help-bubble"
        role="note"
        aria-label="层参数说明"
        style={{
          top: `${anchor.top}px`,
          right: `${anchor.right}px`,
          width: `${anchor.width}px`,
          maxHeight: `${anchor.height}px`,
        }}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
      >
        <p className="settings-help-lead">每一层都是对同一张图串行执行的一趟处理，参数只作用于本层的结果。</p>
        <dl className="settings-help-list">
          {LAYER_HELP.map(({ name, text, values }) => (
            <div className="settings-help-entry" key={name}>
              <dt>{name}</dt>
              <dd>
                {text}
                {values && (
                  <dl className="settings-help-values">
                    {values.map(({ value, meaning }) => (
                      <div className="settings-help-value" key={value}>
                        <dt>{value}</dt>
                        <dd>{meaning}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </aside>
    </OverlayLayer>
  );
}

interface Props {
  preferences: PreferenceSnapshot;
  editPreferences: (patch: Partial<PreferenceSnapshot>) => void;
  /** 只有 Windows 桌面端显示这一组（DLSSNR 走 D3D12 + NGX）。 */
  visible: boolean;
}

/** DLSSNR 设置组：组件、开关与 1–5 层参数。 */
export function DlssnrSettingsGroup({ preferences, editPreferences, visible }: Props) {
  const pageActive = usePageActive();
  const { showToast } = useToast();
  const repository = useMemo(() => new NativeDlssnrRepository(), []);
  const [status, setStatus] = useState<DlssnrStatus | undefined>(() => readStorageSnapshot('yomika.dlssnr-status', DlssnrStatusSchema));
  const [verified, setVerified] = useState(() => Boolean(status));
  const [catalog, setCatalog] = useState<DlssnrCatalog | undefined>(() => readStorageSnapshot('yomika.dlssnr-catalog', DlssnrCatalogSchema));
  const [catalogError, setCatalogError] = useState<string>();
  /** 正在下载的那一条变体 id（同一时刻只有一条：后端那条下载路径也只跑一件）。 */
  const [downloading, setDownloading] = useState<string>();
  const [download, setDownload] = useState<{ completed: number; total?: number | undefined }>();
  const [selectedLayer, setSelectedLayer] = useState<number | undefined>();
  const [draftPass, setDraftPass] = useState<DlssnrPass>();
  const [layerMenu, setLayerMenu] = useState(false);
  const [presetMenu, setPresetMenu] = useState(false);
  const [variantMenu, setVariantMenu] = useState(false);
  /** 层参数说明：指针停上去先看一眼，点一下钉住——不然鼠标一移开说明就收回去，
   *  没法边看边调。进另一层时两个状态都复位。 */
  const [helpPinned, setHelpPinned] = useState(false);
  const [helpHover, setHelpHover] = useState(false);
  const helpOpen = helpPinned || helpHover;
  /** 气泡钉在问号下面，所以要先量按钮的位置；量不到就不画。 */
  const helpToggleRef = useRef<HTMLButtonElement | null>(null);
  const [helpAnchor, setHelpAnchor] = useState<HelpAnchor>();
  const helpTimer = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!pageActive || !visible) {
      window.clearTimeout(helpTimer.current);
      setLayerMenu(false);
      setPresetMenu(false);
      setVariantMenu(false);
      setSelectedLayer(undefined);
      setDraftPass(undefined);
      setHelpPinned(false);
      setHelpHover(false);
      setHelpAnchor(undefined);
    }
  }, [pageActive, visible]);
  const holdHelp = useCallback(() => {
    window.clearTimeout(helpTimer.current);
    setHelpHover(true);
  }, []);
  const releaseHelp = useCallback(() => {
    window.clearTimeout(helpTimer.current);
    helpTimer.current = window.setTimeout(() => setHelpHover(false), HELP_GRACE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(helpTimer.current), []);
  useEffect(() => {
    if (!helpOpen) { setHelpAnchor(undefined); return; }
    const measure = () => {
      const rect = helpToggleRef.current?.getBoundingClientRect();
      if (!rect) return;
      // 宽度与右边缘取下方那张菜单面板（这一屏里被解释的就是它，同宽同右沿才算一体）；
      // 上沿仍从问号按钮的下沿算起，否则气泡会盖住标题行。首帧量不到面板时退回固定宽度。
      const panelRect = helpToggleRef.current?.closest('.settings-choice-panel')?.getBoundingClientRect();
      const measured = panelRect && panelRect.width > 0 ? panelRect : undefined;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + HELP_MARGIN;
      const top = (viewport?.offsetTop ?? 0) + HELP_MARGIN;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const bottom = Math.max(top, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - HELP_MARGIN);
      const width = Math.min(measured ? Math.max(measured.width, HELP_MIN_WIDTH) : HELP_FALLBACK_WIDTH, Math.max(0, viewportWidth - HELP_MARGIN * 2));
      const x = Math.max(left, Math.min((measured?.right ?? rect.right) - width, left + viewportWidth - HELP_MARGIN * 2 - width));
      const belowTop = Math.max(top, Math.min(rect.bottom + HELP_GAP, bottom));
      const aboveBottom = Math.max(top, Math.min(rect.top - HELP_GAP, bottom));
      const below = bottom - belowTop;
      const above = aboveBottom - top;
      const flip = below < HELP_MIN_HEIGHT && above > below;
      setHelpAnchor({
        top: flip ? top : belowTop,
        right: window.innerWidth - x - width,
        width,
        height: flip ? above : below,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [helpOpen]);

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
  const activePreset = useMemo(() => presetOf(passes), [passes]);
  const updatePasses = (next: DlssnrPass[]) => editPreferences({ dlssnrPasses: serializeDlssnrPasses(next) });
  const updateDraftPass = (patch: Partial<DlssnrPass>) => setDraftPass((current) => current ? { ...current, ...patch } : current);
  const openLayer = (index: number) => {
    setSelectedLayer(index);
    setDraftPass({ ...passes[index]! });
    window.clearTimeout(helpTimer.current);
    setHelpPinned(false);
    setHelpHover(false);
  };
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
    showToast(`已装好并启用：${installedDllLabel(result.value.variantLabel, variantId, result.value.version)}${RESTART_NOTE}`, 'success');
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
  // 盘上这一份是清单里的哪一条（清单没到就退回后端内置表），以及清单里有哪几条换了资产。
  // 值里的兜底分两种：文件根本不在是「未安装」，在却不认识是「认不出的片段」——后者原先
  // 也落进「未安装」，那是句谎话（165 MB 就在那儿）。
  const installedVariant = installedVariantId(status, catalog);
  const variantUpdates = availableVariantUpdates(status, catalog);
  const outdatedVariants = new Set(variantUpdates.map((update) => update.id));
  // 说给用户听的名字也优先取清单那一条：社区把同一条变体重发之后，后端那张内置表认不出
  // 它、`status.variantLabel` 是空的，而清单还知道它叫什么。
  const installedLabel = installedVariant === undefined
    ? undefined
    : catalog?.variants.find((entry) => entry.id === installedVariant)?.label ?? status.variantLabel ?? undefined;

  return (
    <div className="settings-group" role="region" aria-label="DLSSNR">
      <SettingsSwitch
        icon={<DlssnrIcon />}
        label="启用 DLSSNR"
        hint={
            probed
             ? `${installedDllLabel(installedLabel, 'nvngx_dlssnr', status.dllVersion)} · ${status.gpuName}`
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
      {/* 值里带版本号：变体名只说「哪一条」，用户问「我装的是哪一版」要看文件自己报的
          那一串（官方原版与社区版同一个变体名、版本号可能不同）。 */}
      {/* 「有更新」看的是**哈希**：清单里那一条的 SHA-256 与盘上这份不同才算换过资产。
          不能比字节数——官方原版与社区兼容版都是 165,840,496 字节，比字节数会把
          「换了另一种变体」也算进来，还会在盘上那份读不出哈希时凭猜报更新。 */}
      <SettingsRow
        icon={<Download />}
        label="DLSSNR 组件"
        mark={variantUpdates.length > 0 ? '有更新' : undefined}
        value={installedDllLabel(installedLabel, status.dllPresent ? '认不出的片段' : '未安装', status.dllVersion)}
        onClick={() => setVariantMenu(true)}
      />
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
          // 装的是哪一条按**哈希**认（清单是活的权威）：同一条社区版被重发之后，后端那张
          // 内置表认不出来了，可它仍然是用户装着的这一条。
          const installed = installedVariant === variant.id;
          const outdated = outdatedVariants.has(variant.id);
          // 有更新的那一条不再算「当前就用这一份」：选中态还亮着的话，用户看不出该点更新。
          const active = installed && !outdated;
          const recommended = status.recommendedVariant === variant.id;
          const busy = downloading === variant.id;
          const label = `${variant.label}${recommended ? '（推荐）' : ''}`;
          // 适配的显卡系列单独占一行（用户 2026-10-18 报「把各 DLSSNR 的适配显卡系列补回来」）。
          // 系列本来就在清单的结构化字段里（`series: [40, 50]`），不在名字里：名字只留那三个词，
          // 系列由这一行说。挤进同一行时 420px 的面板放不下，会退化成换行——用户上一轮报的正是
          // 「选项内的文字会换行」。
          const series = formatSeries(variant.series);
          return <div className={`settings-choice-option${active ? ' is-active' : ''}`} key={variant.id}>
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
              aria-pressed={active}
              title={variant.note || '下载后会被校验再装上'}
              // 已经是这一份、而且没换过资产，就没有要下的东西：直接什么都不做，别把同一条
              // 再下一遍。换了资产的那一条要能点——点它就是更新。
              onClick={() => { if (active) return; void downloadVariant(variant.id); }}
            >
              <span className="settings-choice-option-name">{label}</span>
              {series && <span className="settings-choice-option-series">{series}</span>}
            </button>
            {/* 行尾走模型菜单那一套动作槽：还没装上的那条挂下载按钮，已装上的那条
                （按钮自己不画）右侧就是空的。装的是哪一条由 is-active 与 aria-pressed
                说，「使用中」与 DLL 体积不再写成行尾那行字。换过资产的那条按钮改叫更新
                （`outdated`），和超分模型那一行是同一个控件、同一套说法。 */}
            <ModelDownloadButton
              option={{ value: variant.id, label }}
              installed={installed}
              outdated={outdated}
              pending={downloading !== undefined}
              className="select-option-download"
              onDownload={() => void downloadVariant(variant.id)}
            />
            {/* 进度槽**常驻挂载**，用 `open` 开关（和超分模型菜单那一处同一个槽、同一套写法）：
                条件渲染会在下载结束/重渲染那一刻摘掉节点，卸载的节点没有过渡可放，「消失」就只能
                是啪一下不见——用户 2026-10-18 报「页面出现任何更新就会消失」。 */}
            <ModelDownloadSlot open={busy} label={variant.label} progress={download} />
          </div>;
        })}
      </div>
      </SettingsMenu>}

      {/* 层数：同一张图串行跑几个 pass（1–5 层，往上收益很小，耗时线性涨）。 */}
      <SettingsRow icon={<Layers />} label="层数" value={`${layerCount} 层`} onClick={() => setLayerMenu(true)} />
      {layerMenu && <SettingsMenu
        title={presetMenu ? 'DLSSNR 预设' : selectedLayer === undefined ? 'DLSSNR 层数' : `第 ${selectedLayer + 1} 层`}
        icon={presetMenu ? <Wand /> : <Layers />}
        {...(selectedLayer === undefined ? {} : {
        action: (
          <button
            ref={helpToggleRef}
            className="settings-help-toggle"
            type="button"
            aria-label="参数说明"
            aria-expanded={helpOpen}
            onPointerEnter={holdHelp}
            onPointerLeave={releaseHelp}
            onClick={() => setHelpPinned((current) => !current)}
          >
            <CircleHelp aria-hidden="true" />
          </button>
        ),
      })} onClose={() => {
        // 预设是一层临时视图，退出先回到层列表；再退才关菜单。
        if (presetMenu) { setPresetMenu(false); return; }
        window.clearTimeout(helpTimer.current);
        setHelpPinned(false);
        setHelpHover(false);
        if (selectedLayer !== undefined) { setSelectedLayer(undefined); setDraftPass(undefined); } else setLayerMenu(false);
      }}>
      {helpOpen && selectedLayer !== undefined && helpAnchor && (
        <LayerHelpBubble anchor={helpAnchor} onEnter={holdHelp} onLeave={releaseHelp} />
      )}
      {presetMenu ? <>
        {DLSSNR_PRESETS.map((preset) => (
          <SettingsRow
            key={preset.id}
            icon={<Sparkles />}
            label={preset.label}
            hint={preset.note}
            value={activePreset === preset.id ? '当前' : `${preset.passes.length} 层`}
            onClick={() => {
              updatePasses(preset.passes.map((layer) => ({ ...layer })));
              setPresetMenu(false);
            }}
          />
        ))}
      </> : selectedLayer === undefined ? <>
        {passes.map((pass, index) => <SettingsRow key={index} icon={<Layers />} label={`第 ${index + 1} 层`} value={STYLE_OPTIONS[pass.style]?.label ?? '默认'} onClick={() => openLayer(index)} />)}
        <div className="settings-layer-actions">
          <button className="secondary-action" type="button" onClick={() => setPresetMenu(true)}><Wand aria-hidden="true" />预设</button>
          <button className="secondary-action" type="button" disabled={layerCount >= MAX_DLSSNR_PASSES} onClick={() => updatePasses([...passes, { ...DEFAULT_DLSSNR_PASS }])}><Plus aria-hidden="true" />添加层</button>
        </div>
      </> : draftPass && (() => {
        const index = selectedLayer;
        const pass = draftPass;
        return <>
        {/* 组里不再重复写「第 N 层」：菜单标题已经写着它，这里再来一行等于同一句话说两遍。
            分组本身留着——那道分界线和 aria-label 是这一组参数的边界。 */}
        {/* 每个旋钮的解释都在右上角那枚问号里，行上不再重复一遍：同一句话写在两处，
            改一处就会对不上。 */}
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
            value={pass.intensity}
            min={0}
            max={1}
            step={0.1}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updateDraftPass({ intensity: value })}
          />
          <SettingsNumber
            icon={<Sparkles />}
            label="局部色调"
            value={pass.localToneStrength}
            min={0}
            max={2}
            step={0.1}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updateDraftPass({ localToneStrength: value })}
          />
          <SettingsNumber
            icon={<Sparkles />}
            label="局部结构"
            value={pass.localStructureStrength}
            min={0}
            max={2}
            step={0.1}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updateDraftPass({ localStructureStrength: value })}
          />
          <SettingsNumber
            icon={<Sparkles />}
            label="皮肤结构"
            value={pass.skinStructureStrength}
            min={0}
            max={2}
            step={0.1}
            format={(value) => value.toFixed(2)}
            onChange={(value) => updateDraftPass({ skinStructureStrength: value })}
          />
          <SettingsSwitch
            icon={<Scan />}
            label="自动遮罩"
            checked={pass.autoMask}
            onToggle={() => updateDraftPass({ autoMask: !pass.autoMask })}
          />
          <SettingsSwitch
            icon={<Scan />}
            label="界面修正"
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
