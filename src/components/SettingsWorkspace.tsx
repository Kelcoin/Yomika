import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { SelectField } from './SelectField';

import type { ServerRecord } from '../domain/library';
import type { ServerIdentity } from '../domain/server';
import type { CommandResult } from '../domain/result';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeLegacyRepository } from '../repositories/nativeLegacyRepository';
import { ServerSetupDialog } from './ServerSetupDialog';
import { SyncWorkspace } from './SyncWorkspace';
import { usePreferences } from '../app/preferences';
import { NativeCacheRepository, type CacheStats } from '../repositories/nativeCacheRepository';
import { NativeInferenceRepository } from '../repositories/nativeInferenceRepository';
import { MODEL_MIRROR_PRESETS, buildModelAssetUrl } from '../domain/modelRelease';

function PreferenceRadioFallback({ name, value, options, onChange }: { name: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <div className="select-compat-radios" aria-hidden="false">{options.map(([option, label]) => <label key={option}><input type="radio" name={`${name}-compat`} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{label}</span></label>)}</div>;
}
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';

const repository = new NativeLibraryRepository();
const legacyRepository = new NativeLegacyRepository();
const cacheRepository = new NativeCacheRepository();
const inferenceRepository = new NativeInferenceRepository();
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
  { id: 'settings-migration', label: '数据迁移' },
  { id: 'settings-sync', label: '同步账户' },
  { id: 'settings-models', label: '模型' },
] as const;

export function SettingsWorkspace() {
  const location = useLocation();
  const preferenceState = usePreferences();
  const [preferenceDraftOverride, setPreferenceDraft] = useState<PreferenceSnapshot>();
  const preferenceDraft = preferenceDraftOverride ?? preferenceState.preferences;
  const [preferencePending, setPreferencePending] = useState(false);
  const [preferenceMessage, setPreferenceMessage] = useState<string>();
  const [preferenceError, setPreferenceError] = useState(false);
  const [legacyExport, setLegacyExport] = useState('');
  const [legacyPending, setLegacyPending] = useState(false);
  const [legacyMessage, setLegacyMessage] = useState<string>();
  const [legacyError, setLegacyError] = useState(false);
  const [fullLegacyExport, setFullLegacyExport] = useState('');
  const [fullLegacyScope, setFullLegacyScope] = useState('');
  const [fullLegacyPending, setFullLegacyPending] = useState(false);
  const [fullLegacyMessage, setFullLegacyMessage] = useState<string>();
  const [fullLegacyError, setFullLegacyError] = useState(false);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [loadRetryable, setLoadRetryable] = useState(false);
  const [serverLoadAttempt, setServerLoadAttempt] = useState(0);
  const [selectedSettingsSection, setSelectedSettingsSection] = useState<(typeof settingsSections)[number]['id']>('settings-preferences');
  const [cacheStats, setCacheStats] = useState<CacheStats>();
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheMessage, setCacheMessage] = useState<string>();
  const [cacheError, setCacheError] = useState(false);
  const [modelMirror, setModelMirror] = useState('direct');
  const [modelPrefix, setModelPrefix] = useState('');
  const [modelMessage, setModelMessage] = useState<string>();
  const [modelPending, setModelPending] = useState(false);
  const [modelManifest, setModelManifest] = useState<unknown>();

  async function validateModelArchive(file: File) {
    setModelPending(true); setModelMessage(undefined);
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    if (!modelManifest) { setModelMessage('请先选择模型清单 JSON'); setModelPending(false); return; }
    const result = await inferenceRepository.validateModelArchive(bytes, modelManifest);
    setModelMessage(result.ok ? '模型验证通过' : result.error.message);
    setModelPending(false);
  }

  async function fetchModelManifest() {
    setModelPending(true); setModelMessage(undefined);
    const prefix = modelMirror === 'custom' ? modelPrefix : (MODEL_MIRROR_PRESETS.find((item) => item.id === modelMirror)?.prefix ?? '');
    const result = await inferenceRepository.fetchReleaseManifest(prefix, 'Kelcoin/Yomika', 'v1');
    if (result.ok) { setModelManifest(result.value); setModelMessage('已获取模型清单'); } else setModelMessage(result.error.message);
    setModelPending(false);
  }

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
    setCacheMessage(undefined);
    setCacheError(false);
    const result = await cacheRepository.clearImages();
    if (result.ok) {
      setCacheMessage(`已释放 ${formatCacheBytes(result.value.bytesFreed)}，保留 ${formatCacheBytes(result.value.protectedBytes)} 受保护缓存`);
      await refreshCacheStats();
    } else {
      setCacheMessage(result.error.message);
      setCacheError(true);
    }
    setCacheClearing(false);
  }

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreferencePending(true);
    setPreferenceMessage(undefined);
    setPreferenceError(false);
    const result = await preferenceState.save(preferenceDraft);
    if (result.ok) setPreferenceDraft(result.value);
    else setPreferenceError(true);
    setPreferenceMessage(result.ok ? '偏好已保存' : result.error.message);
    setPreferencePending(false);
  }

  async function importLegacyPreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLegacyPending(true);
    setLegacyMessage(undefined);
    setLegacyError(false);
    const result = await preferenceState.importLegacy(legacyExport.trim());
    if (result.ok) {
      setPreferenceDraft(result.value.preferences);
      setLegacyExport('');
      setLegacyMessage(`已导入 ${result.value.importedCount} 项普通偏好`);
    } else {
      setLegacyMessage(result.error.message);
      setLegacyError(true);
    }
    setLegacyPending(false);
  }

  async function importFullLegacyExport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFullLegacyPending(true);
    setFullLegacyMessage(undefined);
    setFullLegacyError(false);
    const result = await legacyRepository.importExport(fullLegacyScope.trim(), fullLegacyExport.trim());
    if (result.ok) {
      setFullLegacyExport('');
      setFullLegacyMessage(`已导入 ${result.value} 项本地记录`);
      const refreshed = await repository.listServers();
      if (refreshed.ok) setServers(refreshed.value);
    } else {
      setFullLegacyMessage(result.error.message);
      setFullLegacyError(true);
    }
    setFullLegacyPending(false);
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
                <span id="cache-settings-title">图片缓存</span>
                <strong>{cacheStats ? formatCacheBytes(cacheStats.bytes) : '正在统计…'}</strong>
              </div>
              {cacheStats && (
                <div className="cache-breakdown" aria-label="图片缓存明细">
                  <span>封面 {formatCacheBytes(cacheStats.byRendition.cover.bytes)}</span>
                  <span>页缩略图 {formatCacheBytes(cacheStats.byRendition['page-thumbnail'].bytes)}</span>
                  <span>阅读页 {formatCacheBytes(cacheStats.byRendition['reader-page'].bytes)}</span>
                  {cacheStats.byRendition.other.bytes > 0 && <span>其他 {formatCacheBytes(cacheStats.byRendition.other.bytes)}</span>}
                </div>
              )}
              {cacheMessage && <p className={cacheError ? 'form-error' : 'form-success'} role={cacheError ? 'alert' : 'status'}>{cacheMessage}</p>}
              <button className="secondary-action" type="button" disabled={cacheClearing} aria-busy={cacheClearing} onClick={() => void clearImageCache()}>
                {cacheClearing ? '正在清空…' : '清空图片缓存'}
              </button>
            </section>
            {(preferenceState.error || preferenceMessage) && (
              <p className={preferenceState.error || preferenceError ? 'form-error' : 'form-success'} role={preferenceState.error || preferenceError ? 'alert' : 'status'}>
                {preferenceState.error ?? preferenceMessage}
              </p>
            )}
            <button className="primary-action" type="submit" disabled={preferencePending} aria-busy={preferencePending}>{preferencePending ? '保存中…' : '保存偏好'}</button>
          </form>
        )}
      </section>
      )}
      {selectedSettingsSection === 'settings-models' && (
        <section className="preferences-panel" id="settings-models" aria-labelledby="models-title">
          <h2 id="models-title">模型</h2>
          <label className="preference-select">下载源
            <select value={modelMirror} onChange={(event) => setModelMirror(event.target.value)}>
              {MODEL_MIRROR_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              <option value="custom">自定义</option>
            </select>
          </label>
          {modelMirror === 'custom' && <label className="preference-select">加速前缀<input value={modelPrefix} onChange={(event) => setModelPrefix(event.target.value)} placeholder="https://example.com/" /></label>}
          <button type="button" disabled={modelPending} onClick={() => void fetchModelManifest()}>获取最新模型清单</button>
          <label className="preference-select">导入模型压缩包
            <input type="file" accept=".json,application/json" disabled={modelPending} onChange={async (event) => { const file = event.target.files?.[0]; if (file) { try { setModelManifest(JSON.parse(await file.text())); setModelMessage('已读取模型清单'); } catch { setModelMessage('模型清单 JSON 无效'); } } }} />
          </label>
          <label className="preference-select">模型文件
            <input type="file" accept=".zip,application/zip" disabled={modelPending} onChange={(event) => { const file = event.target.files?.[0]; if (file) void validateModelArchive(file); }} />
          </label>
          {modelMessage && <p role="status">{modelMessage}</p>}
          {Boolean(modelManifest) && typeof modelManifest === 'object' && !!Array.isArray((modelManifest as { assets?: unknown[] }).assets) && <ul aria-label="模型资产">
            {((modelManifest as { assets: Array<{ path: string; size: number }> }).assets).map((asset) => {
              const prefix = modelMirror === 'custom' ? modelPrefix : (MODEL_MIRROR_PRESETS.find((item) => item.id === modelMirror)?.prefix ?? '');
              return <li key={asset.path}><a href={buildModelAssetUrl(prefix, 'Kelcoin/Yomika', 'v1', asset.path)} target="_blank" rel="noreferrer">下载 {asset.path}</a> <small>{asset.size} bytes</small></li>;
            })}
          </ul>}
        </section>
      )}
      {selectedSettingsSection === 'settings-migration' && (
      <>
      <section className="settings-section" id="settings-migration" aria-labelledby="legacy-config-title">
        <div>
          <h2 id="legacy-config-title">旧配置</h2>
        </div>
        <form className="legacy-import-form" onSubmit={importLegacyPreferences}>
          <label htmlFor="legacy-config-export">旧配置导出</label>
          <textarea
            id="legacy-config-export"
            name="legacyConfigExport"
            autoComplete="off"
            spellCheck={false}
            value={legacyExport}
            onChange={(event) => setLegacyExport(event.target.value)}
            rows={4}
            required
          />
          {legacyMessage && (
            <p className={legacyError ? 'form-error' : 'form-success'} role={legacyError ? 'alert' : 'status'}>
              {legacyMessage}
            </p>
          )}
          <button className="secondary-action" type="submit" disabled={legacyPending || !legacyExport.trim()} aria-busy={legacyPending}>
            {legacyPending ? '导入中…' : '导入旧配置'}
          </button>
        </form>
      </section>
      <section className="settings-section settings-section-subsection" aria-labelledby="legacy-full-title">
        <div>
          <h2 id="legacy-full-title">完整本地数据</h2>
          <p>导入历史、待看和不重复档案记录。服务器凭据仍需单独配置并保存到系统安全存储。</p>
        </div>
        <form className="legacy-import-form" onSubmit={importFullLegacyExport}>
          <label htmlFor="legacy-scope">数据范围 ID</label>
          <input id="legacy-scope" name="legacyScope" autoComplete="off" spellCheck={false} value={fullLegacyScope} onChange={(event) => setFullLegacyScope(event.target.value)} required />
          <label htmlFor="legacy-full-export">完整 JSON 导出</label>
          <textarea id="legacy-full-export" name="legacyFullExport" autoComplete="off" spellCheck={false} value={fullLegacyExport} onChange={(event) => setFullLegacyExport(event.target.value)} rows={5} required />
          {fullLegacyMessage && <p className={fullLegacyError ? 'form-error' : 'form-success'} role={fullLegacyError ? 'alert' : 'status'}>{fullLegacyMessage}</p>}
          <button className="secondary-action" type="submit" disabled={fullLegacyPending || !fullLegacyExport.trim() || !fullLegacyScope.trim()} aria-busy={fullLegacyPending}>
            {fullLegacyPending ? '导入中…' : '导入完整数据'}
          </button>
        </form>
      </section>
      </>
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
        </div>
      </div>
    </div>
  );
}
