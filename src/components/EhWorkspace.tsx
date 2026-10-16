import type { EhAccount } from '../domain/eh';
import type { SaveEhAccountInput } from '../domain/eh';
import { EhAccountPanel } from './EhAccountPanel';

interface EhWorkspaceProps {
  accounts: EhAccount[];
  onCheckHealth?: ((accountId: string) => Promise<void>) | undefined;
  searching?: boolean | undefined;
  searched?: boolean | undefined;
  searchError?: string | undefined;
  accountsLoading?: boolean | undefined;
  accountsError?: string | undefined;
  onRetryAccounts?: (() => void) | undefined;
  onSaveAccount?: ((input: SaveEhAccountInput) => Promise<void>) | undefined;
  onPasswordLogin?: ((username: string, password: string) => Promise<string>) | undefined;
  /** Resolves with the cookie header once the user has signed in through the
   * page E-Hentai serves; the only route through a Cloudflare challenge. */
  onBrowserLogin?: ((signal?: AbortSignal) => Promise<string>) | undefined;
  /** 移动端：登录页画在应用内的原生浮层上，形状与 `onBrowserLogin` 一样——等 Cookie。 */
  onInAppLogin?: ((signal?: AbortSignal) => Promise<string>) | undefined;
  savingAccount?: boolean | undefined;
  onReadCookie?: ((accountId: string) => Promise<string | undefined>) | undefined;
  onLogout?: ((accountId: string) => Promise<void>) | undefined;
  onEditUsername?: ((accountId: string, username: string) => Promise<void>) | undefined;
}

export function EhWorkspace({ accounts, onCheckHealth, accountsLoading, accountsError, onRetryAccounts, onSaveAccount, onPasswordLogin, onBrowserLogin, onInAppLogin, savingAccount, onReadCookie, onLogout, onEditUsername }: EhWorkspaceProps) {
  return (
    <div>
      {accountsError ? <section className="eh-account-panel" aria-label="E-Hentai 账户">
        <p role="alert">{accountsError}</p>
        <button className="secondary-action" type="button" onClick={onRetryAccounts}>重新读取账户</button>
      </section> : <EhAccountPanel accounts={accounts} onCheckHealth={onCheckHealth} loading={accountsLoading} onSave={onSaveAccount} onPasswordLogin={onPasswordLogin} onBrowserLogin={onBrowserLogin} onInAppLogin={onInAppLogin} saving={savingAccount} onReadCookie={onReadCookie} onLogout={onLogout} onEditUsername={onEditUsername} />}
    </div>
  );
}
