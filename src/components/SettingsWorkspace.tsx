import { ContentSkeleton } from './ContentSkeleton';
import { SecuritySettings } from './SecuritySettings';
import '../styles/settings-heading.css';
import { AutoTextarea } from './AutoTextarea';
import { RefreshIcon as RefreshCw } from './RefreshIcon';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { usePageActive } from '../app/RetainedPage';
import { Languages, ArrowDownWideNarrow, 
  ArrowLeft, ArrowLeftRight, Blocks, BookOpen, CalendarClock, Copy,
  CopyCheck, Database, Download, Eraser, EyeOff, FileDown, FileUp, FolderOpen, HardDrive,
  HeartOff, ImageUpscale, Images, Info, Github, Layers, ListChecks, Minus,
  Paintbrush, Palette, PanelBottom, Pencil, Plus, Rocket, RotateCcw, Save, Settings2, Trash2, ShieldCheck, X, Check,
  SlidersHorizontal, Sparkles, Shuffle, Tags, Upload, User, Wand2, WandSparkles, BookOpenText, Waypoints, Gauge, ScrollText,
} from 'lucide-react';
import { pickDirectory, pickModelFile, pickSavePath, pickTextFile } from '../bridge/filePicker';
import { getPlatformCapabilities } from '../bridge/platform';
import { writeClipboardText } from '../bridge/clipboard';
import { EhRouteWorkspace } from './EhRouteWorkspace';
import { ErrorLogPanel, useErrorLog } from './ErrorLogPanel';
import { accountDisplayName } from './EhAccountPanel';
import { useToast } from './Toast';
import { YomikaMark } from './YomikaMark';
import { AboutDetails } from './AboutDetails';
import { EhMark } from './EhMark';
import { listen } from '@tauri-apps/api/event';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { availableModelUpdates } from '../lib/modelUpdates';
import { CUGAN_VARIANTS, chooseUpscaleFamily, groupUpscaleOptions, upscaleFamily, upscaleModelLabel } from '../lib/upscaleParameters';
import { useTimedConfirmation } from '../lib/useTimedConfirmation';
import { OverlayLayer } from './OverlayLayer';
import { ComputeCenterSettingsGroup } from './ComputeCenterSettingsGroup';
import { DlssnrSettingsGroup } from './DlssnrSettingsGroup';
import { ModelDownloadButton, ModelDownloadSlot } from './ModelDownloadControls';
import { SettingsRow, SettingsRowBody } from './SettingsRow';
import { SettingsChoice, SettingsMenu, SettingsNumber, SettingsOption, SettingsPanel } from './SettingsValueControls';
import { StatusLine } from './StatusLine';
import { CheckRow, CheckRowGroup, SettingsSwitch } from './SettingsControls';
import { UpscaleIcon } from './UpscaleIcon';
import { getTagTranslationSourceVersion, subscribeTagTranslationService, refreshTagTranslations } from '../lib/tagTranslationService';
import { getTagCountVersion, refreshTagCounts, subscribeTagCountChanges } from '../lib/tagCountService';
import {
  DATA_EXPORT_CREDENTIAL_ITEMS,
  DEFAULT_DATA_EXPORT_ITEMS,
  DATA_EXPORT_RECORD_ITEMS,
  isCredentialItem,
  dataExportItemLabel,
  type DataExportReport,
} from '../domain/dataExport';
import { DATA_EXPORT_KIND } from '../domain/dataExport';
import { installedDllLabel } from '../domain/dlssnrVersion';

import type { ServerRecord } from '../domain/library';
import type { ServerIdentity } from '../domain/server';
import type { CommandResult } from '../domain/result';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeLegacyRepository } from '../repositories/nativeLegacyRepository';
import { NativeSettingsRepository } from '../repositories/nativeSettingsRepository';
import { ServerSetupDialog } from './ServerSetupDialog';
import { TextInputDialog } from './TextInputDialog';
import { usePreferences } from '../app/preferences';
import { parseMigrationExport } from '../lib/dataMigration';
import { readoshiServerScope } from '../lib/readoshiScope';
import { invalidateRouteCache } from '../lib/routeCache';
import { COLOR_SCHEMES, CSS_THEME_PRESETS } from '../lib/cssThemePresets';
import { NativeCacheRepository, type CacheStats } from '../repositories/nativeCacheRepository';
import { NativeDedupRepository, type DedupPairInput } from '../repositories/nativeDedupRepository';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { NativeInferenceRepository, InstalledModelSchema, UpscaleCatalogSchema, type InstalledModel, type UpscaleCatalogModel } from '../repositories/nativeInferenceRepository';
import { readStorageSnapshot } from '../lib/storageSnapshot';
import { NativeDlssnrRepository } from '../repositories/nativeDlssnrRepository';
import { DETAIL_ACTIONS, MAX_PREFETCH_PAGES, PreferenceSnapshotSchema } from '../repositories/nativeSettingsRepository';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { openExternalUrl } from '../bridge/externalUrl';
import { readTextFromFile, saveTextToFile } from '../bridge/textFile';

function writeAdvancedCache(key: string, value: unknown[]): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function PreferenceRadioFallback({ name, value, options, onChange }: { name: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <div className="select-compat-radios" aria-hidden="false">{options.map(([option, label]) => <label key={option}><input type="radio" name={`${name}-compat`} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{label}</span></label>)}</div>;
}

/* ---- The two containers every setting is made of -------------------------- */
/* One group frame per section, one row shape per setting. The row carries no
 * control at all: an icon, the name and its hint on the left, the current value
 * on the right, and the whole strip opens the floating menu where the actual
 * control lives — the same secondary surface for every kind of setting, which
 * is what keeps the panel a list instead of a stack of one-off forms. */

function ErrorLogSetting() {
  const errorLog = useErrorLog();
  const count = errorLog.entries?.length;
  return <SettingsPanel
    icon={<ScrollText />}
    label="错误日志"
    value={count === undefined ? '读取中' : `${count} 条`}
    ariaLabel="错误日志"
  >
    <ErrorLogPanel state={errorLog} />
  </SettingsPanel>;
}

/** A setting edited through an arbitrary block of controls — text areas, file
 * pickers, cache reports. */
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';

const repository = new NativeLibraryRepository();
const legacyRepository = new NativeLegacyRepository();
const settingsRepository = new NativeSettingsRepository();
const dedupRepository = new NativeDedupRepository();
const cacheRepository = new NativeCacheRepository();
const inferenceRepository = new NativeInferenceRepository();
const GIB = 1_073_741_824;
const CACHE_RENDITIONS = [
  ['cover', '封面'],
  ['page-thumbnail', '页缩略图'],
  ['reader-page', '阅读页'],
  ['enhanced', '超分结果'],
  ['inference', '推理缓存'],
  ['other', '其他'],
] as const;
/** Vite inlines this at build time from package.json, so the About page cannot
 * drift from the shipped version the way a hand-written string would. */
const APP_VERSION = __APP_VERSION__;
const APP_AUTHOR = __APP_AUTHOR__;
/** Shown on the About page and opened in the browser; trimmed for display. */
const APP_REPOSITORY = __APP_REPOSITORY__;
const APP_REPOSITORY_DISPLAY = APP_REPOSITORY.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** 标签数据的版本读法：翻译库报的是提交时间（ISO 串），频次库报的是 release 的 tag。
 *  ISO 串只留日期——时分秒写在这行提示里没人读得出信息，还占宽。 */
function formatTagDataVersion(version: string | undefined): string | undefined {
  if (!version) return undefined;
  return /^(\d{4}-\d{2}-\d{2})T/.exec(version)?.[1] ?? version;
}

function formatCacheBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${index === 0 ? amount.toFixed(0) : amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')} ${units[index]}`;
}

/** 超分模型列表的固定头名次：内置的那两档（Anime4K 的 shader 链、随包 waifu2x）永远
 * 排在最前，其余的按 id 排。名次写死在这里而不是从数据库或目录里读——那两处的顺序
 * 会随「下载完成」「目录刷新」「版本更新」变化，而列表顺序不该跟着跳（用户 2026-10-18：
 * 模型下载完成会导致顺序发生变化，另外让 anime4k 和 waifu2x 放到上面）。 */
const BUILT_IN_HEAD = ['anime4k-hq', 'anime4k-ultra', 'anime4k', 'waifu2x-upconv7'];
function builtInRank(id: string): number {
  const at = BUILT_IN_HEAD.indexOf(id);
  return at === -1 ? BUILT_IN_HEAD.length : at;
}

/** Keep the selector compact: version and scale are implementation metadata. */
function modelOption(model: InstalledModel): { value: string; label: string } {
  return { value: model.id, label: upscaleModelLabel(model.id) };
}

/** One row per id. The backend lists one record per installed version (newest
 * first, so `resolve_installed_model` can fall back), but an option's value is
 * the id — two versions of the same model rendered as two identical rows. */
function firstPerId(models: InstalledModel[]): InstalledModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

/** The compact bar's selectable entries, in display order; 档案库 由偏好规范化与
 * UI 双重固定（没有它就进不了档案库），其余都可以关掉——关掉的项目会出现在「更多」里。 */
const BOTTOM_NAV_OPTIONS = [
  { key: 'home', label: '首页' },
  { key: 'library', label: '档案库' },
  { key: 'history', label: '历史' },
  { key: 'watchlist', label: '收藏夹' },
  { key: 'to-read', label: '待看' },
  { key: 'downloads', label: '下载' },
  { key: 'settings', label: '设置' },
] as const;

type BottomNavItemKey = (typeof BOTTOM_NAV_OPTIONS)[number]['key'];

/** Settings are split by workflow so everyday controls stay separate from
 * visual preferences, data migration, and model tooling. */
const settingsSections = [
  { id: 'settings-general', label: '通用', hint: '启动页面、下载目录与缓存', icon: <SlidersHorizontal /> },
  { id: 'settings-reading', label: '阅读', hint: '布局、方向与翻页方式', icon: <BookOpen /> },
  { id: 'settings-security', label: '安全', hint: '密码、生物认证与后台隐私', icon: <ShieldCheck /> },
  { id: 'settings-appearance', label: '样式', hint: '主题、配色与自定义 CSS', icon: <Palette /> },
  { id: 'settings-eh', label: 'E-Hentai', hint: '账户登录与 Cookie 管理', icon: <EhMark plate={false} /> },
  { id: 'settings-data', label: '数据', hint: '数据迁移与关联收藏删除', icon: <Database /> },
  { id: 'settings-advanced', label: '高级', hint: '超分与模型管理', icon: <Sparkles /> },
  { id: 'settings-tools', label: '工具', hint: '上传、导入与查重工作台', icon: <Blocks /> },
  { id: 'settings-about', label: '关于', hint: '版本信息与项目来源', icon: <Info /> },
] as const;

/** Sections whose content lives inside the single preferences form. */
const PREFERENCE_SECTIONS = ['settings-general', 'settings-reading', 'settings-appearance', 'settings-advanced', 'settings-data'] as const;

/** The sections no longer print their own title, so the accessible name for a
 * panel comes from the same list the sidebar is built from. */
function sectionLabel(id: string): string {
  return settingsSections.find((section) => section.id === id)?.label ?? '设置';
}

export function SettingsWorkspace() {
  const pageActive = usePageActive();
  const location = useLocation();
  const { showToast } = useToast();
  const preferenceState = usePreferences();
  const [preferenceDraftOverride, setPreferenceDraft] = useState<PreferenceSnapshot>();
  const preferenceDraft = preferenceDraftOverride ?? preferenceState.preferences;
  const [preferenceMessage, setPreferenceMessage] = useState<string>();
  const [preferenceError, setPreferenceError] = useState(false);
  const [migrationText, setMigrationText] = useState('');
  const [migrationPending, setMigrationPending] = useState(false);
  /** 导出弹层的勾选：默认六类记录与设置；凭据默认不勾，勾上时提醒敏感（docs/30）。 */
  const [exportItems, setExportItems] = useState<string[]>([...DEFAULT_DATA_EXPORT_ITEMS]);
  /** 导入弹层：解析后文件里实际装着的条目（勾选框按它动态生成，默认全选）。 */
  const [importAvailable, setImportAvailable] = useState<string[]>([]);
  const [importItems, setImportItems] = useState<string[]>([]);
  const [platformName, setPlatformName] = useState<string>();
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [loadRetryable, setLoadRetryable] = useState(false);
  const [serverLoadAttempt, setServerLoadAttempt] = useState(0);
  const [selectedSettingsSection, setSelectedSettingsSection] = useState<(typeof settingsSections)[number]['id']>('settings-general');
  /** In the compact layout the sections are a list that drills into one section
   * at a time, so a phone shows either the list or one section — never a strip
   * of eight tabs above squeezed content. Ignored in the wide layout. */
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
  const [compactDrilled, setCompactDrilled] = useState(false);
  const showSectionList = !compact || !compactDrilled;
  const showSectionContent = !compact || compactDrilled;
  // 一级一级退：手机上的返回手势走的是 webview 历史（`AppPlugin` 把返回键交给
  // `webView.goBack()`），所以设置项开着时按返回，人想要的是先回到分类列表，而不是
  // 把整个设置页带回上一页。开着的时候压一条守卫条目，返回手势弹掉它、就地回到列表；
  // 页内那个「返回设置分类」按钮关掉这一层时，守卫自己把条目吃掉（`lib/overlayBackGuard`）。
  useOverlayBackGuard(pageActive && compact && compactDrilled, () => setCompactDrilled(false));
  const [cacheStats, setCacheStats] = useState<CacheStats>();
  const [cacheClearing, setCacheClearing] = useState(false);
  /** 标签翻译 / 补全排序的数据版本与刷新状态（docs/30 设置项）。 */
  const [tagTranslationVersion, setTagTranslationVersion] = useState(getTagTranslationSourceVersion());
  const [tagCountVersion, setTagCountVersion] = useState(getTagCountVersion());
  /** 哪一份数据正在刷新（不是「有没有在刷新」）：两颗按钮各管各的，一颗转的时候
   *  另一颗不该跟着禁用。 */
  const [tagDataPending, setTagDataPending] = useState<'translation' | 'count'>();
  useEffect(() => {
    const detachTranslation = subscribeTagTranslationService(() => setTagTranslationVersion(getTagTranslationSourceVersion()));
    const detachCount = subscribeTagCountChanges(() => setTagCountVersion(getTagCountVersion()));
    return () => { detachTranslation(); detachCount(); };
  }, []);
  const refreshTagData = async (kind: 'translation' | 'count') => {
    setTagDataPending(kind);
    try {
      if (kind === 'translation') await refreshTagTranslations();
      else await refreshTagCounts();
      showToast('标签数据已是最新', 'success');
    } catch {
      showToast('标签数据刷新失败，稍后会自动重试', 'error');
    } finally {
      setTagDataPending((current) => (current === kind ? undefined : current));
    }
  };
  /** 打开开关时如果本机还没有这份数据，就地取一次（JHenTai 同款做法）：开关表达的是
   *  「我要用」，等到下次启动才下载就等于「打开了却没有数据」，而且排在补全里的效果
   *  要过一天才看得见。 */
  const setTagDataEnabled = (kind: 'translation' | 'count', enabled: boolean) => {
    editPreferences(kind === 'translation' ? { tagTranslationEnabled: enabled } : { tagCountOrderEnabled: enabled });
    const known = kind === 'translation' ? tagTranslationVersion : tagCountVersion;
    if (!enabled || known) return;
    void (kind === 'translation' ? refreshTagTranslations() : refreshTagCounts()).catch(() => undefined);
  };
  const openAboutLink = async (url: string) => {
    const result = await openExternalUrl(url);
    if (!result.ok) showToast(result.error.message, 'error');
  };
  const [modelPending, setModelPending] = useState(false);
  const [dllValidating, setDllValidating] = useState(false);
  /** The model being downloaded right now, plus how far along it is: the backend
   * reports `model-download-progress` while a release bundle comes down, and only
   * one download runs at a time. */
  const [pendingModel, setPendingModel] = useState<{ id: string; label: string }>();
  const [modelDownload, setModelDownload] = useState<{ completed: number; total?: number | undefined }>();
  const pageRef = useRef<HTMLDivElement>(null);
  /** The E-Hentai row's current value: the active account, reported by the
   * workspace that owns the list. The workspace lives inside the row's menu, so
   * it only mounts when the menu opens — without a section-level fetch the
   * closed row would say 未登录 about an account that is signed in. */
  const [ehAccountName, setEhAccountName] = useState<string>();
  useEffect(() => {
    // 数据一节也要它：收藏同步删除没有登录账户就开不了。
    if (!['settings-eh', 'settings-data'].includes(selectedSettingsSection)) return;
    let active = true;
    void new NativeEhRepository().listAccounts().then((result) => {
      if (!active || !result.ok) return;
      const activeAccount = result.value.find((account) => account.isActive) ?? result.value[0];
      setEhAccountName((current) => current ?? (activeAccount ? accountDisplayName(activeAccount) : undefined));
    });
    return () => { active = false; };
  }, [selectedSettingsSection]);
  /** 自定义菜单展示哪种层级：基础配色或高级 CSS。默认落在基础。 */
  const [appearanceMode, setAppearanceMode] = useState<'basic' | 'advanced'>('basic');
  const activeScheme = COLOR_SCHEMES.find((scheme) => scheme.css !== '' && scheme.css === preferenceDraft.customCss);
  const customValue = activeScheme ? activeScheme.label : preferenceDraft.customCss ? '高级自定义' : '默认';

  const [installedModels, setInstalledModels] = useState<InstalledModel[] | undefined>(() => readStorageSnapshot('yomika.advanced-models', InstalledModelSchema.array()));
  /** The hosted catalog. `undefined` = not fetched yet, `[]` = fetch failed. */
  const [upscaleCatalog, setUpscaleCatalog] = useState<UpscaleCatalogModel[] | undefined>(() => readStorageSnapshot('yomika.advanced-upscale-catalog', UpscaleCatalogSchema.shape.models));
  /** Display may start from the cached list, but **actions** wait for a real answer:
   * trusting the cache here would let a stale or empty snapshot enable the upscale
   * switch before the IPC reconciles, and a cache written while models were missing
   * (or removed outside the app) would leave a control that cannot run. So the gate
   * stays closed until verification returns — see 「shows cached model detection
   * while refreshing after a restart」 in tests/components/settings-workspace.test.tsx. */
  const [modelsVerified, setModelsVerified] = useState(false);
  const [upscaleMenu, setUpscaleMenu] = useState<'models' | 'realcugan'>();
  const [confirmRemoveModel, setConfirmRemoveModel] = useState<string>();
  useTimedConfirmation(confirmRemoveModel, setConfirmRemoveModel, modelPending);
  const closeUpscaleMenu = () => { setUpscaleMenu(undefined); setConfirmRemoveModel(undefined); };
  useEffect(() => {
    if (selectedSettingsSection !== 'settings-advanced') {
      setUpscaleMenu(undefined);
      setConfirmRemoveModel(undefined);
    }
  }, [selectedSettingsSection]);
  // A model with no recorded scale cannot be run, so it is not a choice. One row
  // per id: see firstPerId.
  const runnableModels = firstPerId(installedModels?.filter((model) => model.scale && model.kind === 'upscale') ?? []);
  /** One switch each, derived from what is stored rather than stored separately:
   * a second boolean would be one more thing to keep in step with the model it
   * points at. Off is the backend being off, and no model chosen. */
  const upscaleOn = preferenceDraft.upscaleBackend !== 'off' && Boolean(runnableModels.length);
  const upscaleReady = Boolean(runnableModels.length);
  /** 目录里还没装上盘的那些：列出来才有下载按钮。只列已安装的模型，手机端
   * 就永远等不到 real-esrgan —— 既没有导入入口，也没有下载入口。
   *
   * 顺序**不跟安装状态走**：用户 2026-10-18 报「模型下载完成会导致顺序发生变化」。
   * 以前是「已装的在前、目录里的在后」，已装那一半的顺序来自数据库行序，于是装完一个
   * 就会跳一下。现在两档内置（Anime4K 的 shader 链、随包 waifu2x）永远在最前，其余按
   * id 排——id 不随下载、目录刷新、版本更新变化，列表因此在任何时刻都一样。
   *
   * 行名以目录为准：装之前叫「Real-ESRGAN 通用 x4」，装完还叫这个，不会退回
   * 内置那份按 id 拼出来的名字。 */
  const hostedLabels = new Map((upscaleCatalog ?? []).map((hosted) => [hosted.id, hosted.label] as const));
  const upscaleModelOptions = groupUpscaleOptions([
    ...runnableModels.map((model) => ({ value: model.id, label: hostedLabels.get(model.id) ?? modelOption(model).label })),
    ...(upscaleCatalog ?? [])
      .filter((hosted) => !runnableModels.some((installed) => installed.id === hosted.id))
      .map((hosted) => ({ value: hosted.id, label: hosted.label })),
  ].sort((left, right) => builtInRank(left.value) - builtInRank(right.value) || left.value.localeCompare(right.value)));
  /** 已装、但目录里报了新版本的那些。更新就是同一个下载动作，只是按钮换个说法：
   * 后端把版本编进安装路径（`models/<id>/<version>`），新版本落一个新目录，取用时
   * 认的是最新的那一版，所以不需要先卸载旧的。 */
  const outdatedUpscaleIds = new Set(availableModelUpdates(installedModels, upscaleCatalog).map((update) => update.id));
  /** 这一行显示哪个模型。下载在二级菜单里按选项走，所以这里不需要配一份「当前选项」。
   * 兜底仍然是**已装的第一个**（旧行为）：列表现在是按内置优先排的，拿列表头当兜底
   * 会顺手把「开启超分时默认选谁」也改掉——那是另一件事，用户没让改。 */
  const upscaleSelectedModel = preferenceDraft.upscaleModel || runnableModels[0]?.id || chooseUpscaleFamily(upscaleModelOptions[0]?.value ?? '', '', (upscaleCatalog ?? []).map((model) => model.id)) || '';
  // 选择器的值不能为空：命令失败时列表可能真的是空的，退回随包 waifu2x。
  if (!upscaleModelOptions.length) upscaleModelOptions.push({ value: 'waifu2x-upconv7', label: 'Waifu2x' });
  const selectedUpscaleFamily = upscaleFamily(upscaleSelectedModel);
  const familyModel = (family: string) => chooseUpscaleFamily(family, upscaleSelectedModel, [...runnableModels.map((model) => model.id), ...(upscaleCatalog ?? []).map((model) => model.id)]);
  const modelDownloadAction = (id: string, label: string) => <ModelDownloadButton
    option={{ value: id, label }}
    installed={runnableModels.some((model) => model.id === id)}
    outdated={outdatedUpscaleIds.has(id)} pending={modelPending}
    className="select-option-download" onDownload={() => void downloadModel(id, label)}
  />;
  const modelDownloadStatus = (id: string, label: string) => <ModelDownloadSlot
    open={pendingModel?.id === id} label={pendingModel?.label ?? label} progress={modelDownload}
  />;

  const statsRequestedRef = useRef(false);
  const autosaveTimer = useRef<number>();
  const pendingPreferences = useRef<PreferenceSnapshot>();
  const preferenceEditRevision = useRef(0);

  // Only failures interrupt: a save the user did not ask for should not announce
  // itself on every keystroke. The panel says when it last saved instead.
  useEffect(() => {
    if (preferenceMessage) showToast(preferenceMessage, preferenceError ? 'error' : 'success');
  }, [preferenceError, preferenceMessage, showToast]);
  useEffect(() => {
    if (preferenceState.error) showToast(preferenceState.error, 'error');
  }, [preferenceState.error, showToast]);
  // 下载目录的默认值描述按运行平台给出准确路径。
  useEffect(() => {
    void getPlatformCapabilities().then((result) => {
      if (result.ok) setPlatformName(result.value.platform);
    });
  }, []);

  useEffect(() => {
    const requested = new URLSearchParams(location.search).get('section');
    if (requested && settingsSections.some((section) => section.id === `settings-${requested}`)) {
      setSelectedSettingsSection(`settings-${requested}` as (typeof settingsSections)[number]['id']);
      // A link that names a section means to show it, not to land on the list.
      setCompactDrilled(true);
    }
  }, [location.search]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(undefined);
    setLoadRetryable(false);
    void repository.listServers().then((result) => {
      if (!active) return;
      if (result.ok) setServers(result.value);
      else {
        setLoadError(result.error.message);
        setLoadRetryable(result.error.retryable);
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [serverLoadAttempt]);

  async function refreshCacheStats() {
    const result = await cacheRepository.stats();
    if (result.ok) setCacheStats(result.value);
  }

  useEffect(() => {
    // Once per visit to the section: the URL effect and the initial render used
    // to fire two identical cache_stats calls back to back.
    if (selectedSettingsSection !== 'settings-general') return;
    if (statsRequestedRef.current) return;
    statsRequestedRef.current = true;
    void refreshCacheStats();
  }, [selectedSettingsSection]);

  async function clearImageCache() {
    setCacheClearing(true);
    const result = await cacheRepository.clearImages();
    // Results go to the shared toast: an inline line inside the cache menu was
    // easy to miss and inconsistent with every other action in the app.
    if (result.ok) {
      showToast(`已释放 ${formatCacheBytes(result.value.bytesFreed)}，保留 ${formatCacheBytes(result.value.protectedBytes)} 受保护缓存`, 'success');
      await refreshCacheStats();
    } else {
      showToast(result.error.message, 'error');
    }
    setCacheClearing(false);
  }

  useEffect(() => {
    if (selectedSettingsSection !== 'settings-advanced') return;
    void inferenceRepository.listModels().then((result) => {
      if (result.ok) {
        setInstalledModels(result.value);
        writeAdvancedCache('yomika.advanced-models', result.value);
      }
      setModelsVerified(result.ok);
      if (!result.ok) showToast(result.error.message, 'error');
    });
    // 目录要走网络，慢、而且离线时必然失败：拿不到只是「没有新的可下载」，
    // 已经装在盘上的模型照样可选，所以不弹错、也不挡住上面的模型列表。
    void inferenceRepository.listUpscaleCatalog().then((result) => {
      if (result.ok) {
        setUpscaleCatalog(result.value.models);
        writeAdvancedCache('yomika.advanced-upscale-catalog', result.value.models);
      }
    });
  }, [selectedSettingsSection, showToast]);

  /** Saves a change straight away. The old form had a 保存偏好 button, which meant
   * a toggle could look applied and silently not be. Rapid edits (typing in the
   * CSS box, holding a number spinner) collapse into one write. */
  function editPreferences(patch: Partial<PreferenceSnapshot>) {
    preferenceEditRevision.current += 1;
    const next = { ...preferenceDraft, ...patch };
    setPreferenceDraft(next);
    pendingPreferences.current = next;
    if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => void persistPreferences(next), 400);
  }

  async function persistPreferences(next: PreferenceSnapshot) {
    const revision = preferenceEditRevision.current;
    if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = undefined;
    pendingPreferences.current = undefined;
    // Half-typed values are not failures. Clearing a number field to retype it
    // passes through 0 or NaN, and autosave would report each one as an error.
    if (!PreferenceSnapshotSchema.safeParse(next).success) return;
    setPreferenceMessage(undefined);
    setPreferenceError(false);
    const result = await preferenceState.save(next);
    if (revision !== preferenceEditRevision.current) return;
    if (result.ok) {
      setPreferenceDraft(result.value);
    } else {
      setPreferenceError(true);
      setPreferenceMessage(result.error.message);
    }
  }

  async function refreshModels() {
    const models = await inferenceRepository.listModels();
    if (models.ok) {
      setInstalledModels(models.value);
      writeAdvancedCache('yomika.advanced-models', models.value);
      return models.value;
    }
  }

  async function removeModelFamily(family: string, label: string) {
    if (modelPending) return;
    if (confirmRemoveModel !== family) { setConfirmRemoveModel(family); return; }
    setModelPending(true);
    try {
      const ids = runnableModels.filter((model) => upscaleFamily(model.id) === family).map((model) => model.id);
      const result = await inferenceRepository.removeModels(ids);
      const models = result.ok ? result.value : await refreshModels();
      if (models) {
        setInstalledModels(models);
        writeAdvancedCache('yomika.advanced-models', models);
        if (!models.some((model) => model.id === upscaleSelectedModel)) {
          const fallback = models.find((model) => model.scale && model.kind === 'upscale');
          editPreferences({ upscaleModel: fallback?.id ?? '', ...(!fallback ? { upscaleBackend: 'off' as const } : {}) });
        }
      }
      if (result.ok) showToast(`已删除 ${label}`, 'success');
      else showToast(result.error.message, 'error');
    } finally {
      setConfirmRemoveModel(undefined);
      setModelPending(false);
    }
  }

  async function importModelFromPath(path: string) {
    setModelPending(true);
    try {
      if (path.toLowerCase().endsWith('.dll')) {
        setDllValidating(true);
        const result = await new NativeDlssnrRepository().importDll(path);
        if (!result.ok) { showToast(result.error.message, 'error'); return; }
        window.dispatchEvent(new Event('yomika:dlssnr-imported'));
        const { width, height } = result.value.verification;
        showToast(`DLSSNR 组件已导入：${installedDllLabel(result.value.variantLabel, '自定义 DLL', result.value.version)} · 本机验证通过（${width}×${height}）`, 'success');
        return;
      }
      const result = await inferenceRepository.importModelPath(path);
      if (!result.ok) { showToast(result.error.message, 'error'); return; }
      showToast(`模型已导入：${modelOption(result.value).label}`, 'success');
      await refreshModels();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '模型导入失败', 'error');
    } finally { setModelPending(false); setDllValidating(false); }
  }

  async function downloadModel(modelId: string, label: string) {
    setModelPending(true);
    setPendingModel({ id: modelId, label });
    setModelDownload(undefined);
    try {
      const result = await inferenceRepository.downloadDefaultModel(modelId);
      if (result.ok) { showToast('模型下载完成', 'success'); await refreshModels(); }
      else showToast(result.error.message, 'error');
    } finally {
      setModelPending(false);
      setPendingModel(undefined);
      setModelDownload(undefined);
    }
  }

  // Progress arrives as an event rather than from the awaited command, so the row
  // can show a bar while the download runs. Only one model downloads at a time.
  //
  // The listener is attached once, not when a download starts: registering it from
  // an effect keyed on `pendingModel` meant the first progress events — the ones
  // between the command starting and the effect running — were dropped by
  // construction. `path` is the model id the backend tags each event with, so a
  // second download can never drive the first one's bar.
  const pendingModelRef = useRef<{ id: string; label: string }>();
  pendingModelRef.current = pendingModel;
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ path?: string; completed: number; total?: number | null }>('model-download-progress', (event) => {
      const current = pendingModelRef.current;
      if (!active || !current) return;
      if (event.payload.path && event.payload.path !== current.id) return;
      setModelDownload({ completed: event.payload.completed, total: event.payload.total ?? undefined });
    }).then((detach) => { if (active) unlisten = detach; else detach(); }).catch(() => { /* no webview outside the app */ });
    return () => { active = false; unlisten?.(); };
  }, []);

  /** 默认下载目录的描述按运行平台给出准确位置（Windows 便携版在 exe 同目录）。 */
  const defaultDownloadHint = useMemo(() => {
    switch (platformName) {
      case 'windows': return '默认数据目录：程序所在目录的 data\\downloads';
      case 'macos': return '默认数据目录：~/Library/Application Support/app.yomika.reader/downloads';
      case 'linux': return '默认数据目录：~/.local/share/app.yomika.reader/downloads';
      default: return '默认数据目录下的 downloads 文件夹';
    }
  }, [platformName]);


  /** 导入一份导出内容。文本由调用方给：粘贴进来的是框里那份，从文件导入的是刚读回来的
   *  那份。新版文件（yomika-export）先解析出内容清单进勾选弹层，确认后再落地；旧格式
   *  （同步文档、Readoshi worker、统一信封、旧偏好）保持原有路径；口令加密的旧凭据
   *  文件随口令链路一并移除，不再支持。所有反馈走 toast（docs/30）。 */
  async function runMigrationImport(text: string) {
    setMigrationPending(true);
    const parsed = parseMigrationExport(text);
    if (parsed.kind === 'invalid') {
      showToast(parsed.reason, 'error');
      setMigrationPending(false);
      return;
    }
    if (parsed.kind === 'credentials') {
      showToast('这是旧版口令加密的凭据文件：口令导入已移除，请在旧版本应用中导入后再升级', 'error');
      setMigrationPending(false);
      return;
    }
    if (parsed.kind === 'export') {
      // 新版文件：文件里有什么就勾什么（默认全选），等使用者确认再落地。
      setMigrationText(text.trim());
      setImportAvailable(parsed.payload.items);
      setImportItems([...parsed.payload.items]);
      showToast(`文件里包含 ${parsed.payload.items.map(dataExportItemLabel).join('、')}`, 'info');
      setMigrationPending(false);
      return;
    }
    if (parsed.kind === 'legacy') {
      const result = await preferenceState.importLegacy(text.trim());
      if (result.ok) {
        setPreferenceDraft(result.value.preferences);
        setMigrationText('');
        showToast(`已导入 ${result.value.importedCount} 项偏好设置`, 'success');
        // 首页书架的快照（90 秒内不重取）会盖住刚导入的数据，导入后立刻失效。
        invalidateRouteCache('home:');
      } else {
        showToast(result.error.message, 'error');
      }
      setMigrationPending(false);
      return;
    }
    if (parsed.kind === 'scoped') {
      // 旧版独立导出的同步文档：按记录类全集落地（旧文件里没有凭据）。
      const result = await settingsRepository.importScopedData(
        text.trim(),
        JSON.stringify(['progress', 'history', 'watchlist', 'search_presets', 'dedup', 'app_settings']),
      );
      if (!result.ok) {
        showToast(result.error.message, 'error');
        setMigrationPending(false);
        return;
      }
      setMigrationText('');
      showToast(
        `已导入 ${result.value.applied} 项` +
        (result.value.skipped > 0 ? `，跳过 ${result.value.skipped} 项` : ''),
        'success',
      );
      invalidateRouteCache();
      setMigrationPending(false);
      return;
    }
    if (parsed.kind === 'workerV3') {
      const payload = parsed.payload;
      // The export's serverScope is md5(normalized server URL) in Readoshi's
      // formula; recompute it over the configured servers to find the target
      // scope. A foreign server must be added first — guessing would write
      // the records into the wrong scope.
      const target = servers.find((server) => readoshiServerScope(server.baseUrl) === payload.serverScope);
      if (!target) {
        showToast('导出属于其他 LANraragi 服务器（指纹 ' + payload.serverScope + '），先在设置中添加该服务器再导入', 'error');
        setMigrationPending(false);
        return;
      }
      const result = await legacyRepository.importWorkerExport(target.scopeId, payload);
      if (!result.ok) {
        showToast(result.error.message, 'error');
        setMigrationPending(false);
        return;
      }
      const skipped = payload.history.skipped + payload.watchlist.skipped + payload.dedupe.skipped;
      let dedupePairs = 0;
      let dedupeNote = '';
      if (payload.dedupe.pairs.length > 0) {
        const pairs: DedupPairInput[] = payload.dedupe.pairs.map((pair) => ({
          leftArchiveId: pair.leftArchiveId,
          rightArchiveId: pair.rightArchiveId,
          source: 'readoshi',
          diagnostics: null,
        }));
        const dedupeResult = await dedupRepository.importReadoshi({ scopeId: target.scopeId, pairs });
        if (dedupeResult.ok) dedupePairs = pairs.length;
        else dedupeNote = `（重复关系导入失败：${dedupeResult.error.message}）`;
      }
      setMigrationText('');
      const removed = [
        result.value.historyRemoved ? `清理阅读 ${result.value.historyRemoved}` : '',
        result.value.watchlistRemoved ? `墓碑 ${result.value.watchlistRemoved}` : '',
      ].filter(Boolean).join('，');
      showToast(
        `已导入：阅读 ${result.value.history} · 待看 ${result.value.watchlist} · 重复关系 ${dedupePairs}` +
        (removed ? `（${removed}）` : '') +
        (skipped ? `，跳过 ${skipped} 条异常记录` : '') +
        dedupeNote,
        result.value.history + result.value.watchlist > 0 ? 'success' : 'error',
      );
      invalidateRouteCache('home:');
      setMigrationPending(false);
      return;
    }
    const scopeId = parsed.payload.scopeId || servers[0]?.scopeId;
    if (!scopeId) {
      showToast('导出内容没有数据范围，且本机尚未配置服务器', 'error');
      setMigrationPending(false);
      return;
    }
    const result = await legacyRepository.importExport(scopeId, text.trim());
    if (result.ok) {
      setMigrationText('');
      showToast(`已导入 ${result.value} 项本地记录`, 'success');
      invalidateRouteCache('home:');
    } else {
      showToast(result.error.message, 'error');
    }
    setMigrationPending(false);
  }

  /** 导出：按弹层勾选折一份明文 JSON（docs/30）。勾了凭据时提醒「包含敏感信息」——
   *  防泄漏的防线是导出前的知情确认，不再是一把口令。
   *
   *  这里只负责折出那份文本：存文件与复制各自调它一次。从前折文本是「导出数据」
   *  这颗按钮独占的事，于是没先按过它的时候「导出为文件」是灰的——按了像是没反应。 */
  async function buildMigrationExport(): Promise<DataExportReport | null> {
    if (exportItems.length === 0) {
      showToast('先勾选要导出的数据', 'error');
      return null;
    }
    setMigrationPending(true);
    const result = await settingsRepository.exportData(exportItems);
    setMigrationPending(false);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return null;
    }
    // 凭据库里读不出来的条目（条目被删过、换台机器后凭据库是空的）后端会如实计数，
    // 但从前的报告没人看：不出声的话，「已导出」会让人以为文件里什么都齐了。
    if (result.value.skipped > 0) {
      showToast(`${result.value.skipped} 条凭据在本机读不出来，没有写进文件`, 'error');
    }
    return result.value;
  }

  /** 导出报告的条数摘要：成功提示里带上「带走的是什么」，而不是只说一句成功。 */
  function exportSummary(report: DataExportReport): string {
    return [
      report.records > 0 ? `记录与设置 ${report.records} 项` : '',
      report.servers > 0 ? `服务器 ${report.servers}` : '',
      report.ehAccounts > 0 ? `E-H 账户 ${report.ehAccounts}` : '',
    ].filter(Boolean).join(' · ');
  }

  /** 导入弹层的勾选：文件里有但没勾的类不会被落地。 */
  function toggleImportItem(id: string) {
    setImportItems((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  }

  /** 导入弹层勾选确认：只把勾中的类落地，文件里有但没勾的如实跳过。 */
  async function runSelectedImport() {
    setMigrationPending(true);
    const result = await settingsRepository.importData(migrationText, importItems);
    setMigrationPending(false);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    const parts = [
      result.value.records > 0 ? `记录与设置 ${result.value.records} 项` : '',
      result.value.servers > 0 ? `服务器 ${result.value.servers}` : '',
      result.value.ehAccounts > 0 ? `E-H 账户 ${result.value.ehAccounts}` : '',
      result.value.skipped > 0 ? `跳过 ${result.value.skipped} 类（文件里没有内容，或本机读不出凭据）` : '',
    ].filter(Boolean);
    showToast(parts.length ? `已导入：${parts.join(' · ')}` : '勾选的类别在文件里都是空的，没有导入任何数据', parts.length ? 'success' : 'info');
    setMigrationText('');
    setImportAvailable([]);
    setImportItems([]);
    // 导入可能新增服务器，重新读取列表。
    setServerLoadAttempt((attempt) => attempt + 1);
    await preferenceState.reload();
    setPreferenceDraft(undefined);
    invalidateRouteCache();
  }

  /** 导出弹层的勾选：默认六类记录与设置，凭据要使用者自己勾上。 */
  function toggleExportItem(id: string) {
    setExportItems((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  }

  /** The export is only useful on another machine, so copying it out is part of
   * the export itself — no manual selection inside the read-only box. */
  async function copyMigrationExport() {
    const report = await buildMigrationExport();
    if (!report) return;
    try {
      await writeClipboardText(report.text);
      showToast('导出内容已复制到剪贴板', 'success');
    } catch {
      showToast('复制失败，请改用「导出为文件」', 'error');
    }
  }

  /** 导出成文件：折文本 → 选存哪 → 写盘，一次动作走完（不必先按一次别的东西）。 */
  async function saveMigrationToFile() {
    const report = await buildMigrationExport();
    if (!report) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const path = await pickSavePath(`yomika-export-${stamp}.json`);
    if (!path) return;
    const result = await saveTextToFile(path, report.text);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    const summary = exportSummary(report);
    const where = `已导出到 ${result.value}`;
    if (exportItems.some(isCredentialItem)) {
      // 导出是成功的：提示语里说清「这份文件敏感」，但别用红态的警告——
      // 那是在说「出事了」，而这里只是要人多留个心（docs/30 的知情确认在弹层里已经做过一次）。
      showToast(`${where}：含 API Key、Cookie 等敏感信息，请妥善保管`, 'success');
      return;
    }
    showToast(summary ? `${where}（${summary}）` : `${where}（没有可带走的条目）`, 'success');
  }

  /** 从文件导入：读回来放进框里（让人看见读了什么），再走同一次导入。 */
  async function importMigrationFromFile() {
    const path = await pickTextFile();
    if (!path) return;
    const result = await readTextFromFile(path);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    setMigrationText(result.value);
    await runMigrationImport(result.value);
  }

  // Switching sections starts at the top, before the browser paints the new one.
  // As a passive effect this ran one frame late: the new section was drawn at the
  // previous section's scroll offset and only then snapped up, which is a visible
  // jump on every switch. A layout effect runs after React has updated the DOM and
  // before the frame is painted, so the new section is simply there, at the top.
  // The first render is left alone, so returning to the settings route still
  // restores the position the route cache saved.
  const lastSection = useRef(selectedSettingsSection);
  const lastDrilled = useRef(compactDrilled);
  useLayoutEffect(() => {
    const changed = lastSection.current !== selectedSettingsSection || lastDrilled.current !== compactDrilled;
    lastSection.current = selectedSettingsSection;
    lastDrilled.current = compactDrilled;
    if (!changed) return;
    const scroller = pageRef.current?.closest('.workspace');
    // scrollTop, not scrollTo: the assignment is all this needs, and it works in
    // the jsdom the tests run in.
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
  }, [compactDrilled, selectedSettingsSection]);

  /** The compact bar answers scrolling the way the scroll-to-top disc does. */
  function toggleBottomNavItem(key: BottomNavItemKey) {
    // 档案库固定显示，对应的行是禁用态，这里只是双保险。
    if (key === 'library') return;
    const current = preferenceDraft.bottomNavItems;
    const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
    editPreferences({ bottomNavItems: next });
  }

  async function saveServer(input: { identity: ServerIdentity; apiKey: string }): Promise<CommandResult<ServerIdentity>> {
    const result = await repository.saveServer(input);
    if (result.ok) {
      setServers((current) => [
        ...current.filter((server) => server.id !== result.value.id),
        result.value,
      ].sort((left, right) => left.name.localeCompare(right.name)));
    }
    return result;
  }

  /** 删除一台服务器的配置。档案、进度与历史都挂在同一个 scope id 上，重新添加同一地址还能接上，所以后端只删配置本身。 */
  async function deleteServer(server: ServerRecord): Promise<boolean> {
    const result = await repository.deleteServer(server.id);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return false;
    }
    setServers(result.value);
    showToast(`已删除服务器 ${server.name} 的配置`, 'success');
    return true;
  }

  /** 切换启用的服务器。仓库层会失效书架与首页的路由缓存，面板上的行就地更新。 */
  async function enableServer(server: ServerRecord) {
    if (server.enabled) return;
    const result = await repository.setServerEnabled(server.id);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    setServers((current) => current.map((item) => (
      item.id === result.value.id ? result.value : { ...item, enabled: false }
    )).sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name)));
    showToast(`已启用服务器 ${result.value.name}，书架与首页将读取它`, 'success');
  }

  return (
    <div className="settings-page" ref={pageRef}>
      <h1 className="visually-hidden">设置</h1>
      <div className={`settings-layout${compact ? ' is-compact' : ''}`}>
        {showSectionList && (
        /* The sticky element sits inside a slot that stretches to the row, so its
           containing block does not change height with the section: as a direct
           grid item the sidebar was offset by its own `top` (24px) whenever the
           content was taller than the nav, and the whole list jumped on every
           switch between a tall and a short section. */
        <div className="settings-sidebar-slot">
        <aside className="settings-sidebar" aria-label="设置分类">
          {compact && <header className="settings-compact-heading"><h2>设置</h2></header>}
          {compact ? (
            /* 移动端直接复用内部面板的渲染路径：preferences-form > settings-group
               > SettingsRow——同一套父链与类，不写任何样式覆盖。 */
            <div className="preferences-form">
              <div className="settings-group">
                {settingsSections.map((section) => (
                  <SettingsRow
                    key={section.id}
                    icon={section.icon}
                    label={section.label}
                    trailing="nav"
                    ariaLabel={`打开 ${section.label} 设置`}
                    onClick={() => { setSelectedSettingsSection(section.id); setCompactDrilled(true); }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <nav className="settings-nav">
              {settingsSections.map((section) => (
                <a
                  className={selectedSettingsSection === section.id ? 'is-active' : undefined}
                  href={`#${section.id}`}
                  key={section.id}
                  aria-current={selectedSettingsSection === section.id ? 'page' : undefined}
                  onClick={(event) => { event.preventDefault(); setSelectedSettingsSection(section.id); }}
                >
                  <span>{section.label}</span>
                </a>
              ))}
            </nav>
          )}
        </aside>
        </div>
        )}
        {showSectionContent && (
        <div className="settings-content">
      {compact && (
        <header className="settings-compact-heading">
          <button className="reader-icon-button" type="button" aria-label="返回设置分类" onClick={() => setCompactDrilled(false)}>
            <ArrowLeft aria-hidden="true" />
          </button>
          <h2>{sectionLabel(selectedSettingsSection)}</h2>
        </header>
      )}
      {(PREFERENCE_SECTIONS as readonly string[]).includes(selectedSettingsSection) && (
      <section className="preferences-panel" id={selectedSettingsSection === 'settings-data' ? 'settings-data-preferences' : selectedSettingsSection} aria-label={sectionLabel(selectedSettingsSection)}>
        {/* No section title here: the sidebar already names the section, and one
            visible section at a time meant the heading only reserved a column of
            empty space beside every control. No autosave notice either — every
            control in this panel saves itself, so a line saying so on every
            section was chrome that never told anyone anything they could act on.
            A failed save still interrupts, through the toast. */}
        {preferenceState.loading ? <ContentSkeleton label="正在读取偏好" rows={6} /> : (
          <div className="preferences-form">
            {selectedSettingsSection === 'settings-general' && platformName === 'windows' && (
              <div className="settings-group">
                <SettingsSwitch icon={<Rocket />} label="开机自启" checked={preferenceDraft.startWithWindows} onToggle={() => editPreferences({ startWithWindows: !preferenceDraft.startWithWindows })} />
                <SettingsSwitch icon={<PanelBottom />} label="关闭到托盘" checked={preferenceDraft.closeToTray} onToggle={() => editPreferences({ closeToTray: !preferenceDraft.closeToTray })} />
              </div>
            )}
            <div className="settings-group">
            {selectedSettingsSection === 'settings-general' && (
              <SettingsChoice
                icon={<Rocket />}
                label="启动时打开"
                hint="应用启动后先进入的页面"
                value={preferenceDraft.startupRoute}
                options={[{ value: 'home', label: '首页' }, { value: 'library', label: '档案库' }]}
                onChange={(value) => editPreferences({ startupRoute: value as PreferenceSnapshot['startupRoute'] })}
              >
                <PreferenceRadioFallback name="startupRoute" value={preferenceDraft.startupRoute} options={[['home', '首页'], ['library', '档案库']]} onChange={(value) => editPreferences({ startupRoute: value as PreferenceSnapshot['startupRoute'] })} />
              </SettingsChoice>
            )}
            {selectedSettingsSection === 'settings-general' && (
              <SettingsSwitch
                icon={<BookOpen />}
                label="继续阅读显示已读完"
                hint="关闭时隐藏已读完的记录"
                checked={preferenceDraft.continueReadingShowFinished}
                onToggle={() => editPreferences({ continueReadingShowFinished: !preferenceDraft.continueReadingShowFinished })}
              />
            )}
            {selectedSettingsSection === 'settings-general' && (
              <SettingsSwitch
                icon={<Shuffle />}
                label="随机漫游显示已读完"
                hint="关闭时隐藏已读完的档案，并补抽到占满一排"
                checked={preferenceDraft.randomRoamShowFinished}
                onToggle={() => editPreferences({ randomRoamShowFinished: !preferenceDraft.randomRoamShowFinished })}
              />
            )}
            {selectedSettingsSection === 'settings-general' && (
              <SettingsPanel
                icon={<FolderOpen />}
                label="下载目录"
                hint="上传与下载使用的本机目录"
                value={preferenceDraft.downloadDirectory ? '自定义' : '默认'}
              >
                <p className="settings-menu-path is-selectable">{preferenceDraft.downloadDirectory || defaultDownloadHint}</p>
                <div className="settings-menu-actions">
                  <button className="secondary-action" type="button" title="选择下载目录" aria-label="选择下载目录" onClick={() => {
                    void pickDirectory().then((selected) => {
                      if (typeof selected === 'string') editPreferences({ downloadDirectory: selected });
                    }).catch(() => showToast('无法打开目录选择器', 'error'));
                  }}><FolderOpen aria-hidden="true" />选择目录</button>
                  <button className="secondary-action" type="button" title="恢复默认下载目录" aria-label="恢复默认下载目录" disabled={!preferenceDraft.downloadDirectory} onClick={() => editPreferences({ downloadDirectory: '' })}><RotateCcw aria-hidden="true" />恢复默认</button>
                </div>
              </SettingsPanel>
            )}
            </div>
            {selectedSettingsSection === 'settings-general' && (
              /* 缓存的上限与现状单独成组：与下方服务器组同级同款，吃同一道组间距。 */
              <div className="settings-group">
                <SettingsNumber
                  icon={<HardDrive />}
                  label="图片缓存上限"
                  hint="单位 GB，超出后按最近最少使用清理"
                  value={preferenceDraft.cacheMaxBytes / GIB}
                  min={1}
                  max={32}
                  format={(value) => `${value} GB`}
                  onChange={(value) => editPreferences({ cacheMaxBytes: value * GIB })}
                />
                <SettingsPanel
                  icon={<Database />}
                  label="图片缓存"
                  hint="封面、阅读页与模型结果的本地缓存，可随时清理"
                  value={cacheStats ? formatCacheBytes(cacheStats.bytes) : '统计中…'}
                >
                  {cacheStats ? (
                    <>
                      <div className="cache-summary">
                        <div className="cache-summary-total">
                          <strong>{formatCacheBytes(cacheStats.bytes)}</strong>
                          <span>本地已占用</span>
                        </div>
                        {cacheStats.bytes > 0 && (
                          /* Proportions read faster than four byte counts side by side. */
                          <div className="cache-bar" aria-hidden="true">
                            {CACHE_RENDITIONS.map(([kind]) => [kind, cacheStats.byRendition[kind].bytes] as const).filter(([, bytes]) => bytes > 0).map(([kind, bytes]) => (
                              <span
                                key={kind}
                                className={`cache-bar-slice is-${kind}`}
                                style={{ flexGrow: bytes, flexBasis: 0 }}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                      {cacheStats.bytes > 0 && (
                        <div className="cache-breakdown" aria-label="图片缓存明细">
                          {CACHE_RENDITIONS.map(([kind, label]) => cacheStats.byRendition[kind].bytes > 0 && (
                            <span className="cache-breakdown-item" key={kind}>
                              <span className="cache-breakdown-name"><i className={`cache-swatch is-${kind}`} aria-hidden="true" />{label}</span>
                              <b className="cache-breakdown-size">{formatCacheBytes(cacheStats.byRendition[kind].bytes)}</b>
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Clearing sits at the end of its menu: the numbers above are the
                          answer to "what is in there", the button is the answer to "so
                          clean it", and one never shifts the other. */}
                      <div className="settings-menu-actions">
                        <button
                          className="secondary-action"
                          type="button"
                          disabled={cacheClearing}
                          aria-busy={cacheClearing}
                          aria-label="清空图片缓存"
                          title="清空图片缓存"
                          onClick={() => void clearImageCache()}
                        >
                          <Eraser aria-hidden="true" />清空图片缓存
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="settings-menu-desc">正在统计缓存占用…</p>
                  )}
                </SettingsPanel>
              </div>
            )}
            {selectedSettingsSection === 'settings-general' && (
              /* 标签数据（对齐 JHenTai 偏好设置里那两行）：开关决定「用不用」，数据版本
                 写在副标题里，旁边那颗刷新按钮决定「什么时候去拿」——三件事分开，所以
                 关掉中文翻译不会顺手把频次数据也停掉。此前只有数据层与服务开关，设置页
                 里一个字都没有，等于开没开、数据到没到都没人知道。 */
              <div className="settings-group">
                <SettingsSwitch
                  icon={<Languages />}
                  label="标签中文翻译"
                  hint={tagTranslationVersion
                    ? `数据版本 ${formatTagDataVersion(tagTranslationVersion)}`
                    : '标签与补全建议显示中文译名，打开后自动下载数据'}
                  checked={preferenceDraft.tagTranslationEnabled}
                  action={<button
                    className="icon-button"
                    type="button"
                    disabled={tagDataPending !== undefined}
                    aria-busy={tagDataPending === 'translation'}
                    aria-label="更新标签翻译数据"
                    title="更新标签翻译数据"
                    onClick={() => void refreshTagData('translation')}
                  ><RefreshCw aria-hidden="true" /></button>}
                  onToggle={() => setTagDataEnabled('translation', !preferenceDraft.tagTranslationEnabled)}
                />
                <SettingsSwitch
                  icon={<ArrowDownWideNarrow />}
                  label="标签补全排序规则"
                  hint={tagCountVersion
                    ? `数据版本 ${formatTagDataVersion(tagCountVersion)} · 同分内按全站使用频次排序`
                    : '默认智能排序，打开后同分内按全站使用频次排序'}
                  checked={preferenceDraft.tagCountOrderEnabled}
                  action={<button
                    className="icon-button"
                    type="button"
                    disabled={tagDataPending !== undefined}
                    aria-busy={tagDataPending === 'count'}
                    aria-label="更新标签补全排序数据"
                    title="更新标签补全排序数据"
                    onClick={() => void refreshTagData('count')}
                  ><RefreshCw aria-hidden="true" /></button>}
                  onToggle={() => setTagDataEnabled('count', !preferenceDraft.tagCountOrderEnabled)}
                />
              </div>
            )}
            {selectedSettingsSection !== 'settings-general' && (
              <div className="settings-group">
            {selectedSettingsSection === 'settings-reading' && (
              <SettingsChoice
                icon={<BookOpen />}
                label="默认布局"
                hint="打开阅读器时的翻页方式"
                value={preferenceDraft.defaultLayout}
                options={[{ value: 'auto', label: '自动' }, { value: 'single', label: '单页' }, { value: 'double', label: '双页' }, { value: 'webtoon', label: '条漫' }]}
                onChange={(value) => editPreferences({ defaultLayout: value as PreferenceSnapshot['defaultLayout'] })}
              >
                <PreferenceRadioFallback name="layout" value={preferenceDraft.defaultLayout} options={[['auto', '自动'], ['single', '单页'], ['double', '双页'], ['webtoon', '条漫']]} onChange={(value) => editPreferences({ defaultLayout: value as PreferenceSnapshot['defaultLayout'] })} />
              </SettingsChoice>
            )}
            {selectedSettingsSection === 'settings-reading' && (
              <SettingsChoice
                icon={<ArrowLeftRight />}
                label="翻页方向"
                hint="往哪一侧翻是下一页；进入阅读模式时就按这一档"
                value={preferenceDraft.defaultDirection}
                options={[{ value: 'ltr', label: '从左到右' }, { value: 'rtl', label: '从右到左' }]}
                onChange={(value) => editPreferences({ defaultDirection: value as PreferenceSnapshot['defaultDirection'] })}
              >
                <PreferenceRadioFallback name="direction" value={preferenceDraft.defaultDirection} options={[['ltr', '从左到右'], ['rtl', '从右到左']]} onChange={(value) => editPreferences({ defaultDirection: value as PreferenceSnapshot['defaultDirection'] })} />
              </SettingsChoice>
            )}
            {selectedSettingsSection === 'settings-reading' && (
              <SettingsSwitch
                icon={<RotateCcw />}
                label="允许阅读进度回溯"
                hint="回看前面的页时，将续读位置更新为当前页"
                checked={preferenceDraft.allowProgressRegression}
                onToggle={() => editPreferences({ allowProgressRegression: !preferenceDraft.allowProgressRegression })}
              />
            )}
            {selectedSettingsSection === 'settings-reading' && (
              <SettingsChoice
                icon={<Gauge />}
                label="卡片进度条"
                value={preferenceDraft.progressBarVisibility}
                options={[{ value: 'none', label: '不显示' }, { value: 'history', label: '仅历史记录' }, { value: 'all', label: '全部档案' }]}
                onChange={(value) => editPreferences({ progressBarVisibility: value as PreferenceSnapshot['progressBarVisibility'] })}
              />
            )}
            {selectedSettingsSection === 'settings-reading' && (
              <SettingsNumber
                icon={<Layers />}
                label="预加载页数"
                hint="阅读时提前取回的页数，0 表示关闭"
                value={preferenceDraft.prefetchPages}
                min={0}
                max={MAX_PREFETCH_PAGES}
                format={(value) => `${value} 页`}
                onChange={(value) => editPreferences({ prefetchPages: value })}
              />
            )}
            {selectedSettingsSection === 'settings-reading' && (
              <SettingsNumber
                icon={<Images />}
                label="封面并发请求"
                hint="同时下载的封面数量，过大反而会拖慢"
                value={preferenceDraft.coverConcurrency}
                min={1}
                max={8}
                format={(value) => `${value} 个`}
                onChange={(value) => editPreferences({ coverConcurrency: value })}
              />
            )}
            {selectedSettingsSection === 'settings-appearance' && (
              <SettingsChoice
                icon={<Palette />}
                label="主题"
                hint="浅色、深色或跟随系统"
                value={preferenceDraft.theme}
                options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}
                onChange={(value) => editPreferences({ theme: value as PreferenceSnapshot['theme'] })}
              >
                <PreferenceRadioFallback name="theme" value={preferenceDraft.theme} options={[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]} onChange={(value) => editPreferences({ theme: value as PreferenceSnapshot['theme'] })} />
              </SettingsChoice>
            )}
            {selectedSettingsSection === 'settings-appearance' && (
              <SettingsSwitch
                icon={<PanelBottom />}
                label="悬浮底栏"
                hint="底栏变成悬浮胶囊，滚动时自动收起"
                checked={preferenceDraft.floatingNav}
                onToggle={() => editPreferences({ floatingNav: !preferenceDraft.floatingNav })}
              />
            )}
            {selectedSettingsSection === 'settings-appearance' && (
              <SettingsPanel
                icon={<ListChecks />}
                label="底栏项目"
                hint="只影响移动端底栏，没勾的收进「更多」"
                ariaLabel="底栏项目"
                value={`${preferenceDraft.bottomNavItems.length} 项`}
              >
                <CheckRowGroup label="底栏项目">
                  {BOTTOM_NAV_OPTIONS.map(({ key, label }) => {
                    const pinned = key === 'library';
                    return (
                      <CheckRow
                        key={key}
                        label={label}
                        checked={pinned || preferenceDraft.bottomNavItems.includes(key)}
                        locked={pinned}
                        ariaLabel={`底栏显示${label}`}
                        onToggle={() => toggleBottomNavItem(key)}
                      />
                    );
                  })}
                </CheckRowGroup>
              </SettingsPanel>
            )}
            {selectedSettingsSection === 'settings-appearance' && (
              <SettingsPanel
                icon={<Paintbrush />}
                label="自定义"
                hint="基础套用配色，高级可覆盖任意 CSS"
                ariaLabel="自定义"
                value={customValue}
              >
                {/* 两个层级：基础只挑配色，高级保留完整的 CSS 覆盖面。 */}
                <div className="settings-menu-mode" role="group" aria-label="自定义方式">
                  <button type="button" className={`settings-menu-mode-button${appearanceMode === 'basic' ? ' is-active' : ''}`} aria-pressed={appearanceMode === 'basic'} onClick={() => setAppearanceMode('basic')}>基础</button>
                  <button
                    type="button"
                    className={`settings-menu-mode-button${appearanceMode === 'advanced' ? ' is-active' : ''}`}
                    aria-pressed={appearanceMode === 'advanced'}
                    onClick={() => {
                      // 基础层的卡片写进的正是 customCss 这个字段本身（见下面的卡片 onClick），
                      // 所以「选中的那套基础配色」一进高级编辑器就成了一段没人写过的正文。它不
                      // 是用户的 CSS，清掉：高级的框该空着等用户写。用户自己在高级里写的
                      // （不等于任何一套基础配色）保持原样。
                      if (COLOR_SCHEMES.some((scheme) => scheme.css === preferenceDraft.customCss)) editPreferences({ customCss: '' });
                      setAppearanceMode('advanced');
                    }}
                  >高级</button>
                </div>
                {appearanceMode === 'basic' ? (
                  <div className="custom-scheme-grid">
                    {COLOR_SCHEMES.map((scheme) => (
                      <button
                        key={scheme.id}
                        type="button"
                        className={`custom-scheme-card${preferenceDraft.customCss === scheme.css ? ' is-active' : ''}`}
                        aria-pressed={preferenceDraft.customCss === scheme.css}
                        title={scheme.description}
                        onClick={() => editPreferences({ customCss: scheme.css })}
                      >
                        <span className="custom-scheme-swatch" aria-hidden="true">{scheme.swatch.map((color) => <i key={color} style={{ background: color }} />)}</span>
                        <span>{scheme.label}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="custom-css-presets" role="group" aria-label="预设主题">
                      {CSS_THEME_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className={`css-preset-card${preferenceDraft.customCss === preset.css ? ' is-active' : ''}`}
                          aria-pressed={preferenceDraft.customCss === preset.css}
                          title={preset.description}
                          onClick={() => editPreferences({ customCss: preset.css })}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <AutoTextarea
                      name="customCss"
                      aria-label="自定义 CSS"
                      className="is-selectable"
                      spellCheck={false}
                      rows={8}
                      value={preferenceDraft.customCss}
                      onChange={(event) => editPreferences({ customCss: event.target.value })}
                    />
                    <p className="custom-css-count">{preferenceDraft.customCss.length} / 20000</p>
                  </>
                )}
              </SettingsPanel>
            )}
              </div>
            )}
            {/* 收藏删除这两个开关自己一组：它们管的是「删档案时要不要把 E-Hentai 上的
                收藏一起删」，与数据迁移分组显示。放在迁移开关那一组里
                会让人以为它们管的是同步本身，放在最前面又把真正的同步控件挤到了下面。 */}
            {selectedSettingsSection === 'settings-data' && (
              <div className="settings-group">
                <SettingsSwitch
                  icon={<HeartOff />}
                  label="同步删除 E-Hentai 收藏"
                  hint={ehAccountName ? '删除弹窗里可逐次关掉' : '登录 E-Hentai 后才能启用'}
                  checked={preferenceDraft.ehFavoriteDeleteSync}
                  /* 没登录就开不了（要关掉已经打开的仍然可以）。 */
                  disabled={!ehAccountName && !preferenceDraft.ehFavoriteDeleteSync}
                  onToggle={() => editPreferences({ ehFavoriteDeleteSync: !preferenceDraft.ehFavoriteDeleteSync })}
                />
                <SettingsSwitch
                  icon={<ShieldCheck />}
                  label="默认开启收藏同步删除"
                  hint="删除弹窗里的那个开关"
                  checked={preferenceDraft.confirmEhFavoriteDelete}
                  disabled={!preferenceDraft.ehFavoriteDeleteSync}
                  onToggle={() => editPreferences({ confirmEhFavoriteDelete: !preferenceDraft.confirmEhFavoriteDelete })}
                />
              </div>
            )}
            {/* 导入与导出同属「数据迁移」，单独成组：它们与同步开关、账户配置不是一件事。
                必须是同一个 settings-group 的兄弟节点，才能吃到 preferences-form 的组间距。 */}
            {selectedSettingsSection === 'settings-data' && (
              <div className="settings-group">
                <SettingsPanel
                  icon={<FileDown />}
                  label="导出数据"
                  hint="勾选要带走的数据，导出成明文 JSON 文件"
                  value={exportItems.length > 0 ? `${exportItems.length} 类` : '未选择'}
                >
                  {/* 勾选在导出弹层里当场做：没有「范围」偏好要提前配置。勾了凭据类，
                      下面那行提醒与导出完成后的 toast 都会说一次「切勿分享」。
                      两组分开摆：记录与设置是六类可以逐类挑，凭据是另一件事。 */}
                  <CheckRowGroup label="阅读记录与应用设置" caption="阅读记录与应用设置">
                    {DATA_EXPORT_RECORD_ITEMS.map((item) => (
                      <CheckRow
                        key={item.id}
                        label={item.label}
                        checked={exportItems.includes(item.id)}
                        ariaLabel={`导出${item.label}`}
                        onToggle={() => toggleExportItem(item.id)}
                      />
                    ))}
                  </CheckRowGroup>
                  <CheckRowGroup label="服务器与账户凭据" caption="服务器与账户凭据">
                    {DATA_EXPORT_CREDENTIAL_ITEMS.map((item) => (
                      <CheckRow
                        key={item.id}
                        label={item.label}
                        checked={exportItems.includes(item.id)}
                        ariaLabel={`导出${item.label}`}
                        onToggle={() => toggleExportItem(item.id)}
                      />
                    ))}
                  </CheckRowGroup>
                  {exportItems.some(isCredentialItem) && (
                    <p className="form-error" role="alert">勾选的类别包含 API Key、Cookie 等敏感信息：导出文件请妥善保管，切勿分享。</p>
                  )}
                  {/* 只有两颗按钮，而且都自己把文件折出来：从前那颗「导出数据」只把
                      文本塞进框里、既看不到也没别的作用，后两颗还要等它先跑一遍。 */}
                  <div className="settings-menu-actions" role="group" aria-label="数据导出操作">
                    <button className="secondary-action" type="button" disabled={migrationPending || exportItems.length === 0} aria-busy={migrationPending} onClick={() => void saveMigrationToFile()}>
                      <Download aria-hidden="true" />{migrationPending ? '处理中…' : '导出为文件'}
                    </button>
                    <button className="secondary-action" type="button" disabled={migrationPending || exportItems.length === 0} onClick={() => void copyMigrationExport()}>
                      <Copy aria-hidden="true" />复制
                    </button>
                  </div>
                </SettingsPanel>
                <SettingsPanel
                  icon={<FileUp />}
                  label="导入数据"
                  hint="粘贴或选择导出文件，勾选要导入的内容"
                  onClose={() => { setMigrationText(''); setImportAvailable([]); setImportItems([]); }}
                >
                  <form className="legacy-import-form" onSubmit={(event) => { event.preventDefault(); if (importAvailable.length > 0) void runSelectedImport(); else void runMigrationImport(migrationText); }}>
                    <AutoTextarea
                      id="migration-json"
                      name="migrationJson"
                      aria-label="导出 JSON"
                      autoComplete="off"
                      spellCheck={false}
                      value={migrationText}
                      onChange={(event) => { setMigrationText(event.target.value); setImportAvailable([]); }}
                      rows={6}
                    />
                    {importAvailable.length > 0 && (
                      /* 解析后动态生成的勾选框：文件里有什么就列出什么，默认全选。 */
                      <CheckRowGroup label="文件里包含的数据">
                        {importAvailable.map((id) => (
                          <CheckRow
                            key={id}
                            label={dataExportItemLabel(id)}
                            checked={importItems.includes(id)}
                            ariaLabel={`导入${dataExportItemLabel(id)}`}
                            onToggle={() => toggleImportItem(id)}
                          />
                        ))}
                      </CheckRowGroup>
                    )}
                    <div className="settings-menu-actions" role="group" aria-label="数据导入操作">
                      <button className="secondary-action" type="button" disabled={migrationPending} onClick={() => void importMigrationFromFile()}>
                        <FolderOpen aria-hidden="true" />从文件导入
                      </button>
                      {/* 解析出来的新文件先勾选再导入；粘贴的旧格式（同步文档、Readoshi、
                          统一信封、旧偏好）仍由这一颗按钮直接认出来走各自的路。 */}
                      <button className="primary-action" type="submit" disabled={migrationPending || !migrationText.trim() || (importAvailable.length > 0 && importItems.length === 0)} aria-busy={migrationPending}>
                        <FileUp aria-hidden="true" />{migrationPending ? '处理中…' : importAvailable.length > 0 ? '导入所选' : '导入数据'}
                      </button>
                    </div>
                  </form>
                </SettingsPanel>
              </div>
            )}
            {/* 详情页两项单独成组：功能按钮与时间格式都属于「详情页长什么样」，
                与配色等外观微调分开摆放。 */}
            {selectedSettingsSection === 'settings-appearance' && (
              <div className="settings-group">
                <SettingsPanel icon={<ListChecks />} label="详情页功能按钮" hint="选择详情页显示的操作；其他操作仍可从右上角菜单打开" ariaLabel="详情页功能按钮" value={`${preferenceDraft.detailActions.length} 项`}>
                  <CheckRowGroup label="详情页功能按钮">
                    {DETAIL_ACTIONS.map((action) => {
                      const labels = { read: '阅读', readingList: '待看', favorites: '收藏夹', download: '下载', edit: '编辑', clearProgress: '清除阅读进度', delete: '删除' };
                      const included = preferenceDraft.detailActions.includes(action);
                      const locked = action === 'read';
                      return (
                        <CheckRow
                          key={action}
                          label={labels[action]}
                          checked={included}
                          locked={locked}
                          ariaLabel={`详情页显示${labels[action]}`}
                          onToggle={() => editPreferences({ detailActions: DETAIL_ACTIONS.filter((key) => key === action ? !included : preferenceDraft.detailActions.includes(key)) })}
                        />
                      );
                    })}
                  </CheckRowGroup>
                </SettingsPanel>
                <SettingsChoice
                  icon={<CalendarClock />}
                  label="详情页时间"
                  hint="详情页信息栏第四项显示的时间"
                  value={preferenceDraft.detailDateKind}
                  options={[{ value: 'published', label: '发布时间' }, { value: 'added', label: '添加时间' }]}
                  onChange={(value) => editPreferences({ detailDateKind: value as PreferenceSnapshot['detailDateKind'] })}
                >
                  <PreferenceRadioFallback name="detail-date-kind" value={preferenceDraft.detailDateKind} options={[['published', '发布时间'], ['added', '添加时间']]} onChange={(value) => editPreferences({ detailDateKind: value as PreferenceSnapshot['detailDateKind'] })} />
                </SettingsChoice>
              </div>
            )}
            {/* SFW 单独成组：内容保护开关不与外观微调混在一起，置底独立可辨。 */}
            {selectedSettingsSection === 'settings-appearance' && (
              <div className="settings-group">
                <SettingsSwitch
                  icon={<EyeOff />}
                  label="SFW 模式"
                  hint="封面模糊显示，悬停或点击可临时看清"
                  checked={preferenceDraft.sfwMode}
                  onToggle={() => editPreferences({ sfwMode: !preferenceDraft.sfwMode })}
                />
              </div>
            )}
            {/* 高级区的模型导入单独置底。 */}
            {/* 算力中心两组：本机对外提供算力 + 把一页交给远端算。两边的设置互不
                影响；「作为算力中心」那一组在能力齐全前是关着的（后端也会拦一次）。 */}
            {selectedSettingsSection === 'settings-advanced' && (
              <ComputeCenterSettingsGroup
                preferences={preferenceDraft}
                editPreferences={editPreferences}
                mobile={platformName === 'android' || platformName === 'ios'}
              />
            )}
            {/* DLSSNR：只在 Windows 桌面、支持系列的 N 卡且这个构建有 NGX 核心时
                才画出来（组件自己按 status 判断；还没装片段的机器正是来挑一种下载的）。 */}
            {selectedSettingsSection === 'settings-advanced' && (
              <DlssnrSettingsGroup preferences={preferenceDraft} editPreferences={editPreferences} visible={platformName === 'windows'} />
            )}
            {selectedSettingsSection === 'settings-advanced' && (
              <div className="settings-group">
                <SettingsSwitch
                  icon={<UpscaleIcon enabled={upscaleOn} />}
                  label="启用超分"
                  /* 模型还没读出来时说「正在读取」，读完才回答有没有——不然一行人
                     打开页面就被告知「尚未安装」，而它只是还没查到。 */
                  hint={installedModels === undefined ? '正在读取模型…' : upscaleReady ? '用超分模型放大阅读画面' : '尚未安装可用的超分模型'}
                  checked={upscaleOn}
                  disabled={!modelsVerified}
                  onToggle={() => {
                    if (upscaleOn) { editPreferences({ upscaleBackend: 'off' }); return; }
                    if (!upscaleReady) { showToast('超分模型未安装，无法启用', 'error'); return; }
                    // 开启时默认选谁：仍是**已装的第一个**（旧行为）。列表现在按内置优先
                    // 排，拿列表头当兜底会顺手改掉这个默认——那是另一件事（用户 2026-10-18
                    // 只要求把 anime4k / waifu2x 排到上面，没要求换默认模型）。
                    editPreferences({ upscaleBackend: 'auto', upscaleModel: preferenceDraft.upscaleModel || runnableModels[0]?.id || upscaleModelOptions[0]!.value });
                  }}
                />
                <SettingsRow
                  icon={<ImageUpscale />}
                  label={<>超分模型{outdatedUpscaleIds.size > 0 && <span className="settings-row-mark">有更新</span>}</>}
                  ariaLabel="超分模型"
                  value={upscaleModelOptions.find((option) => option.value === selectedUpscaleFamily)?.label}
                  onClick={() => setUpscaleMenu('models')}
                  expanded={upscaleMenu !== undefined}
                />
                {upscaleMenu && <SettingsMenu
                  title={upscaleMenu === 'models' ? '超分模型' : 'Real-CUGAN 设置'}
                  icon={upscaleMenu === 'models' ? <ImageUpscale /> : <Settings2 />}
                  onClose={closeUpscaleMenu}
                  onBack={upscaleMenu !== 'models' ? () => setUpscaleMenu('models') : undefined}
                  backLabel="返回模型列表"
                >
                  {upscaleMenu === 'models' ? <div className="settings-choice-list">
                    {upscaleModelOptions.map((option) => {
                      const id = familyModel(option.value);
                      const installed = runnableModels.some((model) => upscaleFamily(model.id) === option.value);
                      const downloaded = installed && !BUILT_IN_HEAD.includes(option.value);
                      return <SettingsOption key={option.value} active={option.value === selectedUpscaleFamily}
                        disabled={modelPending} onClick={() => { editPreferences({ upscaleModel: id }); closeUpscaleMenu(); }}
                        action={<>
                          {modelDownloadAction(id, option.label)}
                          {downloaded && option.value === 'realcugan' && <button className="select-option-download" type="button" aria-label={`设置${option.label}`} title="模型设置" disabled={modelPending} onClick={() => { setConfirmRemoveModel(undefined); setUpscaleMenu('realcugan'); }}><Settings2 aria-hidden="true" /></button>}
                          {downloaded && <button className={`select-option-download${confirmRemoveModel === option.value ? ' is-danger' : ''}`} type="button" aria-label={`${confirmRemoveModel === option.value ? '确认删除' : '删除'}${option.label}`} title={confirmRemoveModel === option.value ? '确认删除模型' : '删除模型'} disabled={modelPending} onClick={() => void removeModelFamily(option.value, option.label)}>{confirmRemoveModel === option.value ? <Check aria-hidden="true" /> : <Trash2 aria-hidden="true" />}</button>}
                        </>}
                        status={modelDownloadStatus(id, option.label)}
                      ><span>{option.label}</span></SettingsOption>;
                    })}
                  </div> : <>
                    <div className="settings-parameter-row">
                      <span className="settings-parameter-label"><SlidersHorizontal aria-hidden="true" />降噪力度</span>
                      <div className="settings-parameter-options" role="group" aria-label="降噪力度">
                        {CUGAN_VARIANTS.map((variant) => <button
                          type="button" key={variant.value}
                          className={variant.value === familyModel('realcugan') ? 'is-active' : ''}
                          aria-pressed={variant.value === familyModel('realcugan')}
                          disabled={modelPending || !runnableModels.some((model) => model.id === variant.value)}
                          onClick={() => editPreferences({ upscaleModel: variant.value })}
                        >{variant.label}</button>)}
                      </div>
                    </div>
                    {CUGAN_VARIANTS.some((variant) => !runnableModels.some((model) => model.id === variant.value) || outdatedUpscaleIds.has(variant.value)) && <div className="settings-choice-list">
                      {CUGAN_VARIANTS.filter((variant) => !runnableModels.some((model) => model.id === variant.value) || outdatedUpscaleIds.has(variant.value)).map((variant) => <SettingsOption key={variant.value}
                        disabled={modelPending} onClick={() => void downloadModel(variant.value, `Real-CUGAN · ${variant.label}`)}
                        action={modelDownloadAction(variant.value, `Real-CUGAN · ${variant.label}`)}
                        status={modelDownloadStatus(variant.value, variant.label)}
                      ><span>{variant.label}</span></SettingsOption>)}
                    </div>}
                  </>}
                </SettingsMenu>}
                <SettingsChoice
                  icon={<WandSparkles />}
                  label="自动开启超分"
                  hint="按标签规则与图片体积决定是否自动开启"
                  value={preferenceDraft.upscaleAutoEnable ? preferenceDraft.upscaleAutoTagMode : 'off'}
                  options={[{ value: 'off', label: '关闭' }, { value: 'whitelist', label: '仅白名单' }, { value: 'blacklist', label: '排除黑名单' }]}
                  onChange={(value) => editPreferences({ upscaleAutoEnable: value !== 'off', upscaleAutoTagMode: value === 'blacklist' ? 'blacklist' : 'whitelist' })}
                />
                <SettingsNumber
                  icon={<Gauge />}
                  label="超分开启阈值"
                  hint="平均每页体积，单位 KB"
                  value={Math.round(preferenceDraft.upscaleAutoThresholdBytes / 1024)}
                  min={64}
                  max={8192}
                  step={64}
                  format={(value) => `${value} KB`}
                  disabled={!preferenceDraft.upscaleAutoEnable}
                  onChange={(value) => editPreferences({ upscaleAutoThresholdBytes: Math.round(value * 1024) })}
                />
                {preferenceDraft.upscaleAutoEnable && (preferenceDraft.upscaleAutoTagMode === 'whitelist'
                  ? <SettingsPanel icon={<Tags />} label="自动超分白名单" hint="每行一个标签；仅匹配的档案会自动开启" value={preferenceDraft.upscaleAutoWhitelist.trim() ? '已设置' : '无'}>
                    <AutoTextarea className="settings-rule-list" aria-label="自动超分白名单" value={preferenceDraft.upscaleAutoWhitelist} onChange={(event) => editPreferences({ upscaleAutoWhitelist: event.target.value })} spellCheck={false} rows={5} />
                  </SettingsPanel>
                  : <SettingsPanel icon={<EyeOff />} label="自动超分黑名单" hint="每行一个标签；匹配的档案不会自动开启" value={preferenceDraft.upscaleAutoBlacklist.trim() ? '已设置' : '无'}>
                    <AutoTextarea className="settings-rule-list" aria-label="自动超分黑名单" value={preferenceDraft.upscaleAutoBlacklist} onChange={(event) => editPreferences({ upscaleAutoBlacklist: event.target.value })} spellCheck={false} rows={5} />
                  </SettingsPanel>)}
              </div>
            )}
            {selectedSettingsSection === 'settings-advanced' && (
              <div className="settings-group">
                {/* 单按钮的设置不值得一个二级菜单：导入动作就在行右侧。
                    按钮里画一个"档案盒 + 上传箭头"的专属图标——这行的语义
                    （导入模型包）是 Upload 箭头说不完整的。 */}
                <SettingsRow
                  icon={<Upload />}
                  label="模型导入"
                  hint="导入超分模型或 DLSSNR DLL；DLL 验证仅覆盖本机测试尺寸"
                  control={
                    <button className="secondary-action" type="button" disabled={modelPending} aria-busy={modelPending} title="导入模型文件或压缩包" onClick={() => void pickModelFile().then((selected) => { if (selected) void importModelFromPath(selected); })}>
                      <svg className="model-import-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" />
                        <path d="M12 3v12" />
                        <path d="m7 8 5-5 5 5" />
                        <path d="M8 15h8" />
                      </svg>
                      {dllValidating ? '正在验证 DLL…' : modelPending ? '导入中…' : '选择模型文件…'}
                    </button>
                  }
                />
              </div>
            )}
            {/* The server list keeps its own live region and its own group of rows:
                each row opens the same setup dialog the add row does. */}
            {selectedSettingsSection === 'settings-general' && (
              <div className="settings-group server-region" role="region" aria-label="服务器" aria-live="polite">
                {loading && servers.length === 0 && <ContentSkeleton label="正在读取服务器" rows={2} />}
                {!loading && loadError && (
                  <div className="server-list-error">
                    <p className="form-error" role="alert">{loadError}</p>
                    {loadRetryable && (
                      <button className="secondary-action" type="button" onClick={() => setServerLoadAttempt((attempt) => attempt + 1)}>
                        <RefreshCw aria-hidden="true" />
                        重试读取服务器
                      </button>
                    )}
                  </div>
                )}
                {servers.map((server) => (
                  <div className="settings-item server-row" key={server.id}>
                    <ServerSetupDialog variant="row" onSave={saveServer} server={server} onDelete={() => deleteServer(server)} />
                    {/* 一次只允许启用一台：首页、书架与档案库的数据源就是它
                        （当前标记跟在名字旁）。已启用的行不可再关（停用最后一
                        台会让应用没有数据源），所以只有未启用的行有启用按钮。 */}
                    {!server.enabled && (
                      <button
                        className="server-current-toggle"
                        type="button"
                        aria-pressed={false}
                        title="设为启用的服务器"
                        onClick={() => void enableServer(server)}
                      >启用</button>
                    )}
                  </div>
                ))}
                {/* The add row stays through a failed load: re-entering the
                    credentials is one of the ways to answer that error. */}
                <div className="settings-item">
                  <ServerSetupDialog variant="row" onSave={saveServer} />
                </div>
              </div>
            )}
          </div>
        )}
      </section>
      )}
      {selectedSettingsSection === 'settings-eh' && (
      /* The whole E-Hentai workspace — login modes, account list, cookie export —
         is one setting's second level: the row reports the active account, the
         floating menu holds the work. */
      <section className="settings-section" id="settings-eh" aria-label="E-Hentai">
        <div className="settings-group">
          <SettingsPanel icon={<EhMark size={20} plate={false} />} label="E-Hentai 账户" value={ehAccountName ?? '未登录'} ariaLabel="E-Hentai 账户">
            <EhRouteWorkspace onActiveAccountChange={setEhAccountName} />
          </SettingsPanel>
          <SettingsSwitch
            icon={<Tags />}
            label="我的标签"
            hint="这些标签在卡片与详情页优先靠左显示"
            disabled={!ehAccountName}
            checked={preferenceDraft.ehMyTagsPriority && Boolean(ehAccountName)}
            onToggle={() => editPreferences({ ehMyTagsPriority: !preferenceDraft.ehMyTagsPriority })}
          />
        </div>
      </section>
      )}
      {selectedSettingsSection === 'settings-security' && <SecuritySettings />}
      {selectedSettingsSection === 'settings-about' && (
      /* What an About page is for: what this is, who made it, where it lives and
         under what terms. It used to list the data directory, where server
         credentials are kept and the current cache size — three answers to
         questions nobody opens this page to ask, and the last one is in 高级 where
         it can actually be cleared. Same row shape as every other section, so the
         page reads as one list instead of a hero plus a definition list. */
      <section className="settings-section settings-about" id="settings-about" aria-label="关于">
        <div className="settings-group">
          <SettingsRow
            icon={<YomikaMark size={20} />}
            label="Yomika"
            hint="本地漫画阅读器"
            value={`v${APP_VERSION}`}
            trailing="none"
          />
          {APP_AUTHOR && <SettingsRow icon={<User />} label="开发者" value={APP_AUTHOR} trailing="none" />}
          {/* Absent until the project declares one in package.json. Better a
              missing row than a licence the app made up on its behalf. */}
          <AboutDetails />
          <SettingsRow icon={<BookOpenText />} label="LANraragi 文档" hint="在浏览器中打开 LANraragi 的使用文档" trailing="nav" onClick={() => void openAboutLink('https://sugoi.gitbook.io/lanraragi')} />
          {/* 错误日志是这一组里的一行（行上是状态，点开才是记录）：必须留在组框里，
              挂到框外面它就没有容器了。 */}
          <ErrorLogSetting />
          {/* 仓库地址放在这一组的最后一行。 */}
          {APP_REPOSITORY && (
            <SettingsRow icon={<Github />} label="仓库地址" hint={APP_REPOSITORY_DISPLAY} trailing="nav" onClick={() => void openAboutLink(APP_REPOSITORY)} />
          )}
        </div>
      </section>
      )}
      {selectedSettingsSection === 'settings-tools' && (
      <section className="settings-section" id="settings-tools" aria-label="工具">
        <div className="settings-group">
          {/* Rows, not cards: each one says what it does, then navigates — the
              operation here is a route, so it happens on the row itself. */}
          <SettingsRow icon={<Upload />} label="上传档案" hint="把本机压缩包传给 LANraragi，可批量选择" trailing="nav" to="/tools/upload" />
          <SettingsRow icon={<CopyCheck />} label="重复档案查重" hint="按内容比对整个库，逐组确认后删除" trailing="nav" to="/tools/dedup" />
        </div>
      </section>
      )}
        </div>
        )}
      </div>
    </div>
  );
}
