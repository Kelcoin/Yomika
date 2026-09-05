import { ArrowRight, FolderHeart, RefreshCw, Server } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';

import { EmptyState } from '../components/EmptyState';
import { EhWorkspace } from '../components/EhWorkspace';
import { LibraryShell } from '../components/LibraryShell';
import { LibraryWorkspace } from '../components/LibraryWorkspace';
import { ReaderRoute as ReaderRouteScreen } from '../components/ReaderRoute';
import { SettingsWorkspace } from '../components/SettingsWorkspace';
import { TaskCenter } from '../components/TaskCenter';
import { UploadPanel } from '../components/UploadPanel';
import { EhRouteWorkspace } from '../components/EhRouteWorkspace';
import { SyncWorkspace } from '../components/SyncWorkspace';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { MetadataEditRoute } from '../components/MetadataEditRoute';
import { DeduplicationWorkspace } from '../components/DeduplicationWorkspace';
import { ArchiveThumbnailRail } from '../components/ArchiveThumbnailCard';
import { pickRandomSample } from '../lib/archiveCardPresentation';
import { readRouteCache, writeRouteCache } from '../lib/routeCache';
import { getNativeImageCache } from '../lib/nativeImageCache';
import type { ImageHandle } from '../lib/unifiedImageCache';
import type { ArchiveRecord, ReadingHistoryRecord, WatchlistRecord } from '../domain/library';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';
import { presentEhError, type EhSearchResult } from '../services/ehClient';

const workspaces = {
  history: ['历史', '开始阅读后，进度会保存在这里。'],
  watchlist: ['收藏夹', '收藏的档案会显示在这里。'],
  // Separate from the watchlist on purpose: "I plan to read this" is not the
  // same statement as "I liked this".
  toRead: ['待看档案', '加入待看的档案会排在这里，读完可以移出。'],
} as const;

const HOME_SNAPSHOT_KEY = 'home:shelves';
/** Same reasoning as the library list: switching tabs and coming back should not
 * re-resolve the shelves and draw a new random set. */
const HOME_SNAPSHOT_FRESH_MS = 90_000;

interface HomeSnapshot {
  servers: Awaited<ReturnType<NativeLibraryRepository['listServers']>>;
  history: ReadingHistoryRecord[];
  watchlist: WatchlistRecord[];
  archives: ArchiveRecord[];
  randomArchives: ArchiveRecord[];
}

function HomeWorkspace() {
  const snapshot = readRouteCache<HomeSnapshot>(HOME_SNAPSHOT_KEY, HOME_SNAPSHOT_FRESH_MS);
  const [servers, setServers] = useState<Awaited<ReturnType<NativeLibraryRepository['listServers']>> | undefined>(snapshot?.servers);
  const [history, setHistory] = useState<ReadingHistoryRecord[]>(snapshot?.history ?? []);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>(snapshot?.watchlist ?? []);
  const [archives, setArchives] = useState<ArchiveRecord[]>(snapshot?.archives ?? []);
  const [randomArchives, setRandomArchives] = useState<ArchiveRecord[]>(snapshot?.randomArchives ?? []);
  const [recentLoading, setRecentLoading] = useState(!snapshot);
  const [recentError, setRecentError] = useState<string>();
  const [randomLoading, setRandomLoading] = useState(!snapshot);
  const [serverLoadAttempt, setServerLoadAttempt] = useState(0);
  const restoredFromSnapshot = useRef(Boolean(snapshot));
  // LANraragi picks the random set. Behind a callback so the rail's refresh
  // button can ask for another draw without reloading the whole page.
  const loadRandom = useCallback(async (serverId: string) => {
    setRandomLoading(true);
    const random = await repository.searchRandomArchives(serverId, 8);
    if (random.ok) setRandomArchives(random.value);
    else {
      // Server could not answer. Sample the newest page from the local mirror
      // rather than reading the whole index to pick eight cards.
      const page = await repository.listArchivesPage(serverId, 0, 60, { sortBy: 'added', order: 'desc' });
      if (page.ok) setRandomArchives(pickRandomSample(page.value.items, 8));
    }
    setRandomLoading(false);
  }, []);
  useEffect(() => {
    // A fresh snapshot is already on screen; re-resolving the shelves would cost
    // a round trip and draw a different random set for no reason.
    if (restoredFromSnapshot.current) {
      restoredFromSnapshot.current = false;
      return;
    }
    let active = true;
    void (async () => {
      setRecentLoading(true);
      setRecentError(undefined);
      const result = await repository.listServers();
      if (!active) return;
      setServers(result);
      if (!result.ok) {
        setRecentLoading(false);
        setRandomLoading(false);
        return;
      }
      const server = result.value[0];
      if (!server) {
        setRecentLoading(false);
        setRandomLoading(false);
        return;
      }
      const [historyResult, watchlistResult] = await Promise.all([
        repository.listHistory(server.scopeId),
        repository.listWatchlist(server.scopeId),
      ]);
      if (!active) return;
      // Every early exit clears both flags: a rail left on `loading` shimmers
      // forever instead of admitting it has nothing.
      if (!historyResult.ok) { setRecentError(historyResult.error.message); setRecentLoading(false); setRandomLoading(false); return; }
      if (!watchlistResult.ok) { setRecentError(watchlistResult.error.message); setRecentLoading(false); setRandomLoading(false); return; }
      setHistory(historyResult.value);
      setWatchlist(watchlistResult.value);
      // Resolve only the ids the two rails can show. The window is wider than
      // the rails so an id the local index has not seen yet gets backfilled by
      // the next one instead of leaving a hole.
      const shelfIds = [...new Set([
        ...historyResult.value.slice(0, 6).map((item) => item.archiveId),
        ...watchlistResult.value.filter((item) => !item.deleted).slice(0, 24).map((item) => item.archiveId),
      ])];
      const archiveResult = await repository.listArchivesByIds(server.id, shelfIds);
      if (!active) return;
      if (!archiveResult.ok) setRecentError(archiveResult.error.message);
      else setArchives(archiveResult.value);
      setRecentLoading(false);
      await loadRandom(server.id);
    })();
    return () => { active = false; };
  }, [loadRandom, serverLoadAttempt]);
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
  // The effect already picked the random set (server first, newest page as the
  // fallback). Sampling `archives` here would just re-show the shelf, because
  // `archives` now holds only the ids the shelves asked for.
  const random = randomArchives;
  const progressByArchiveId = useMemo(() => new Map(history.map((item) => [item.archiveId, item.pageIndex + 1])), [history]);
  // Snapshot for the next visit, so switching tabs and coming back is free.
  useEffect(() => {
    if (!servers) return;
    writeRouteCache(HOME_SNAPSHOT_KEY, { servers, history, watchlist, archives, randomArchives } satisfies HomeSnapshot);
  }, [archives, history, randomArchives, servers, watchlist]);
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
      <ArchiveThumbnailRail title="继续阅读" archives={continueReading} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} loading={recentLoading} skeletonCount={4} />
      <ArchiveThumbnailRail title="待看档案" archives={toRead} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} loading={recentLoading} skeletonCount={4} />
      <ArchiveThumbnailRail title="随机漫游" archives={random} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} loading={randomLoading} skeletonCount={6} refreshing={randomLoading} onRefresh={() => { const id = servers.value?.[0]?.id; if (id) void loadRandom(id); }} />
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
const stateImageCache = getNativeImageCache();

function StateWorkspace({ name }: { name: 'history' | 'watchlist' | 'toRead' }) {
  const [history, setHistory] = useState<ReadingHistoryRecord[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>([]);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [serverId, setServerId] = useState<string>();
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
      setServerId(server.id);
      setScopeId(server.scopeId);
      const result = await (name === 'history'
        ? repository.listHistory(server.scopeId)
        : name === 'toRead'
          ? repository.listReadingList(server.scopeId)
          : repository.listWatchlist(server.scopeId));
      if (!active) return;
      if (!result.ok) { setError(result.error.message); setLoading(false); return; }
      if (name === 'history') setHistory(result.value as ReadingHistoryRecord[]);
      else setWatchlist(result.value as WatchlistRecord[]);
      // This shelf's own ids, not the whole library: the page shows every entry
      // it holds, so the id list is already the bound.
      const shelfIds = name === 'history'
        ? (result.value as ReadingHistoryRecord[]).map((item) => item.archiveId)
        : (result.value as WatchlistRecord[]).filter((item) => !item.deleted).map((item) => item.archiveId);
      const archiveResult = await repository.listArchivesByIds(server.id, [...new Set(shelfIds)]);
      if (!active) return;
      if (!archiveResult.ok) setError(archiveResult.error.message);
      else setArchives(archiveResult.value);
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
    if (name === 'history') return [];
    const query = watchlistQuery.trim().toLocaleLowerCase();
    return activeWatchlist
      .filter((item) => !query || (archiveTitles.get(item.archiveId) ?? item.archiveId).toLocaleLowerCase().includes(query))
      .sort((left, right) => watchlistSort === 'recent'
        ? right.addedAt.localeCompare(left.addedAt)
        : (archiveTitles.get(left.archiveId) ?? left.archiveId).localeCompare(archiveTitles.get(right.archiveId) ?? right.archiveId));
  }, [activeWatchlist, archiveTitles, name, watchlistQuery, watchlistSort]);
  const archiveById = useMemo(() => new Map(archives.map((archive) => [archive.archiveId, archive])), [archives]);
  const visibleArchives = useMemo(() => {
    const ids = name === 'history' ? sortedHistory.map((item) => item.archiveId) : visibleWatchlist.map((item) => item.archiveId);
    return ids.map((id) => archiveById.get(id)).filter((archive): archive is ArchiveRecord => Boolean(archive));
  }, [archiveById, name, sortedHistory, visibleWatchlist]);
  const progressByArchiveId = useMemo(
    () => new Map(history.map((item) => [item.archiveId, item.pageIndex + 1])),
    [history],
  );
  const loadThumbnail = useCallback(async (archive: ArchiveRecord, signal?: AbortSignal) => {
    if (!scopeId || !serverId) return undefined;
    try {
      return await stateImageCache.load(
        { scopeId, serverId, archiveId: archive.archiveId, rendition: 'cover', pageIndex: 0 },
        signal ? { signal } : {},
      );
    } catch {
      return undefined;
    }
  }, [scopeId, serverId]);
  const releaseThumbnail = useCallback((handle: ImageHandle) => stateImageCache.release(handle), []);

  const removeSelectedWatchlist = async () => {
    if (!scopeId || selectedWatchlist.size === 0) return;
    setWatchlistPending(true);
    setWatchlistError(undefined);
    setWatchlistMessage(undefined);
    const results = await Promise.all([...selectedWatchlist].map(async (archiveId) => ({
      archiveId,
      result: name === 'toRead'
        ? await repository.setReadingList(scopeId, archiveId, false)
        : await repository.setWatchlist(scopeId, archiveId, false),
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
      {!loading && !error && hasServer && (visibleArchives.length === 0
        ? <EmptyState icon={FolderHeart} title={`暂无${title}`} description={description} />
        : (
          // Same list and card system as the library, so display mode and sort
          // behave identically here.
          <LibraryWorkspace
            archives={visibleArchives}
            heading={null}
            showSearch={false}
            showDetail={false}
            readingProgressByArchiveId={progressByArchiveId}
            {...(name === 'watchlist' ? {
              selectedArchiveIds: selectedWatchlist,
              onToggleSelected: (archiveId: string, checked: boolean) => setSelectedWatchlist((current) => {
                const next = new Set(current);
                if (checked) next.add(archiveId);
                else next.delete(archiveId);
                return next;
              }),
            } : {})}
            {...(scopeId && serverId ? { onLoadThumbnail: loadThumbnail, onReleaseThumbnail: releaseThumbnail } : {})}
          />
        ))}
      {!loading && !error && hasServer && name === 'watchlist' && activeWatchlist.length > 0 && visibleWatchlist.length === 0 && (
        <p className="server-list-message" role="status">没有匹配的待看档案。</p>
      )}
    </div>
  );
}

/** Upload is a page of its own, not a panel inside settings. */
function UploadRoute() {
  return (
    <div className="workspace-stack">
      <header className="workspace-heading"><h1>上传档案</h1></header>
      <UploadPanel />
    </div>
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
      <Route path="/to-read" element={<StateWorkspace name="toRead" />} />
      <Route path="/eh" element={<EhRouteWorkspace />} />
      <Route path="/downloads" element={<TaskCenter />} />
      {/* Tools live on their own routes; the settings section is only an index. */}
      <Route path="/tools/upload" element={<UploadRoute />} />
      <Route path="/tools/dedup" element={<DeduplicationWorkspace />} />
      <Route path="/dedup" element={<Navigate to="/tools/dedup" replace />} />
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
