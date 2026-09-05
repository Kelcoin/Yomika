import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, ChevronRight, RefreshCw, Upload, CopyCheck, Eraser } from 'lucide-react';
import { SelectField } from './SelectField';
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
import { pickDirectory } from '../bridge/filePicker';
import { MAX_PREFETCH_PAGES, PreferenceSnapshotSchema } from '../repositories/nativeSettingsRepository';

function PreferenceRadioFallback({ name, value, options, onChange }: { name: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <div className="select-compat-radios" aria-hidden="false">{options.map(([option, label]) => <label key={option}><input type="radio" name={`${name}-compat`} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{label}</span></label>)}</div>;
}
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';

const repository = new NativeLibraryRepository();
const legacyRepository = new NativeLegacyRepository();
const cacheRepository = new NativeCacheRepository();
const inferenceRepository = new NativeInferenceRepository();
const GIB = 1_073_741_824;
/** The same file the window icon and the sidebar brand use, so the About page
 * cannot show a stand-in that drifts from the real mark. */
const markUrl = new URL('../../assets/yomika-icon.svg', import.meta.url).href;
/** Vite inlines this at build time from package.json, so the About page cannot
 * drift from the shipped version the way a hand-written string would. */
const APP_VERSION = __APP_VERSION__;
const APP_AUTHOR = __APP_AUTHOR__;
const APP_LICENSE = __APP_LICENSE__;
const APP_REPOSITORY = __APP_REPOSITORY__;

function formatCacheBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${index === 0 ? amount.toFixed(0) : amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')} ${units[index]}`;
}

/** Names a model by id, version and the scale it produces, since the scale is
 * the model's to decide and not the user's. */
function modelOption(model: InstalledModel): { value: string; label: string } {
  return { value: model.id, label: `${model.id} · ${model.version}${model.scale ? ` · x${model.scale}` : ''}` };
}

/** Grouped by topic: one "阅读与存储" panel used to hold the theme, the reader
 * defaults, the cache and the upscaler at once. */const settingsSections = [
  { id: 'settings-general', label: '通用' },
  { id: 'settings-reading', label: '阅读' },
  { id: 'settings-appearance', label: '样式' },
  { id: 'settings-eh', label: 'E-Hentai' },
  { id: 'settings-sync', label: '同步' },
  { id: 'settings-advanced', label: '高级' },
  { id: 'settings-tools', label: '工具' },
  { id: 'settings-about', label: '关于' },
] as const;

/** Sections whose content lives inside the single preferences form. */
const PREFERENCE_SECTIONS = ['settings-general', 'settings-reading', 'settings-appearance', 'settings-advanced'] as const;

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
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>();
  // A model with no recorded scale cannot be run, so it is not a choice; nor is a
  // de-censoring bundle, which is not an upscaler.
  const runnableModels = installedModels?.filter((model) => model.scale && model.kind === 'upscale');
  /** One switch each, derived from what is stored rather than stored separately:
   * a second boolean would be one more thing to keep in step with the model it
   * points at. Off is the backend being off, and no bundle chosen. */
  const upscaleOn = preferenceDraft.upscaleBackend !== 'off';
  const decensorOn = preferenceDraft.decensorModel !== '';
  const decensorBundles = installedModels?.filter((model) => model.kind === 'decensor');
  const [installingBundle, setInstallingBundle] = useState(false);
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
    if (selectedSettingsSection !== 'settings-advanced') return;
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
    // Only the reading section shows the model picker, and the list comes off
    // disk, so it is read on demand rather than at mount.
    if (selectedSettingsSection !== 'settings-reading' || installedModels) return;
    void inferenceRepository.listModels().then((result) => {
      setInstalledModels(result.ok ? result.value : []);
    });
  }, [installedModels, selectedSettingsSection]);

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

  /** Installs a de-censoring bundle from a directory the user picks. Nothing is
   * downloaded and nothing is shipped: the files are copied out of an existing
   * Aletheia-Lens install, because 337 MB neither fits through IPC nor belongs in
   * the repository. */
  async function installDecensorBundle() {
    const directory = await pickDirectory();
    if (!directory) return;
    setInstallingBundle(true);
    const result = await inferenceRepository.installDecensorBundle(directory);
    setInstallingBundle(false);
    if (!result.ok) { showToast(result.error.message, 'error'); return; }
    showToast(`去码模型包已安装：${result.value.id} · ${result.value.version}`, 'success');
    const models = await inferenceRepository.listModels();
    if (models.ok) setInstalledModels(models.value);
    editPreferences({ decensorModel: result.value.id });
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
      {(PREFERENCE_SECTIONS as readonly string[]).includes(selectedSettingsSection) && (
      <section className="preferences-panel" id={selectedSettingsSection} aria-label={sectionLabel(selectedSettingsSection)}>
        {/* No section title here: the sidebar already names the section, and one
            visible section at a time meant the heading only reserved a column of
            empty space beside every control. No autosave notice either — every
            control in this panel saves itself, so a line saying so on every
            section was chrome that never told anyone anything they could act on.
            A failed save still interrupts, through the toast. */}
        {preferenceState.loading ? <p className="server-list-message" role="status">正在读取偏好…</p> : (
          <div className="preferences-form">
            {selectedSettingsSection === 'settings-general' && <fieldset>
              <legend>启动时打开</legend>
              <SelectField name="startupRoute" aria-label="启动时打开" value={preferenceDraft.startupRoute} options={[{ value: 'home', label: '首页' }, { value: 'library', label: '档案库' }]} onChange={(value) => editPreferences({ startupRoute: value as PreferenceSnapshot['startupRoute'] })} />
              <PreferenceRadioFallback name="startupRoute" value={preferenceDraft.startupRoute} options={[['home', '首页'], ['library', '档案库']]} onChange={(value) => editPreferences({ startupRoute: value as PreferenceSnapshot['startupRoute'] })} />
            </fieldset>}
            {/* Theme belongs with the app-wide basics. 样式 is the custom-CSS
                surface, and 通用 used to hold nothing but the server list. */}
            {selectedSettingsSection === 'settings-general' && <fieldset>
              <legend>主题</legend>
              <SelectField name="theme" aria-label="主题" value={preferenceDraft.theme} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={(value) => editPreferences({ theme: value as PreferenceSnapshot['theme'] })} />
              <PreferenceRadioFallback name="theme" value={preferenceDraft.theme} options={[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]} onChange={(value) => editPreferences({ theme: value as PreferenceSnapshot['theme'] })} />
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
            {selectedSettingsSection === 'settings-reading' && (
              /* One switch per feature, and the selects below it offer real
                 choices only. They used to carry the off state themselves — a
                 backend list whose first entry was 关闭, a model list whose first
                 entry was 未选择 — so turning upscaling on meant knowing that two
                 unrelated controls had to stop saying "no". */
              <fieldset className="preference-switch">
                <legend>超分</legend>
                <label className="preference-toggle">
                  <input
                    type="checkbox"
                    name="upscaleEnabled"
                    checked={upscaleOn}
                    disabled={!runnableModels?.length}
                    onChange={(event) => editPreferences(event.target.checked
                      ? { upscaleBackend: 'auto', upscaleModel: preferenceDraft.upscaleModel || runnableModels?.[0]?.id || '' }
                      : { upscaleBackend: 'off' })}
                  />
                  <span>放大阅读页面</span>
                </label>
                {!runnableModels?.length && (
                  <p className="server-list-message" role="status">
                    {runnableModels ? '尚未安装可用的超分模型，安装后会出现在这里。' : '正在读取已安装模型…'}
                  </p>
                )}
              </fieldset>
            )}
            {selectedSettingsSection === 'settings-reading' && upscaleOn && runnableModels?.length ? <fieldset>
              <legend>超分模型</legend>
              {/* The models that are actually installed and runnable, not a name
                  typed from memory: a typo here used to fail silently at upscale
                  time. A model whose directory has no manifest has no recorded
                  scale, so it cannot be run and is not offered. */}
              <SelectField
                name="upscaleModel"
                aria-label="超分模型"
                value={preferenceDraft.upscaleModel || (runnableModels[0]?.id ?? '')}
                options={runnableModels.map(modelOption)}
                onChange={(value) => editPreferences({ upscaleModel: value })}
              />
              <PreferenceRadioFallback
                name="upscaleModel"
                value={preferenceDraft.upscaleModel || (runnableModels[0]?.id ?? '')}
                options={runnableModels.map((model) => [model.id, modelOption(model).label])}
                onChange={(value) => editPreferences({ upscaleModel: value })}
              />
            </fieldset> : null}
            {selectedSettingsSection === 'settings-reading' && upscaleOn && runnableModels?.length ? <fieldset>
              <legend>超分后端</legend>
              <SelectField name="upscaleBackend" aria-label="超分后端" value={preferenceDraft.upscaleBackend} options={[{ value: 'auto', label: '自动（优先 GPU）' }, { value: 'cpu', label: 'CPU' }]} onChange={(value) => editPreferences({ upscaleBackend: value as PreferenceSnapshot['upscaleBackend'] })} />
              <PreferenceRadioFallback name="upscaleBackend" value={preferenceDraft.upscaleBackend} options={[['auto', '自动（优先 GPU）'], ['cpu', 'CPU']]} onChange={(value) => editPreferences({ upscaleBackend: value as PreferenceSnapshot['upscaleBackend'] })} />
            </fieldset> : null}
            {selectedSettingsSection === 'settings-reading' && (
              <fieldset className="preference-switch">
                <legend>去码</legend>
                <label className="preference-toggle">
                  <input
                    type="checkbox"
                    name="decensorEnabled"
                    checked={decensorOn}
                    disabled={!decensorBundles?.length}
                    onChange={(event) => editPreferences({ decensorModel: event.target.checked ? decensorBundles?.[0]?.id ?? '' : '' })}
                  />
                  <span>修补被审查的区域</span>
                </label>
                <p className="settings-tool-hint">在阅读页面上运行检测与修补，结果按页缓存。修补模型固定使用 CPU。</p>
                {!decensorBundles?.length && installedModels && (
                  <>
                    {/* The bundle is 337 MB, a quarter of a gigabyte of it the
                        detector alone, so it does not travel as bytes and it is not
                        in the repository. Pointing at a directory that already has
                        it costs a copy and nothing else. */}
                    <p className="server-list-message" role="status">尚未安装去码模型包。选择 Aletheia-Lens 的 <code>_internal/models</code> 目录即可安装（约 337 MB，会复制到本机）。</p>
                    <div className="settings-actions">
                      <button className="settings-action" type="button" disabled={installingBundle} aria-busy={installingBundle} onClick={() => void installDecensorBundle()}>
                        {installingBundle ? '安装中…' : '选择目录安装'}
                      </button>
                    </div>
                  </>
                )}
              </fieldset>
            )}
            {selectedSettingsSection === 'settings-reading' && decensorOn && (decensorBundles?.length ?? 0) > 1 ? <fieldset>
              <legend>去码模型包</legend>
              <SelectField
                name="decensorModel"
                aria-label="去码模型包"
                value={preferenceDraft.decensorModel}
                options={(decensorBundles ?? []).map((model) => ({ value: model.id, label: `${model.id} · ${model.version}` }))}
                onChange={(value) => editPreferences({ decensorModel: value })}
              />
              <PreferenceRadioFallback
                name="decensorModel"
                value={preferenceDraft.decensorModel}
                options={(decensorBundles ?? []).map((model) => [model.id, `${model.id} · ${model.version}`] as [string, string])}
                onChange={(value) => editPreferences({ decensorModel: value })}
              />
            </fieldset> : null}
            {selectedSettingsSection === 'settings-advanced' && <label className="preference-select">图片缓存上限（GB）
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
            {selectedSettingsSection === 'settings-advanced' && <section className="cache-settings" aria-label="图片缓存">
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
                  {([
                    ['cover', cacheStats.byRendition.cover.bytes],
                    ['page-thumbnail', cacheStats.byRendition['page-thumbnail'].bytes],
                    ['reader-page', cacheStats.byRendition['reader-page'].bytes],
                    ['other', cacheStats.byRendition.other.bytes],
                  ] as const).filter(([, bytes]) => bytes > 0).map(([kind, bytes]) => (
                    <span
                      key={kind}
                      className={`cache-bar-slice is-${kind}`}
                      style={{ width: `${Math.max(1, Math.round((bytes / cacheStats.bytes) * 100))}%` }}
                    />
                  ))}
                </div>
              )}
              {cacheStats && (
                <div className="cache-breakdown" aria-label="图片缓存明细">
                  <span><i className="cache-swatch is-cover" aria-hidden="true" />封面 {formatCacheBytes(cacheStats.byRendition.cover.bytes)}</span>
                  <span><i className="cache-swatch is-page-thumbnail" aria-hidden="true" />页缩略图 {formatCacheBytes(cacheStats.byRendition['page-thumbnail'].bytes)}</span>
                  <span><i className="cache-swatch is-reader-page" aria-hidden="true" />阅读页 {formatCacheBytes(cacheStats.byRendition['reader-page'].bytes)}</span>
                  {cacheStats.byRendition.other.bytes > 0 && <span><i className="cache-swatch is-other" aria-hidden="true" />其他 {formatCacheBytes(cacheStats.byRendition.other.bytes)}</span>}
                </div>
              )}
            </section>}
          </div>
        )}
      </section>
      )}
      {selectedSettingsSection === 'settings-advanced' && (
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
          {APP_REPOSITORY && (
            <div><dt>仓库</dt><dd>
              <a href={APP_REPOSITORY} target="_blank" rel="noreferrer noopener">{APP_REPOSITORY.replace(/^https?:\/\//, '')}</a>
            </dd></div>
          )}
          {/* Absent until the project declares one in package.json. Better a
              missing row than a licence the app made up on its behalf. */}
          {APP_LICENSE && <div><dt>开源协议</dt><dd>{APP_LICENSE}</dd></div>}
          <div><dt>构建于</dt><dd>Tauri 2 · React 18 · SQLite</dd></div>
        </dl>
        <div className="about-links settings-actions">
          {APP_REPOSITORY && <a className="settings-action" href={APP_REPOSITORY} target="_blank" rel="noreferrer noopener">项目仓库</a>}
          <a className="settings-action" href="https://sugoi.gitbook.io/lanraragi" target="_blank" rel="noreferrer noopener">LANraragi 文档</a>
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
          <Link className="tool-card" to="/downloads">
            <RefreshCw aria-hidden="true" />
            <strong>任务列表</strong>
            <span>查看下载与上传任务的进度，重试失败项。</span>
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
