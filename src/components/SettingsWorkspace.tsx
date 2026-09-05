import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { RefreshCw, Upload, CopyCheck, Eraser } from 'lucide-react';
import { SelectField } from './SelectField';
import { EhRouteWorkspace } from './EhRouteWorkspace';
import { useToast } from './Toast';

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

function PreferenceRadioFallback({ name, value, options, onChange }: { name: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <div className="select-compat-radios" aria-hidden="false">{options.map(([option, label]) => <label key={option}><input type="radio" name={`${name}-compat`} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{label}</span></label>)}</div>;
}
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';

const repository = new NativeLibraryRepository();
const legacyRepository = new NativeLegacyRepository();
const cacheRepository = new NativeCacheRepository();
const inferenceRepository = new NativeInferenceRepository();
const GIB = 1_073_741_824;
/** Vite inlines this at build time from package.json, so the About page cannot
 * drift from the shipped version the way a hand-written string would. */
const APP_VERSION = __APP_VERSION__;

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
const PREFERENCE_SECTIONS = ['settings-reading', 'settings-appearance', 'settings-advanced'] as const;

export function SettingsWorkspace() {
  const location = useLocation();
  const { showToast } = useToast();
  const preferenceState = usePreferences();
  const [preferenceDraftOverride, setPreferenceDraft] = useState<PreferenceSnapshot>();
  const preferenceDraft = preferenceDraftOverride ?? preferenceState.preferences;
  const [preferencePending, setPreferencePending] = useState(false);
  const [preferenceSavedAt, setPreferenceSavedAt] = useState<number>();
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
  const [cacheStats, setCacheStats] = useState<CacheStats>();
  const [cacheClearing, setCacheClearing] = useState(false);
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>();
  // A model with no recorded scale cannot be run, so it is not a choice.
  const runnableModels = installedModels?.filter((model) => model.scale);
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
    setPreferencePending(true);
    setPreferenceMessage(undefined);
    setPreferenceError(false);
    const result = await preferenceState.save(next);
    if (result.ok) {
      setPreferenceDraft(result.value);
      setPreferenceSavedAt(Date.now());
    } else {
      setPreferenceError(true);
      setPreferenceMessage(result.error.message);
    }
    setPreferencePending(false);
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
      <div className="settings-layout">
        <aside className="settings-sidebar" aria-label="设置分类">
          <nav className="settings-nav">
            {settingsSections.map((section, index) => (
              <a
                className={selectedSettingsSection === section.id ? 'is-active' : undefined}
                href={`#${section.id}`}
                key={section.id}
                aria-current={selectedSettingsSection === section.id ? 'page' : undefined}
                onClick={(event) => { event.preventDefault(); setSelectedSettingsSection(section.id); }}
              >
                <span className="settings-nav-index">{String(index + 1).padStart(2, '0')}</span>
                <span>{section.label}</span>
              </a>
            ))}
          </nav>
        </aside>
        <div className="settings-content">
      {(PREFERENCE_SECTIONS as readonly string[]).includes(selectedSettingsSection) && (
      <section className="preferences-panel" id={selectedSettingsSection} aria-labelledby="preferences-title">
        <div className="preferences-panel-heading">
          <h2 id="preferences-title">{selectedSettingsSection === 'settings-reading' ? '阅读' : selectedSettingsSection === 'settings-appearance' ? '样式' : '高级'}</h2>
          {/* Autosave has to say so, or a change looks unsaved. */}
          <span className="preferences-autosave" role="status">
            {preferencePending ? '正在保存…' : preferenceSavedAt ? '更改已自动保存' : '更改会自动保存'}
          </span>
        </div>
        {preferenceState.loading ? <p className="server-list-message" role="status">正在读取偏好…</p> : (
          <div className="preferences-form">
            {selectedSettingsSection === 'settings-appearance' && <fieldset>
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
                    onClick={() => editPreferences({ customCss: preset.css })}
                  >
                    <strong>{preset.label}</strong>
                    <span>{preset.description}</span>
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
            {selectedSettingsSection === 'settings-reading' && <fieldset>
              <legend>超分后端</legend>
              <SelectField name="upscaleBackend" aria-label="超分后端" value={preferenceDraft.upscaleBackend} options={[{ value: 'off', label: '关闭' }, { value: 'cpu', label: 'CPU' }, { value: 'auto', label: '自动（优先 GPU）' }]} onChange={(value) => editPreferences({ upscaleBackend: value as PreferenceSnapshot['upscaleBackend'] })} />
              <PreferenceRadioFallback name="upscaleBackend" value={preferenceDraft.upscaleBackend} options={[['off', '关闭'], ['cpu', 'CPU'], ['auto', '自动（优先 GPU）']]} onChange={(value) => editPreferences({ upscaleBackend: value as PreferenceSnapshot['upscaleBackend'] })} />
            </fieldset>}
            {selectedSettingsSection === 'settings-reading' && preferenceDraft.upscaleBackend !== 'off' && (
              /* The models that are actually installed and runnable, not a name
                 typed from memory: a typo here used to fail silently at upscale
                 time. A model whose directory has no manifest has no recorded
                 scale, so it cannot be run and is not offered. */
              runnableModels?.length
                ? <fieldset>
                    <legend>超分模型</legend>
                    <SelectField
                      name="upscaleModel"
                      aria-label="超分模型"
                      value={preferenceDraft.upscaleModel}
                      options={[{ value: '', label: '未选择' }, ...runnableModels.map(modelOption)]}
                      onChange={(value) => editPreferences({ upscaleModel: value })}
                    />
                    <PreferenceRadioFallback
                      name="upscaleModel"
                      value={preferenceDraft.upscaleModel}
                      options={runnableModels.map((model) => [model.id, modelOption(model).label])}
                      onChange={(value) => editPreferences({ upscaleModel: value })}
                    />
                  </fieldset>
                : <p className="server-list-message" role="status">
                    {runnableModels ? '尚未安装可用的超分模型，安装后会出现在这里。' : '正在读取已安装模型…'}
                  </p>
            )}
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
            {selectedSettingsSection === 'settings-advanced' && <section className="cache-settings" aria-labelledby="cache-settings-title">
              <div className="cache-settings-heading">
                {/* Clearing sits next to the number it changes. */}
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
                <span id="cache-settings-title">图片缓存</span>
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
          <div className="settings-actions">
            <button className="secondary-action" type="button" disabled={migrationPending} aria-busy={migrationPending} onClick={() => void runMigrationExport()}>
              {migrationPending ? '处理中…' : '导出数据'}
            </button>
            <button className="primary-action" type="submit" disabled={migrationPending || !migrationText.trim()} aria-busy={migrationPending}>
              {migrationPending ? '处理中…' : '导入数据'}
            </button>
          </div>
        </form>
      </section>
      )}
      {selectedSettingsSection === 'settings-general' && (
      <>
      <section className="settings-section" id="settings-server" aria-labelledby="servers-title">
        <div>
          <h2 id="servers-title">服务器</h2>
          <p>LANraragi 连接信息保存在本机，凭据进入系统安全存储。若凭据失效，使用同一地址再次保存即可更新 API Key。</p>
        </div>
        <ServerSetupDialog onSave={saveServer} />
      </section>
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
        {!loading && !loadError && servers.length === 0 && (
          <p className="server-list-message">尚未添加 LANraragi 服务器。</p>
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
      </>
      )}
      {selectedSettingsSection === 'settings-sync' && (
      <section className="settings-section" id="settings-sync" aria-labelledby="sync-settings-title">
        <div className="settings-sync-content"><SyncWorkspace embedded /></div>
      </section>
      )}
      {selectedSettingsSection === 'settings-eh' && (
      /* The sidebar no longer carries an E-Hentai entry; the account form and the
         browse workspace live here. */
      <section className="settings-section" id="settings-eh" aria-labelledby="eh-settings-title">
        <div>
          <h2 id="eh-settings-title">E-Hentai</h2>
        </div>
        <div className="settings-eh-content"><EhRouteWorkspace /></div>
      </section>
      )}
      {selectedSettingsSection === 'settings-about' && (
      <section className="settings-section" id="settings-about" aria-labelledby="about-title">
        <div className="about-hero">
          <span className="about-mark" aria-hidden="true">読</span>
          <div>
            <h2 id="about-title">Yomika</h2>
            <p>LANraragi 的桌面客户端。列表与搜索交给服务器，封面与阅读进度留在本机。</p>
          </div>
          <span className="about-version">v{APP_VERSION}</span>
        </div>
        <dl className="settings-about-list">
          <div><dt>运行环境</dt><dd>Tauri 2 · React 18 · SQLite</dd></div>
          <div><dt>数据目录</dt><dd>系统的应用数据目录（Tauri <code>app_data_dir</code>）</dd></div>
          <div><dt>服务器凭据</dt><dd>存放在系统密钥库，不进入导出内容</dd></div>
          <div><dt>图片缓存</dt><dd>{cacheStats ? formatCacheBytes(cacheStats.bytes) : '进入「高级」查看'}</dd></div>
        </dl>
        <div className="about-links">
          <a className="secondary-action" href="https://sugoi.gitbook.io/lanraragi" target="_blank" rel="noreferrer noopener">LANraragi 文档</a>
          <Link className="secondary-action" to="/settings?section=advanced">数据与缓存</Link>
        </div>
      </section>
      )}
      {selectedSettingsSection === 'settings-tools' && (
      <section className="settings-section" id="settings-tools" aria-labelledby="tools-title">
        <div>
          <h2 id="tools-title">工具</h2>
          <p>每个工具都是独立页面，有自己的滚动区域与状态。</p>
        </div>
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
      </div>
    </div>
  );
}
