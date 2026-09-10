import { useEffect, useState } from 'react';

import { EhWorkspace } from './EhWorkspace';
import { useToast } from './Toast';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { presentEhError, presentEhLoginError } from '../services/ehClient';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';

const EH_HEALTH_CACHE_KEY = 'yomika.eh.health.v1';
type EhHealthCache = Record<string, { checkedAt: number; username: string | null; assets: NonNullable<EhAccount['assets']>; exhentaiAccess?: boolean | null | undefined }>;
const EMPTY_HEALTH_ASSETS: NonNullable<EhAccount['assets']> = { gp: '', credits: '', hath: '' };

function mergeHealthAssets(previous: EhAccount['assets'], next: NonNullable<EhAccount['assets']>) {
  return {
    gp: next.gp.trim() || previous?.gp || '',
    credits: next.credits.trim() || previous?.credits || '',
    hath: next.hath.trim() || previous?.hath || '',
  };
}

function hasHealthAssets(assets: EhAccount['assets']) {
  return Boolean(assets?.gp.trim() || assets?.credits.trim() || assets?.hath.trim());
}

function hydrateHealth(account: EhAccount, health: EhHealthCache[string] | undefined): EhAccount {
  if (!health) return account;
  const assets = mergeHealthAssets(account.assets, health.assets ?? EMPTY_HEALTH_ASSETS);
  // An older SQLite row can contain empty assets or an error status even though
  // a previous successful probe was cached. Preserve that snapshot until the
  // fresh probe below completes; a verified row with an explicit false is kept.
  const useCachedHealth = !hasHealthAssets(account.assets)
    || account.exhentaiAccess === undefined
    || account.status === 'error';
  const exhentaiAccess = useCachedHealth
    ? health.exhentaiAccess
    : account.exhentaiAccess ?? health.exhentaiAccess;
  if (!useCachedHealth) return account;
  return {
    ...account,
    status: account.status === 'error' ? 'verified' : account.status,
    username: account.username ?? health.username ?? undefined,
    usernameHint: account.usernameHint ?? health.username ?? undefined,
    assets,
    exhentaiAccess,
    host: exhentaiAccess ? 'exhentai.org' : account.host,
  };
}

function readHealthCache(): EhHealthCache {
  try {
    const value = JSON.parse(window.localStorage.getItem(EH_HEALTH_CACHE_KEY) ?? '{}') as unknown;
    return value && typeof value === 'object' ? value as EhHealthCache : {};
  } catch { return {}; }
}

function writeHealthCache(cache: EhHealthCache) {
  try { window.localStorage.setItem(EH_HEALTH_CACHE_KEY, JSON.stringify(cache)); } catch { /* storage can be unavailable in private webviews */ }
}

const ehRepository = new NativeEhRepository();

/** How often the sign-in window's cookie jar is checked, and how long the wait
 * lasts. A Cloudflare challenge plus a password is a slow manual job, so the
 * ceiling is generous; the interval is only as tight as it needs to be to feel
 * immediate once the session lands. */
const BROWSER_LOGIN_POLL_MS = 1_500;
const BROWSER_LOGIN_GRACE_MS = 5_000;
const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

/** Its own module rather than a route-file export: the settings page hosts this
 * workspace, and importing it from `app/routes` made the two files import each
 * other, which left the settings page rendering nothing. `/eh` still routes here
 * as a deep link. */
export function EhRouteWorkspace() {
  const { showToast } = useToast();
  const [accounts, setAccounts] = useState<EhAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [savingAccount, setSavingAccount] = useState(false);

  useEffect(() => {
    let active = true;
    void ehRepository.listAccounts().then(async (result) => {
      if (!active) return;
      if (result.ok) {
        const cached = readHealthCache();
        const hydrated = result.value.map((account) => hydrateHealth(account, cached[account.id]));
        setAccounts(hydrated);
        setAccountsLoading(false);
        const refreshed = await Promise.all(hydrated.map(async (account) => {
          const health = await ehRepository.checkLoginHealth(account.id);
          if (!health.ok) return account;
          const assets = mergeHealthAssets(account.assets, health.value.assets);
          // `null` means the Ex probe was blocked or unavailable, not a negative
          // result. Keeping an old false here made a one-time failed probe look
          // like a permanent "EXHENTAI 不可访问" verdict on every visit.
          const exhentaiAccess = health.value.exhentaiAccess;
          const next = {
            ...account,
            status: health.value.loggedIn ? 'verified' as const : 'error' as const,
            username: health.value.username ?? account.username,
            usernameHint: health.value.username ?? account.usernameHint,
            assets,
            exhentaiAccess,
            host: exhentaiAccess ? 'exhentai.org' as const : account.host,
          };
          if (health.value.loggedIn) {
            const latest = readHealthCache();
            latest[account.id] = { checkedAt: Date.now(), username: next.username ?? null, assets, exhentaiAccess };
            writeHealthCache(latest);
          }
          return next;
        }));
        if (active) setAccounts((current) => current.map((account) => {
          const update = refreshed.find((item) => item.id === account.id);
          return update ? { ...update, isActive: account.isActive } : account;
        }));
      }
      if (active) setAccountsLoading(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <EhWorkspace
      accounts={accounts}
      accountsLoading={accountsLoading}
      onSwitchAccount={async (accountId) => {
        const result = await ehRepository.setActiveAccount(accountId);
        if (!result.ok) {
          // Not a search error: it used to be reported in the search slot, which
          // only renders when there is an active account — so a switch that left
          // none reported itself nowhere at all.
          showToast(presentEhError(result.error.code, result.error.message), 'error');
          return;
        }
        setAccounts((current) => current.map((account) => ({
          ...account,
          isActive: account.id === accountId,
        })));
      }}
      onCheckHealth={async (accountId) => {
        const result = await ehRepository.checkLoginHealth(accountId);
        if (!result.ok) {
          showToast(presentEhError(result.error.code, result.error.message), 'error');
          return;
        }
        setAccounts((current) => current.map((account) => account.id === accountId
          ? (() => {
              const assets = mergeHealthAssets(account.assets, result.value.assets);
              const exhentaiAccess = result.value.exhentaiAccess;
              return {
              ...account,
              status: result.value.loggedIn ? 'verified' : 'error',
              username: result.value.username,
              usernameHint: result.value.username ?? account.usernameHint,
              assets,
              exhentaiAccess,
              host: exhentaiAccess ? 'exhentai.org' : account.host,
              };
            })()
          : account));
        const health = result.value;
        if (health.loggedIn) {
          const cache = readHealthCache();
          const previousAccount = accounts.find((account) => account.id === accountId);
          const previous = cache[accountId];
          cache[accountId] = {
            checkedAt: Date.now(),
            username: health.username ?? previous?.username ?? null,
            assets: mergeHealthAssets(previousAccount?.assets ?? previous?.assets, health.assets),
            exhentaiAccess: health.exhentaiAccess ?? previousAccount?.exhentaiAccess ?? previous?.exhentaiAccess,
          };
          writeHealthCache(cache);
        }
        showToast('E-Hentai 账户信息已更新', 'success');
      }}
      onReadCookie={async (accountId) => {
        const result = await ehRepository.readAccountCookie(accountId);
        if (!result.ok) { showToast(presentEhError(result.error.code, result.error.message), 'error'); return undefined; }
        return result.value;
      }}
      onLogout={async (accountId) => {
        const result = await ehRepository.removeAccount(accountId);
        if (!result.ok) { showToast(presentEhError(result.error.code, result.error.message), 'error'); return; }
        setAccounts((current) => current.filter((account) => account.id !== accountId));
        showToast('已登出 E-Hentai 账户', 'info');
      }}
      savingAccount={savingAccount}
      onSaveAccount={async (input: SaveEhAccountInput) => {
        setSavingAccount(true);
        const result = await ehRepository.saveAccount(input);
        setSavingAccount(false);
        if (!result.ok) throw new Error(presentEhError(result.error.code, result.error.message));
        // JHenTai treats the presence of both authentication cookies as the
        // result of a successful web login. Do not immediately perform a
        // second HTTP health request here: Cloudflare may challenge that
        // request even though the WebView login just succeeded, which used to
        // overwrite a valid account with the misleading “错误” status.
        setAccounts((current) => [...current.filter((account) => account.id !== result.value.id), { ...result.value, status: 'verified' }]);
      }}
      onPasswordLogin={async (username: string, password: string) => {
        setSavingAccount(true);
        const result = await ehRepository.loginWithPassword(username, password);
        setSavingAccount(false);
        if (!result.ok) throw new Error(presentEhLoginError(result.error.code, result.error.message));
        return result.value;
      }}
      onBrowserLogin={async (signal?: AbortSignal) => {
        // Open E-Hentai's own page and wait for its cookie jar to hold a session.
        // Polling rather than an event: the user is the one who decides when the
        // challenge is cleared and the form submitted, and there is nothing on
        // the page to hook.
        const opened = await ehRepository.openLoginWindow();
        if (!opened.ok) throw new Error(presentEhError(opened.error.code, opened.error.message));
        const deadline = Date.now() + BROWSER_LOGIN_TIMEOUT_MS;
        // Give the WebView time to load the login/challenge page. Reading its
        // pre-existing cookie jar immediately can mistake stale credentials for
        // a completed login and close the window before it is usable.
        await new Promise((resolve) => window.setTimeout(resolve, BROWSER_LOGIN_GRACE_MS));
        while (Date.now() < deadline) {
          if (signal?.aborted) {
            await ehRepository.closeLoginWindow();
            throw new Error('已取消网页登录');
          }
          await new Promise((resolve) => window.setTimeout(resolve, BROWSER_LOGIN_POLL_MS));
          const captured = await ehRepository.captureLoginCookies();
          if (!captured.ok) {
            // The window is gone: closing it is how someone gives up.
            if (captured.error.code === 'EH_LOGIN_WINDOW_CLOSED') throw new Error('登录窗口已关闭');
            throw new Error(presentEhError(captured.error.code, captured.error.message));
          }
          if (captured.value) {
            await ehRepository.closeLoginWindow();
            return captured.value;
          }
        }
        await ehRepository.closeLoginWindow();
        throw new Error('网页登录超时，请重试');
      }}
    />
  );
}
