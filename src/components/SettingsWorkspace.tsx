import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, ChevronRight, RefreshCw, Upload, CopyCheck, Eraser, FolderOpen, RotateCcw, Download } from 'lucide-react';
import { SelectField } from './SelectField';
import { pickDirectory } from '../bridge/filePicker';
import { EhRouteWorkspace } from './EhRouteWorkspace';
import { useToast } from './Toast';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';

import type { ServerRecord } from '../domain/library';
import type { ServerIdentity } from '../domain/server';
import type { CommandResult } from '../domain/result';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeLegacyRepository } from '../repositories/nativeLegacyRepository';
import { ServerSetupDialog } from './ServerSetupDialog';
import { SyncWorkspace } from './SyncWorkspace';
import { usePreferences } from '../app/preferences';
import { buildMigrationExport, parseMigrationExport } from '../lib/dataMigration';
import { CSS_THEME_PRESETS } from '../lib/cssThemePresets';
import { NativeCacheRepository, type CacheStats } from '../repositories/nativeCacheRepository';
import { NativeInferenceRepository, type InstalledModel } from '../repositories/nativeInferenceRepository';
import { MAX_PREFETCH_PAGES, PreferenceSnapshotSchema } from '../repositories/nativeSettingsRepository';
import { openExternalUrl } from '../bridge/externalUrl';

function PreferenceRadioFallback({ name, value, options, onChange }: { name: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <div className="select-compat-radios" aria-hidden="false">{options.map(([option, label]) => <label key={option}><input type="radio" name={`${name}-compat`} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{label}</span></label>)}</div>;
}
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';

const repository = new NativeLibraryRepository();
const legacyRepository = new NativeLegacyRepository();
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
/** The same file the window icon and the sidebar brand use, so the About page
 * cannot show a stand-in that drifts from the real mark. */
const markUrl = new URL('../../assets/yomika-icon.svg', import.meta.url).href;
/** Vite inlines this at build time from package.json, so the About page cannot
 * drift from the shipped version the way a hand-written string would. */
const APP_VERSION = __APP_VERSION__;
const APP_AUTHOR = __APP_AUTHOR__;
const APP_LICENSE = __APP_LICENSE__;

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

const DECENSOR_COMPONENT_IDS = ['mrcnn', 'deepcreampy-bar', 'deepcreampy-mosaic', 'fatal-pixels'] as const;
const DECENSOR_STAGE_META: Record<(typeof DECENSOR_COMPONENT_IDS)[number], { role: string; name: string }> = {
  mrcnn: { role: '遮挡区域检测', name: 'Mask R-CNN' },
  'deepcreampy-bar': { role: '条状遮挡修补', name: 'DeepCreamPy Bar' },
  'deepcreampy-mosaic': { role: '马赛克修补', name: 'DeepCreamPy Mosaic' },
  'fatal-pixels': { role: '修复结果增强', name: 'Fatal Pixels' },
};

function decensorStageOptions(models: InstalledModel[] | undefined, componentId: string) {
  return (models ?? [])
    .filter((model) => model.kind === 'decensor' && model.components.some((component) => component.id === componentId))
    .map((model) => {
      const component = model.components.find((item) => item.id === componentId);
      return { value: model.id, label: `${component?.name ?? model.id} · ${model.version}` };
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
  { id: 'settings-general', label: '通用' },
  { id: 'settings-reading', label: '阅读' },
  { id: 'settings-appearance', label: '样式' },
  { id: 'settings-eh', label: 'E-Hentai' },
  { id: 'settings-sync', label: '同步' },
  { id: 'settings-advanced', label: '高级' },
  { id: 'settings-about', label: '关于' },
  { id: 'settings-tools', label: '工具' },
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
  const upscaleOptions = runnableModels?.length
    ? runnableModels.map(modelOption)
    : [{ value: 'waifu2x-upconv7', label: 'waifu2x' }];
  const statsRequestedRef = useRef(false);
  const autosaveTimer = useRef<number>();
  const pendingPreferences = useRef<PreferenceSnapshot>();

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
    // Results go to the shared toast: an inline line inside the cache box was
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
    const next = { ...preferenceDraft, ...patch };
    setPreferenceDraft(next);
    pendingPreferences.current = next;
    if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => void persistPreferences(next), 400);
  }

  async function persistPreferences(next: PreferenceSnapshot) {
    if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = undefined;
    pendingPreferences.current = undefined;
    // Half-typed values are not failures. Clearing a number field to retype it
    // passes through 0 or NaN, and autosave would report each one as an error.
    if (!PreferenceSnapshotSchema.safeParse(next).success) return;
    setPreferenceMessage(undefined);
    setPreferenceError(false);
    const result = await preferenceState.save(next);
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


  /** One control pair for both payload shapes: a unified export (Readoshi's
   * worker envelope) goes to the native importer, anything else is treated as a
   * legacy preferences blob. */
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
      } else {
        setMigrationMessage(result.error.message);
        setMigrationError(true);
      }
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
    const [history, watchlist] = await Promise.all([
      repository.listHistory(scopeId),
      repository.listWatchlist(scopeId),
    ]);
    if (!history.ok || !watchlist.ok) {
      setMigrationMessage(history.ok ? (watchlist.ok ? '导出失败' : watchlist.error.message) : history.error.message);
      setMigrationError(true);
      setMigrationPending(false);
      return;
    }
    const payload = buildMigrationExport({ scopeId, history: history.value, watchlist: watchlist.value });
    setMigrationText(JSON.stringify(payload, null, 2));
    setMigrationMessage(`已导出 ${payload.items.length} 项本地记录`);
    setMigrationPending(false);
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

  return (
    <div className="settings-page">
      <header className="workspace-heading">
        <h1>设置</h1>
      </header>
      <div className={`settings-layout${compact ? ' is-compact' : ''}`}>
        {showSectionList && (
        <aside className="settings-sidebar" aria-label="设置分类">
          <nav className="settings-nav">
            {settingsSections.map((section) => (
              <a
                className={!compact && selectedSettingsSection === section.id ? 'is-active' : undefined}
                href={`#${section.id}`}
                key={section.id}
                aria-current={!compact && selectedSettingsSection === section.id ? 'page' : undefined}
                onClick={(event) => { event.preventDefault(); setSelectedSettingsSection(section.id); setCompactDrilled(true); }}
              >
                <span>{section.label}</span>
                {compact && <ChevronRight aria-hidden="true" />}
              </a>
            ))}
          </nav>
        </aside>
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
      {selectedSettingsSection === 'settings-advanced' && (
        <section className="model-import-row" aria-label="模型导入">
          <button type="button" className="icon-button model-import-button" disabled={modelPending} aria-label="导入模型文件或压缩包" title="导入模型文件或压缩包" onClick={() => modelInputRef.current?.click()}><Upload aria-hidden="true" /></button>
          <input ref={modelInputRef} className="visually-hidden" type="file" accept=".zip,.onnx,application/zip,application/octet-stream" disabled={modelPending} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importModelFile(file); event.currentTarget.value = ''; }} />
        </section>
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
          <div className={`preferences-form${selectedSettingsSection === 'settings-advanced' ? ' enhancement-settings' : ''}`}>
            {selectedSettingsSection === 'settings-general' && <fieldset>
              <legend>启动时打开</legend>
              <SelectField name="startupRoute" aria-label="启动时打开" value={preferenceDraft.startupRoute} options={[{ value: 'home', label: '首页' }, { value: 'library', label: '档案库' }]} onChange={(value) => editPreferences({ startupRoute: value as PreferenceSnapshot['startupRoute'] })} />
              <PreferenceRadioFallback name="startupRoute" value={preferenceDraft.startupRoute} options={[['home', '首页'], ['library', '档案库']]} onChange={(value) => editPreferences({ startupRoute: value as PreferenceSnapshot['startupRoute'] })} />
            </fieldset>}
            {selectedSettingsSection === 'settings-reading' && <fieldset>
              <legend>默认布局</legend>
              <SelectField name="layout" aria-label="默认布局" value={preferenceDraft.defaultLayout} options={[{ value: 'auto', label: '自动' }, { value: 'single', label: '单页' }, { value: 'double', label: '双页' }, { value: 'webtoon', label: '条漫' }]} onChange={(value) => editPreferences({ defaultLayout: value as PreferenceSnapshot['defaultLayout'] })} />
              <PreferenceRadioFallback name="layout" value={preferenceDraft.defaultLayout} options={[['auto', '自动'], ['single', '单页'], ['double', '双页'], ['webtoon', '条漫']]} onChange={(value) => editPreferences({ defaultLayout: value as PreferenceSnapshot['defaultLayout'] })} />
            </fieldset>}
            {selectedSettingsSection === 'settings-reading' && <fieldset>
              <legend>默认方向</legend>
              <SelectField name="direction" aria-label="默认方向" value={preferenceDraft.defaultDirection} options={[{ value: 'ltr', label: '从左到右' }, { value: 'rtl', label: '从右到左' }]} onChange={(value) => editPreferences({ defaultDirection: value as PreferenceSnapshot['defaultDirection'] })} />
              <PreferenceRadioFallback name="direction" value={preferenceDraft.defaultDirection} options={[['ltr', '从左到右'], ['rtl', '从右到左']]} onChange={(value) => editPreferences({ defaultDirection: value as PreferenceSnapshot['defaultDirection'] })} />
            </fieldset>}
            {selectedSettingsSection === 'settings-appearance' && <fieldset>
              <legend>主题</legend>
              <SelectField name="theme" aria-label="主题" value={preferenceDraft.theme} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={(value) => editPreferences({ theme: value as PreferenceSnapshot['theme'] })} />
              <PreferenceRadioFallback name="theme" value={preferenceDraft.theme} options={[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]} onChange={(value) => editPreferences({ theme: value as PreferenceSnapshot['theme'] })} />
            </fieldset>}
            {selectedSettingsSection === 'settings-appearance' && <fieldset className="custom-css-editor">
              <legend>自定义 CSS</legend>
              <p className="custom-css-hint">
                在设计令牌之后追加，可覆盖任意变量与样式。改动即时生效，清空即恢复默认。
              </p>
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
            </fieldset>}
            {selectedSettingsSection === 'settings-reading' && <label className="preference-select">预加载页数
              <input
                name="prefetchPages"
                aria-label="预加载页数"
                type="number"
                min={0}
                max={MAX_PREFETCH_PAGES}
                step={1}
                value={preferenceDraft.prefetchPages}
                onChange={(event) => editPreferences({ prefetchPages: Number(event.target.value) })}
              />
            </label>}
            {selectedSettingsSection === 'settings-reading' && <label className="preference-select">封面并发请求
              <input
                name="coverConcurrency"
                aria-label="封面并发请求"
                type="number"
                min={1}
                max={8}
                step={1}
                value={preferenceDraft.coverConcurrency}
                onChange={(event) => editPreferences({ coverConcurrency: Number(event.target.value) })}
              />
            </label>}
            {selectedSettingsSection === 'settings-advanced' && (
              <fieldset className="model-feature-block">
                <legend>超分</legend>
                <div className="model-feature-heading">
                  <span>启用超分</span>
                  <button
                    className="switch-control"
                    type="button"
                    role="switch"
                    name="upscaleEnabled"
                    aria-label="启用超分"
                    aria-checked={upscaleOn}
                    onClick={() => {
                      if (upscaleOn) { editPreferences({ upscaleBackend: 'off' }); return; }
                      if (!upscaleReady) { showToast('超分模型未安装，无法启用', 'error'); return; }
                      editPreferences({ upscaleBackend: 'auto', upscaleModel: preferenceDraft.upscaleModel || upscaleModelOptions[0]!.value });
                    }}
                  />
                </div>
                <div className="model-choice-row">
                  <SelectField name="upscaleModel" aria-label="超分模型" value={preferenceDraft.upscaleModel || upscaleModelOptions[0]!.value} options={upscaleModelOptions} onChange={(value) => editPreferences({ upscaleModel: value })} optionAction={(option) => runnableModels?.some((model) => model.id === option.value) ? null : <button className="select-option-download" type="button" aria-label={`下载${option.label}`} title="下载模型" disabled={modelPending} onClick={(event) => { event.stopPropagation(); void downloadModel(option.value); }}><Download aria-hidden="true" /></button>} />
                </div>
                {!runnableModels?.length && <p className="server-list-message" role="status">{runnableModels ? '尚未安装可用的超分模型。' : '正在读取已安装模型…'}</p>}
              </fieldset>
            )}
            {selectedSettingsSection === 'settings-advanced' && (
              <fieldset className="model-feature-block">
                <legend>去码</legend>
                <div className="model-feature-heading">
                  <span>启用去码</span>
                  <button
                    className="switch-control"
                    type="button"
                    role="switch"
                    name="decensorEnabled"
                    aria-label="启用去码"
                    aria-checked={decensorOn}
                    onClick={() => {
                      if (decensorOn) { editPreferences({ decensorModel: '' }); return; }
                      if (!decensorReady) { showToast('去码模型不完整，无法启用', 'error'); return; }
                      editPreferences({ decensorModel: decensorBundles?.[0]?.id ?? '' });
                    }}
                  />
                </div>
                <div className="model-stage-list" aria-label="去码流程模型">
                  {DECENSOR_COMPONENT_IDS.map((id) => {
                    const component = selectedDecensorBundle?.components.find((item) => item.id === id);
                    const stageOptions = decensorStageOptions(decensorBundles, id);
                    const fallback = { value: 'aletheia-lens', label: DECENSOR_STAGE_META[id].name };
                    return <div className="model-stage-row" key={id}><span>{component?.role ?? DECENSOR_STAGE_META[id].role}</span><SelectField name={`decensor-${id}`} aria-label={`${component?.role ?? DECENSOR_STAGE_META[id].role}模型`} value={preferenceDraft.decensorModel || stageOptions[0]?.value || fallback.value} options={stageOptions.length ? stageOptions : [fallback]} onChange={(value) => { if (value) editPreferences({ decensorModel: value }); }} optionAction={(option) => decensorBundles?.some((model) => model.id === option.value && hasCompleteDecensorBundle(model)) ? null : <button className="select-option-download" type="button" aria-label={`下载${option.label}`} title="下载模型" disabled={modelPending} onClick={(event) => { event.stopPropagation(); void downloadModel(option.value); }}><Download aria-hidden="true" /></button>} /></div>;
                  })}
                </div>
                {!decensorBundles?.length && <p className="server-list-message" role="status">{installedModels ? '尚未安装去码模型。' : '正在读取模型索引…'}</p>}
              </fieldset>
            )}
            {selectedSettingsSection === 'settings-sync' && <fieldset className="preference-switch">
              <legend>删除档案</legend>
              <label className="preference-toggle"><button className="switch-control" type="button" role="switch" aria-label="同步删除 E-Hentai 收藏" aria-checked={preferenceDraft.ehFavoriteDeleteSync} onClick={() => editPreferences({ ehFavoriteDeleteSync: !preferenceDraft.ehFavoriteDeleteSync })}><span /></button><span>同步删除 E-Hentai 收藏</span></label>
              <label className="preference-toggle"><button className="switch-control" type="button" role="switch" aria-label="每次确认收藏同步删除" aria-checked={preferenceDraft.confirmEhFavoriteDelete} disabled={!preferenceDraft.ehFavoriteDeleteSync} onClick={() => editPreferences({ confirmEhFavoriteDelete: !preferenceDraft.confirmEhFavoriteDelete })}><span /></button><span>每次确认收藏同步删除</span></label>
            </fieldset>}
            {selectedSettingsSection === 'settings-general' && <fieldset>
              <legend>下载目录</legend>
              <div className="download-directory-setting">
                <span title={preferenceDraft.downloadDirectory}>{preferenceDraft.downloadDirectory || '默认数据目录 / downloads'}</span>
                <button className="secondary-action" type="button" title="选择下载目录" aria-label="选择下载目录" onClick={() => {
                  void pickDirectory().then((selected) => {
                    if (typeof selected === 'string') editPreferences({ downloadDirectory: selected });
                  }).catch(() => showToast('无法打开目录选择器', 'error'));
                }}><FolderOpen aria-hidden="true" /></button>
                <button className="secondary-action" type="button" title="恢复默认目录" aria-label="恢复默认下载目录" disabled={!preferenceDraft.downloadDirectory} onClick={() => editPreferences({ downloadDirectory: '' })}><RotateCcw aria-hidden="true" /></button>
              </div>
            </fieldset>}
            {selectedSettingsSection === 'settings-general' && <label className="preference-select">图片缓存上限（GB）
              <input
                name="cacheMaxBytes"
                aria-label="图片缓存上限"
                type="number"
                min={1}
                max={32}
                step={1}
                value={preferenceDraft.cacheMaxBytes / GIB}
                onChange={(event) => editPreferences({ cacheMaxBytes: Number(event.target.value) * GIB })}
              />
            </label>}
            {selectedSettingsSection === 'settings-general' && <section className="cache-settings" aria-label="图片缓存">
              {/* Clearing sits immediately left of the number it changes, and in
                  that order on purpose: the button is anchored to the start of
                  the row, so a smaller total after clearing cannot shift it. */}
              <div className="cache-settings-heading">
                <button
                  className="icon-button cache-clear-button"
                  type="button"
                  disabled={cacheClearing}
                  aria-busy={cacheClearing}
                  aria-label="清空图片缓存"
                  title="清空图片缓存"
                  onClick={() => void clearImageCache()}
                >
                  <Eraser aria-hidden="true" />
                </button>
                <strong>{cacheStats ? formatCacheBytes(cacheStats.bytes) : '正在统计…'}</strong>
              </div>
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
            </section>}
          </div>
        )}
      </section>
      )}
      {selectedSettingsSection === 'settings-sync' && (
      <section className="settings-section" id="settings-migration" aria-labelledby="migration-title">
        <div>
          <h2 id="migration-title">数据迁移</h2>
          <p>导出阅读历史与待看记录，或粘贴导出内容导入。服务器凭据不在导出范围内，需要单独配置。</p>
        </div>
        <form className="legacy-import-form" onSubmit={runMigrationImport}>
          <label htmlFor="migration-json">导出 JSON</label>
          <textarea
            id="migration-json"
            name="migrationJson"
            autoComplete="off"
            spellCheck={false}
            value={migrationText}
            onChange={(event) => setMigrationText(event.target.value)}
            rows={6}
          />
          {/* One row, two controls of the same shape sharing its width. They were a
              secondary and a primary action, which differ in padding, font size and
              even in what their disabled cursor is — side by side, doing two halves
              of one job, that read as an accident. */}
          <div className="settings-actions" role="group" aria-label="数据迁移操作">
            <button className="settings-action" type="button" disabled={migrationPending} aria-busy={migrationPending} onClick={() => void runMigrationExport()}>
              {migrationPending ? '处理中…' : '导出数据'}
            </button>
            <button className="settings-action is-primary" type="submit" disabled={migrationPending || !migrationText.trim()} aria-busy={migrationPending}>
              {migrationPending ? '处理中…' : '导入数据'}
            </button>
          </div>
        </form>
      </section>
      )}
      {selectedSettingsSection === 'settings-general' && (
      /* No heading and no explanatory paragraph: the section is one list of
         servers, and the sidebar already says 通用. The add button follows the
         list rather than heading it, so it reads as "and one more" — with nothing
         configured yet the list is empty and the button is the first thing on the
         page anyway. */
      <section className="settings-section server-settings" id="settings-server" aria-label="服务器">
        <div className="server-list" aria-live="polite">
          {loading && <p className="server-list-message" role="status">正在读取服务器…</p>}
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
            <article className="server-row" key={server.id}>
              <div>
                <h3>{server.name}</h3>
                <p>{server.baseUrl}</p>
              </div>
              <div className="server-row-actions">
                <span className="server-state">已配置</span>
                <ServerSetupDialog onSave={saveServer} server={server} />
              </div>
            </article>
          ))}
        </div>
        <div className="settings-actions">
          <ServerSetupDialog onSave={saveServer} />
        </div>
      </section>
      )}
      {selectedSettingsSection === 'settings-sync' && (
      <section className="settings-section" id="settings-sync" aria-labelledby="sync-settings-title">
        <div className="settings-sync-content"><SyncWorkspace embedded /></div>
      </section>
      )}
      {selectedSettingsSection === 'settings-eh' && (
      /* The sidebar no longer carries an E-Hentai entry; the account form and the
         browse workspace live here. */
      <section className="settings-section" id="settings-eh" aria-label="E-Hentai">
        <div className="settings-eh-content"><EhRouteWorkspace /></div>
      </section>
      )}
      {selectedSettingsSection === 'settings-about' && (
      /* What an About page is for: what this is, who made it, where it lives and
         under what terms. It used to list the data directory, where server
         credentials are kept and the current cache size — three answers to
         questions nobody opens this page to ask, and the last one is in 高级 where
         it can actually be cleared. */
      <section className="settings-section settings-about" id="settings-about" aria-labelledby="about-title">
        <div className="about-hero">
          {/* The actual app mark, the same file the window icon and the sidebar
              use — the page used to draw a 読 glyph on a vermilion square, which
              is not the project's logo. */}
          <img className="about-mark" src={markUrl} alt="" width="72" height="72" />
          <div className="about-hero-copy">
            <h2 id="about-title">Yomika</h2>
          </div>
          <span className="about-version">v{APP_VERSION}</span>
        </div>
        <dl className="settings-about-list">
          {APP_AUTHOR && <div><dt>开发者</dt><dd>{APP_AUTHOR}</dd></div>}
          {/* Absent until the project declares one in package.json. Better a
              missing row than a licence the app made up on its behalf. */}
          {APP_LICENSE && <div><dt>开源协议</dt><dd>{APP_LICENSE}</dd></div>}
          <div><dt>构建于</dt><dd>Tauri 2 · React 18 · SQLite</dd></div>
        </dl>
        <div className="about-links settings-actions">
          <button className="settings-action" type="button" onClick={() => void openAboutLink('https://sugoi.gitbook.io/lanraragi')}>LANraragi 文档</button>
        </div>
      </section>
      )}
      {selectedSettingsSection === 'settings-tools' && (
      <section className="settings-section" id="settings-tools" aria-label="工具">
        {/* Cards, not two bare buttons: each one says what it does before you
            spend a navigation finding out. */}
        <div className="settings-tools-links">
          <Link className="tool-card" to="/tools/upload">
            <Upload aria-hidden="true" />
            <strong>上传档案</strong>
            <span>把本机压缩包传给 LANraragi，可批量选择。</span>
          </Link>
          <Link className="tool-card" to="/tools/dedup">
            <CopyCheck aria-hidden="true" />
            <strong>重复档案查重</strong>
            <span>按内容比对整个库，逐组确认后删除。</span>
          </Link>
        </div>
      </section>
      )}
        </div>
        )}
      </div>
    </div>
  );
}
