import { useCallback, useEffect, useRef, useState } from 'react';

import { EhWorkspace } from './EhWorkspace';
import { accountDisplayName } from './EhAccountPanel';
import { useToast } from './Toast';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { getPlatformCapabilities } from '../bridge/platform';
import { ehAccountIdFor, ehHostFor, formatEhCookieHeader, parseEhCookie } from '../lib/ehCookie';
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

/** A health result without a name needs the profile-webview fallback: the
 * forums page is the only place the account is named, and Cloudflare blocks
 * plain HTTP clients from it. */
function healthMissingName(account: EhAccount): boolean {
  return !account.username && !account.usernameHint;
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

/** 手机上不能另开 webview 窗口（Android 上那会把应用自己的界面顶掉、关掉时应用跟着没了），
 * 登录页要画在应用内。平台是异步命令：提示文案要它，而点下「打开登录页面」时也必须已经
 * 知道答案——不然刚启动就点的人会走到那条会闪退的路上。每次挂载问一次、在组件内共用
 * 同一个 promise（不跨组件实例缓存：平台不会变，但缓存住一个过期答案的代价更贵）。
 *
 * Rust 侧另有一道防线：`open_eh_login_window` 在移动端直接拒绝。 */

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
export function EhRouteWorkspace({ onActiveAccountChange }: { onActiveAccountChange?: ((label: string | undefined) => void) | undefined } = {}) {
  const { showToast } = useToast();
  const [accounts, setAccounts] = useState<EhAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [savingAccount, setSavingAccount] = useState(false);
  /** 手机上不能另开 webview 窗口（会把应用自己的界面顶掉，关掉时应用跟着没了），
   * 所以登录页改成应用内浮层。平台是异步命令，先按「桌面」画——按错的那一瞬间只影响
   * 提示文案，点下去之前结果就回来了。 */
  const [platformMobile, setPlatformMobile] = useState(false);
  const platformMobileRef = useRef<Promise<boolean> | undefined>(undefined);
  const isMobilePlatform = useCallback((): Promise<boolean> => {
    platformMobileRef.current ??= getPlatformCapabilities().then(
      (result) => result.ok && (result.value.platform === 'android' || result.value.platform === 'ios'),
    );
    return platformMobileRef.current;
  }, []);

  useEffect(() => { void isMobilePlatform().then(setPlatformMobile); }, [isMobilePlatform]);

  /* 移动端的应用内登录有两条收尾路径：原生浮层那条由上面那次轮询直接领走结果；顶层导航
     那条（桌面、iOS）会让应用整页重载，登录期间那个 promise 早就没了，所以重载后来领一次。
     这里留着这条兜底，两条路都不会把结果丢在地上。 */
  useEffect(() => {
    let active = true;
    void ehRepository.takeInAppLogin().then(async (result) => {
      if (!active || !result.ok || !result.value) return;
      const credentials = parseEhCookie(result.value);
      if (!credentials) return;
      const saved = await ehRepository.saveAccount({
        id: ehAccountIdFor(credentials),
        label: 'E-Hentai 账户',
        host: ehHostFor(credentials),
        cookie: formatEhCookieHeader(result.value),
      });
      if (!active) return;
      if (!saved.ok) {
        showToast(presentEhError(saved.error.code, saved.error.message), 'error');
        return;
      }
      setAccounts((current) => [...current.filter((account) => account.id !== saved.value.id), { ...saved.value, status: 'verified' }]);
      showToast('E-Hentai 登录成功', 'success');
    });
    return () => { active = false; };
  }, [showToast]);

  // The settings row reports the active account as its current value, so the
  // list state has to surface one level. 收起的行也要能看到登录的是谁：用户名，
  // 或 Cookie 登录时的会员编号——不是那条谁也认不出的通用标签。没有 isActive
  // 标记时退回第一个账户：单账户场景下它就是当前账户，不应显示「未登录」。
  useEffect(() => {
    const active = accounts.find((account) => account.isActive) ?? accounts[0];
    onActiveAccountChange?.(active ? accountDisplayName(active) : undefined);
  }, [accounts, onActiveAccountChange]);

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
        // 用户名只在网页登录完成时抓取一次并落库；此后的健康检查与刷新不再
        // 重新抓取——显示名以账户行里的 username_hint 为准（可手动编辑）。
      }
      if (active) setAccountsLoading(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <EhWorkspace
      accounts={accounts}
      accountsLoading={accountsLoading}
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
        // 用户名不做刷新抓取；缺名时提示手动编辑。
        const target = accounts.find((account) => account.id === accountId);
        if (target && healthMissingName({ ...target, username: health.username ?? undefined, usernameHint: health.username ?? target.usernameHint })) {
          showToast('未记录账户名，默认显示为「E 站用户」，可点编辑按钮修改', 'info');
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
      onEditUsername={async (accountId: string, username: string) => {
        const result = await ehRepository.setUsernameHint(accountId, username);
        if (!result.ok) throw new Error(presentEhError(result.error.code, result.error.message));
        setAccounts((current) => current.map((account) => account.id === accountId
          ? { ...account, username: username, usernameHint: username }
          : account));
      }}
      onSaveAccount={async (input: SaveEhAccountInput) => {
        setSavingAccount(true);
        const result = await ehRepository.saveAccount(input);
        setSavingAccount(false);
        if (!result.ok) throw new Error(presentEhError(result.error.code, result.error.message));
        // A web login that captured both authentication cookies counts as a
        // success. Do not immediately perform a second HTTP health request
        // here: Cloudflare may challenge that request even though the WebView
        // login just succeeded, which used to overwrite a valid account with
        // the misleading “错误” status.
        setAccounts((current) => [...current.filter((account) => account.id !== result.value.id), { ...result.value, status: 'verified' }]);
        // 仅网页登录完成时抓一次用户名并落库（一次纯 HTTP 尝试，通常被
        // Cloudflare 拦下）；抓不到就默认显示为「E 站用户」，用户要改就点
        // 账户卡上的编辑按钮原地修改。
        if (healthMissingName(result.value)) {
          void ehRepository.fetchForumUsername(result.value.id).then((resolved) => {
            if (!resolved.ok || !resolved.value) return;
            setAccounts((current) => current.map((account) => account.id === result.value.id
              ? { ...account, username: resolved.value ?? undefined, usernameHint: resolved.value ?? undefined }
              : account));
          });
        }
      }}
      onPasswordLogin={async (username: string, password: string) => {
        setSavingAccount(true);
        const result = await ehRepository.loginWithPassword(username, password);
        setSavingAccount(false);
        if (!result.ok) throw new Error(presentEhLoginError(result.error.code, result.error.message));
        return result.value;
      }}
      /* 移动端与桌面两条路，形状一样：打开登录页 → 等 Cookie → 结果回来。
         桌面另开一个窗口（那窗口的 Cookie 罐单独一份）；移动端开的是应用内的原生浮层
         ——Android 上应用自己的 webview 就是 activity 的内容视图，另开窗口会把它顶掉、
         顶层导航等于把应用整个换掉（两条都闪退），所以登录页画在原生侧的另一层 WebView
         上，应用原地不动，登录完由这里领结果。 */
      onInAppLogin={platformMobile ? async (signal?: AbortSignal) => {
        const started = await ehRepository.startInAppLogin();
        if (!started.ok) throw new Error(presentEhError(started.error.code, started.error.message));
        const deadline = Date.now() + BROWSER_LOGIN_TIMEOUT_MS;
        try {
          while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error('已取消网页登录');
            const taken = await ehRepository.takeInAppLogin();
            if (!taken.ok) throw new Error(presentEhError(taken.error.code, taken.error.message));
            if (taken.value) return taken.value;
            await new Promise((resolve) => window.setTimeout(resolve, BROWSER_LOGIN_POLL_MS));
          }
          throw new Error('网页登录超时，请重试');
        } finally {
          // 收工就关掉浮层：把人留在登录页上是最没道理的一种结局。
          await ehRepository.cancelInAppLogin();
        }
      } : undefined}
      onBrowserLogin={platformMobile ? undefined : async (signal?: AbortSignal) => {
        // Open E-Hentai's own page and wait for its cookie jar to hold a session.
        // Polling rather than an event: the user is the one who decides when the
        // challenge is cleared and the form submitted, and there is nothing on
        // the page to hook.
        //
        // 手机上登录页画在应用内（`EhLoginSheet`），读的也是应用自己那个 webview 的
        // Cookie；桌面上才是另开一个窗口。
        // 现场再确认一次平台：刚启动就点的人不能因为状态还没填上而走错路。
        const opened = await ehRepository.openLoginWindow();
        if (!opened.ok) throw new Error(presentEhError(opened.error.code, opened.error.message));
        const deadline = Date.now() + BROWSER_LOGIN_TIMEOUT_MS;
        // Give the WebView time to load the login/challenge page. Reading its
        // pre-existing cookie jar immediately can mistake stale credentials for
        // a completed login and close the window before it is usable.
        await new Promise((resolve) => window.setTimeout(resolve, BROWSER_LOGIN_GRACE_MS));
        try {
          while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error('已取消网页登录');
            // 先查、再等：宽限结束时正好查第一次，不必再白等一个轮询间隔。
            const captured = await ehRepository.captureLoginCookies();
            if (!captured.ok) {
              // The window is gone: closing it is how someone gives up.
              if (captured.error.code === 'EH_LOGIN_WINDOW_CLOSED') throw new Error('登录窗口已关闭');
              throw new Error(presentEhError(captured.error.code, captured.error.message));
            }
            if (captured.value) return captured.value;
            await new Promise((resolve) => window.setTimeout(resolve, BROWSER_LOGIN_POLL_MS));
          }
          throw new Error('网页登录超时，请重试');
        } finally {
          await ehRepository.closeLoginWindow();
        }
      }}
    />
  );
}
