import { PlugZap } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import type { ServerRecord } from '../domain/library';
import { pickServer } from '../domain/server';
import type { SyncAccount, SyncAccountKind } from '../domain/syncWire';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSyncRepository } from '../repositories/nativeSyncRepository';
import { DEFAULT_SYNC_SCOPE, SYNC_SCOPE_CATEGORIES, parseSyncScope, type SyncScopeCategory } from '../domain/syncScope';
import { SYNC_COMPLETED_EVENT, publishSyncApplied } from '../lib/autoSync';
import { useToast } from './Toast';
import { CheckRow, CheckRowGroup } from './SettingsControls';

/** 可选的两类远端。R2 只是 S3 兼容端点里最常见的一个例子，任何 S3 兼容服务
 * （MinIO、B2、AWS S3…）填端点与桶名都能用。 */
const SYNC_ACCOUNT_KINDS: Array<{ id: SyncAccountKind; label: string; hint: string }> = [
  { id: 'webdav', label: 'WebDAV', hint: '坚果云、Nextcloud、群晖等提供的 WebDAV 目录' },
  { id: 's3', label: '对象存储', hint: 'S3 兼容端点，例如 Cloudflare R2、MinIO、AWS S3' },
];

const libraryRepository = new NativeLibraryRepository();
const syncRepository = new NativeSyncRepository();

/** The account id is an internal key, never shown or asked for. It is derived
 * from the kind and the account name, so saving with the same 名称 updates that
 * account instead of piling up an indistinguishable copy — and a WebDAV account
 * and an object-storage one may share a name without colliding. */
function syncAccountIdFor(kind: SyncAccountKind, label: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${kind === 's3' ? 's3' : 'dav'}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Account and sync state behind the settings 同步 rows: one loader, one save,
 * one sync runner, everything reported through the shared toast. `enabled` gates
 * the load so the settings page only fetches accounts when its 同步 section is
 * actually shown. */
export function useSyncSettings(enabled = true) {
  const { showToast } = useToast();
  const [accounts, setAccounts] = useState<SyncAccount[]>([]);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncingId, setSyncingId] = useState<string>();
  /** 表单开着时指向被编辑的账户；'new' 是新增；undefined 表示收起。 */
  const [formTarget, setFormTarget] = useState<'new' | SyncAccount>();
  /** 表单里的账户类型草稿：WebDAV 目录或 S3 兼容对象存储。 */
  const [kindDraft, setKindDraft] = useState<SyncAccountKind>('webdav');
  /** 范围草稿：表单里勾选的类别，保存时随账户一起写。 */
  const [scopeDraft, setScopeDraft] = useState<SyncScopeCategory[]>([...DEFAULT_SYNC_SCOPE]);
  /** 编辑时的口令：打开表单时从凭据库读一次，聚焦输入框才显示明文。 */
  const [credentialDraft, setCredentialDraft] = useState('');
  const [revealCredential, setRevealCredential] = useState(false);
  /** 重置远端是破坏性的，所以按钮点两下：第一次只把它变成「确认重置」。 */
  const [resetAccount, setResetAccount] = useState<SyncAccount>();
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

  /** 生效的那套：同步、账户行、同步范围都看它。另一套留在库里待命。 */
  const activeAccount = accounts.find((account) => account.active) ?? accounts[0];
  /** 正在编辑的这个类型之外，另一类已存的那份：表单里据此提示「切回去还能用」。 */
  const standbyAccount = accounts.find((account) => account.kind !== kindDraft);

  /** 只重读账户行：同步成功后「上次同步」要立刻跟上。 */
  async function reloadAccounts() {
    const result = await syncRepository.listAccounts();
    if (result.ok) setAccounts(result.value);
  }

  // 范围草稿跟着账户里存着的那份走：重新加载、编辑保存、别的设备同步回来之后
  // 都会刷新，勾选框不该停在旧的一份上。
  useEffect(() => {
    if (!activeAccount) return;
    setScopeDraft(parseSyncScope(activeAccount.syncScope));
  }, [accounts, activeAccount]);

  // 自动同步完成时也要刷新：那一侧不经过这个 hook。
  useEffect(() => {
    if (!enabled) return undefined;
    const onCompleted = () => { void reloadAccounts(); };
    window.addEventListener(SYNC_COMPLETED_EVENT, onCompleted);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, onCompleted);
  }, [enabled]);

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

  /** 同步范围是独立的一行：每次勾选就写回账户，没有"保存"按钮。
   * 还没账户时只留在草稿里——导入导出用的是同一份勾选，没有账户也该能挑范围。 */
  async function saveScope(next: SyncScopeCategory[]) {
    const account = activeAccount;
    setScopeDraft(next);
    if (!account) return;
    setScopeSaving(true);
    setError(undefined);
    try {
      const result = await syncRepository.saveScope(account.id, JSON.stringify(next));
      if (!result.ok) {
        // 写失败就把草稿退回账户里存着的那份，别让界面说一套、远端做一套。
        setScopeDraft(parseSyncScope(account.syncScope));
        setError(result.error.message);
        return;
      }
      setAccounts((current) => current.map((item) => (item.id === result.value.id ? result.value : item)));
    } finally {
      setScopeSaving(false);
    }
  }

  /** 离开这一节（或这个页面）就收起编辑态：账号口令是这一次编辑的临时草稿，
   * 下次再进来应该看到收起的行，而不是上次没保存完的表单。 */
  useEffect(() => {
    if (enabled) return;
    setFormTarget(undefined);
    setRevealCredential(false);
    setCredentialDraft('');
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
      id: editing?.id ?? syncAccountIdFor(kindDraft, label),
      kind: kindDraft,
      label,
      baseUrl: String(form.get('baseUrl') ?? '').trim(),
      bucket: String(form.get('bucket') ?? '').trim(),
      username: String(form.get('username') ?? '').trim(),
      // 编辑时留空表示沿用已存的口令，原生侧就是这么理解的。
      credential: String(form.get('credential') ?? ''),
    };
    try {
      const saved = await syncRepository.saveAccount(input);
      if (!saved.ok) {
        setError(saved.error.message);
        return;
      }
      // 保存这套＝启用这套，另一套转为待命：整体重读一遍最稳妥。
      await reloadAccounts();
      formElement.reset();
      setFormTarget(undefined);
      setMessage(`${saved.value.kind === 's3' ? '对象存储' : 'WebDAV'} 账户已保存并启用`);
    } finally {
      setSaving(false);
    }
  }

  /** 「测试」：把表单里现在的字段原样送去探一次，不写库、不动远端。 */
  async function testAccount() {
    const form = document.querySelector<HTMLFormElement>('.settings-choice-panel form.sync-form');
    if (!form) return;
    const data = new FormData(form);
    const label = String(data.get('label') ?? '').trim();
    const editing = typeof formTarget === 'object' ? formTarget : undefined;
    setTesting(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await syncRepository.testAccount({
        id: editing?.id ?? syncAccountIdFor(kindDraft, label),
        kind: kindDraft,
        label,
        baseUrl: String(data.get('baseUrl') ?? '').trim(),
        bucket: String(data.get('bucket') ?? '').trim(),
        username: String(data.get('username') ?? '').trim(),
        credential: String(data.get('credential') ?? ''),
      });
      if (result.ok) setMessage(result.value);
      else setError(result.error.message);
    } finally {
      setTesting(false);
    }
  }

  async function runSync(account: SyncAccount) {
    const server = pickServer(servers, null);
    if (!server) {
      setError('请先在设置中添加 LANraragi 服务器');
      return;
    }
    setSyncingId(account.id);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await syncRepository.syncRemoteScope(account.id, server.scopeId);
      if (result.ok) {
        setMessage(result.value === 0 ? '没有需要同步的变更' : `已同步 ${result.value} 项变更（含从远端拉回的部分）`);
        // 与自动同步同一条收尾：界面快照失效、偏好重读，账户行也把「上次同步」刷新。
        publishSyncApplied('manual', result.value);
        await reloadAccounts();
      } else {
        setError(result.error.message);
      }
    } finally {
      setSyncingId(undefined);
    }
  }

  /** 把已存凭据读回表单（读不到就留空：留空保存＝不改凭据，原生侧就是这么理解的）。 */
  function loadCredential(account: SyncAccount) {
    void syncRepository.accountCredential(account.id).then((result) => {
      if (result.ok) setCredentialDraft((current) => (current === '' ? result.value : current));
    });
  }

  /** 打开表单：带上传入账户的类型，并把已存口令读回来（读不到就留空，
   * 留空保存＝不改口令，原生侧就是这么理解的）。范围不在这里，它有自己的行。 */
  function openForm(account?: SyncAccount) {
    setError(undefined);
    setMessage(undefined);
    setKindDraft(account?.kind ?? 'webdav');
    setCredentialDraft('');
    setRevealCredential(false);
    setFormTarget(account ?? 'new');
    if (!account) return;
    loadCredential(account);
  }

  /** 表单里换类型：立刻换成那一套账户——有就填它自己的值，没有就清空。
   * 两套账户分开存，切过去绝不能还留着另一套的地址、用户名或凭据。 */
  function switchKind(kind: SyncAccountKind) {
    if (kind === kindDraft) return;
    setError(undefined);
    setMessage(undefined);
    setKindDraft(kind);
    setCredentialDraft('');
    setRevealCredential(false);
    const stored = accounts.find((account) => account.kind === kind);
    setFormTarget(stored ?? 'new');
    if (stored) loadCredential(stored);
  }

  async function resetRemote(account: SyncAccount) {
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
    beginReset: (account: SyncAccount) => { setError(undefined); setMessage(undefined); setResetAccount(account); },
    cancelReset: () => setResetAccount(undefined),
    resetRemote,
    servers,
    loading,
    error,
    message,
    saving,
    testing,
    testAccount,
    syncingId,
    saveAccount,
    runSync,
    activeAccount,
    standbyAccount,
    formTarget,
    kindDraft,
    switchKind,
    scopeDraft,
    scopeSaving,
    saveScope,
    toggleScope: (category: SyncScopeCategory) => {
      const next = scopeDraft.includes(category)
        ? scopeDraft.filter((item) => item !== category)
        : [...scopeDraft, category];
      void saveScope(next);
    },
    credentialDraft,
    setCredentialDraft,
    revealCredential,
    setRevealCredential,
    startEdit: openForm,
    closeForm: () => { setFormTarget(undefined); setRevealCredential(false); setCredentialDraft(''); },
  };
}

/** 账户类型的中文名，行与提示共用。 */
export function accountKindLabel(kind: SyncAccountKind): string {
  return SYNC_ACCOUNT_KINDS.find((entry) => entry.id === kind)?.label ?? 'WebDAV';
}

type SyncSettingsState = ReturnType<typeof useSyncSettings>;

/** 同步范围的勾选行：「底栏项目」那套多选行，整行可点、尾部图标表示勾选。
 * 它是独立的一行（不再挂在账户表单里），勾一下就写回账户。
 * 凭据不在这里：服务器、账户与 API Key/Cookie/同步口令只在本机，随「导入导出范围」
 * 与那份口令加密的文件走，同步永远不带它们。 */
export function SyncScopeChecks({ sync }: { sync: SyncSettingsState }) {
  return (
    <>
      <CheckRowGroup label="同步范围">
        {SYNC_SCOPE_CATEGORIES.map((category) => (
          <CheckRow
            key={category.id}
            label={category.label}
            checked={sync.scopeDraft.includes(category.id)}
            disabled={sync.scopeSaving}
            ariaLabel={`同步${category.label}`}
            onToggle={() => sync.toggleScope(category.id)}
          />
        ))}
      </CheckRowGroup>
      {/* 一句就够（原来这里是两句话、还和上面的提示重复）。 */}
      <p className="sync-scope-hint">凭据只在本机，要从「导入导出范围」带走。</p>
    </>
  );
}

/** 账户表单，新建与编辑共用：名称/地址/用户名/凭据。设置里的「同步账户」菜单渲染它，
 * 行为只有这一份；同步范围不在这里——它是自己的一行。 */
export function SyncAccountForm({ sync }: { sync: SyncSettingsState }) {
  const account = typeof sync.formTarget === 'object' ? sync.formTarget : undefined;
  return (
    <form
      className="sync-form"
      key={account ? account.id : 'new'}
      onSubmit={sync.saveAccount}
    >
      {/* 两种远端：WebDAV 目录，或 S3 兼容对象存储（Cloudflare R2、MinIO…）。
          字段随类型换，凭据始终进系统凭据库。 */}
      <fieldset className="sync-kind">
        <legend>类型</legend>
        <div className="settings-menu-mode" role="group" aria-label="账户类型">
          {SYNC_ACCOUNT_KINDS.map((kind) => (
            <button
              key={kind.id}
              type="button"
              className={`settings-menu-mode-button${sync.kindDraft === kind.id ? ' is-active' : ''}`}
              aria-pressed={sync.kindDraft === kind.id}
              title={kind.hint}
              onClick={() => sync.switchKind(kind.id)}
            >
              {kind.label}
            </button>
          ))}
        </div>
        {/* 两套账户分开存、只生效一套：切过去以后另一套还在，保存这套就切回来。 */}
        <p className="sync-scope-hint">
          {sync.standbyAccount
            ? `${accountKindLabel(sync.standbyAccount.kind)} 账户「${sync.standbyAccount.label}」已保存待命；保存这套就换成它生效。`
            : '两套账户分开保存，只有一套生效。'}
        </p>
      </fieldset>
      <label>名称<input name="label" required autoComplete="off" placeholder="家里的 NAS" defaultValue={account?.label ?? ''} /></label>
      {sync.kindDraft === 's3' ? (
        <>
          <label>端点<input name="baseUrl" required type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://<账号>.r2.cloudflarestorage.com" defaultValue={account?.baseUrl ?? ''} /></label>
          <label>存储桶<input name="bucket" required autoComplete="off" spellCheck={false} placeholder="yomika" defaultValue={account?.bucket ?? ''} /></label>
          <label>Access Key ID<input name="username" required autoComplete="off" spellCheck={false} defaultValue={account?.username ?? ''} /></label>
        </>
      ) : (
        <>
          <label>WebDAV 地址<input name="baseUrl" required type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://dav.example.com/Yomika" defaultValue={account?.baseUrl ?? ''} /></label>
          <label>用户名<input name="username" autoComplete="username" spellCheck={false} defaultValue={account?.username ?? ''} /></label>
        </>
      )}
      {/* 编辑时凭据已回填；聚焦时显示明文，方便核对。留空保存＝不改凭据。 */}
      <label>{sync.kindDraft === 's3' ? 'Secret Access Key' : '密码或 Token'}<input
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
      {/* 保存前先能试：测试只读一次远端，不合适就改字段，不用先存一遍。 */}
      <div className="sync-form-actions">
        <button className="secondary-action" type="submit" disabled={sync.saving || sync.testing} aria-busy={sync.saving}>{sync.saving ? '保存中…' : '保存'}</button>
        <button className="secondary-action" type="button" disabled={sync.saving || sync.testing} aria-busy={sync.testing} onClick={() => void sync.testAccount()}><PlugZap aria-hidden="true" />{sync.testing ? '测试中…' : '测试'}</button>
        {sync.accounts.length > 0 && (
          <button className="secondary-action" type="button" disabled={sync.saving || sync.testing} onClick={sync.closeForm}>取消</button>
        )}
      </div>
    </form>
  );
}
