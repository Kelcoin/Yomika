import type { EhAccount } from '../domain/eh';
import type { SaveEhAccountInput } from '../domain/eh';
import { EhAccountPanel } from './EhAccountPanel';

interface EhWorkspaceProps {
  accounts: EhAccount[];
  onSwitchAccount?: ((accountId: string) => void) | undefined;
  onCheckHealth?: ((accountId: string) => Promise<void>) | undefined;
  searching?: boolean | undefined;
  searched?: boolean | undefined;
  searchError?: string | undefined;
  accountsLoading?: boolean | undefined;
  onSaveAccount?: ((input: SaveEhAccountInput) => Promise<void>) | undefined;
  onPasswordLogin?: ((username: string, password: string) => Promise<string>) | undefined;
  /** Resolves with the cookie header once the user has signed in through the
   * page E-Hentai serves; the only route through a Cloudflare challenge. */
  onBrowserLogin?: ((signal?: AbortSignal) => Promise<string>) | undefined;
  savingAccount?: boolean | undefined;
  onReadCookie?: ((accountId: string) => Promise<string | undefined>) | undefined;
  onLogout?: ((accountId: string) => Promise<void>) | undefined;
}

export function EhWorkspace({ accounts, onSwitchAccount, onCheckHealth, accountsLoading, onSaveAccount, onPasswordLogin, onBrowserLogin, savingAccount, onReadCookie, onLogout }: EhWorkspaceProps) {
  return (
    <div>
      <EhAccountPanel accounts={accounts} onSwitch={onSwitchAccount} onCheckHealth={onCheckHealth} loading={accountsLoading} onSave={onSaveAccount} onPasswordLogin={onPasswordLogin} onBrowserLogin={onBrowserLogin} saving={savingAccount} onReadCookie={onReadCookie} onLogout={onLogout} />
    </div>
  );
}
