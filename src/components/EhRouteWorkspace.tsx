import { useEffect, useState } from 'react';

import { EhWorkspace } from './EhWorkspace';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { presentEhError, type EhSearchResult } from '../services/ehClient';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';

const ehRepository = new NativeEhRepository();

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
      }}
      onPasswordLogin={async (username: string, password: string) => {
        setSavingAccount(true);
        const result = await ehRepository.loginWithPassword(username, password);
        setSavingAccount(false);
        if (!result.ok) throw new Error(presentEhError(result.error.code, result.error.message));
        return result.value;
      }}
    />
  );
}
