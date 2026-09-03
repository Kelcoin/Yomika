import { ArrowRight, FolderHeart, RefreshCw, Server } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';

import { EmptyState } from '../components/EmptyState';
import { EhWorkspace } from '../components/EhWorkspace';
import { LibraryShell } from '../components/LibraryShell';
import { ReaderRoute as ReaderRouteScreen } from '../components/ReaderRoute';
import { SettingsWorkspace } from '../components/SettingsWorkspace';
import { TaskCenter } from '../components/TaskCenter';
import { SyncWorkspace } from '../components/SyncWorkspace';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { MetadataEditRoute } from '../components/MetadataEditRoute';
import { DeduplicationWorkspace } from '../components/DeduplicationWorkspace';
import { ArchiveThumbnailRail } from '../components/ArchiveThumbnailCard';
import { pickRandomSample } from '../lib/archiveCardPresentation';
import type { ArchiveRecord, ReadingHistoryRecord, WatchlistRecord } from '../domain/library';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';
import { presentEhError, type EhSearchResult } from '../services/ehClient';

const workspaces = {
  history: ['历史', '开始阅读后，进度会保存在这里。'],
  watchlist: ['收藏夹', '收藏的档案会显示在这里。'],
} as const;

function HomeWorkspace() {
  const [servers, setServers] = useState<Awaited<ReturnType<NativeLibraryRepository['listServers']>>>();
  const [history, setHistory] = useState<ReadingHistoryRecord[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>([]);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [randomArchives, setRandomArchives] = useState<ArchiveRecord[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string>();
  const [serverLoadAttempt, setServerLoadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      setRecentLoading(true);
      setRecentError(undefined);
      const result = await repository.listServers();
      if (!active) return;
      setServers(result);
      if (!result.ok) {
        setRecentLoading(false);
        return;
      }
      const server = result.value[0];
      if (!server) {
        setRecentLoading(false);
        return;
      }
      const [historyResult, watchlistResult, archiveResult] = await Promise.all([
        repository.listHistory(server.scopeId),
        repository.listWatchlist(server.scopeId),
        repository.listArchives(server.id),
      ]);
      if (!active) return;
      if (!historyResult.ok) setRecentError(historyResult.error.message);
      else if (!watchlistResult.ok) setRecentError(watchlistResult.error.message);
      else if (!archiveResult.ok) setRecentError(archiveResult.error.message);
      else {
        setHistory(historyResult.value);
        setWatchlist(watchlistResult.value);
        setArchives(archiveResult.value);
      }
      // LANraragi picks the random set: the alternative was shuffling the whole
      // local index client-side.
      const random = await repository.searchRandomArchives(server.id, 8);
      if (!active) return;
      if (random.ok) setRandomArchives(random.value);
      setRecentLoading(false);
    })();
    return () => { active = false; };
  }, [serverLoadAttempt]);
  const connected = servers?.ok && servers.value.length > 0;
  const serverFailure = servers && !servers.ok ? servers : undefined;
  const connectionError = serverFailure?.error.message;
  const recent = useMemo(() => history.slice(0, 6), [history]);
  const archiveById = useMemo(() => new Map(archives.map((archive) => [archive.archiveId, archive])), [archives]);
  const continueReading = useMemo(
    () => recent.map((item) => archiveById.get(item.archiveId)).filter((item): item is ArchiveRecord => Boolean(item)),
    [archiveById, recent],
  );
  const toRead = useMemo(
    () => watchlist.filter((item) => !item.deleted).map((item) => archiveById.get(item.archiveId)).filter((item): item is ArchiveRecord => Boolean(item)).slice(0, 8),
    [archiveById, watchlist],
  );
  const random = useMemo(
    () => (randomArchives.length > 0 ? randomArchives : pickRandomSample(archives, 8)),
    [archives, randomArchives, serverLoadAttempt],
  );
  const progressByArchiveId = useMemo(() => new Map(history.map((item) => [item.archiveId, item.pageIndex + 1])), [history]);
  return (
    <div className="workspace-home">
      {connectionError ? (
        <section className="first-run" aria-labelledby="first-run-title">
          <div className="first-run-copy">
            <Server aria-hidden="true" />
            <h2 id="first-run-title">无法读取服务器</h2>
            <p className="form-error" role="alert">{connectionError}</p>
          </div>
          <div className="first-run-actions">
            {serverFailure?.error.retryable && (
              <button className="secondary-action" type="button" onClick={() => {
                setServers(undefined);
                setServerLoadAttempt((attempt) => attempt + 1);
              }}>
                <RefreshCw aria-hidden="true" />
                重试读取服务器
              </button>
            )}
            <Link className="secondary-action" to="/settings">打开设置</Link>
          </div>
        </section>
      ) : !connected && (
        // Only an unusable setup gets a prompt; a working server needs no banner.
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
      {connected && servers.value?.[0] && <>
      <ArchiveThumbnailRail title="继续阅读" archives={continueReading} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} />
      <ArchiveThumbnailRail title="待看档案" archives={toRead} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} />
      <ArchiveThumbnailRail title="随机漫游" archives={random} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} />
      </>}
      {recentError && <p className="form-error" role="alert">{recentError}</p>}
      {!recentLoading && !recentError && connected && continueReading.length === 0 && toRead.length === 0 && (
        <EmptyState
          icon={FolderHeart}
          title="书架还是空的"
          description="开始阅读后，最近阅读内容会出现在这里。"
        />
      )}
    </div>
  );
}

const repository = new NativeLibraryRepository();

function StateWorkspace({ name }: { name: 'history' | 'watchlist' }) {
  const [history, setHistory] = useState<ReadingHistoryRecord[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>([]);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [serverName, setServerName] = useState('LANraragi');
  const [scopeId, setScopeId] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [hasServer, setHasServer] = useState(true);
  const [watchlistQuery, setWatchlistQuery] = useState('');
  const [watchlistSort, setWatchlistSort] = useState<'title' | 'recent'>('title');
  const [selectedWatchlist, setSelectedWatchlist] = useState<Set<string>>(() => new Set());
  const [watchlistPending, setWatchlistPending] = useState(false);
  const [watchlistMessage, setWatchlistMessage] = useState<string>();
  const [watchlistError, setWatchlistError] = useState<string>();
  useEffect(() => {
    let active = true;
    void (async () => {
      const servers = await repository.listServers();
      if (!active) return;
      if (!servers.ok) { setError(servers.error.message); setLoading(false); return; }
      const server = servers.value[0];
      if (!server) { setHasServer(false); setLoading(false); return; }
      setServerName(server.name);
      setScopeId(server.scopeId);
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
  const archiveTitles = useMemo(() => new Map(archives.map((archive) => [archive.archiveId, archive.title])), [archives]);
  const sortedHistory = useMemo(
    () => [...history].sort((left, right) => right.visitedAt.localeCompare(left.visitedAt)),
    [history],
  );
  const activeWatchlist = useMemo(() => watchlist.filter((item) => !item.deleted), [watchlist]);
  const visibleWatchlist = useMemo(() => {
    if (name !== 'watchlist') return [];
    const query = watchlistQuery.trim().toLocaleLowerCase();
    return activeWatchlist
      .filter((item) => !query || (archiveTitles.get(item.archiveId) ?? item.archiveId).toLocaleLowerCase().includes(query))
      .sort((left, right) => watchlistSort === 'recent'
        ? right.addedAt.localeCompare(left.addedAt)
        : (archiveTitles.get(left.archiveId) ?? left.archiveId).localeCompare(archiveTitles.get(right.archiveId) ?? right.archiveId));
  }, [activeWatchlist, archiveTitles, name, watchlistQuery, watchlistSort]);
  const records = name === 'history' ? sortedHistory : activeWatchlist;

  const removeSelectedWatchlist = async () => {
    if (!scopeId || selectedWatchlist.size === 0) return;
    setWatchlistPending(true);
    setWatchlistError(undefined);
    setWatchlistMessage(undefined);
    const results = await Promise.all([...selectedWatchlist].map(async (archiveId) => ({
      archiveId,
      result: await repository.setWatchlist(scopeId, archiveId, false),
    })));
    const removed = new Set(results.filter(({ result }) => result.ok).map(({ archiveId }) => archiveId));
    const failures = results.filter(({ result }) => !result.ok);
    if (removed.size > 0) {
      setWatchlist((current) => current.filter((item) => !removed.has(item.archiveId)));
      setWatchlistMessage('已保存在本机，等待同步');
    }
    setSelectedWatchlist(new Set(failures.map(({ archiveId }) => archiveId)));
    if (failures.length > 0) {
      const reason = failures[0]?.result;
      setWatchlistError(`有 ${failures.length} 项未能移除：${reason && !reason.ok ? reason.error.message : '未知错误'}`);
    }
    setWatchlistPending(false);
  };
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
      {!loading && !error && hasServer && name === 'watchlist' && activeWatchlist.length > 0 && (
        <div className="watchlist-controls">
          <label className="search-label">
            <span className="sr-only">筛选待看</span>
            <input
              aria-label="筛选待看"
              type="search"
              autoComplete="off"
              placeholder="筛选待看…"
              value={watchlistQuery}
              onChange={(event) => setWatchlistQuery(event.target.value)}
            />
          </label>
          <label className="watchlist-sort">排序
            <select aria-label="待看排序" value={watchlistSort} onChange={(event) => setWatchlistSort(event.target.value as 'title' | 'recent')}>
              <option value="title">标题</option>
              <option value="recent">最近加入</option>
            </select>
          </label>
          <label className="watchlist-select-all">
            <input
              type="checkbox"
              checked={visibleWatchlist.length > 0 && visibleWatchlist.every((item) => selectedWatchlist.has(item.archiveId))}
              onChange={(event) => setSelectedWatchlist((current) => {
                const next = new Set(current);
                for (const item of visibleWatchlist) {
                  if (event.target.checked) next.add(item.archiveId);
                  else next.delete(item.archiveId);
                }
                return next;
              })}
            />
            全选当前结果
          </label>
          <button className="secondary-action" type="button" disabled={selectedWatchlist.size === 0 || watchlistPending} aria-busy={watchlistPending} onClick={() => void removeSelectedWatchlist()}>
            {watchlistPending ? '移除中…' : '移除所选'}
          </button>
        </div>
      )}
      {watchlistError && <p className="form-error" role="alert">{watchlistError}</p>}
      {watchlistMessage && <p className="server-list-message" role="status">{watchlistMessage}</p>}
      {!loading && !error && hasServer && (records.length === 0 ? <EmptyState icon={FolderHeart} title={`暂无${title}`} description={description} /> : (
        <ul className="state-list" aria-label={title}>
          {name === 'history'
            ? sortedHistory.map((item) => (
              <li key={item.archiveId}>
                <Link to={`/reader/${item.archiveId}`}>
                  <strong>{archiveTitles.get(item.archiveId) ?? item.archiveId}</strong>
                  <span>{serverName} · 第 {item.pageIndex + 1} 页</span>
                  <ArrowRight aria-hidden="true" />
                </Link>
              </li>
            ))
            : visibleWatchlist.map((item) => {
              const itemTitle = archiveTitles.get(item.archiveId) ?? item.archiveId;
              return (
              <li className="watchlist-row" key={item.archiveId}>
                <input
                  type="checkbox"
                  aria-label={`选择 ${itemTitle}`}
                  checked={selectedWatchlist.has(item.archiveId)}
                  onChange={(event) => setSelectedWatchlist((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(item.archiveId);
                    else next.delete(item.archiveId);
                    return next;
                  })}
                />
                <Link to={`/reader/${item.archiveId}`}>
                  <strong>{itemTitle}</strong>
                  <span>{serverName} · 收藏夹</span>
                  <ArrowRight aria-hidden="true" />
                </Link>
              </li>
              );
            })}
        </ul>
      ))}
      {!loading && !error && hasServer && name === 'watchlist' && activeWatchlist.length > 0 && visibleWatchlist.length === 0 && (
        <p className="server-list-message" role="status">没有匹配的待看档案。</p>
      )}
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
    />
  );
}

export function WorkspaceRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomeWorkspace />} />
      <Route path="/library" element={<LibraryShell />} />
      <Route path="/library/:archiveId" element={<LibraryShell />} />
      <Route path="/library/:archiveId/edit" element={<MetadataEditRouteRoute />} />
      <Route path="/history" element={<StateWorkspace name="history" />} />
      <Route path="/watchlist" element={<StateWorkspace name="watchlist" />} />
      <Route path="/eh" element={<EhRouteWorkspace />} />
      <Route path="/downloads" element={<TaskCenter />} />
      <Route path="/dedup" element={<DeduplicationWorkspace />} />
      <Route path="/sync" element={<Navigate to="/settings?section=sync" replace />} />
      <Route path="/settings" element={<SettingsWorkspace />} />
      <Route path="*" element={<HomeWorkspace />} />
    </Routes>
  );
}

function MetadataEditRouteRoute() {
  const { archiveId = '' } = useParams();
  return <MetadataEditRoute archiveId={archiveId} />;
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
