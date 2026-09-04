import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { RefreshCw, Upload, CopyCheck, Eraser } from 'lucide-react';
import { SelectField } from './SelectField';
import { EhRouteWorkspace } from '../app/routes';
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
import { ACCENT_PRESETS, DEFAULT_ACCENT_COLOR, contrastRatio, isAccessibleAccent, normalizeAccentColor } from '../lib/accentColor';
import { NativeCacheRepository, type CacheStats } from '../repositories/nativeCacheRepository';

function PreferenceRadioFallback({ name, value, options, onChange }: { name: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <div className="select-compat-radios" aria-hidden="false">{options.map(([option, label]) => <label key={option}><input type="radio" name={`${name}-compat`} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{label}</span></label>)}</div>;
}
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';

const repository = new NativeLibraryRepository();
const legacyRepository = new NativeLegacyRepository();
const cacheRepository = new NativeCacheRepository();
const GIB = 1_073_741_824;

function formatCacheBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${index === 0 ? amount.toFixed(0) : amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')} ${units[index]}`;
}

const settingsSections = [
  { id: 'settings-preferences', label: '阅读与存储' },
  { id: 'settings-server', label: '服务器连接' },
  { id: 'settings-eh', label: 'E-Hentai' },
  { id: 'settings-migration', label: '数据迁移' },
  { id: 'settings-sync', label: '同步账户' },
  { id: 'settings-tools', label: '工具' },
] as const;

export function SettingsWorkspace() {
  const location = useLocation();
  const { showToast } = useToast();
  const preferenceState = usePreferences();
  const [preferenceDraftOverride, setPreferenceDraft] = useState<PreferenceSnapshot>();
  const preferenceDraft = preferenceDraftOverride ?? preferenceState.preferences;
  const accentPreview = normalizeAccentColor(preferenceDraft.accentColor);
  const [preferencePending, setPreferencePending] = useState(false);
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
  const [selectedSettingsSection, setSelectedSettingsSection] = useState<(typeof settingsSections)[number]['id']>('settings-preferences');
  const [cacheStats, setCacheStats] = useState<CacheStats>();
  const [cacheClearing, setCacheClearing] = useState(false);

  // Saving preferences, clearing the cache and migrating data all report through
  // the shared toast now; the inline lines they used to print were easy to miss.
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
    if (selectedSettingsSection === 'settings-preferences') void refreshCacheStats();
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

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreferencePending(true);
    setPreferenceMessage(undefined);
    setPreferenceError(false);
    const result = await preferenceState.save({
      ...preferenceDraft,
      accentColor: normalizeAccentColor(preferenceDraft.accentColor) ?? DEFAULT_ACCENT_COLOR,
    });
    if (result.ok) setPreferenceDraft(result.value);
    else setPreferenceError(true);
    setPreferenceMessage(result.ok ? '偏好已保存' : result.error.message);
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
      {selectedSettingsSection === 'settings-preferences' && (
      <section className="preferences-panel" id="settings-preferences" aria-labelledby="preferences-title">
        <div>
          <h2 id="preferences-title">阅读与存储</h2>
        </div>
        {preferenceState.loading ? <p className="server-list-message" role="status">正在读取偏好…</p> : (
          <form className="preferences-form" onSubmit={savePreferences}>
            <fieldset>
              <legend>主题</legend>
              <SelectField name="theme" aria-label="主题" value={preferenceDraft.theme} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={(value) => setPreferenceDraft({ ...preferenceDraft, theme: value as PreferenceSnapshot['theme'] })} />
              <PreferenceRadioFallback name="theme" value={preferenceDraft.theme} options={[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]} onChange={(value) => setPreferenceDraft({ ...preferenceDraft, theme: value as PreferenceSnapshot['theme'] })} />
            </fieldset>
            <fieldset>
              <legend>默认布局</legend>
              <SelectField name="layout" aria-label="默认布局" value={preferenceDraft.defaultLayout} options={[{ value: 'auto', label: '自动' }, { value: 'single', label: '单页' }, { value: 'double', label: '双页' }, { value: 'webtoon', label: '条漫' }]} onChange={(value) => setPreferenceDraft({ ...preferenceDraft, defaultLayout: value as PreferenceSnapshot['defaultLayout'] })} />
              <PreferenceRadioFallback name="layout" value={preferenceDraft.defaultLayout} options={[['auto', '自动'], ['single', '单页'], ['double', '双页'], ['webtoon', '条漫']]} onChange={(value) => setPreferenceDraft({ ...preferenceDraft, defaultLayout: value as PreferenceSnapshot['defaultLayout'] })} />
            </fieldset>
            <fieldset>
              <legend>默认方向</legend>
              <SelectField name="direction" aria-label="默认方向" value={preferenceDraft.defaultDirection} options={[{ value: 'ltr', label: '从左到右' }, { value: 'rtl', label: '从右到左' }]} onChange={(value) => setPreferenceDraft({ ...preferenceDraft, defaultDirection: value as PreferenceSnapshot['defaultDirection'] })} />
              <PreferenceRadioFallback name="direction" value={preferenceDraft.defaultDirection} options={[['ltr', '从左到右'], ['rtl', '从右到左']]} onChange={(value) => setPreferenceDraft({ ...preferenceDraft, defaultDirection: value as PreferenceSnapshot['defaultDirection'] })} />
            </fieldset>
            <fieldset className="accent-picker">
              <legend>强调色</legend>
              <div className="accent-swatches">
                {ACCENT_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className={`accent-swatch${preferenceDraft.accentColor === preset.value ? ' is-active' : ''}`}
                    style={{ background: preset.value }}
                    aria-label={preset.label}
                    aria-pressed={preferenceDraft.accentColor === preset.value}
                    onClick={() => setPreferenceDraft({ ...preferenceDraft, accentColor: preset.value })}
                  />
                ))}
              </div>
              <label className="preference-select">自定义色值
                <input
                  name="accentColor"
                  aria-label="自定义强调色"
                  value={preferenceDraft.accentColor}
                  spellCheck={false}
                  // Keep the raw text while typing: expanding #abc mid-word
                  // would rewrite the field under the cursor. Normalization
                  // happens on save.
                  onChange={(event) => setPreferenceDraft({ ...preferenceDraft, accentColor: event.target.value.trim().toLowerCase() })}
                />
              </label>
              {accentPreview
                ? !isAccessibleAccent(accentPreview) && (
                  <p className="form-error" role="alert">
                    与白色文字的对比度为 {contrastRatio(accentPreview, '#ffffff')}:1，低于 WCAG AA 要求的 4.5:1
                  </p>
                )
                : <p className="form-error" role="alert">强调色需要是 #rrggbb 形式的十六进制色值</p>}
            </fieldset>
            <label className="preference-select">预加载页数
              <input
                name="prefetchPages"
                aria-label="预加载页数"
                type="number"
                min={0}
                max={5}
                step={1}
                value={preferenceDraft.prefetchPages}
                onChange={(event) => setPreferenceDraft({ ...preferenceDraft, prefetchPages: Number(event.target.value) })}
              />
            </label>
            <label className="preference-select">封面并发请求
              <input
                name="coverConcurrency"
                aria-label="封面并发请求"
                type="number"
                min={1}
                max={8}
                step={1}
                value={preferenceDraft.coverConcurrency}
                onChange={(event) => setPreferenceDraft({ ...preferenceDraft, coverConcurrency: Number(event.target.value) })}
              />
            </label>
            <fieldset>
              <legend>超分后端</legend>
              <SelectField name="upscaleBackend" aria-label="超分后端" value={preferenceDraft.upscaleBackend} options={[{ value: 'off', label: '关闭' }, { value: 'cpu', label: 'CPU' }, { value: 'auto', label: '自动（优先 GPU）' }]} onChange={(value) => setPreferenceDraft({ ...preferenceDraft, upscaleBackend: value as PreferenceSnapshot['upscaleBackend'] })} />
              <PreferenceRadioFallback name="upscaleBackend" value={preferenceDraft.upscaleBackend} options={[['off', '关闭'], ['cpu', 'CPU'], ['auto', '自动（优先 GPU）']]} onChange={(value) => setPreferenceDraft({ ...preferenceDraft, upscaleBackend: value as PreferenceSnapshot['upscaleBackend'] })} />
            </fieldset>
            {preferenceDraft.upscaleBackend !== 'off' && (
              <label className="preference-select">超分模型
                <input
                  name="upscaleModel"
                  aria-label="超分模型"
                  value={preferenceDraft.upscaleModel}
                  spellCheck={false}
                  placeholder="例如 real-esrgan-anime-x2"
                  onChange={(event) => setPreferenceDraft({ ...preferenceDraft, upscaleModel: event.target.value })}
                />
              </label>
            )}
            <label className="preference-select">图片缓存上限（GB）
              <input
                name="cacheMaxBytes"
                aria-label="图片缓存上限"
                type="number"
                min={1}
                max={32}
                step={1}
                value={preferenceDraft.cacheMaxBytes / GIB}
                onChange={(event) => setPreferenceDraft({ ...preferenceDraft, cacheMaxBytes: Number(event.target.value) * GIB })}
              />
            </label>
            <section className="cache-settings" aria-labelledby="cache-settings-title">
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
            </section>
            <button className="primary-action" type="submit" disabled={preferencePending} aria-busy={preferencePending}>{preferencePending ? '保存中…' : '保存偏好'}</button>
          </form>
        )}
      </section>
      )}
      {selectedSettingsSection === 'settings-migration' && (
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
      {selectedSettingsSection === 'settings-server' && (
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
      {selectedSettingsSection === 'settings-tools' && (
      <section className="settings-section" id="settings-tools" aria-labelledby="tools-title">
        <div>
          <h2 id="tools-title">工具</h2>
        </div>
        {/* Index only: the upload and dedup workspaces are full routes, so they
            get their own scroll area instead of being squeezed in here. */}
        <div className="settings-tools-links">
          <Link className="secondary-action" to="/tools/upload"><Upload aria-hidden="true" />上传档案</Link>
          <Link className="secondary-action" to="/tools/dedup"><CopyCheck aria-hidden="true" />重复档案查重</Link>
        </div>
      </section>
      )}
        </div>
      </div>
    </div>
  );
}
