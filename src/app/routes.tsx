import { ArrowRight, FolderHeart, RefreshCw, Server } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';

import { EmptyState } from '../components/EmptyState';
import { LoadingIndicator } from '../components/LoadingIndicator';
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
import { useArchiveContextMenu } from '../components/useArchiveContextMenu';
import { findMissingArchives } from '../lib/archiveExistence';
import { pickRandomSample } from '../lib/archiveCardPresentation';
import { readRouteCache, writeRouteCache } from '../lib/routeCache';
import { useCardStyle } from './preferences';
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

/** Timeline label for a shelf row: the date, plus the time when it was today, so
 * a day's reading reads as a sequence rather than as one repeated date. */
function formatShelfTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const today = new Date();
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const HOME_SNAPSHOT_KEY = 'home:shelves';/** Same reasoning as the library list: switching tabs and coming back should not
 * re-resolve the shelves and draw a new random set. */
const HOME_SNAPSHOT_FRESH_MS = 90_000;

interface HomeSnapshot {
  servers: Awaited<ReturnType<NativeLibraryRepository['listServers']>>;
  history: ReadingHistoryRecord[];
  watchlist: WatchlistRecord[];
  readingList: WatchlistRecord[];
  archives: ArchiveRecord[];
  randomArchives: ArchiveRecord[];
}

function HomeWorkspace() {
  const snapshot = readRouteCache<HomeSnapshot>(HOME_SNAPSHOT_KEY, HOME_SNAPSHOT_FRESH_MS);
  const [servers, setServers] = useState<Awaited<ReturnType<NativeLibraryRepository['listServers']>> | undefined>(snapshot?.servers);
  const [history, setHistory] = useState<ReadingHistoryRecord[]>(snapshot?.history ?? []);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>(snapshot?.watchlist ?? []);
  const [readingList, setReadingList] = useState<WatchlistRecord[]>(snapshot?.readingList ?? []);
  const [archives, setArchives] = useState<ArchiveRecord[]>(snapshot?.archives ?? []);
  const [randomArchives, setRandomArchives] = useState<ArchiveRecord[]>(snapshot?.randomArchives ?? []);
  const [recentLoading, setRecentLoading] = useState(!snapshot);
  const [recentError, setRecentError] = useState<string>();
  const [randomLoading, setRandomLoading] = useState(!snapshot);
  const [serverLoadAttempt, setServerLoadAttempt] = useState(0);
  const restoredFromSnapshot = useRef(Boolean(snapshot));
  /** Re-reads the shelves. Bumping the attempt re-runs the load effect, which is
   * also how the snapshot gets refreshed on demand. */
  const reloadShelves = useCallback(() => setServerLoadAttempt((attempt) => attempt + 1), []);
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
      const [historyResult, watchlistResult, readingListResult] = await Promise.all([
        repository.listHistory(server.scopeId),
        repository.listWatchlist(server.scopeId),
        repository.listReadingList(server.scopeId),
      ]);
      if (!active) return;
      // Every early exit clears both flags: a rail left on `loading` shimmers
      // forever instead of admitting it has nothing.
      if (!historyResult.ok) { setRecentError(historyResult.error.message); setRecentLoading(false); setRandomLoading(false); return; }
      if (!watchlistResult.ok) { setRecentError(watchlistResult.error.message); setRecentLoading(false); setRandomLoading(false); return; }
      if (!readingListResult.ok) { setRecentError(readingListResult.error.message); setRecentLoading(false); setRandomLoading(false); return; }
      setHistory(historyResult.value);
      setWatchlist(watchlistResult.value);
      setReadingList(readingListResult.value);
      // Resolve only the ids the rails can show. The window is wider than the
      // rails so an id the local index has not seen yet gets backfilled by the
      // next one instead of leaving a hole.
      const shelfIds = [...new Set([
        ...historyResult.value.slice(0, 6).map((item) => item.archiveId),
        ...watchlistResult.value.filter((item) => !item.deleted).slice(0, 24).map((item) => item.archiveId),
        ...readingListResult.value.filter((item) => !item.deleted).slice(0, 24).map((item) => item.archiveId),
      ])];
      const archiveResult = await repository.listArchivesByIds(server.id, shelfIds);
      if (!active) return;
      if (!archiveResult.ok) setRecentError(archiveResult.error.message);
      else setArchives(archiveResult.value);
      setRecentLoading(false);
      await loadRandom(server.id);
      // The mirror only learns about a deletion when something asks the server,
      // so confirm the handful of cards the rails are about to show rather than
      // letting the user discover a gone archive by clicking it.
      const missing = await findMissingArchives(server.id, archiveResult.ok ? archiveResult.value.map((archive) => archive.archiveId) : []);
      if (!active || missing.size === 0) return;
      setArchives((current) => current.filter((archive) => !missing.has(archive.archiveId)));
      setRandomArchives((current) => current.filter((archive) => !missing.has(archive.archiveId)));
    })();
    return () => { active = false; };
  }, [loadRandom, serverLoadAttempt]);
  const connected = servers?.ok && servers.value.length > 0;
  const serverFailure = servers && !servers.ok ? servers : undefined;
  const connectionError = serverFailure?.error.message;
  const { open: openContextMenu, menu: contextMenu } = useArchiveContextMenu();
  const recent = useMemo(() => history.slice(0, 6), [history]);
  const archiveById = useMemo(() => new Map(archives.map((archive) => [archive.archiveId, archive])), [archives]);
  const continueReading = useMemo(
    () => recent.map((item) => archiveById.get(item.archiveId)).filter((item): item is ArchiveRecord => Boolean(item)),
    [archiveById, recent],
  );
  /** 收藏夹, which is what `listWatchlist` holds. This rail was labelled 待看档案
   * while reading from the watchlist, so the home page and the /to-read shelf
   * disagreed about what 待看 meant. */
  const favourites = useMemo(
    () => watchlist.filter((item) => !item.deleted).map((item) => archiveById.get(item.archiveId)).filter((item): item is ArchiveRecord => Boolean(item)).slice(0, 8),
    [archiveById, watchlist],
  );
  const toRead = useMemo(
    () => readingList.filter((item) => !item.deleted).map((item) => archiveById.get(item.archiveId)).filter((item): item is ArchiveRecord => Boolean(item)).slice(0, 8),
    [archiveById, readingList],
  );
  // The effect already picked the random set (server first, newest page as the
  // fallback). Sampling `archives` here would just re-show the shelf, because
  // `archives` now holds only the ids the shelves asked for.
  const random = randomArchives;
  const progressByArchiveId = useMemo(() => new Map(history.map((item) => [item.archiveId, item.pageIndex + 1])), [history]);
  // Snapshot for the next visit, so switching tabs and coming back is free.
  useEffect(() => {
    if (!servers) return;
    writeRouteCache(HOME_SNAPSHOT_KEY, { servers, history, watchlist, readingList, archives, randomArchives } satisfies HomeSnapshot);
  }, [archives, history, randomArchives, readingList, servers, watchlist]);
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
      <ArchiveThumbnailRail title="继续阅读" archives={continueReading} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} loading={recentLoading} skeletonCount={4} refreshing={recentLoading} onRefresh={reloadShelves} onArchiveContextMenu={openContextMenu} />
      <ArchiveThumbnailRail title="待看档案" archives={toRead} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} loading={recentLoading} skeletonCount={4} refreshing={recentLoading} onRefresh={reloadShelves} onArchiveContextMenu={openContextMenu} />
      <ArchiveThumbnailRail title="收藏夹" archives={favourites} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} loading={recentLoading} skeletonCount={4} refreshing={recentLoading} onRefresh={reloadShelves} onArchiveContextMenu={openContextMenu} />
      <ArchiveThumbnailRail title="随机漫游" archives={random} scopeId={servers.value[0].scopeId} serverId={servers.value[0].id} progressByArchiveId={progressByArchiveId} loading={randomLoading} skeletonCount={6} refreshing={randomLoading} onRefresh={() => { const id = servers.value?.[0]?.id; if (id) void loadRandom(id); }} onArchiveContextMenu={openContextMenu} />
      {contextMenu}
      </>}
      {recentError && <p className="form-error" role="alert">{recentError}</p>}
      {!recentLoading && !recentError && connected && continueReading.length === 0 && toRead.length === 0 && favourites.length === 0 && (
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
  /** Filters this shelf's own records in the browser. The bar is the library's,
   * the scope is not: a shelf holds a few dozen entries it already has titles
   * for, so there is nothing to ask the server. */
  const [query, setQuery] = useState('');
  /** The style chosen in the library. A shelf shows the same cards, so it shows
   * them the same way. */
  const { cardStyle, setCardStyle } = useCardStyle();
  const [shelfMessage, setShelfMessage] = useState<string>();
  // The shelves show the same cards as the library, so they answer a right click
  // the same way. Categories need a server-side list this page does not load.
  // Removing an entry is here rather than in a toolbar: the multi-select bar that
  // used to do it was the only control on the page, and one card at a time is
  // what a right click already addresses.
  const { open: openContextMenu, menu: contextMenu } = useArchiveContextMenu({
    inReadingList: () => name !== 'history',
    ...(name === 'history' ? {} : {
      readingListLabels: name === 'toRead'
        ? { add: '加入待看', remove: '移出待看' }
        : { add: '加入收藏夹', remove: '移出收藏夹' },
      onToggleReadingList: (archive: ArchiveRecord) => {
        if (!scopeId) return;
        const remove = name === 'toRead'
          ? repository.setReadingList(scopeId, archive.archiveId, false)
          : repository.setWatchlist(scopeId, archive.archiveId, false);
        void remove.then((result) => {
          if (!result.ok) { setShelfMessage(`未能移除：${result.error.message}`); return; }
          setWatchlist((current) => current.filter((item) => item.archiveId !== archive.archiveId));
          setShelfMessage('已保存在本机，等待同步');
        });
      },
    }),
  });
  // The shelves show the same cards as the library, so they answer a right click
  // the same way. Categories need a server-side list this page does not load.
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
      // Same reason as the home rails: the mirror does not hear about deletions,
      // so a shelf would keep offering archives the server no longer has.
      const missing = await findMissingArchives(server.id, archiveResult.ok ? archiveResult.value.map((archive) => archive.archiveId) : []);
      if (!active || missing.size === 0) return;
      setArchives((current) => current.filter((archive) => !missing.has(archive.archiveId)));
    })();
    return () => { active = false; };
  }, [name]);
  const [title, description] = workspaces[name];
  const sortedHistory = useMemo(
    () => [...history].sort((left, right) => right.visitedAt.localeCompare(left.visitedAt)),
    [history],
  );
  const activeWatchlist = useMemo(() => watchlist.filter((item) => !item.deleted), [watchlist]);
  /** Most recently added first. The shelves had a sort control offering "title"
   * or "recent"; recency is the only order that says anything about a shelf, so
   * it is the order rather than a choice. */
  const sortedWatchlist = useMemo(
    () => [...activeWatchlist].sort((left, right) => right.addedAt.localeCompare(left.addedAt)),
    [activeWatchlist],
  );
  const archiveById = useMemo(() => new Map(archives.map((archive) => [archive.archiveId, archive])), [archives]);
  const shelfArchives = useMemo(() => {
    const ids = name === 'history' ? sortedHistory.map((item) => item.archiveId) : sortedWatchlist.map((item) => item.archiveId);
    return ids.map((id) => archiveById.get(id)).filter((archive): archive is ArchiveRecord => Boolean(archive));
  }, [archiveById, name, sortedHistory, sortedWatchlist]);
  const visibleArchives = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return shelfArchives;
    return shelfArchives.filter((archive) => archive.title.toLocaleLowerCase().includes(needle));
  }, [query, shelfArchives]);
  const progressByArchiveId = useMemo(
    () => new Map(history.map((item) => [item.archiveId, item.pageIndex + 1])),
    [history],
  );
  /** When each archive entered the history, shown as a timeline down the right of
   * the list. Only the history has a meaningful time per row. */
  const timelineByArchiveId = useMemo(() => (
    name === 'history'
      ? new Map(history.map((item) => [item.archiveId, formatShelfTime(item.visitedAt)]))
      : undefined
  ), [history, name]);
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

  return (
    <div className="shelf-workspace">
      {/* No page title: the sidebar already names the shelf, and a 40px heading
          above an empty state was most of what the page showed. No control bar
          either — the order is fixed and the card style follows the library. */}
      {loading && <LoadingIndicator label={`正在读取${title}`} size="lg" />}
      {error && <p className="form-error" role="alert">{error}</p>}
      {shelfMessage && <p className="server-list-message" role="status">{shelfMessage}</p>}
      {!loading && !error && !hasServer && (
        <EmptyState
          icon={Server}
          title="尚未连接 LANraragi"
          description="添加服务器后即可读取和同步本机记录。"
          action={<Link className="primary-action" to="/settings">添加服务器<ArrowRight aria-hidden="true" /></Link>}
        />
      )}
      {!loading && !error && hasServer && shelfArchives.length === 0 && (
        <EmptyState icon={FolderHeart} title={`暂无${title}`} description={description} />
      )}
      {!loading && !error && hasServer && shelfArchives.length > 0 && (
        // Same list and card system as the library, and the same search bar, so
        // the only difference is what it searches.
        <LibraryWorkspace
          archives={visibleArchives}
          heading={null}
          showToolbar={false}
          showDetail={false}
          cardStyle={cardStyle}
          onCardStyleChange={setCardStyle}
          searchQuery={query}
          onSearchQueryChange={setQuery}
          searchScope={{ label: `搜索${title}`, placeholder: `在${title}中搜索…` }}
          readingProgressByArchiveId={progressByArchiveId}
          onArchiveContextMenu={openContextMenu}
          {...(timelineByArchiveId ? { timelineByArchiveId } : {})}
          {...(scopeId && serverId ? { onLoadThumbnail: loadThumbnail, onReleaseThumbnail: releaseThumbnail } : {})}
        />
      )}
      {contextMenu}
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
