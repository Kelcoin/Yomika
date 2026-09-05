import { CheckCircle, Globe, KeyRound, LogIn, RefreshCw, ArrowRightLeft } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';
import { ehAccountIdFor, ehHostFor, formatEhCookie, parseEhCookie } from '../lib/ehCookie';
import { useToast } from './Toast';

interface EhAccountPanelProps {
  accounts: EhAccount[];
  onSwitch?: ((accountId: string) => void) | undefined;
  onCheckHealth?: ((accountId: string) => void) | undefined;
  loading?: boolean | undefined;
  onSave?: ((input: SaveEhAccountInput) => Promise<void>) | undefined;
  onPasswordLogin?: ((username: string, password: string) => Promise<string>) | undefined;
  /** Opens E-Hentai's own page and resolves with the cookie header once the user
   * has signed in there. */
  onBrowserLogin?: ((signal?: AbortSignal) => Promise<string>) | undefined;
  saving?: boolean | undefined;
}

function statusLabel(status: EhAccount['status']): string {
  if (status === 'verified') return '已验证';
  if (status === 'error') return '错误';
  return '未验证';
}

/** Three ways in, as in JHenTai: sign in with the account, sign in on E-Hentai's
 * own page, or paste the cookies. Everything else (site, account id, label) is
 * derived — the old form asked for an "account ID", a "name", a site and a
 * "username hint", none of which the user can meaningfully answer.
 *
 * The middle one is not a convenience. A Cloudflare challenge is a browser check,
 * so the password form cannot pass it however correct the credentials are, and
 * before this the only way through was copying cookies out of another browser by
 * hand. */
export function EhAccountPanel({ accounts, onSwitch, onCheckHealth, loading, onSave, onPasswordLogin, onBrowserLogin, saving }: EhAccountPanelProps) {
  const { showToast } = useToast();
  const [mode, setMode] = useState<'password' | 'browser' | 'cookie'>('password');
  const [formError, setFormError] = useState<string>();
  // Also a toast. The form is inside a settings section that scrolls, and the
  // sign-in failure people needed to see most — a bridge error with no obvious
  // cause — was reported at the bottom of it and nowhere else.
  useEffect(() => {
    if (formError) showToast(formError, 'error');
  }, [formError, showToast]);
  const [browserPending, setBrowserPending] = useState(false);
  const browserAbortRef = useRef<AbortController>();
  useEffect(() => () => browserAbortRef.current?.abort(), []);

  async function saveCookie(rawCookie: string) {
    const credentials = parseEhCookie(rawCookie);
    if (!credentials) {
      setFormError('未能识别 Cookie：需要包含 ipb_member_id 与 ipb_pass_hash');
      return false;
    }
    await onSave?.({
      id: ehAccountIdFor(credentials),
      label: `E-Hentai ${credentials.memberId}`,
      host: ehHostFor(credentials),
      cookie: formatEhCookie(credentials),
    });
    return true;
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onPasswordLogin) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setFormError(undefined);
    try {
      const cookie = await onPasswordLogin(String(data.get('ehUsername') ?? '').trim(), String(data.get('ehPassword') ?? ''));
      if (await saveCookie(cookie)) form.reset();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '登录失败');
    }
  }

  async function submitCookie(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setFormError(undefined);
    try {
      if (await saveCookie(String(data.get('ehCookie') ?? ''))) form.reset();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '账户保存失败');
    }
  }

  async function startBrowserLogin() {
    if (!onBrowserLogin || browserPending) return;
    const controller = new AbortController();
    browserAbortRef.current = controller;
    setFormError(undefined);
    setBrowserPending(true);
    try {
      await saveCookie(await onBrowserLogin(controller.signal));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '网页登录失败');
    } finally {
      setBrowserPending(false);
      browserAbortRef.current = undefined;
    }
  }

  if (loading) {
    return (
      <section className="eh-account-panel" aria-label="E-Hentai 账户">
        <p role="status">正在读取账户…</p>
      </section>
    );
  }

  return (
    <section className="eh-account-panel" aria-label="E-Hentai 账户">
      {(onSave || onPasswordLogin || onBrowserLogin) && (
        <div className="eh-login">
          <div className="eh-login-tabs" role="tablist" aria-label="登录方式">
            <button type="button" role="tab" aria-selected={mode === 'password'} className={`secondary-action${mode === 'password' ? ' is-active' : ''}`} onClick={() => { setMode('password'); setFormError(undefined); }}>
              <LogIn aria-hidden="true" />账号登录
            </button>
            {onBrowserLogin && (
              <button type="button" role="tab" aria-selected={mode === 'browser'} className={`secondary-action${mode === 'browser' ? ' is-active' : ''}`} onClick={() => { setMode('browser'); setFormError(undefined); }}>
                <Globe aria-hidden="true" />网页登录
              </button>
            )}
            <button type="button" role="tab" aria-selected={mode === 'cookie'} className={`secondary-action${mode === 'cookie' ? ' is-active' : ''}`} onClick={() => { setMode('cookie'); setFormError(undefined); }}>
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
                在弹出的窗口中完成 Cloudflare 验证并登录，凭据会自动读取。遇到人机验证时这是唯一可行的方式。
              </p>
              {browserPending ? (
                <>
                  <p role="status">正在等待窗口中的登录…</p>
                  <button className="secondary-action" type="button" onClick={() => browserAbortRef.current?.abort()}>取消</button>
                </>
              ) : (
                <button className="primary-action" type="button" onClick={() => void startBrowserLogin()} disabled={saving} aria-busy={saving}>
                  <Globe aria-hidden="true" />打开登录页面
                </button>
              )}
            </div>
          ) : (
            <form className="eh-account-form" onSubmit={submitCookie}>
              <label>Cookie
                <textarea name="ehCookie" required rows={3} spellCheck={false} placeholder="粘贴浏览器中的 ipb_member_id 与 ipb_pass_hash（可直接粘贴整段 Cookie）" />
              </label>
              <button className="primary-action" type="submit" disabled={saving} aria-busy={saving}>{saving ? '保存中…' : '保存 Cookie'}</button>
            </form>
          )}
          {formError && <p className="form-error" role="alert">{formError}</p>}
        </div>
      )}
      {accounts.length > 0 && (
      <ul>
        {accounts.map((account) => (
          <li key={account.id} className={account.isActive ? 'active' : ''}>
            <div>
              <strong>{account.label}</strong>
              <span>{account.host}</span>
              <small>{statusLabel(account.status)}</small>
            </div>
            <div className="account-actions">
              {onCheckHealth && (
                <button type="button" className="icon-button" aria-label={`检查${account.label}`} title="检查登录状态" onClick={() => onCheckHealth(account.id)}>
                  <RefreshCw aria-hidden="true" />
                </button>
              )}
              {onSwitch && !account.isActive && (
                <button type="button" className="icon-button" aria-label={`切换到${account.label}`} title="切换账户" onClick={() => onSwitch(account.id)}>
                  <ArrowRightLeft aria-hidden="true" />
                </button>
              )}
              {account.isActive && <CheckCircle aria-label="当前活跃" />}
            </div>
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}
