import { KeyRound, RefreshCw, Waypoints } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import type { ServerRecord } from '../domain/library';
import type { WebdavAccount } from '../domain/syncWire';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSyncRepository } from '../repositories/nativeSyncRepository';
import { EmptyState } from './EmptyState';

const libraryRepository = new NativeLibraryRepository();
const syncRepository = new NativeSyncRepository();

export function SyncWorkspace({ embedded = false }: { embedded?: boolean } = {}) {
  const [accounts, setAccounts] = useState<WebdavAccount[]>([]);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState<string>();

  useEffect(() => {
    let active = true;
    void Promise.all([syncRepository.listAccounts(), libraryRepository.listServers()]).then(([accountResult, serverResult]) => {
      if (!active) return;
      if (accountResult.ok) setAccounts(accountResult.value);
      else setError(accountResult.error.message);
      if (serverResult.ok) setServers(serverResult.value);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    const form = new FormData(formElement);
    const input = {
      id: String(form.get('accountId') ?? '').trim(),
      label: String(form.get('label') ?? '').trim(),
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
      if (result.ok) setMessage(result.value === 0 ? '没有待同步的本地变更' : `已同步 ${result.value} 项本地变更`);
      else setError(result.error.message);
    } finally {
      setSyncingId(undefined);
    }
  }

  return (
    <div className="sync-workspace">
      {!embedded && <header className="workspace-heading"><h1>同步</h1></header>}
      {loading && <p className="server-list-message" role="status">正在读取同步账户…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
      {!loading && accounts.length === 0 && (
        <EmptyState icon={Waypoints} title="同步尚未配置" description="添加 WebDAV 账户后，本地阅读进度、历史和待看变更会以密文增量同步。" />
      )}
      {accounts.length > 0 && (
        <section className="sync-account-list" aria-label="WebDAV 账户">
          {accounts.map((account) => (
            <article className="sync-account-row" key={account.id}>
              <div>
                <h2>{account.label}</h2>
                <p>{account.baseUrl}</p>
                <small>{account.username || '无用户名'} · {account.status === 'unverified' ? '待首次同步验证' : account.status}</small>
              </div>
              <button className="primary-action" type="button" disabled={syncingId !== undefined || servers.length === 0} aria-busy={syncingId === account.id} onClick={() => void runSync(account)}>
                <RefreshCw aria-hidden="true" />{syncingId === account.id ? '同步中…' : '立即同步'}
              </button>
            </article>
          ))}
        </section>
      )}
      {!loading && servers.length === 0 && <p className="server-list-message">需要先添加 LANraragi 服务器，才能确定本地同步范围。</p>}
      <section className="sync-setup" aria-labelledby="sync-setup-title">
        <div className="sync-setup-heading">
          <KeyRound aria-hidden="true" />
          <div>
            <h2 id="sync-setup-title">添加或更新 WebDAV</h2>
            <p>账户信息保存在本机，口令进入系统安全存储。</p>
          </div>
        </div>
        {/* Two columns of labelled fields with the wide URL row spanning both:
            everything used to sit in one cramped stack. */}
        <form className="sync-form" onSubmit={saveAccount}>
          <label>账户 ID<input name="accountId" required pattern="[A-Za-z0-9_-]+" autoComplete="off" spellCheck={false} placeholder="dav-home" /></label>
          <label>名称<input name="label" required autoComplete="off" placeholder="家里的 NAS" /></label>
          <label className="sync-form-wide">WebDAV 地址<input name="baseUrl" required type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://dav.example.com/Yomika" /></label>
          <label>用户名<input name="username" autoComplete="username" spellCheck={false} /></label>
          <label>密码或 Token<input name="credential" required type="password" autoComplete="off" spellCheck={false} /></label>
          <div className="sync-form-actions">
            <button className="secondary-action" type="submit" disabled={saving} aria-busy={saving}>{saving ? '保存中…' : '保存同步账户'}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
