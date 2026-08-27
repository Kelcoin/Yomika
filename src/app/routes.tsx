import { ArrowRight, FolderHeart, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';

import { EmptyState } from '../components/EmptyState';
import { EhWorkspace } from '../components/EhWorkspace';
import { LibraryRouteWorkspace } from '../components/LibraryRouteWorkspace';
import { ReaderRoute as ReaderRouteScreen } from '../components/ReaderRoute';
import { SettingsWorkspace } from '../components/SettingsWorkspace';
import { TaskCenter } from '../components/TaskCenter';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import type { ReadingHistoryRecord, WatchlistRecord } from '../domain/library';
import type { EhAccount } from '../domain/eh';
import type { EhSearchResult } from '../services/ehClient';

const workspaces = {
  library: ['档案库', '连接服务器后，档案会显示在这里。'],
  history: ['历史', '开始阅读后，进度会保存在这里。'],
  watchlist: ['待看', '加入待看的档案会显示在这里。'],
  downloads: ['下载', '当前没有下载任务。'],
  sync: ['同步', '添加 WebDAV 账户后可查看同步状态。'],
} as const;

function HomeWorkspace() {
  const [servers, setServers] = useState<Awaited<ReturnType<NativeLibraryRepository['listServers']>>>();
  useEffect(() => {
    let active = true;
    void repository.listServers().then((result) => { if (active) setServers(result); });
    return () => { active = false; };
  }, []);
  const connected = servers?.ok && servers.value.length > 0;
  return (
    <div className="workspace-home">
      <header className="workspace-heading">
        <p className="workspace-kicker">本地书架</p>
        <h1>首页</h1>
      </header>
      {connected ? (
        <section className="first-run" aria-labelledby="first-run-title">
          <div className="first-run-copy">
            <Server aria-hidden="true" />
            <p className="eyebrow">已连接</p>
            <h2 id="first-run-title">{servers.value?.[0]?.name ?? 'LANraragi'}</h2>
            <p>服务器已配置，可以开始浏览档案。</p>
          </div>
          <Link className="primary-action" to="/library">打开档案库<ArrowRight aria-hidden="true" /></Link>
        </section>
      ) : (
        <section className="first-run" aria-labelledby="first-run-title">
        <div className="first-run-copy">
          <Server aria-hidden="true" />
          <p className="eyebrow">未连接</p>
          <h2 id="first-run-title">添加你的 LANraragi</h2>
          <p>服务器配置保存在本机。连接后即可浏览档案并建立离线书架。</p>
        </div>
        <Link className="primary-action" to="/settings">
          添加服务器
          <ArrowRight aria-hidden="true" />
        </Link>
        </section>
      )}
      <div className="shelf-rule" aria-hidden="true">
        <span>最近阅读</span>
        <span>00</span>
      </div>
      <EmptyState
        icon={FolderHeart}
        title="书架还是空的"
        description="连接服务器后，最近阅读和待看内容会出现在这里。"
      />
    </div>
  );
}

const repository = new NativeLibraryRepository();

function StateWorkspace({ name }: { name: 'history' | 'watchlist' }) {
  const [history, setHistory] = useState<ReadingHistoryRecord[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void (async () => {
      const servers = await repository.listServers();
      if (!active) return;
      if (!servers.ok) { setError(servers.error.message); return; }
      const scopeId = servers.value[0]?.scopeId;
      if (!scopeId) return;
      const result = name === 'history' ? await repository.listHistory(scopeId) : await repository.listWatchlist(scopeId);
      if (!active) return;
      if (!result.ok) setError(result.error.message);
      else if (name === 'history') setHistory(result.value as ReadingHistoryRecord[]);
      else setWatchlist(result.value as WatchlistRecord[]);
    })();
    return () => { active = false; };
  }, [name]);
  const [title, description] = workspaces[name];
  const records = name === 'history' ? history : watchlist;
  return (
    <div>
      <header className="workspace-heading"><h1>{title}</h1></header>
      {error && <p className="form-error" role="alert">{error}</p>}
      {records.length === 0 ? <EmptyState icon={FolderHeart} title={`暂无${title}`} description={description} /> : (
        <ul className="state-list">
          {name === 'history'
            ? history.map((item) => <li key={item.archiveId}><strong>{item.archiveId}</strong><span>第 {item.pageIndex + 1} 页</span></li>)
            : watchlist.map((item) => <li key={item.archiveId}><strong>{item.archiveId}</strong><span>待看</span></li>)}
        </ul>
      )}
    </div>
  );
}

function EmptyWorkspace({ name }: { name: keyof typeof workspaces }) {
  const [title, description] = workspaces[name];
  return (
    <div>
      <header className="workspace-heading">
        <h1>{title}</h1>
      </header>
      <EmptyState icon={FolderHeart} title={`暂无${title}`} description={description} />
    </div>
  );
}

const ehRepository = new NativeEhRepository();

function EhRouteWorkspace() {
  const [accounts, setAccounts] = useState<EhAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [results, setResults] = useState<EhSearchResult[]>();
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string>();

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
          setSearchError(result.error.message);
        }
        setSearching(false);
      }}
      onSwitchAccount={async (accountId) => {
        const result = await ehRepository.setActiveAccount(accountId);
        if (!result.ok) {
          setSearchError(result.error.message);
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
          setSearchError(result.error.message);
          return;
        }
        setAccounts((current) => current.map((account) => account.id === accountId
          ? { ...account, status: result.value.loggedIn ? 'verified' : 'error' }
          : account));
      }}
    />
  );
}

export function WorkspaceRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomeWorkspace />} />
      <Route path="/library" element={<LibraryRouteWorkspace />} />
      <Route path="/history" element={<StateWorkspace name="history" />} />
      <Route path="/watchlist" element={<StateWorkspace name="watchlist" />} />
      <Route path="/eh" element={<EhRouteWorkspace />} />
      <Route path="/downloads" element={<TaskCenter />} />
      <Route path="/sync" element={<EmptyWorkspace name="sync" />} />
      <Route path="/settings" element={<SettingsWorkspace />} />
      <Route path="*" element={<HomeWorkspace />} />
    </Routes>
  );
}

export function ReaderRoutes() {
  return (
    <Routes>
      <Route path="/reader/:archiveId" element={<ReaderRoute />} />
    </Routes>
  );
}

function ReaderRoute() {
  const { archiveId = '' } = useParams();
  return <ReaderRouteScreen archiveId={archiveId} />;
}
