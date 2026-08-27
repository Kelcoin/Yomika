import { useEffect, useState, type FormEvent } from 'react';

import type { ServerRecord } from '../domain/library';
import type { ServerIdentity } from '../domain/server';
import type { CommandResult } from '../domain/result';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeLegacyRepository } from '../repositories/nativeLegacyRepository';
import { ServerSetupDialog } from './ServerSetupDialog';
import { usePreferences } from '../app/preferences';
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';

const repository = new NativeLibraryRepository();
const legacyRepository = new NativeLegacyRepository();

export function SettingsWorkspace() {
  const preferenceState = usePreferences();
  const [preferenceDraftOverride, setPreferenceDraft] = useState<PreferenceSnapshot>();
  const preferenceDraft = preferenceDraftOverride ?? preferenceState.preferences;
  const [preferencePending, setPreferencePending] = useState(false);
  const [preferenceMessage, setPreferenceMessage] = useState<string>();
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

  useEffect(() => {
    let active = true;
    void repository.listServers().then((result) => {
      if (!active) return;
      if (result.ok) setServers(result.value);
      else setLoadError(result.error.message);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreferencePending(true);
    setPreferenceMessage(undefined);
    const result = await preferenceState.save(preferenceDraft);
    if (result.ok) setPreferenceDraft(result.value);
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
    <div>
      <header className="workspace-heading">
        <p className="workspace-kicker">设备配置</p>
        <h1>设置</h1>
      </header>
      <section className="preferences-panel" aria-labelledby="preferences-title">
        <div>
          <p className="eyebrow">本机</p>
          <h2 id="preferences-title">阅读与存储</h2>
        </div>
        {preferenceState.loading ? <p className="server-list-message">正在读取偏好...</p> : (
          <form className="preferences-form" onSubmit={savePreferences}>
            <fieldset>
              <legend>主题</legend>
              <div className="segmented-control">
                {[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([value, label]) => (
                  <label key={value}><input type="radio" name="theme" value={value} checked={preferenceDraft.theme === value} onChange={() => setPreferenceDraft({ ...preferenceDraft, theme: value as PreferenceSnapshot['theme'] })} /><span>{label}</span></label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>默认布局</legend>
              <div className="segmented-control">
                {[['auto', '自动'], ['single', '单页'], ['double', '双页'], ['webtoon', '条漫']].map(([value, label]) => (
                  <label key={value}><input type="radio" name="layout" value={value} checked={preferenceDraft.defaultLayout === value} onChange={() => setPreferenceDraft({ ...preferenceDraft, defaultLayout: value as PreferenceSnapshot['defaultLayout'] })} /><span>{label}</span></label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>默认方向</legend>
              <div className="segmented-control">
                {[['ltr', '从左到右'], ['rtl', '从右到左']].map(([value, label]) => (
                  <label key={value}><input type="radio" name="direction" value={value} checked={preferenceDraft.defaultDirection === value} onChange={() => setPreferenceDraft({ ...preferenceDraft, defaultDirection: value as PreferenceSnapshot['defaultDirection'] })} /><span>{label}</span></label>
                ))}
              </div>
            </fieldset>
            <label className="preference-select">图片缓存上限
              <select value={preferenceDraft.cacheMaxBytes} onChange={(event) => setPreferenceDraft({ ...preferenceDraft, cacheMaxBytes: Number(event.target.value) })}>
                <option value={536_870_912}>512 MiB</option>
                <option value={2_147_483_648}>2 GiB</option>
                <option value={4_294_967_296}>4 GiB</option>
                <option value={8_589_934_592}>8 GiB</option>
              </select>
            </label>
            {(preferenceState.error || preferenceMessage) && (
              <p className={preferenceState.error || preferenceMessage !== '偏好已保存' ? 'form-error' : 'form-success'} role={preferenceState.error || preferenceMessage !== '偏好已保存' ? 'alert' : 'status'}>
                {preferenceState.error ?? preferenceMessage}
              </p>
            )}
            <button className="primary-action" type="submit" disabled={preferencePending}>{preferencePending ? '保存中' : '保存偏好'}</button>
          </form>
        )}
      </section>
      <section className="settings-section" aria-labelledby="legacy-config-title">
        <div>
          <p className="eyebrow">迁移</p>
          <h2 id="legacy-config-title">旧配置</h2>
        </div>
        <form className="legacy-import-form" onSubmit={importLegacyPreferences}>
          <label htmlFor="legacy-config-export">旧配置导出</label>
          <textarea
            id="legacy-config-export"
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
          <button className="secondary-action" type="submit" disabled={legacyPending || !legacyExport.trim()}>
            {legacyPending ? '导入中' : '导入旧配置'}
          </button>
        </form>
      </section>
      <section className="settings-section" aria-labelledby="legacy-full-title">
        <div>
          <p className="eyebrow">迁移</p>
          <h2 id="legacy-full-title">完整本地数据</h2>
          <p>导入历史、待看和不重复档案记录。服务器凭据仍需单独配置并保存到系统安全存储。</p>
        </div>
        <form className="legacy-import-form" onSubmit={importFullLegacyExport}>
          <label htmlFor="legacy-scope">数据范围 ID</label>
          <input id="legacy-scope" value={fullLegacyScope} onChange={(event) => setFullLegacyScope(event.target.value)} required />
          <label htmlFor="legacy-full-export">完整 JSON 导出</label>
          <textarea id="legacy-full-export" value={fullLegacyExport} onChange={(event) => setFullLegacyExport(event.target.value)} rows={5} required />
          {fullLegacyMessage && <p className={fullLegacyError ? 'form-error' : 'form-success'} role={fullLegacyError ? 'alert' : 'status'}>{fullLegacyMessage}</p>}
          <button className="secondary-action" type="submit" disabled={fullLegacyPending || !fullLegacyExport.trim() || !fullLegacyScope.trim()}>
            {fullLegacyPending ? '导入中' : '导入完整数据'}
          </button>
        </form>
      </section>
      <section className="settings-section" aria-labelledby="servers-title">
        <div>
          <p className="eyebrow">连接</p>
          <h2 id="servers-title">服务器</h2>
          <p>LANraragi 连接信息保存在本机，凭据进入系统安全存储。</p>
        </div>
        <ServerSetupDialog onSave={saveServer} />
      </section>
      <div className="server-list" aria-live="polite">
        {loading && <p className="server-list-message">正在读取服务器...</p>}
        {!loading && loadError && <p className="form-error" role="alert">{loadError}</p>}
        {!loading && !loadError && servers.length === 0 && (
          <p className="server-list-message">尚未添加 LANraragi 服务器。</p>
        )}
        {servers.map((server) => (
          <article className="server-row" key={server.id}>
            <div>
              <h3>{server.name}</h3>
              <p>{server.baseUrl}</p>
            </div>
            <span className="server-state">已配置</span>
          </article>
        ))}
      </div>
    </div>
  );
}
