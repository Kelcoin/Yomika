import { Copy, Globe, KeyRound, LogIn, RefreshCw, ArrowRightLeft, Download, LogOut, RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';
import { ehAccountIdFor, ehHostFor, formatEhCookieHeader, parseEhCookie } from '../lib/ehCookie';
import { useToast } from './Toast';

interface EhAccountPanelProps {
  accounts: EhAccount[];
  onSwitch?: ((accountId: string) => void) | undefined;
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
export function EhAccountPanel({ accounts, onSwitch, onCheckHealth, loading, onSave, onPasswordLogin, onBrowserLogin, saving, onReadCookie, onLogout }: EhAccountPanelProps) {
  const { showToast, clearToasts } = useToast();
  const [mode, setMode] = useState<'password' | 'browser' | 'cookie'>('password');
  const [browserPending, setBrowserPending] = useState(false);
  const [revealedId, setRevealedId] = useState<string>();
  const [dragOffset, setDragOffset] = useState(0);
  const [cookieAccount, setCookieAccount] = useState<{ accountId: string; label: string; cookie: string }>();
  const pointerDrag = useRef<{ id: string; pointerId: number; startX: number; baseOffset: number }>();
  const touchDrag = useRef<{ id: string; startX: number; baseOffset: number }>();
  const browserAbortRef = useRef<AbortController>();
  useEffect(() => () => browserAbortRef.current?.abort(), []);

  const accountActionWidth = 112;

  function accountDisplayName(account: EhAccount): string {
    if (account.username) return account.username;
    if (account.usernameHint) return account.usernameHint;
    return /^E-Hentai\s+\d+$/i.test(account.label) ? 'E-Hentai 账户' : account.label;
  }

  function pointerOffsetFor(accountId: string) {
    if (pointerDrag.current?.id === accountId || touchDrag.current?.id === accountId) return dragOffset;
    return revealedId === accountId ? -accountActionWidth : 0;
  }

  function beginAccountDrag(accountId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') return;
    pointerDrag.current = {
      id: accountId,
      pointerId: event.pointerId,
      startX: event.clientX,
      baseOffset: revealedId === accountId ? -accountActionWidth : 0,
    };
    setDragOffset(pointerDrag.current.baseOffset);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveAccountDrag(accountId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') return;
    const drag = pointerDrag.current;
    if (!drag || drag.id !== accountId || drag.pointerId !== event.pointerId) return;
    const next = Math.max(-accountActionWidth, Math.min(0, drag.baseOffset + event.clientX - drag.startX));
    setDragOffset(next);
  }

  function finishAccountDrag(accountId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') return;
    const drag = pointerDrag.current;
    if (!drag || drag.id !== accountId || drag.pointerId !== event.pointerId) return;
    const finalOffset = Math.max(-accountActionWidth, Math.min(0, drag.baseOffset + event.clientX - drag.startX));
    setRevealedId(finalOffset < -accountActionWidth * 0.35 ? accountId : undefined);
    setDragOffset(0);
    pointerDrag.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function beginAccountTouch(accountId: string, clientX: number) {
    touchDrag.current = {
      id: accountId,
      startX: clientX,
      baseOffset: revealedId === accountId ? -accountActionWidth : 0,
    };
    setDragOffset(touchDrag.current.baseOffset);
  }

  function moveAccountTouch(accountId: string, clientX: number) {
    const drag = touchDrag.current;
    if (!drag || drag.id !== accountId) return;
    setDragOffset(Math.max(-accountActionWidth, Math.min(0, drag.baseOffset + clientX - drag.startX)));
  }

  function finishAccountTouch(accountId: string, clientX: number) {
    const drag = touchDrag.current;
    if (!drag || drag.id !== accountId) return;
    const finalOffset = Math.max(-accountActionWidth, Math.min(0, drag.baseOffset + clientX - drag.startX));
    setRevealedId(finalOffset < -accountActionWidth * 0.35 ? accountId : undefined);
    setDragOffset(0);
    touchDrag.current = undefined;
  }

  function readCookieFields(cookie: string) {
    const preferred = ['nw', 'datatags', 'ipb_member_id', 'ipb_pass_hash', 'ipb_coppa', 'ipb_session_id', 'igneous', 'sk', 'star', 'event', 'hath_perks'];
    const defaults: Record<string, string> = { nw: '1', datatags: '1' };
    const actual = cookie.split(';').map((part) => part.trim()).filter((part) => part.includes('='));
    const fieldsByName = new Map(actual.map((field) => [field.slice(0, field.indexOf('=')).trim().toLowerCase(), field]));
    return [
      ...preferred.map((name) => fieldsByName.get(name) ?? `${name}=${defaults[name] ?? ''}`),
      ...actual.filter((field) => !preferred.includes(field.slice(0, field.indexOf('=')).trim().toLowerCase())),
    ];
  }

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

  if (loading) {
    return (
      <section className="eh-account-panel" aria-label="E-Hentai 账户">
        <p role="status">正在读取账户…</p>
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
                <Globe aria-hidden="true" />网页登录
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
        </div>
      )}
      {accounts.length > 0 && (
      <ul>
        {accounts.map((account) => {
          const assets = account.assets;
          const hasAssets = Boolean(assets && (assets.gp || assets.credits || assets.hath));
          const assetsLabel = hasAssets
            ? `GP ${assets?.gp || '-'} · Credits ${assets?.credits || '-'} · Hath ${assets?.hath || '-'}`
            : '正在更新资产…';
          return (
          <li key={account.id} className={`eh-account-swipe-row${account.isActive ? ' active' : ''}${revealedId === account.id ? ' is-revealed' : ''}`}>
            <div className="eh-account-swipe-actions" aria-hidden={revealedId !== account.id}>
              <button type="button" className="icon-button" tabIndex={revealedId === account.id ? 0 : -1} aria-label={`导出${account.label} Cookie`} title="导出 Cookie" onClick={() => { if (onReadCookie) void onReadCookie(account.id).then((cookie) => { if (cookie) setCookieAccount({ accountId: account.id, label: accountDisplayName(account), cookie }); }); }}><Download aria-hidden="true" /></button>
              <button type="button" className="icon-button danger" tabIndex={revealedId === account.id ? 0 : -1} aria-label={`登出${account.label}`} title="登出" onClick={() => { if (onLogout) void onLogout(account.id); setRevealedId(undefined); }}><LogOut aria-hidden="true" /></button>
            </div>
            <div
              className="eh-account-swipe-surface"
              data-testid={`eh-account-surface-${account.id}`}
              style={{ transform: `translate3d(${pointerOffsetFor(account.id)}px, 0, 0)` }}
              onPointerDown={(event) => beginAccountDrag(account.id, event)}
              onPointerMove={(event) => moveAccountDrag(account.id, event)}
              onPointerUp={(event) => finishAccountDrag(account.id, event)}
              onPointerCancel={(event) => finishAccountDrag(account.id, event)}
              onTouchStart={(event) => { const touch = event.touches[0]; if (touch) beginAccountTouch(account.id, touch.clientX); }}
              onTouchMove={(event) => { event.preventDefault(); const touch = event.touches[0]; if (touch) moveAccountTouch(account.id, touch.clientX); }}
              onTouchEnd={(event) => { const touch = event.changedTouches[0]; if (touch) finishAccountTouch(account.id, touch.clientX); }}
            >
              <div className="eh-account-summary">
                <strong>{accountDisplayName(account)}</strong>
                <span>{account.exhentaiAccess === true ? 'EXHENTAI 可访问' : account.exhentaiAccess === false ? 'EXHENTAI 不可访问' : '正在检测 EXHENTAI 访问权限…'}</span>
                <small>{assetsLabel}</small>
              </div>
              <div className="account-actions">
              {onCheckHealth && (
                <button type="button" className="icon-button" aria-label={`检查${account.label}`} title="更新账户信息" onPointerDown={(event) => event.stopPropagation()} onClick={() => onCheckHealth(account.id)}>
                  <RefreshCw aria-hidden="true" />
                </button>
              )}
              {onSwitch && !account.isActive && (
                <button type="button" className="icon-button" aria-label={`切换到${account.label}`} title="切换账户" onPointerDown={(event) => event.stopPropagation()} onClick={() => onSwitch(account.id)}>
                  <ArrowRightLeft aria-hidden="true" />
                </button>
              )}
              {account.isActive && <span className="visually-hidden" aria-label="当前活跃">当前活跃</span>}
              </div>
            </div>
          </li>
        );})}
      </ul>
      )}
      {cookieAccount && <div className="eh-cookie-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCookieAccount(undefined); }}>
        <div className="eh-cookie-dialog" role="dialog" aria-modal="true" aria-label={`${cookieAccount.label} Cookie`}>
          <div className="eh-cookie-dialog-header"><strong>{cookieAccount.label}</strong><div className="eh-cookie-dialog-actions"><button type="button" className="icon-button" aria-label="复制全部 Cookie" title="复制全部 Cookie" onClick={() => { void navigator.clipboard?.writeText(cookieAccount.cookie).then(() => showToast('Cookie 已复制', 'success'), () => showToast('复制 Cookie 失败', 'error')); }}><Copy aria-hidden="true" /></button><button type="button" className="icon-button" aria-label="关闭 Cookie" onClick={() => setCookieAccount(undefined)}><X aria-hidden="true" /></button></div></div>
          <div className="eh-cookie-fields">{readCookieFields(cookieAccount.cookie).map((field) => { const [name, ...rest] = field.split('='); const value = rest.join('='); return <div className="eh-cookie-field" key={name}><code>{name}</code><span title={value}>{value || '未获取'}</span>{name === 'igneous' && <button type="button" className="icon-button" aria-label="刷新 igneous" title="刷新 igneous" onClick={() => { if (!onCheckHealth || !onReadCookie) return; void onCheckHealth(cookieAccount.accountId).then(async () => { const cookie = await onReadCookie(cookieAccount.accountId); if (cookie) setCookieAccount({ ...cookieAccount, cookie }); }); }}><RotateCw aria-hidden="true" /></button>}</div>; })}</div>
        </div>
      </div>}
    </section>
  );
}
