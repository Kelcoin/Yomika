import { ArrowRight, FolderHeart, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';

import { EmptyState } from '../components/EmptyState';
import { EhWorkspace } from '../components/EhWorkspace';
import { LibraryRouteWorkspace } from '../components/LibraryRouteWorkspace';
import { ReaderRoute as ReaderRouteScreen } from '../components/ReaderRoute';
import { SettingsWorkspace } from '../components/SettingsWorkspace';
import { TaskCenter } from '../components/TaskCenter';
import { SyncWorkspace } from '../components/SyncWorkspace';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import type { ArchiveRecord, ReadingHistoryRecord, WatchlistRecord } from '../domain/library';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';
import type { EhSearchResult } from '../services/ehClient';

const workspaces = {
  history: ['历史', '开始阅读后，进度会保存在这里。'],
  watchlist: ['待看', '加入待看的档案会显示在这里。'],
} as const;

function HomeWorkspace() {
  const [servers, setServers] = useState<Awaited<ReturnType<NativeLibraryRepository['listServers']>>>();
  const [history, setHistory] = useState<ReadingHistoryRecord[]>([]);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string>();
  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await repository.listServers();
      if (!active) return;
      setServers(result);
      const server = result.ok ? result.value[0] : undefined;
      if (!server) {
        setRecentLoading(false);
        return;
      }
      const [historyResult, archiveResult] = await Promise.all([
        repository.listHistory(server.scopeId),
        repository.listArchives(server.id),
      ]);
      if (!active) return;
      if (!historyResult.ok) setRecentError(historyResult.error.message);
      else if (!archiveResult.ok) setRecentError(archiveResult.error.message);
      else {
        setHistory(historyResult.value);
        setArchives(archiveResult.value);
      }
      setRecentLoading(false);
    })();
    return () => { active = false; };
  }, []);
  const connected = servers?.ok && servers.value.length > 0;
  const titles = new Map(archives.map((archive) => [archive.archiveId, archive.title]));
  const recent = history.slice(0, 6);
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
        <span>{String(recent.length).padStart(2, '0')}</span>
      </div>
      {recentLoading && <p className="server-list-message" role="status">正在读取最近阅读…</p>}
      {recentError && <p className="form-error" role="alert">{recentError}</p>}
      {!recentLoading && !recentError && (recent.length > 0 ? (
        <ul className="home-recent-list" aria-label="最近阅读">
          {recent.map((item) => (
            <li key={item.archiveId}>
              <Link to={`/reader/${item.archiveId}`}>
                <strong>{titles.get(item.archiveId) ?? item.archiveId}</strong>
                <span>第 {item.pageIndex + 1} 页</span>
                <ArrowRight aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={FolderHeart}
          title="书架还是空的"
          description={connected ? '开始阅读后，最近阅读内容会出现在这里。' : '连接服务器后，最近阅读和待看内容会出现在这里。'}
        />
      ))}
    </div>
  );
}

const repository = new NativeLibraryRepository();

function StateWorkspace({ name }: { name: 'history' | 'watchlist' }) {
  const [history, setHistory] = useState<ReadingHistoryRecord[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>([]);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [serverName, setServerName] = useState('LANraragi');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [hasServer, setHasServer] = useState(true);
  useEffect(() => {
    let active = true;
    void (async () => {
      const servers = await repository.listServers();
      if (!active) return;
      if (!servers.ok) { setError(servers.error.message); setLoading(false); return; }
      const server = servers.value[0];
      if (!server) { setHasServer(false); setLoading(false); return; }
      setServerName(server.name);
      const [result, archiveResult] = await Promise.all([
        name === 'history' ? repository.listHistory(server.scopeId) : repository.listWatchlist(server.scopeId),
        repository.listArchives(server.id),
      ]);
      if (!active) return;
      if (!result.ok) setError(result.error.message);
      else if (!archiveResult.ok) setError(archiveResult.error.message);
      else if (name === 'history') setHistory(result.value as ReadingHistoryRecord[]);
      else setWatchlist(result.value as WatchlistRecord[]);
      if (archiveResult.ok) setArchives(archiveResult.value);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [name]);
  const [title, description] = workspaces[name];
  const records = name === 'history' ? history : watchlist;
  const archiveTitles = new Map(archives.map((archive) => [archive.archiveId, archive.title]));
  return (
    <div>
      <header className="workspace-heading"><h1>{title}</h1></header>
      {loading && <p className="server-list-message" role="status">正在读取{title}…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && !error && !hasServer && (
        <>
          <EmptyState icon={Server} title="尚未连接 LANraragi" description="添加服务器后即可读取和同步本机记录。" />
          <Link className="primary-action empty-state-action" to="/settings">添加服务器<ArrowRight aria-hidden="true" /></Link>
        </>
      )}
      {!loading && !error && hasServer && (records.length === 0 ? <EmptyState icon={FolderHeart} title={`暂无${title}`} description={description} /> : (
        <ul className="state-list">
          {name === 'history'
            ? history.map((item) => (
              <li key={item.archiveId}>
                <Link to={`/reader/${item.archiveId}`}>
                  <strong>{archiveTitles.get(item.archiveId) ?? item.archiveId}</strong>
                  <span>{serverName} · 第 {item.pageIndex + 1} 页</span>
                  <ArrowRight aria-hidden="true" />
                </Link>
              </li>
            ))
            : watchlist.map((item) => (
              <li key={item.archiveId}>
                <Link to={`/reader/${item.archiveId}`}>
                  <strong>{archiveTitles.get(item.archiveId) ?? item.archiveId}</strong>
                  <span>{serverName} · 待看</span>
                  <ArrowRight aria-hidden="true" />
                </Link>
              </li>
            ))}
        </ul>
      ))}
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
      savingAccount={savingAccount}
      onSaveAccount={async (input: SaveEhAccountInput) => {
        setSavingAccount(true);
        const result = await ehRepository.saveAccount(input);
        setSavingAccount(false);
        if (!result.ok) throw new Error(result.error.message);
        setAccounts((current) => [...current.filter((account) => account.id !== result.value.id), result.value]);
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
      <Route path="/sync" element={<SyncWorkspace />} />
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
