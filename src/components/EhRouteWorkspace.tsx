import { useEffect, useState } from 'react';

import { EhWorkspace } from './EhWorkspace';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { presentEhError, presentEhLoginError, type EhSearchResult } from '../services/ehClient';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';

const ehRepository = new NativeEhRepository();

/** How often the sign-in window's cookie jar is checked, and how long the wait
 * lasts. A Cloudflare challenge plus a password is a slow manual job, so the
 * ceiling is generous; the interval is only as tight as it needs to be to feel
 * immediate once the session lands. */
const BROWSER_LOGIN_POLL_MS = 1_500;
const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

/** Its own module rather than a route-file export: the settings page hosts this
 * workspace, and importing it from `app/routes` made the two files import each
 * other, which left the settings page rendering nothing. `/eh` still routes here
 * as a deep link. */
export function EhRouteWorkspace() {
  const [accounts, setAccounts] = useState<EhAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [results, setResults] = useState<EhSearchResult[]>();
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [savingAccount, setSavingAccount] = useState(false);

  useEffect(() => {
    let active = true;
    void ehRepository.listAccounts().then((result) => {
      if (!active) return;
      if (result.ok) setAccounts(result.value);
      setAccountsLoading(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <EhWorkspace
      accounts={accounts}
      accountsLoading={accountsLoading}
      results={results}
      searching={searching}
      searched={searched}
      searchError={searchError}
      onSearch={async (query) => {
        setSearching(true);
        setSearchError(undefined);
        setSearched(false);
        const activeAccount = accounts.find((a) => a.isActive);
        if (!activeAccount) {
          setSearchError('请先添加并激活一个 E-Hentai 账户');
          setSearching(false);
          return;
        }
        const result = await ehRepository.searchGalleries(activeAccount.id, query);
        if (result.ok) {
          setResults(result.value.galleries);
          setSearched(true);
        } else {
          setSearchError(presentEhError(result.error.code, result.error.message));
        }
        setSearching(false);
      }}
      onSwitchAccount={async (accountId) => {
        const result = await ehRepository.setActiveAccount(accountId);
        if (!result.ok) {
          setSearchError(presentEhError(result.error.code, result.error.message));
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
          setSearchError(presentEhError(result.error.code, result.error.message));
          return;
        }
        setAccounts((current) => current.map((account) => account.id === accountId
          ? { ...account, status: result.value.loggedIn ? 'verified' : 'error' }
          : account));
      }}
      savingAccount={savingAccount}
      onSaveAccount={async (input: SaveEhAccountInput) => {
        setSavingAccount(true);
        const result = await ehRepository.saveAccount(input);
        setSavingAccount(false);
        if (!result.ok) throw new Error(presentEhError(result.error.code, result.error.message));
        setAccounts((current) => [...current.filter((account) => account.id !== result.value.id), result.value]);
        // Verify immediately. A freshly saved account sitting at 未验证 says
        // nothing about whether the credentials work, which is the only thing
        // the user wants to know after signing in.
        const health = await ehRepository.checkLoginHealth(result.value.id);
        setAccounts((current) => current.map((account) => account.id === result.value.id
          ? { ...account, status: health.ok && health.value.loggedIn ? 'verified' : 'error' }
          : account));
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
