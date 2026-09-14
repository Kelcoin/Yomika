import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowLeft, ArrowLeftRight, Blocks, BookOpen, Brush, ChevronDown, ChevronRight, Copy,
  CopyCheck, Database, Download, Eraser, EyeOff, FileDown, FileUp, FolderOpen, Grid2x2, HardDrive,
  HeartOff, ImageUpscale, Images, Info, Github, KeyRound, Layers, ListChecks, Lock, Check, Minus,
  Paintbrush, Palette, PanelBottom, Plus, RefreshCw, Rocket, RotateCcw, Scale, Scan, ShieldCheck,
  SlidersHorizontal, Sparkles, Tags, Upload, User, Wand2, WandSparkles, BookOpenText, Waypoints,
} from 'lucide-react';
import { pickDirectory } from '../bridge/filePicker';
import { getPlatformCapabilities } from '../bridge/platform';
import { writeClipboardText } from '../bridge/clipboard';
import { EhRouteWorkspace } from './EhRouteWorkspace';
import { accountDisplayName } from './EhAccountPanel';
import { useToast } from './Toast';
import { YomikaMark } from './YomikaMark';
import { EhMark } from './EhMark';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { useSyncSettings } from './SyncWorkspace';

import type { ServerRecord } from '../domain/library';
import type { ServerIdentity } from '../domain/server';
import type { CommandResult } from '../domain/result';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeLegacyRepository } from '../repositories/nativeLegacyRepository';
import { ServerSetupDialog } from './ServerSetupDialog';
import { TextInputDialog } from './TextInputDialog';
import { usePreferences } from '../app/preferences';
import { buildMigrationExport, parseMigrationExport } from '../lib/dataMigration';
import { readoshiServerScope } from '../lib/readoshiScope';
import { invalidateRouteCache } from '../lib/routeCache';
import { COLOR_SCHEMES, CSS_THEME_PRESETS } from '../lib/cssThemePresets';
import { NativeCacheRepository, type CacheStats } from '../repositories/nativeCacheRepository';
import { NativeDedupRepository, type DedupPairInput } from '../repositories/nativeDedupRepository';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { NativeInferenceRepository, type InstalledModel } from '../repositories/nativeInferenceRepository';
import { DETAIL_ACTIONS, MAX_PREFETCH_PAGES, PreferenceSnapshotSchema } from '../repositories/nativeSettingsRepository';
import { openExternalUrl } from '../bridge/externalUrl';

function PreferenceRadioFallback({ name, value, options, onChange }: { name: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <div className="select-compat-radios" aria-hidden="false">{options.map(([option, label]) => <label key={option}><input type="radio" name={`${name}-compat`} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{label}</span></label>)}</div>;
}

/* ---- The two containers every setting is made of -------------------------- */
/* One group frame per section, one row shape per setting. The row carries no
 * control at all: an icon, the name and its hint on the left, the current value
 * on the right, and the whole strip opens the floating menu where the actual
 * control lives — the same secondary surface for every kind of setting, which
 * is what keeps the panel a list instead of a stack of one-off forms. */

/** The floating menu a row opens. One masked sheet for every kind of control —
 * switches, steppers, option lists, text areas — so the second level always
 * reads as the same thing, wherever it was opened from. Escape belongs to the
 * menu wherever the focus is: it can be lost to the row behind it, and a menu
 * that only answers a focused Escape is a trap. */
function SettingsMenu({ title, description, onClose, children }: { title: string; description?: string | undefined; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <div className="settings-choice-overlay" role="presentation" onClick={onClose}>
      <div
        className="settings-choice-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
      >
        <h2 className="settings-choice-title">{title}</h2>
        {description && <p className="settings-menu-desc">{description}</p>}
        <div className="settings-menu-body">{children}</div>
      </div>
    </div>
  );
}

/** One setting row. A plain value row when there is nothing to open; a button
 * that opens a floating menu otherwise. Nothing in the row is shaped like a
 * field — choosing happens in the menu. */
function SettingsRow({ icon, label, hint, value, trailing = 'menu', onClick, ariaLabel, expanded, busy, disabled }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  value?: string | undefined;
  trailing?: 'menu' | 'nav' | 'none';
  onClick?: (() => void) | undefined;
  ariaLabel?: string | undefined;
  expanded?: boolean | undefined;
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  const row = onClick ? (
    <button
      className="settings-row settings-row-button"
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-busy={busy}
    >
      <SettingsRowBody icon={icon} label={label} hint={hint} value={value} trailing={trailing} />
    </button>
  ) : (
    <div className="settings-row">
      <SettingsRowBody icon={icon} label={label} hint={hint} value={value} trailing={trailing} />
    </div>
  );
  return <div className="settings-item">{row}</div>;
}

function SettingsRowBody({ icon, label, hint, value, trailing }: { icon?: ReactNode; label: string; hint?: string | undefined; value?: string | undefined; trailing: 'menu' | 'nav' | 'none' }) {
  return (
    <>
      {icon && <span className="settings-row-icon" aria-hidden="true">{icon}</span>}
      <span className="settings-row-copy">
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
      <span className="settings-row-control settings-row-value">
        {value && <span>{value}</span>}
        {trailing === 'menu' && <ChevronDown aria-hidden="true" />}
        {trailing === 'nav' && <ChevronRight aria-hidden="true" />}
      </span>
    </>
  );
}

/** A setting whose answer is one of a few. */
function SettingsChoice({ icon, label, hint, ariaLabel, value, options, onChange, optionAction, children }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  ariaLabel?: string | undefined;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  optionAction?: ((option: { value: string; label: string }) => ReactNode) | undefined;
  /** The hidden compat input the tests and the old markup rely on. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <>
      <SettingsRow icon={icon} label={label} hint={hint} value={selected?.label} onClick={() => setOpen(true)} ariaLabel={ariaLabel ?? label} expanded={open} busy={!selected} />
      {children}
      {open && (
        <SettingsMenu title={ariaLabel ?? label} onClose={() => setOpen(false)}>
          <div className="settings-choice-list">
            {options.map((option) => (
              <div className={`settings-choice-option${option.value === value ? ' is-active' : ''}`} key={option.value}>
                <button type="button" className="settings-choice-option-main" onClick={() => { onChange(option.value); setOpen(false); }}>
                  <span>{option.label}</span>
                </button>
                {optionAction?.(option)}
              </div>
            ))}
            {options.length === 0 && <p className="settings-choice-empty">暂无可选项</p>}
          </div>
        </SettingsMenu>
      )}
    </>
  );
}

/** A yes/no setting. A switch has no second level to open: the drawn switch
 * sits in the row itself, on the right where every other value lives, and
 * flipping it is the whole interaction. */
function SettingsSwitch({ icon, label, hint, checked, disabled, onToggle }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
  onToggle: () => void;
}) {
  return (
    <div className={`settings-row settings-switch-row${disabled ? ' is-disabled' : ''}`}>
      {icon && <span className="settings-row-icon" aria-hidden="true">{icon}</span>}
      <span className="settings-row-copy">
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
      <button className="switch-control" type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={onToggle}><span /></button>
    </div>
  );
}

/** A numeric setting, edited with a stepper around the same input the old rows
 * used. Half-typed values still pass through untouched: autosave, not the
 * stepper, decides what is valid. */
function SettingsNumber({ icon, label, hint, value, min, max, step = 1, format, onChange }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: ((value: number) => string) | undefined;
  onChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <>
      <SettingsRow icon={icon} label={label} hint={hint} value={format ? format(value) : String(value)} onClick={() => setOpen(true)} ariaLabel={label} expanded={open} />
      {open && (
        <SettingsMenu title={label} description={hint} onClose={() => setOpen(false)}>
          <div className="settings-menu-stepper">
            <button className="icon-action" type="button" aria-label={`减小${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}><Minus aria-hidden="true" /></button>
            <input
              className="settings-number"
              aria-label={label}
              type="number"
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={(event) => onChange(Number(event.target.value))}
            />
            <button className="icon-action" type="button" aria-label={`增大${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}><Plus aria-hidden="true" /></button>
          </div>
        </SettingsMenu>
      )}
    </>
  );
}

/** A setting edited through an arbitrary block of controls — text areas, file
 * pickers, cache reports. */
function SettingsPanel({ icon, label, hint, value, ariaLabel, onClose, children }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  value?: string | undefined;
  ariaLabel?: string | undefined;
  /** Runs when the menu closes, by Escape, an outside click or the row again —
   * a draft that only meant something inside the menu dies with it. */
  onClose?: (() => void) | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); onClose?.(); };
  return (
    <>
      <SettingsRow icon={icon} label={label} hint={hint} value={value} onClick={() => setOpen(true)} ariaLabel={ariaLabel ?? label} expanded={open} />
      {open && (
        <SettingsMenu title={ariaLabel ?? label} description={hint} onClose={close}>
          {children}
        </SettingsMenu>
      )}
    </>
  );
}

import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';

const repository = new NativeLibraryRepository();
const legacyRepository = new NativeLegacyRepository();
const dedupRepository = new NativeDedupRepository();
const cacheRepository = new NativeCacheRepository();
const inferenceRepository = new NativeInferenceRepository();
const GIB = 1_073_741_824;
const CACHE_RENDITIONS = [
  ['cover', '封面'],
  ['page-thumbnail', '页缩略图'],
  ['reader-page', '阅读页'],
  ['enhanced', '超分结果'],
  ['decensored', '去码结果'],
  ['inference', '推理缓存'],
  ['other', '其他'],
] as const;
/** Vite inlines this at build time from package.json, so the About page cannot
 * drift from the shipped version the way a hand-written string would. */
const APP_VERSION = __APP_VERSION__;
const APP_AUTHOR = __APP_AUTHOR__;
const APP_LICENSE = __APP_LICENSE__;
/** Shown on the About page and opened in the browser; trimmed for display. */
const APP_REPOSITORY = __APP_REPOSITORY__;
const APP_REPOSITORY_DISPLAY = APP_REPOSITORY.replace(/^https?:\/\//, '').replace(/\/$/, '');

function formatCacheBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${index === 0 ? amount.toFixed(0) : amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')} ${units[index]}`;
}

/** Keep the selector compact: version and scale are implementation metadata. */
function modelOption(model: InstalledModel): { value: string; label: string } {
  if (model.kind === 'decensor') return { value: model.id, label: model.id === 'aletheia-lens' ? 'Aletheia Lens' : model.id.replaceAll('-', ' ') };
  const names: Record<string, string> = { 'waifu2x-upconv7': 'waifu2x', 'aletheia-lens': 'Aletheia Lens', 'realesr-general-x4v3': 'Real-ESRGAN', 'realesr-general': 'Real-ESRGAN', '4x-Fatal-Pixels': 'Fatal Pixels', anime4k: 'Anime4K', 'anime4k-hq': 'Anime4K' };
  const name = names[model.id] ?? model.id.replaceAll('-', ' ');
  return { value: model.id, label: name };
}

/** The compact bar's selectable entries, in display order; 档案库与设置由
 * 偏好规范化与 UI 双重固定，始终显示。 */
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

const DECENSOR_COMPONENT_IDS = ['mrcnn', 'deepcreampy-bar', 'deepcreampy-mosaic', 'fatal-pixels'] as const;const DECENSOR_STAGE_META: Record<(typeof DECENSOR_COMPONENT_IDS)[number], { role: string; name: string; icon: ReactNode }> = {
  mrcnn: { role: '遮挡区域检测', name: 'Mask R-CNN', icon: <Scan /> },
  'deepcreampy-bar': { role: '条状遮挡修补', name: 'DeepCreamPy Bar', icon: <Brush /> },
  'deepcreampy-mosaic': { role: '马赛克修补', name: 'DeepCreamPy Mosaic', icon: <Grid2x2 /> },
  'fatal-pixels': { role: '修复结果增强', name: 'Fatal Pixels', icon: <WandSparkles /> },
};

function decensorStageOptions(models: InstalledModel[] | undefined, componentId: string) {
  return (models ?? [])
    .filter((model) => model.kind === 'decensor' && model.components.some((component) => component.id === componentId))
    .map((model) => {
      const component = model.components.find((item) => item.id === componentId);
      // 组件名即流程角色，版本号（多为 "1"）只会读成「点 1」，不再拼接。
      return { value: model.id, label: component?.name ?? model.id };
    });
}

function hasCompleteDecensorBundle(model: InstalledModel | undefined): boolean {
  if (!model || model.kind !== 'decensor') return false;
  const installed = new Set(model.components.map((component) => component.id));
  return DECENSOR_COMPONENT_IDS.every((id) => installed.has(id));
}

/** Settings are split by workflow so everyday controls stay separate from
 * visual preferences, synchronization, and model tooling. */
const settingsSections = [
  { id: 'settings-general', label: '通用', hint: '启动页面、下载目录与缓存', icon: <SlidersHorizontal /> },
  { id: 'settings-reading', label: '阅读', hint: '布局、方向与翻页方式', icon: <BookOpen /> },
  { id: 'settings-appearance', label: '样式', hint: '主题、配色与自定义 CSS', icon: <Palette /> },
  { id: 'settings-eh', label: 'E-Hentai', hint: '账户登录与 Cookie 管理', icon: <EhMark /> },
  { id: 'settings-sync', label: '同步', hint: 'WebDAV 同步与数据迁移', icon: <RefreshCw /> },
  { id: 'settings-advanced', label: '高级', hint: '超分与去码模型', icon: <Sparkles /> },
  { id: 'settings-tools', label: '工具', hint: '上传、导入与查重工作台', icon: <Blocks /> },
  { id: 'settings-about', label: '关于', hint: '版本信息与项目来源', icon: <Info /> },
] as const;

/** Sections whose content lives inside the single preferences form. */
const PREFERENCE_SECTIONS = ['settings-general', 'settings-reading', 'settings-appearance', 'settings-advanced', 'settings-sync'] as const;

/** The sections no longer print their own title, so the accessible name for a
 * panel comes from the same list the sidebar is built from. */
function sectionLabel(id: string): string {
  return settingsSections.find((section) => section.id === id)?.label ?? '设置';
}

export function SettingsWorkspace() {
  const location = useLocation();
  const { showToast } = useToast();
  const preferenceState = usePreferences();
  const [preferenceDraftOverride, setPreferenceDraft] = useState<PreferenceSnapshot>();
  const preferenceDraft = preferenceDraftOverride ?? preferenceState.preferences;
  const [preferenceMessage, setPreferenceMessage] = useState<string>();
  const [preferenceError, setPreferenceError] = useState(false);
  const [migrationText, setMigrationText] = useState('');
  const [migrationPending, setMigrationPending] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState<string>();
  const [migrationError, setMigrationError] = useState(false);
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
  const [cacheStats, setCacheStats] = useState<CacheStats>();
  const [cacheClearing, setCacheClearing] = useState(false);
  const openAboutLink = async (url: string) => {
    const result = await openExternalUrl(url);
    if (!result.ok) showToast(result.error.message, 'error');
  };
  const [modelPending, setModelPending] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  /** WebDAV state for the 同步 rows, loaded only while that section is shown. */
  const sync = useSyncSettings(selectedSettingsSection === 'settings-sync');
  /** The E-Hentai row's current value: the active account, reported by the
   * workspace that owns the list. The workspace lives inside the row's menu, so
   * it only mounts when the menu opens — without a section-level fetch the
   * closed row would say 未登录 about an account that is signed in. */
  const [ehAccountName, setEhAccountName] = useState<string>();
  useEffect(() => {
    if (selectedSettingsSection !== 'settings-eh') return;
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

  const [installedModels, setInstalledModels] = useState<InstalledModel[]>();
  // A model with no recorded scale cannot be run, so it is not a choice; nor is a
  // de-censoring bundle, which is not an upscaler.
  const runnableModels = installedModels?.filter((model) => model.scale && model.kind === 'upscale');
  /** One switch each, derived from what is stored rather than stored separately:
   * a second boolean would be one more thing to keep in step with the model it
   * points at. Off is the backend being off, and no bundle chosen. */
  const upscaleOn = preferenceDraft.upscaleBackend !== 'off' && Boolean(runnableModels?.length);
  const decensorOn = preferenceDraft.decensorModel !== '' && hasCompleteDecensorBundle(
    installedModels?.find((model) => model.id === preferenceDraft.decensorModel),
  );
  const decensorBundles = installedModels?.filter((model) => model.kind === 'decensor');
  const selectedDecensorBundle = decensorBundles?.find((model) => model.id === (preferenceDraft.decensorModel || decensorBundles[0]?.id)) ?? decensorBundles?.[0];
  const decensorReady = hasCompleteDecensorBundle(selectedDecensorBundle);
  const upscaleReady = Boolean(runnableModels?.length);
  const upscaleModelOptions = runnableModels?.length ? runnableModels.map(modelOption) : [{ value: 'waifu2x-upconv7', label: 'waifu2x' }];
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
    if (migrationMessage) showToast(migrationMessage, migrationError ? 'error' : 'success');
  }, [migrationError, migrationMessage, showToast]);
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
    if (selectedSettingsSection !== 'settings-advanced' || installedModels) return;
    void inferenceRepository.listModels().then((result) => {
      setInstalledModels(result.ok ? result.value : []);
      if (!result.ok) showToast(result.error.message, 'error');
    });
  }, [installedModels, selectedSettingsSection, showToast]);

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
    if (models.ok) setInstalledModels(models.value);
  }

  async function importModelFile(file: File) {
    setModelPending(true);
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const result = await inferenceRepository.importModelFile(bytes, file.name);
      if (!result.ok) { showToast(result.error.message, 'error'); return; }
      showToast(`模型已导入：${modelOption(result.value).label}`, 'success');
      await refreshModels();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '模型导入失败', 'error');
    } finally { setModelPending(false); }
  }

  async function downloadModel(modelId: string) {
    setModelPending(true);
    try {
      const result = await inferenceRepository.downloadDefaultModel(modelId);
      if (result.ok) { showToast('模型下载完成', 'success'); await refreshModels(); }
      else showToast(result.error.message, 'error');
    } finally { setModelPending(false); }
  }

  /** 默认下载目录的描述按运行平台给出准确位置（Windows 便携版在 exe 同目录）。 */
  const defaultDownloadHint = useMemo(() => {
    switch (platformName) {
      case 'windows': return '默认数据目录：程序所在目录的 data\\downloads';
      case 'macos': return '默认数据目录：~/Library/Application Support/app.yomika.reader/downloads';
      case 'linux': return '默认数据目录：~/.local/share/app.yomika.reader/downloads';
      default: return '默认数据目录下的 downloads 文件夹';
    }
  }, [platformName]);


  /** One control pair for both payload shapes: a unified export (the worker
   * envelope) goes to the native importer, anything else is treated as a legacy
   * preferences blob. */
  async function runMigrationImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMigrationPending(true);
    setMigrationMessage(undefined);
    setMigrationError(false);
    const parsed = parseMigrationExport(migrationText);
    if (parsed.kind === 'invalid') {
      setMigrationMessage(parsed.reason);
      setMigrationError(true);
      setMigrationPending(false);
      return;
    }
    if (parsed.kind === 'legacy') {
      const result = await preferenceState.importLegacy(migrationText.trim());
      if (result.ok) {
        setPreferenceDraft(result.value.preferences);
        setMigrationText('');
        setMigrationMessage(`已导入 ${result.value.importedCount} 项偏好设置`);
        // 首页书架的快照（90 秒内不重取）会盖住刚导入的数据，导入后立刻失效。
        invalidateRouteCache('home:');
      } else {
        setMigrationMessage(result.error.message);
        setMigrationError(true);
      }
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
        setMigrationMessage('导出属于其他 LANraragi 服务器（指纹 ' + payload.serverScope + '），先在设置中添加该服务器再导入');
        setMigrationError(true);
        setMigrationPending(false);
        return;
      }
      const result = await legacyRepository.importWorkerExport(target.scopeId, payload);
      if (!result.ok) {
        setMigrationMessage(result.error.message);
        setMigrationError(true);
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
      setMigrationMessage(
        `已导入：阅读 ${result.value.history} · 待看 ${result.value.watchlist} · 重复关系 ${dedupePairs}` +
        (removed ? `（${removed}）` : '') +
        (skipped ? `，跳过 ${skipped} 条异常记录` : '') +
        dedupeNote,
      );
      invalidateRouteCache('home:');
      setMigrationPending(false);
      return;
    }
    const scopeId = parsed.payload.scopeId || servers[0]?.scopeId;
    if (!scopeId) {
      setMigrationMessage('导出内容没有数据范围，且本机尚未配置服务器');
      setMigrationError(true);
      setMigrationPending(false);
      return;
    }
    const result = await legacyRepository.importExport(scopeId, migrationText.trim());
    if (result.ok) {
      setMigrationText('');
      setMigrationMessage(`已导入 ${result.value} 项本地记录`);
      invalidateRouteCache('home:');
    } else {
      setMigrationMessage(result.error.message);
      setMigrationError(true);
    }
    setMigrationPending(false);
  }

  async function runMigrationExport() {
    setMigrationPending(true);
    setMigrationMessage(undefined);
    setMigrationError(false);
    const scopeId = servers[0]?.scopeId;
    if (!scopeId) {
      setMigrationMessage('尚未配置服务器，无法确定导出范围');
      setMigrationError(true);
      setMigrationPending(false);
      return;
    }
    const [history, readingList] = await Promise.all([
      repository.listHistory(scopeId),
      repository.listReadingList(scopeId),
    ]);
    if (!history.ok) {
      setMigrationMessage(history.error.message);
      setMigrationError(true);
      setMigrationPending(false);
      return;
    }
    if (!readingList.ok) {
      setMigrationMessage(readingList.error.message);
      setMigrationError(true);
      setMigrationPending(false);
      return;
    }
    // 收藏夹 IS the LANraragi 🔖 Favorites category — server-side state, so it
    // is not part of the local export at all.
    const payload = buildMigrationExport({ scopeId, history: history.value, readingList: readingList.value });
    setMigrationText(JSON.stringify(payload, null, 2));
    setMigrationMessage(`已导出 ${payload.items.length + (payload.readingList?.length ?? 0) + (payload.readingListDeleted?.length ?? 0)} 项本地记录`);
    setMigrationPending(false);
  }

  /** The export is only useful on another machine, so copying it out is part of
   * the export itself — no manual selection inside the read-only box. */
  async function copyMigrationExport() {
    try {
      await writeClipboardText(migrationText);
      showToast('导出内容已复制到剪贴板', 'success');
    } catch {
      showToast('复制失败，请手动选择导出内容复制', 'error');
    }
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
    // 档案库与设置固定显示，对应的行是禁用态，这里只是双保险。
    if (key === 'library' || key === 'settings') return;
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
      <section className="preferences-panel" id={selectedSettingsSection === 'settings-sync' ? 'settings-sync-preferences' : selectedSettingsSection} aria-label={sectionLabel(selectedSettingsSection)}>
        {/* No section title here: the sidebar already names the section, and one
            visible section at a time meant the heading only reserved a column of
            empty space beside every control. No autosave notice either — every
            control in this panel saves itself, so a line saying so on every
            section was chrome that never told anyone anything they could act on.
            A failed save still interrupts, through the toast. */}
        {preferenceState.loading ? <p className="server-list-message" role="status">正在读取偏好…</p> : (
          <div className="preferences-form">
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
                hint="关闭后，首页继续阅读隐藏阅读进度超过 95% 的记录；历史页面始终完整显示"
                checked={preferenceDraft.continueReadingShowFinished}
                onToggle={() => editPreferences({ continueReadingShowFinished: !preferenceDraft.continueReadingShowFinished })}
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
                  <button className="settings-action" type="button" title="选择下载目录" aria-label="选择下载目录" onClick={() => {
                    void pickDirectory().then((selected) => {
                      if (typeof selected === 'string') editPreferences({ downloadDirectory: selected });
                    }).catch(() => showToast('无法打开目录选择器', 'error'));
                  }}><FolderOpen aria-hidden="true" />选择目录</button>
                  <button className="settings-action" type="button" title="恢复默认下载目录" aria-label="恢复默认下载目录" disabled={!preferenceDraft.downloadDirectory} onClick={() => editPreferences({ downloadDirectory: '' })}><RotateCcw aria-hidden="true" />恢复默认</button>
                </div>
              </SettingsPanel>
            )}
            {selectedSettingsSection === 'settings-general' && (
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
            )}
            {selectedSettingsSection === 'settings-general' && (
              <SettingsPanel
                icon={<Database />}
                label="图片缓存"
                hint="封面、阅读页与模型结果的本地缓存，可随时清理"
                value={cacheStats ? formatCacheBytes(cacheStats.bytes) : '统计中…'}
              >
                <strong className="settings-menu-strong">{cacheStats ? formatCacheBytes(cacheStats.bytes) : '正在统计…'}</strong>
                {cacheStats && cacheStats.bytes > 0 && (
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
                {cacheStats && (
                  <div className="cache-breakdown" aria-label="图片缓存明细">
                    {CACHE_RENDITIONS.map(([kind, label]) => cacheStats.byRendition[kind].bytes > 0 && <span key={kind}><i className={`cache-swatch is-${kind}`} aria-hidden="true" />{label} {formatCacheBytes(cacheStats.byRendition[kind].bytes)}</span>)}
                  </div>
                )}
                {/* Clearing sits at the end of its menu: the numbers above are the
                    answer to "what is in there", the button is the answer to "so
                    clean it", and one never shifts the other. */}
                <div className="settings-menu-actions">
                  <button
                    className="settings-action"
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
              </SettingsPanel>
            )}
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
                label="默认方向"
                hint="从哪一侧开始阅读"
                value={preferenceDraft.defaultDirection}
                options={[{ value: 'ltr', label: '从左到右' }, { value: 'rtl', label: '从右到左' }]}
                onChange={(value) => editPreferences({ defaultDirection: value as PreferenceSnapshot['defaultDirection'] })}
              >
                <PreferenceRadioFallback name="direction" value={preferenceDraft.defaultDirection} options={[['ltr', '从左到右'], ['rtl', '从右到左']]} onChange={(value) => editPreferences({ defaultDirection: value as PreferenceSnapshot['defaultDirection'] })} />
              </SettingsChoice>
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
                hint="移动端底栏改为悬浮胶囊样式；向下滚动时隐藏，向上滚动时恢复"
                checked={preferenceDraft.floatingNav}
                onToggle={() => editPreferences({ floatingNav: !preferenceDraft.floatingNav })}
              />
            )}
            {selectedSettingsSection === 'settings-appearance' && (
              <SettingsPanel
                icon={<ListChecks />}
                label="底栏项目"
                hint="选择移动端底栏显示的项目；档案库与设置固定显示，不影响桌面端侧边栏"
                ariaLabel="底栏项目"
                value={`${preferenceDraft.bottomNavItems.length} 项`}
              >
                <div className="settings-menu-checks">
                  {BOTTOM_NAV_OPTIONS.map(({ key, label }) => {
                    const pinned = key === 'library' || key === 'settings';
                    const included = pinned || preferenceDraft.bottomNavItems.includes(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        role="checkbox"
                        aria-checked={included}
                        aria-label={`底栏显示${label}`}
                        disabled={pinned}
                        className={`settings-menu-check${included ? ' is-checked' : ''}${pinned ? ' is-pinned' : ''}`}
                        onClick={() => toggleBottomNavItem(key)}
                      >
                        <span>{label}</span>
                        {pinned ? <Lock aria-hidden="true" /> : included ? <Check aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </div>
                <p className="settings-menu-desc">带锁的档案库与设置固定显示，不受勾选影响。</p>
              </SettingsPanel>
            )}
            {selectedSettingsSection === 'settings-appearance' && (
              <SettingsPanel icon={<ListChecks />} label="详情页功能按钮" hint="选择详情页显示的操作；其他操作仍可从右上角菜单打开" ariaLabel="详情页功能按钮" value={`${preferenceDraft.detailActions.length} 项`}>
                <div className="settings-menu-checks">
                  {DETAIL_ACTIONS.map((action) => {
                    const labels = { read: '阅读', readingList: '待看', favorites: '收藏夹', download: '下载', edit: '编辑', delete: '删除' };
                    const included = preferenceDraft.detailActions.includes(action);
                    const locked = action === 'read';
                    return <button key={action} type="button" role="checkbox" disabled={locked} aria-checked={locked || included} aria-label={`详情页显示${labels[action]}`} className={`settings-menu-check${locked || included ? ' is-checked' : ''}${locked ? ' is-pinned' : ''}`} onClick={() => { if (!locked) editPreferences({ detailActions: DETAIL_ACTIONS.filter((key) => key === action ? !included : preferenceDraft.detailActions.includes(key)) }); }}><span>{labels[action]}</span>{locked ? <span aria-hidden="true">锁定</span> : included && <Check aria-hidden="true" />}</button>;
                  })}
                </div>
              </SettingsPanel>
            )}
            {selectedSettingsSection === 'settings-appearance' && (
              <SettingsPanel
                icon={<Paintbrush />}
                label="自定义"
                hint="基础配色一键套用；高级模式可在设计令牌之后追加任意 CSS 覆盖，改动即时生效"
                ariaLabel="自定义"
                value={customValue}
              >
                {/* 两个层级：基础只挑配色，高级保留完整的 CSS 覆盖面。 */}
                <div className="settings-menu-mode" role="group" aria-label="自定义方式">
                  <button type="button" className={`settings-menu-mode-button${appearanceMode === 'basic' ? ' is-active' : ''}`} aria-pressed={appearanceMode === 'basic'} onClick={() => setAppearanceMode('basic')}>基础</button>
                  <button type="button" className={`settings-menu-mode-button${appearanceMode === 'advanced' ? ' is-active' : ''}`} aria-pressed={appearanceMode === 'advanced'} onClick={() => setAppearanceMode('advanced')}>高级</button>
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
                    <textarea
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
            {selectedSettingsSection === 'settings-sync' && (
              <SettingsSwitch
                icon={<HeartOff />}
                label="同步删除 E-Hentai 收藏"
                hint="删除档案时一并删除对应的 E-Hentai 收藏"
                checked={preferenceDraft.ehFavoriteDeleteSync}
                onToggle={() => editPreferences({ ehFavoriteDeleteSync: !preferenceDraft.ehFavoriteDeleteSync })}
              />
            )}
            {selectedSettingsSection === 'settings-sync' && (
              <SettingsSwitch
                icon={<ShieldCheck />}
                label="默认开启收藏同步删除"
                hint="删除确认弹窗中的「同步删除 E-Hentai 收藏」开关默认勾选；删除行为始终需要确认"
                checked={preferenceDraft.confirmEhFavoriteDelete}
                disabled={!preferenceDraft.ehFavoriteDeleteSync}
                onToggle={() => editPreferences({ confirmEhFavoriteDelete: !preferenceDraft.confirmEhFavoriteDelete })}
              />
            )}
            {selectedSettingsSection === 'settings-sync' && (
              <SettingsPanel
                icon={<Waypoints />}
                label="WebDAV 账户"
                hint="同步阅读进度、历史与待看变更；在菜单中管理账户并添加新设备"
                ariaLabel="WebDAV 账户"
                value={sync.loading ? '读取中…' : sync.accounts.length === 0 ? '未配置' : sync.accounts.length === 1 ? sync.accounts[0]!.label : `${sync.accounts[0]!.label} 等 ${sync.accounts.length} 个`}
              >
                {sync.loading ? <p className="server-list-message" role="status">正在读取同步账户…</p> : sync.accounts.length === 0 ? (
                  <p className="settings-menu-desc">尚未配置 WebDAV 账户，填写下方表单保存第一台设备。</p>
                ) : (
                  <div className="settings-menu-accounts">
                    {sync.accounts.map((account) => (
                      <div className="settings-menu-account" key={account.id}>
                        <Waypoints className="settings-menu-account-glyph" aria-hidden="true" />
                        <div className="settings-menu-account-copy">
                          <strong>{account.label}</strong>
                          <span>{account.baseUrl}</span>
                          <small>{account.username || '无用户名'} · {account.status === 'unverified' ? '待首次同步验证' : account.status}</small>
                        </div>
                        <button className="settings-action" type="button" disabled={sync.syncingId !== undefined} onClick={() => void sync.exportKey(account)}>导出密钥</button>
                        <button className="settings-action" type="button" disabled={sync.syncingId !== undefined} onClick={() => sync.beginKeyImport(account)}>导入密钥</button>
                        <button className="settings-action" type="button" disabled={sync.syncingId !== undefined || sync.servers.length === 0} aria-busy={sync.syncingId === account.id} onClick={() => void sync.runSync(account)}>
                          <RefreshCw aria-hidden="true" />{sync.syncingId === account.id ? '同步中…' : '立即同步'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {!sync.loading && sync.accounts.length > 0 && sync.servers.length === 0 && (
                  <p className="settings-menu-desc">需要先在「通用」中添加 LANraragi 服务器，才能确定本地同步范围。</p>
                )}
                <TextInputDialog
                  open={sync.keyImportAccount !== undefined}
                  onOpenChange={(open) => { if (!open) sync.closeKeyImport(); }}
                  title={`导入同步密钥 · ${sync.keyImportAccount?.label ?? ''}`}
                  description="粘贴原设备「导出密钥」复制的内容。远端已有数据时，导入前会先验证这把密钥能否解密它。"
                  label="同步密钥"
                  confirmLabel="导入密钥"
                  validate={(value) => (value.trim() ? undefined : '请粘贴导出的同步密钥')}
                  onConfirm={(value) => void sync.confirmKeyImport(value)}
                />
                {/* 账户管理与添加在同一个菜单里完成，不再分成两行。
                    账户 ID 由名称自动派生，不再让用户填写。 */}
                <p className="settings-menu-divider">添加或更新账户</p>
                <form className="sync-form" onSubmit={sync.saveAccount}>
                  <label>名称<input name="label" required autoComplete="off" placeholder="家里的 NAS" /></label>
                  <label className="sync-form-wide">WebDAV 地址<input name="baseUrl" required type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://dav.example.com/Yomika" /></label>
                  <label>用户名<input name="username" autoComplete="username" spellCheck={false} /></label>
                  <label>密码或 Token<input name="credential" required type="password" autoComplete="off" spellCheck={false} /></label>
                  <div className="sync-form-actions">
                    <button className="secondary-action" type="submit" disabled={sync.saving} aria-busy={sync.saving}>{sync.saving ? '保存中…' : '保存同步账户'}</button>
                  </div>
                </form>
              </SettingsPanel>
            )}
            {selectedSettingsSection === 'settings-sync' && (
              /* 导入 and 导出 are two directions, not one form: each opens its
                 own menu, and closing either clears the shared draft — text
                 that only mattered while the menu was open never lingers
                 behind. */
              <SettingsPanel
                icon={<FileDown />}
                label="导出数据"
                hint="导出阅读历史与待看记录为可迁移的 JSON；服务器凭据不在导出范围内"
                onClose={() => setMigrationText('')}
              >
                <form className="legacy-import-form" onSubmit={(event) => event.preventDefault()}>
                  <textarea
                    id="migration-export"
                    aria-label="导出 JSON"
                    className="is-selectable"
                    readOnly
                    rows={6}
                    spellCheck={false}
                    value={migrationText}
                    onChange={(event) => setMigrationText(event.target.value)}
                  />
                  <div className="settings-menu-actions" role="group" aria-label="数据导出操作">
                    <button className="settings-action" type="button" disabled={migrationPending} aria-busy={migrationPending} onClick={() => void runMigrationExport()}>
                      {migrationPending ? '处理中…' : '导出数据'}
                    </button>
                    <button className="settings-action" type="button" disabled={!migrationText.trim()} onClick={() => void copyMigrationExport()}>
                      <Copy aria-hidden="true" />复制
                    </button>
                  </div>
                </form>
              </SettingsPanel>
            )}
            {selectedSettingsSection === 'settings-sync' && (
              <SettingsPanel
                icon={<FileUp />}
                label="导入数据"
                hint="粘贴另一台设备导出的 JSON，恢复本地记录与偏好设置"
                onClose={() => { setMigrationText(''); setMigrationMessage(undefined); setMigrationError(false); }}
              >
                <form className="legacy-import-form" onSubmit={runMigrationImport}>
                  <textarea
                    id="migration-json"
                    name="migrationJson"
                    aria-label="导出 JSON"
                    autoComplete="off"
                    spellCheck={false}
                    value={migrationText}
                    onChange={(event) => setMigrationText(event.target.value)}
                    rows={6}
                  />
                  <div className="settings-menu-actions" role="group" aria-label="数据导入操作">
                    <button className="settings-action is-primary" type="submit" disabled={migrationPending || !migrationText.trim()} aria-busy={migrationPending}>
                      {migrationPending ? '处理中…' : '导入数据'}
                    </button>
                  </div>
                </form>
              </SettingsPanel>
            )}
            </div>
            {/* SFW 单独成组：内容保护开关不与外观微调混在一起，置底独立可辨。 */}
            {selectedSettingsSection === 'settings-appearance' && (
              <div className="settings-group">
                <SettingsSwitch
                  icon={<EyeOff />}
                  label="SFW 模式"
                  hint="所有封面模糊显示；悬停封面或点击卡片才临时显示那一枚，移开或失焦自动恢复"
                  checked={preferenceDraft.sfwMode}
                  onToggle={() => editPreferences({ sfwMode: !preferenceDraft.sfwMode })}
                />
              </div>
            )}
            {/* 高级区拆成三组：超分、去码各自独立，模型导入单独置底。 */}
            {selectedSettingsSection === 'settings-advanced' && (
              <div className="settings-group">
                <SettingsSwitch
                  icon={<Sparkles />}
                  label="启用超分"
                  hint={upscaleReady ? '用超分模型放大阅读画面' : '用超分模型放大阅读画面；尚未安装可用的超分模型'}
                  checked={upscaleOn}
                  onToggle={() => {
                    if (upscaleOn) { editPreferences({ upscaleBackend: 'off' }); return; }
                    if (!upscaleReady) { showToast('超分模型未安装，无法启用', 'error'); return; }
                    editPreferences({ upscaleBackend: 'auto', upscaleModel: preferenceDraft.upscaleModel || upscaleModelOptions[0]!.value });
                  }}
                />
                <SettingsChoice
                  icon={<ImageUpscale />}
                  label="超分模型"
                  value={preferenceDraft.upscaleModel || upscaleModelOptions[0]!.value}
                  options={upscaleModelOptions}
                  onChange={(value) => editPreferences({ upscaleModel: value })}
                  optionAction={(option) => runnableModels?.some((model) => model.id === option.value) ? null : <button className="select-option-download" type="button" aria-label={`下载${option.label}`} title="下载模型" disabled={modelPending} onClick={(event) => { event.stopPropagation(); void downloadModel(option.value); }}><Download aria-hidden="true" /></button>}
                />
                {!runnableModels?.length && (
                  <p className="server-list-message" role="status">{runnableModels ? '尚未安装可用的超分模型。' : '正在读取已安装模型…'}</p>
                )}
              </div>
            )}
            {selectedSettingsSection === 'settings-advanced' && (
              <div className="settings-group">
                <SettingsSwitch
                  icon={<Eraser />}
                  label="启用去码"
                  hint={decensorReady ? '按流程逐级修补遮挡' : '按流程逐级修补遮挡；去码模型不完整，无法启用'}
                  checked={decensorOn}
                  onToggle={() => {
                    if (decensorOn) { editPreferences({ decensorModel: '' }); return; }
                    if (!decensorReady) { showToast('去码模型不完整，无法启用', 'error'); return; }
                    editPreferences({ decensorModel: decensorBundles?.[0]?.id ?? '' });
                  }}
                />
                <div role="group" aria-label="去码流程模型">
                  {DECENSOR_COMPONENT_IDS.map((id) => {
                    const component = selectedDecensorBundle?.components.find((item) => item.id === id);
                    const stageOptions = decensorStageOptions(decensorBundles, id);
                    const fallback = { value: 'aletheia-lens', label: DECENSOR_STAGE_META[id].name };
                    const role = component?.role ?? DECENSOR_STAGE_META[id].role;
                    return <SettingsChoice
                      key={id}
                      icon={DECENSOR_STAGE_META[id].icon}
                      label={role}
                      ariaLabel={`${role}模型`}
                      value={preferenceDraft.decensorModel || stageOptions[0]?.value || fallback.value}
                      options={stageOptions.length ? stageOptions : [fallback]}
                      onChange={(value) => { if (value) editPreferences({ decensorModel: value }); }}
                      optionAction={(option) => decensorBundles?.some((model) => model.id === option.value && hasCompleteDecensorBundle(model)) ? null : <button className="select-option-download" type="button" aria-label={`下载${option.label}`} title="下载模型" disabled={modelPending} onClick={(event) => { event.stopPropagation(); void downloadModel(option.value); }}><Download aria-hidden="true" /></button>}
                    />;
                  })}
                </div>
                {!decensorBundles?.length && (
                  <p className="server-list-message" role="status">{installedModels ? '尚未安装去码模型。' : '正在读取模型索引…'}</p>
                )}
              </div>
            )}
            {selectedSettingsSection === 'settings-advanced' && (
              <div className="settings-group">
                {/* 单按钮的设置不值得一个二级菜单：导入动作就在行右侧。
                    按钮里画一个"档案盒 + 上传箭头"的专属图标——这行的语义
                    （导入模型包）是 Upload 箭头说不完整的。 */}
                <div className="settings-row">
                  <span className="settings-row-icon" aria-hidden="true"><Upload /></span>
                  <span className="settings-row-copy">
                    <span className="settings-row-label">模型导入</span>
                    <span className="settings-row-hint">导入超分或去码的模型文件与压缩包</span>
                  </span>
                  <button className="settings-action" type="button" disabled={modelPending} aria-busy={modelPending} title="导入模型文件或压缩包" onClick={() => modelInputRef.current?.click()}>
                    <svg className="model-import-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" />
                      <path d="M12 3v12" />
                      <path d="m7 8 5-5 5 5" />
                      <path d="M8 15h8" />
                    </svg>
                    {modelPending ? '导入中…' : '选择模型文件…'}
                  </button>
                </div>
                <input ref={modelInputRef} className="visually-hidden" type="file" accept=".zip,.onnx,application/zip,application/octet-stream" disabled={modelPending} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importModelFile(file); event.currentTarget.value = ''; }} />
              </div>
            )}
            {/* The server list keeps its own live region and its own group of rows:
                each row opens the same setup dialog the add row does. */}
            {selectedSettingsSection === 'settings-general' && (
              <div className="settings-group server-region" role="region" aria-label="服务器" aria-live="polite">
                {loading && <p className="server-list-message" role="status">正在读取服务器…</p>}
                {!loading && loadError && (
                  <div className="server-list-error">
                    <p className="form-error" role="alert">{loadError}</p>
                    {loadRetryable && (
                      <button className="settings-action" type="button" onClick={() => setServerLoadAttempt((attempt) => attempt + 1)}>
                        <RefreshCw aria-hidden="true" />
                        重试读取服务器
                      </button>
                    )}
                  </div>
                )}
                {servers.map((server) => (
                  <div className="settings-item server-row" key={server.id}>
                    <ServerSetupDialog variant="row" onSave={saveServer} server={server} />
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
          <SettingsPanel icon={<EhMark size={20} />} label="E-Hentai 账户" value={ehAccountName ?? '未登录'} ariaLabel="E-Hentai 账户">
            <EhRouteWorkspace onActiveAccountChange={setEhAccountName} />
          </SettingsPanel>
          <SettingsSwitch
            icon={<Tags />}
            label="我的标签"
            hint="拉取 E-Hentai 账户的「我的标签」：档案卡片与详情页中的这些标签优先靠左显示，并使用预设底色；需已登录 E-Hentai"
            disabled={!ehAccountName}
            checked={preferenceDraft.ehMyTagsPriority && Boolean(ehAccountName)}
            onToggle={() => editPreferences({ ehMyTagsPriority: !preferenceDraft.ehMyTagsPriority })}
          />
        </div>
      </section>
      )}
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
          {APP_LICENSE && <SettingsRow icon={<Scale />} label="开源协议" value={APP_LICENSE} trailing="none" />}
          <SettingsRow icon={<Blocks />} label="构建于" value="Tauri 2 · React 18 · SQLite" trailing="none" />
          {APP_REPOSITORY && (
            <div className="settings-item">
              <button className="settings-row settings-row-button" type="button" aria-label="仓库地址" onClick={() => void openAboutLink(APP_REPOSITORY)}>
                <span className="settings-row-icon" aria-hidden="true"><Github /></span>
                <span className="settings-row-copy">
                  <span className="settings-row-label">仓库地址</span>
                  <span className="settings-row-hint">{APP_REPOSITORY_DISPLAY}</span>
                </span>
                <span className="settings-row-control settings-row-value"><ChevronRight aria-hidden="true" /></span>
              </button>
            </div>
          )}
          <div className="settings-item">
            <button className="settings-row settings-row-button" type="button" aria-label="LANraragi 文档" onClick={() => void openAboutLink('https://sugoi.gitbook.io/lanraragi')}>
              <span className="settings-row-icon" aria-hidden="true"><BookOpenText /></span>
              <span className="settings-row-copy">
                <span className="settings-row-label">LANraragi 文档</span>
                <span className="settings-row-hint">在浏览器中打开 LANraragi 的使用文档</span>
              </span>
              <span className="settings-row-control settings-row-value"><ChevronRight aria-hidden="true" /></span>
            </button>
          </div>
        </div>
      </section>
      )}
      {selectedSettingsSection === 'settings-tools' && (
      <section className="settings-section" id="settings-tools" aria-label="工具">
        <div className="settings-group">
          {/* Rows, not cards: each one says what it does, then navigates — the
              operation here is a route, so it happens on the row itself. */}
          <div className="settings-item">
            <Link className="settings-row settings-row-button" to="/tools/upload">
              <span className="settings-row-icon" aria-hidden="true"><Upload /></span>
              <span className="settings-row-copy">
                <span className="settings-row-label">上传档案</span>
                <span className="settings-row-hint">把本机压缩包传给 LANraragi，可批量选择。</span>
              </span>
              <span className="settings-row-control settings-row-value"><ChevronRight aria-hidden="true" /></span>
            </Link>
          </div>
          <div className="settings-item">
            <Link className="settings-row settings-row-button" to="/tools/dedup">
              <span className="settings-row-icon" aria-hidden="true"><CopyCheck /></span>
              <span className="settings-row-copy">
                <span className="settings-row-label">重复档案查重</span>
                <span className="settings-row-hint">按内容比对整个库，逐组确认后删除。</span>
              </span>
              <span className="settings-row-control settings-row-value"><ChevronRight aria-hidden="true" /></span>
            </Link>
          </div>
        </div>
      </section>
      )}
        </div>
        )}
      </div>
    </div>
  );
}
