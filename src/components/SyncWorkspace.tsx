import { RefreshCw, Waypoints } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import type { ServerRecord } from '../domain/library';
import { pickServer } from '../domain/server';
import type { WebdavAccount } from '../domain/syncWire';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSyncRepository } from '../repositories/nativeSyncRepository';
import { DEFAULT_SYNC_SCOPE, SYNC_SCOPE_CATEGORIES, parseSyncScope, scopeSummary, type SyncScopeCategory } from '../domain/syncScope';
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
  /** 表单开着时指向被编辑的账户；'new' 是新增；undefined 表示收起。 */
  const [formTarget, setFormTarget] = useState<'new' | WebdavAccount>();
  /** 范围草稿：表单里勾选的类别，保存时随账户一起写。 */
  const [scopeDraft, setScopeDraft] = useState<SyncScopeCategory[]>([...DEFAULT_SYNC_SCOPE]);
  /** 编辑时的口令：打开表单时从凭据库读一次，聚焦输入框才显示明文。 */
  const [credentialDraft, setCredentialDraft] = useState('');
  const [revealCredential, setRevealCredential] = useState(false);
  /** 重置远端是破坏性的，所以按钮点两下：第一次只把它变成「确认重置」。 */
  const [resetAccount, setResetAccount] = useState<WebdavAccount>();
  const [resetting, setResetting] = useState(false);

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
    const editing = typeof formTarget === 'object' ? formTarget : undefined;
    const input = {
      // 编辑时沿用原 id（改名不该变成另一个账户），新增才由名称派生。
      id: editing?.id ?? webdavAccountIdFor(label),
      label,
      baseUrl: String(form.get('baseUrl') ?? '').trim(),
      username: String(form.get('username') ?? '').trim(),
      // 编辑时留空表示沿用已存的口令，原生侧就是这么理解的。
      credential: String(form.get('credential') ?? ''),
      syncScope: JSON.stringify(scopeDraft),
    };
    try {
      const saved = await syncRepository.saveAccount(input);
      if (!saved.ok) {
        setError(saved.error.message);
        return;
      }
      setAccounts((current) => [...current.filter((account) => account.id !== saved.value.id), saved.value]
        .sort((left, right) => left.label.localeCompare(right.label)));
      formElement.reset();
      setFormTarget(undefined);
      setMessage('同步账户已保存在本机');
    } finally {
      setSaving(false);
    }
  }

  async function runSync(account: WebdavAccount) {
    const server = pickServer(servers, null);
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

  /** 打开表单：编辑时带上该账户的范围，并把已存口令读回来（读不到就留空，
   * 留空保存＝不改口令，原生侧就是这么理解的）。 */
  function openForm(account?: WebdavAccount) {
    setError(undefined);
    setMessage(undefined);
    setScopeDraft(account ? parseSyncScope(account.syncScope) : [...DEFAULT_SYNC_SCOPE]);
    setCredentialDraft('');
    setRevealCredential(false);
    setFormTarget(account ?? 'new');
    if (!account) return;
    void syncRepository.accountCredential(account.id).then((result) => {
      if (result.ok) setCredentialDraft((current) => (current === '' ? result.value : current));
    });
  }

  async function resetRemote(account: WebdavAccount) {
    setResetting(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await syncRepository.resetRemote(account.id);
      if (result.ok) setMessage(`已重置远端（${account.label}）：下次同步会按本地状态重新写一份。`);
      else setError(result.error.message);
    } finally {
      setResetting(false);
      setResetAccount(undefined);
    }
  }

  return {
    accounts,
    resetAccount,
    resetting,
    beginReset: (account: WebdavAccount) => { setError(undefined); setMessage(undefined); setResetAccount(account); },
    cancelReset: () => setResetAccount(undefined),
    resetRemote,
    servers,
    loading,
    error,
    message,
    saving,
    syncingId,
    saveAccount,
    runSync,
    formTarget,
    scopeDraft,
    toggleScope: (category: SyncScopeCategory) => setScopeDraft((current) => (
      current.includes(category) ? current.filter((item) => item !== category) : [...current, category]
    )),
    credentialDraft,
    setCredentialDraft,
    revealCredential,
    setRevealCredential,
    startEdit: openForm,
    closeForm: () => { setFormTarget(undefined); setRevealCredential(false); },
  };
}

type SyncSettingsState = ReturnType<typeof useSyncSettings>;

/** 账户表单，新建与编辑共用：名称/地址/用户名/口令 + 同步范围勾选。两个入口
 * （/sync 页与设置里的菜单）都渲染它，行为只有这一份。 */
export function SyncAccountForm({ sync, autoFocus = false }: { sync: SyncSettingsState; autoFocus?: boolean }) {
  const account = typeof sync.formTarget === 'object' ? sync.formTarget : undefined;
  return (
    <form
      className="sync-form"
      key={account ? account.id : 'new'}
      onSubmit={sync.saveAccount}
    >
      <label>名称<input name="label" required autoComplete="off" placeholder="家里的 NAS" defaultValue={account?.label ?? ''} autoFocus={autoFocus} /></label>
      <label className="sync-form-wide">WebDAV 地址<input name="baseUrl" required type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://dav.example.com/Yomika" defaultValue={account?.baseUrl ?? ''} /></label>
      <label>用户名<input name="username" autoComplete="username" spellCheck={false} defaultValue={account?.username ?? ''} /></label>
      {/* 编辑时口令已回填；聚焦时显示明文，方便核对。留空保存＝不改口令。 */}
      <label>密码或 Token<input
        name="credential"
        required={account === undefined}
        type={sync.revealCredential ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        placeholder={account ? '留空则保持不变' : ''}
        value={sync.credentialDraft}
        onChange={(event) => sync.setCredentialDraft(event.currentTarget.value)}
        onFocus={() => sync.setRevealCredential(true)}
        onBlur={() => sync.setRevealCredential(false)}
      /></label>
      <fieldset className="sync-scope">
        <legend>同步范围</legend>
        <div className="sync-scope-grid">
          {SYNC_SCOPE_CATEGORIES.map((category) => (
            <label key={category.id} className="sync-scope-option">
              <input
                type="checkbox"
                checked={sync.scopeDraft.includes(category.id)}
                onChange={() => sync.toggleScope(category.id)}
              />
              <span>{category.label}</span>
            </label>
          ))}
        </div>
        <p className="sync-scope-hint">默认只同步前五项。单独的账号行共享同一台服务器上的进度与书架；服务器地址、E-H 账户与应用设置会带着本机信息上远端，默认不勾。</p>
      </fieldset>
      <div className="sync-form-actions">
        <button className="secondary-action" type="submit" disabled={sync.saving} aria-busy={sync.saving}>{sync.saving ? '保存中…' : '保存'}</button>
        {sync.accounts.length > 0 && (
          <button className="secondary-action" type="button" disabled={sync.saving} onClick={sync.closeForm}>取消</button>
        )}
      </div>
    </form>
  );
}

/** The /sync deep link keeps the full workspace: accounts with their sync
 * action, then the setup form. The settings 同步 section renders the same state
 * as plain settings rows whose menus hold these blocks. */
export function SyncWorkspace() {
  const sync = useSyncSettings();
  // 单账户：只维护一个 WebDAV 账户，多个账户的时代结束了。
  const account = sync.accounts[0];
  const editing = sync.formTarget !== undefined;
  const formOpen = editing || sync.accounts.length === 0;
  return (
    <div className="sync-workspace">
      <h1 className="visually-hidden">同步</h1>
      {/* One slot for the account area, held open at the height of the state it
          can end up in. Replacing a one-line "reading…" with a full empty state
          used to shove the form below it three hundred pixels down, every time
          the section was opened. */}
      <div className="sync-account-slot">
        {sync.loading && <LoadingIndicator size="sm" label="正在读取同步账户" />}
        {!sync.loading && !account && (
          <div className="settings-group sync-empty">
            <EmptyState icon={Waypoints} title="同步尚未配置" description="添加 WebDAV 账户后，本地阅读进度、历史和待看变更会以密文增量同步。" />
            {sync.servers.length === 0 && <p className="server-list-message">需要先添加 LANraragi 服务器，才能确定本地同步范围。</p>}
          </div>
        )}
        {account && (
          <section className="sync-account-list settings-group" aria-label="WebDAV 账户">
            <article className="sync-account-row">
              <Waypoints className="sync-account-glyph" aria-hidden="true" />
              <div>
                <h2>{account.label}</h2>
                <p>{account.baseUrl}</p>
                <small>{account.username || '无用户名'} · {scopeSummary(account.syncScope)}</small>
              </div>
              {/* 动作与表单互为开关：编辑时动作收起来，收起/展开都有高度过渡。 */}
              <div className={`sync-collapsible${editing ? '' : ' is-open'}`}>
                <div className="sync-account-actions">
                  <button className="secondary-action" type="button" disabled={sync.syncingId !== undefined} onClick={() => sync.startEdit(account)}>编辑</button>
                  <button className="primary-action" type="button" disabled={sync.syncingId !== undefined || sync.servers.length === 0} aria-busy={sync.syncingId === account.id} onClick={() => void sync.runSync(account)}>
                    <RefreshCw aria-hidden="true" />{sync.syncingId === account.id ? '同步中…' : '立即同步'}
                  </button>
                  {sync.resetAccount?.id === account.id ? (
                    <>
                      <button className="secondary-action" type="button" disabled={sync.resetting} onClick={() => void sync.resetRemote(account)}>确认重置</button>
                      <button className="secondary-action" type="button" disabled={sync.resetting} onClick={sync.cancelReset}>取消</button>
                    </>
                  ) : (
                    <button className="secondary-action" type="button" disabled={sync.syncingId !== undefined} title="删掉远端那份同步文档，下次同步按本地重新写一份" onClick={() => sync.beginReset(account)}>重置远端</button>
                  )}
                </div>
              </div>
            </article>
            {sync.servers.length === 0 && <p className="server-list-message">需要先添加 LANraragi 服务器，才能确定本地同步范围。</p>}
          </section>
        )}
      </div>
      <div className={`sync-collapsible${formOpen ? ' is-open' : ''}`}>
        <section className="sync-setup settings-group">
          <SyncAccountForm sync={sync} autoFocus={!account} />
        </section>
      </div>
    </div>
  );
}
