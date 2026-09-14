import { KeyRound, RefreshCw, Waypoints } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import type { ServerRecord } from '../domain/library';
import type { WebdavAccount } from '../domain/syncWire';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSyncRepository } from '../repositories/nativeSyncRepository';
import { EmptyState } from './EmptyState';
import { LoadingIndicator } from './LoadingIndicator';
import { useToast } from './Toast';

const libraryRepository = new NativeLibraryRepository();
const syncRepository = new NativeSyncRepository();

/** The account id is an internal key, never shown or asked for. It is derived
 * from the account name, so saving with the same 名称 updates that account
 * instead of piling up an indistinguishable copy. */
function webdavAccountIdFor(label: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `dav-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Account and sync state shared by the standalone /sync workspace and the
 * settings rows: one loader, one save, one sync runner, everything reported
 * through the shared toast. `enabled` gates the load so the settings page only
 * fetches accounts when its 同步 section is actually shown. */
export function useSyncSettings(enabled = true) {
  const { showToast } = useToast();
  const [accounts, setAccounts] = useState<WebdavAccount[]>([]);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState<string>();

  // Both reach the toast as well as the page. This panel is embedded in settings,
  // where every neighbouring control reports that way, and an error rendered only
  // at the bottom of a scrolled panel is an error nobody sees.
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);
  useEffect(() => {
    if (message) showToast(message, 'success');
  }, [message, showToast]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    void Promise.all([syncRepository.listAccounts(), libraryRepository.listServers()]).then(([accountResult, serverResult]) => {
      if (!active) return;
      if (accountResult.ok) setAccounts(accountResult.value);
      else setError(accountResult.error.message);
      if (serverResult.ok) setServers(serverResult.value);
      setLoading(false);
    });
    return () => { active = false; };
  }, [enabled]);

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    const form = new FormData(formElement);
    const label = String(form.get('label') ?? '').trim();
    const input = {
      id: webdavAccountIdFor(label),
      label,
      baseUrl: String(form.get('baseUrl') ?? '').trim(),
      username: String(form.get('username') ?? '').trim(),
      credential: String(form.get('credential') ?? ''),
    };
    try {
      const saved = await syncRepository.saveAccount(input);
      if (!saved.ok) {
        setError(saved.error.message);
        return;
      }
      setAccounts((current) => [...current.filter((account) => account.id !== saved.value.id), saved.value]
        .sort((left, right) => left.label.localeCompare(right.label)));
      const key = await syncRepository.createKey(saved.value.id);
      if (!key.ok) {
        setError(`账户已保存，但同步密钥创建失败：${key.error.message}`);
        return;
      }
      formElement.reset();
      setMessage('同步账户已保存在本机');
    } finally {
      setSaving(false);
    }
  }

  async function runSync(account: WebdavAccount) {
    const server = servers[0];
    if (!server) {
      setError('请先在设置中添加 LANraragi 服务器');
      return;
    }
    setSyncingId(account.id);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await syncRepository.syncWebdavScope(account.id, server.scopeId);
      if (result.ok) setMessage(result.value === 0 ? '没有需要同步的变更' : `已同步 ${result.value} 项变更（含从远端拉回的部分）`);
      else setError(result.error.message);
    } finally {
      setSyncingId(undefined);
    }
  }

  return { accounts, servers, loading, error, message, saving, syncingId, saveAccount, runSync };
}

/** The /sync deep link keeps the full workspace: accounts with their sync
 * action, then the setup form. The settings 同步 section renders the same state
 * as plain settings rows whose menus hold these blocks. */
export function SyncWorkspace() {
  const sync = useSyncSettings();
  return (
    <div className="sync-workspace">
      <h1 className="visually-hidden">同步</h1>
      {/* One slot for the account area, held open at the height of the state it
          can end up in. Replacing a one-line "reading…" with a full empty state
          used to shove the form below it three hundred pixels down, every time
          the section was opened. */}
      <div className="sync-account-slot">
        {sync.loading && <LoadingIndicator size="sm" label="正在读取同步账户" />}
        {!sync.loading && sync.accounts.length === 0 && (
          <div className="settings-group sync-empty">
            <EmptyState icon={Waypoints} title="同步尚未配置" description="添加 WebDAV 账户后，本地阅读进度、历史和待看变更会以密文增量同步。" />
            {sync.servers.length === 0 && <p className="server-list-message">需要先添加 LANraragi 服务器，才能确定本地同步范围。</p>}
          </div>
        )}
        {sync.accounts.length > 0 && (
          <section className="sync-account-list settings-group" aria-label="WebDAV 账户">
              {sync.accounts.map((account) => (
                <article className="sync-account-row" key={account.id}>
                  <Waypoints className="sync-account-glyph" aria-hidden="true" />
                  <div>
                    <h2>{account.label}</h2>
                    <p>{account.baseUrl}</p>
                    <small>{account.username || '无用户名'} · {account.status === 'unverified' ? '待首次同步验证' : account.status}</small>
                  </div>
                  <button className="primary-action" type="button" disabled={sync.syncingId !== undefined || sync.servers.length === 0} aria-busy={sync.syncingId === account.id} onClick={() => void sync.runSync(account)}>
                    <RefreshCw aria-hidden="true" />{sync.syncingId === account.id ? '同步中…' : '立即同步'}
                  </button>
                </article>
              ))}
            {sync.servers.length === 0 && <p className="server-list-message">需要先添加 LANraragi 服务器，才能确定本地同步范围。</p>}
          </section>
        )}
      </div>
      <section className="sync-setup settings-group" aria-labelledby="sync-setup-title">
        <div className="sync-setup-heading">
          <KeyRound aria-hidden="true" />
          <div>
            <h2 id="sync-setup-title">添加或更新 WebDAV</h2>
            <p>账户信息保存在本机，口令进入系统安全存储。</p>
          </div>
        </div>
        {/* Two columns of labelled fields with the wide URL row spanning both:
            everything used to sit in one cramped stack. */}
        <form className="sync-form" onSubmit={sync.saveAccount}>
          <label>名称<input name="label" required autoComplete="off" placeholder="家里的 NAS" /></label>
          <label className="sync-form-wide">WebDAV 地址<input name="baseUrl" required type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://dav.example.com/Yomika" /></label>
          <label>用户名<input name="username" autoComplete="username" spellCheck={false} /></label>
          <label>密码或 Token<input name="credential" required type="password" autoComplete="off" spellCheck={false} /></label>
          <div className="sync-form-actions">
            <button className="secondary-action" type="submit" disabled={sync.saving} aria-busy={sync.saving}>{sync.saving ? '保存中…' : '保存同步账户'}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
