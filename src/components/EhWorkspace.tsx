import { Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import type { EhAccount } from '../domain/eh';
import type { EhSearchResult } from '../services/ehClient';
import { EhAccountPanel } from './EhAccountPanel';

interface EhWorkspaceProps {
  accounts: EhAccount[];
  results?: EhSearchResult[] | undefined;
  onSearch?: ((query: string) => void) | undefined;
  onSwitchAccount?: ((accountId: string) => void) | undefined;
  onCheckHealth?: ((accountId: string) => void) | undefined;
  searching?: boolean | undefined;
  searched?: boolean | undefined;
  searchError?: string | undefined;
  accountsLoading?: boolean | undefined;
}

export function EhWorkspace({ accounts, results, onSearch, onSwitchAccount, onCheckHealth, searching, searched, searchError, accountsLoading }: EhWorkspaceProps) {
  const [query, setQuery] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim() && onSearch) onSearch(query.trim());
  }

  return (
    <div>
      <header className="workspace-heading">
        <p className="workspace-kicker">E-Hentai</p>
        <h1>账户与搜索</h1>
      </header>
      <EhAccountPanel accounts={accounts} onSwitch={onSwitchAccount} onCheckHealth={onCheckHealth} loading={accountsLoading} />
      <section className="eh-search-section" aria-label="搜索">
        <form className="eh-search-form" onSubmit={handleSubmit}>
          <label className="eh-search-input">
            <Search aria-hidden="true" />
            <input
              type="search"
              placeholder="搜索 E-Hentai..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={searching}
            />
          </label>
          <button className="primary-action" type="submit" disabled={searching || !query.trim()}>
            {searching ? '搜索中' : '搜索'}
          </button>
        </form>
        {searchError && <p className="form-error" role="alert">{searchError}</p>}
        {searching && <p role="status">正在搜索...</p>}
        {!searching && searched && results && results.length === 0 && <p>未找到匹配的画廊</p>}
        {!searching && results && results.length > 0 && (
          <ul className="eh-results-list">
            {results.map((result) => (
              <li key={result.galleryKey}>
                <strong>{result.title}</strong>
                <span>{result.category}</span>
                <span>{result.uploader}</span>
                <span>{result.pageCount} pages</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
