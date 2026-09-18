import { KeyRound, LogIn, RefreshCw, Download, LogOut, Pencil } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { writeClipboardText } from '../bridge/clipboard';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';
import { ehAccountIdFor, ehHostFor, formatEhCookieHeader, parseEhCookie } from '../lib/ehCookie';
import { EhMark } from './EhMark';
import { useToast } from './Toast';
import { StatusLine } from './StatusLine';

/** What the account is called anywhere it is shown: the username when one has
 * been recorded, otherwise the generic 「E 站用户」 — the member id is not a
 * display name, and the user can set a real one with the edit button. */
export function accountDisplayName(account: EhAccount): string {
  if (account.username) return account.username;
  if (account.usernameHint) return account.usernameHint;
  return 'E 站用户';
}

interface EhAccountPanelProps {
  accounts: EhAccount[];
  onCheckHealth?: ((accountId: string) => Promise<void>) | undefined;
  loading?: boolean | undefined;
  onSave?: ((input: SaveEhAccountInput) => Promise<void>) | undefined;
  onPasswordLogin?: ((username: string, password: string) => Promise<string>) | undefined;
  /** Opens E-Hentai's own page and resolves with the cookie header once the user
   * has signed in there. */
  onBrowserLogin?: ((signal?: AbortSignal) => Promise<string>) | undefined;
  saving?: boolean | undefined;
  onReadCookie?: ((accountId: string) => Promise<string | undefined>) | undefined;
  onLogout?: ((accountId: string) => Promise<void>) | undefined;
  /** 用户名手动输入弹窗：网页登录抓取失败后弹出，或由账户卡上的编辑按钮打开。 */
  usernameDialogAccountId?: string | undefined;
  onRequestUsernameDialog?: ((accountId: string) => void) | undefined;
  onCloseUsernameDialog?: (() => void) | undefined;
  onEditUsername?: ((accountId: string, username: string) => Promise<void>) | undefined;
}

/** Three ways in: sign in with the account, sign in on E-Hentai's
 * own page, or paste the cookies. Everything else (site, account id, label) is
 * derived — the old form asked for an "account ID", a "name", a site and a
 * "username hint", none of which the user can meaningfully answer.
 *
 * The middle one is not a convenience. A Cloudflare challenge is a browser check,
 * so the password form cannot pass it however correct the credentials are, and
 * before this the only way through was copying cookies out of another browser by
 * hand. */
export function EhAccountPanel({ accounts, onCheckHealth, loading, onSave, onPasswordLogin, onBrowserLogin, saving, onReadCookie, onLogout, onEditUsername }: EhAccountPanelProps) {
  const { showToast, clearToasts } = useToast();
  const [mode, setMode] = useState<'password' | 'browser' | 'cookie'>('password');
  const [browserPending, setBrowserPending] = useState(false);
  /** 原地编辑态：正在改名的账户与草稿值。Enter 或失焦提交，Esc 取消。 */
  const [editingAccountId, setEditingAccountId] = useState<string>();
  const [usernameDraft, setUsernameDraft] = useState('');
  const [savingUsername, setSavingUsername] = useState(false);
  const browserAbortRef = useRef<AbortController>();
  useEffect(() => () => browserAbortRef.current?.abort(), []);

  async function saveCookie(rawCookie: string) {
    const credentials = parseEhCookie(rawCookie);
    if (!credentials) {
      showToast('未能识别 Cookie：需要包含 ipb_member_id 与 ipb_pass_hash', 'error');
      return false;
    }
    await onSave?.({
      id: ehAccountIdFor(credentials),
      label: 'E-Hentai 账户',
      host: ehHostFor(credentials),
      cookie: formatEhCookieHeader(rawCookie),
    });
    clearToasts('error');
    return true;
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onPasswordLogin) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const cookie = await onPasswordLogin(String(data.get('ehUsername') ?? '').trim(), String(data.get('ehPassword') ?? ''));
      if (await saveCookie(cookie)) form.reset();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '登录失败', 'error');
    }
  }

  async function submitCookie(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      if (await saveCookie(String(data.get('ehCookie') ?? ''))) form.reset();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '账户保存失败', 'error');
    }
  }

  async function startBrowserLogin() {
    if (!onBrowserLogin || browserPending) return;
    const controller = new AbortController();
    browserAbortRef.current = controller;
    setBrowserPending(true);
    try {
      await saveCookie(await onBrowserLogin(controller.signal));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '网页登录失败', 'error');
    } finally {
      setBrowserPending(false);
      browserAbortRef.current = undefined;
    }
  }

  /** Export is one step: the stored cookie goes to the clipboard as a header
   * string, ready to paste wherever a `Cookie:` header is asked for. */
  async function exportCookie(account: EhAccount) {
    if (!onReadCookie) return;
    try {
      const cookie = await onReadCookie(account.id);
      if (!cookie) {
        showToast('未能读取 Cookie', 'error');
        return;
      }
      await writeClipboardText(formatEhCookieHeader(cookie));
      showToast('Cookie 已复制到剪贴板', 'success');
    } catch {
      showToast('复制 Cookie 失败', 'error');
    }
  }

  /** 原地提交：Enter 或失焦时调用；空名视为取消（回到原显示）。 */
  async function commitUsername() {
    const accountId = editingAccountId;
    if (!accountId || !onEditUsername) return;
    const name = usernameDraft.trim();
    const account = accounts.find((item) => item.id === accountId);
    const previous = account?.username ?? account?.usernameHint ?? '';
    if (name === previous || !name) {
      // 没改或清空了：不保存，退出编辑态。
      setEditingAccountId(undefined);
      return;
    }
    setSavingUsername(true);
    try {
      await onEditUsername(accountId, name);
      showToast('账户名已更新', 'success');
      setEditingAccountId(undefined);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      setSavingUsername(false);
    }
  }

  function startEditing(account: EhAccount) {
    // 草稿只带已记录的显示名；「E 站用户」回退不是用户的真名，不带。
    setUsernameDraft(account.username ?? account.usernameHint ?? '');
    setEditingAccountId(account.id);
  }

  if (loading) {
    return (
      <section className="eh-account-panel" aria-label="E-Hentai 账户">
        <StatusLine busy>正在读取账户…</StatusLine>
      </section>
    );
  }

  return (
    <section className="eh-account-panel" aria-label="E-Hentai 账户">
      {accounts.length === 0 && (onSave || onPasswordLogin || onBrowserLogin) && (
        <div className="eh-login">
          <div className="eh-login-tabs" role="tablist" aria-label="登录方式">
            <button type="button" role="tab" aria-selected={mode === 'password'} className={`secondary-action${mode === 'password' ? ' is-active' : ''}`} onClick={() => setMode('password')}>
              <LogIn aria-hidden="true" />账号登录
            </button>
            {onBrowserLogin && (
              <button type="button" role="tab" aria-selected={mode === 'browser'} className={`secondary-action${mode === 'browser' ? ' is-active' : ''}`} onClick={() => setMode('browser')}>
                <KeyRound aria-hidden="true" />网页登录
              </button>
            )}
            <button type="button" role="tab" aria-selected={mode === 'cookie'} className={`secondary-action${mode === 'cookie' ? ' is-active' : ''}`} onClick={() => setMode('cookie')}>
              <KeyRound aria-hidden="true" />Cookie 导入
            </button>
          </div>
          {mode === 'password' ? (
            <form className="eh-account-form" onSubmit={submitPassword}>
              <label>用户名<input name="ehUsername" required autoComplete="off" spellCheck={false} /></label>
              <label>密码<input name="ehPassword" required type="password" autoComplete="off" spellCheck={false} /></label>
              <button className="primary-action" type="submit" disabled={saving} aria-busy={saving}>{saving ? '登录中…' : '登录 E-Hentai'}</button>
            </form>
          ) : mode === 'browser' ? (
            <div className="eh-account-form">
              <p className="eh-login-hint">
                在弹出的窗口里完成 Cloudflare 验证并登录，凭据自动读取。
              </p>
              {browserPending ? (
                <>
                  <StatusLine busy>正在等待窗口中的登录…</StatusLine>
                  <button className="secondary-action" type="button" onClick={() => browserAbortRef.current?.abort()}>取消</button>
                </>
              ) : (
                <button className="primary-action" type="button" onClick={() => void startBrowserLogin()} disabled={saving} aria-busy={saving}>
                  <KeyRound aria-hidden="true" />打开登录页面
                </button>
              )}
            </div>
          ) : (
            <form className="eh-account-form" onSubmit={submitCookie}>
              <label>Cookie
                <textarea name="ehCookie" required rows={3} spellCheck={false} placeholder="粘贴整段 Cookie，或 ipb_member_id 与 ipb_pass_hash" />
              </label>
              <button className="primary-action" type="submit" disabled={saving} aria-busy={saving}>{saving ? '保存中…' : '保存 Cookie'}</button>
            </form>
          )}
        </div>
      )}
      {accounts.length > 0 && (
      /* The account info sits straight in the menu body — no inner frame. The
         EH roundel stands in for a profile picture, the access badge rides the
         name line, and the assets read as one quiet metric line. */
      <ul>
        {accounts.map((account) => {
          const assets = account.assets;
          const hasAssets = Boolean(assets && (assets.gp || assets.credits || assets.hath));
          const assetsLabel = hasAssets
            ? `GP ${assets?.gp || '-'} · Credits ${assets?.credits || '-'} · Hath ${assets?.hath || '-'}`
            : '正在更新资产…';
          return (
          <li key={account.id} className="eh-account">
            <div className="eh-account-status">
              <EhMark size={34} className="eh-account-glyph-mark" aria-hidden="true" />
              <div className="eh-account-summary">
                <strong>
                  {editingAccountId === account.id ? (
                    <input
                      className="eh-name-input"
                      value={usernameDraft}
                      disabled={savingUsername}
                      aria-label="账户名"
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                      onChange={(event) => setUsernameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); void commitUsername(); }
                        else if (event.key === 'Escape') { setEditingAccountId(undefined); }
                      }}
                      onBlur={() => { if (!savingUsername) void commitUsername(); }}
                    />
                  ) : (
                    accountDisplayName(account)
                  )}
                  {onEditUsername && editingAccountId !== account.id && (
                    <button type="button" className="eh-name-edit" aria-label={`编辑 ${accountDisplayName(account)} 的账户名`} title="编辑账户名" onClick={() => startEditing(account)}>
                      <Pencil aria-hidden="true" />
                    </button>
                  )}
                  <span className={`eh-access-badge is-${account.exhentaiAccess === true ? 'ok' : account.exhentaiAccess === false ? 'off' : 'unknown'}`}>
                    {account.exhentaiAccess === true ? 'EX 可访问' : account.exhentaiAccess === false ? 'EX 不可访问' : '检测 EX 中…'}
                  </span>
                </strong>
                <small>{assetsLabel}</small>
              </div>
            </div>
            <div className="eh-account-actions">
              {onCheckHealth && (
                <button type="button" className="secondary-action is-compact" onClick={() => onCheckHealth(account.id)}>
                  <RefreshCw aria-hidden="true" />检查登录状态
                </button>
              )}
              {onReadCookie && (
                <button type="button" className="secondary-action is-compact" onClick={() => { void exportCookie(account); }}>
                  <Download aria-hidden="true" />导出 Cookie
                </button>
              )}
              {onLogout && (
                <button type="button" className="secondary-action is-compact is-danger" onClick={() => { void onLogout(account.id); }}>
                  <LogOut aria-hidden="true" />退出登录
                </button>
              )}
            </div>
          </li>
        );})}
      </ul>
      )}
    </section>
  );
}
