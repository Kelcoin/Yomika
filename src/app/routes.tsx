import { Bookmark, BookOpen, Eraser, FolderHeart, RefreshCw, Server, Shuffle } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { RetainedPage } from './RetainedPage';
import { EmptyState } from '../components/EmptyState';
import { LibraryShell } from '../components/LibraryShell';
import { ShelfShell } from '../components/ShelfShell';
import { LibraryWorkspace, type ShelfTimelineEntry } from '../components/LibraryWorkspace';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { pickServer } from '../domain/server';
import { ServerRequiredPrompt } from '../components/ServerRequiredPrompt';
import { MorePagesRoute } from '../components/MorePagesRoute';

/** The standalone pages load on first entry. Everything else — home, library
 * and the three shelves — stays in the main chunk: those five panels are the
 * app's shell, are kept mounted across visits, and would pay a Suspense flash
 * on every return for no further savings. The leaves were the bulk of the
 * parsed bytes on boot even though they are one route deep. */
const ReaderRouteScreen = lazy(() => import('../components/ReaderRoute').then((module) => ({ default: module.ReaderRoute })));
const SettingsWorkspace = lazy(() => import('../components/SettingsWorkspace').then((module) => ({ default: module.SettingsWorkspace })));
const LocalArchivesWorkspace = lazy(() => import('../components/LocalArchivesWorkspace').then((module) => ({ default: module.LocalArchivesWorkspace })));
const UploadPanel = lazy(() => import('../components/UploadPanel').then((module) => ({ default: module.UploadPanel })));
const EhRouteWorkspace = lazy(() => import('../components/EhRouteWorkspace').then((module) => ({ default: module.EhRouteWorkspace })));
const MetadataEditRoute = lazy(() => import('../components/MetadataEditRoute').then((module) => ({ default: module.MetadataEditRoute })));
const DeduplicationWorkspace = lazy(() => import('../components/DeduplicationWorkspace').then((module) => ({ default: module.DeduplicationWorkspace })));
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { ArchiveThumbnailRail } from '../components/ArchiveThumbnailCard';
import { useArchiveContextMenu } from '../components/useArchiveContextMenu';
import { useArchiveSelection } from '../components/useArchiveSelection';
import { TextInputDialog } from '../components/TextInputDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { findMissingArchives } from '../lib/archiveExistence';
import { pickRandomSample } from '../lib/archiveCardPresentation';
import { readRouteCache, writeRouteCache } from '../lib/routeCache';
import { isArchiveFinished } from '../lib/archiveCardPresentation';
import { useCardStyle, usePreferences } from './preferences';
import { getNativeImageCache } from '../lib/nativeImageCache';
import type { ImageHandle } from '../lib/unifiedImageCache';
import type { ArchiveRecord, ReadingHistoryRecord, WatchlistRecord } from '../domain/library';
import type { SearchPreset } from '../repositories/nativeLibraryRepository';
import type { EhAccount, SaveEhAccountInput } from '../domain/eh';

const workspaces = {
  history: ['历史', '开始阅读后，进度会保存在这里。'],
  watchlist: ['收藏夹', '收藏的档案会显示在这里。'],
  // Separate from the watchlist on purpose: "I plan to read this" is not the
  // same statement as "I liked this".
  toRead: ['待看档案', '加入待看的档案会排在这里，读完可以移出。'],
} as const;

/** Timeline facts for a shelf row: the day it belongs to (for grouping), a short
 * day label for the day's first row, and the clock time for the row itself. The
 * history rail reads as a sequence instead of one repeated date. */
function formatShelfTimeline(iso: string): ShelfTimelineEntry {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { date: '', dayLabel: '', time: '' };
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDelta = Math.round((startOfDay(new Date()) - startOfDay(at)) / 86_400_000);
  const dayLabel = dayDelta === 0
    ? '今天'
    : dayDelta === 1
      ? '昨天'
      : at.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  return { date, dayLabel, time: at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) };
}

const HOME_SNAPSHOT_KEY = 'home:shelves';/** Same reasoning as the library list: switching tabs and coming back should not
 * re-resolve the shelves and draw a new random set. */
const HOME_SNAPSHOT_FRESH_MS = 90_000;

interface HomeSnapshot {
  servers: Awaited<ReturnType<NativeLibraryRepository['listServers']>>;
  history: ReadingHistoryRecord[];
  readingList: WatchlistRecord[];
  archives: ArchiveRecord[];
  randomArchives: ArchiveRecord[];
}

function HomeWorkspace() {
  const { preferences } = usePreferences();
  const snapshot = readRouteCache<HomeSnapshot>(HOME_SNAPSHOT_KEY, HOME_SNAPSHOT_FRESH_MS);
  const [servers, setServers] = useState<Awaited<ReturnType<NativeLibraryRepository['listServers']>> | undefined>(snapshot?.servers);
  const [history, setHistory] = useState<ReadingHistoryRecord[]>(snapshot?.history ?? []);
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
  // The draw keeps going until the rail's width is full: the caller says how
  // many finished archives count as invisible, and a batch that comes back
  // mostly finished asks the server again rather than leaving the rail short.
  const loadRandom = useCallback(async (
    serverId: string,
    context: { showFinished: boolean; progress: ReadonlyMap<string, number> },
  ) => {
    setRandomLoading(true);
    // Rail step: a 150px card plus its 12px gap — the same measure the rail's
    // skeleton uses. Counting the whole window and letting the rail scroll the
    // spare overcosts nothing and never leaves a visible gap.
    const needed = Math.max(8, Math.ceil(window.innerWidth / 150) + 2);
    const accepted = (archive: ArchiveRecord) => context.showFinished
      || !isArchiveFinished(archive.pageCount, context.progress.get(archive.archiveId) ?? 0);
    const collected = new Map<string, ArchiveRecord>();
    for (let draw = 0; draw < 3 && collected.size < needed; draw += 1) {
      const random = await repository.searchRandomArchives(serverId, 24);
      if (!random.ok) break;
      for (const archive of random.value) {
        if (accepted(archive)) collected.set(archive.archiveId, archive);
      }
    }
    if (collected.size > 0) setRandomArchives([...collected.values()]);
    else {
      // Server could not answer. Sample the newest page from the local mirror
      // rather than reading the whole index to pick that many cards.
      const page = await repository.listArchivesPage(serverId, 0, 60, { sortBy: 'added', order: 'desc' });
      if (page.ok) {
        const eligible = page.value.items.filter(accepted);
        setRandomArchives(eligible.length > 0 ? pickRandomSample(eligible, needed) : []);
      }
    }
    setRandomLoading(false);
  }, []);
  // Preferences as of the latest render, for the load effect below: toggling a
  // preference must not re-resolve the shelves, so the effect reads the ref
  // instead of closing over state.
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
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
      const server = pickServer(result.value, null);
      if (!server) {
        setRecentLoading(false);
        setRandomLoading(false);
        return;
      }
      const [historyResult, readingListResult] = await Promise.all([
        repository.listHistory(server.scopeId),
        repository.listReadingList(server.scopeId),
      ]);
      if (!active) return;
      // Every early exit clears both flags: a rail left on `loading` shimmers
      // forever instead of admitting it has nothing.
      if (!historyResult.ok) { setRecentError(historyResult.error.message); setRecentLoading(false); setRandomLoading(false); return; }
      if (!readingListResult.ok) { setRecentError(readingListResult.error.message); setRecentLoading(false); setRandomLoading(false); return; }
      setHistory(historyResult.value);
      setReadingList(readingListResult.value);
      // Resolve only the ids the rails can show. The window is wider than the
      // rails so an id the local index has not seen yet gets backfilled by the
      // next one instead of leaving a hole.
      const shelfIds = [...new Set([
        ...historyResult.value.slice(0, 6).map((item) => item.archiveId),
        ...readingListResult.value.filter((item) => !item.deleted).slice(0, 24).map((item) => item.archiveId),
      ])];
      // 书架 id 解析与随机漫游互不依赖，重叠拉取：原先是先等完书架、
      // 再等随机、最后等缺失确认，三条链串行只让首屏更晚齐。
      const archivePromise = repository.listArchivesByIds(server.id, shelfIds);
      const randomPromise = loadRandom(server.id, {
        showFinished: preferencesRef.current.randomRoamShowFinished,
        progress: new Map(historyResult.value.map((item) => [item.archiveId, item.pageIndex + 1])),
      });
      const archiveResult = await archivePromise;
      if (!active) return;
      if (!archiveResult.ok) setRecentError(archiveResult.error.message);
      else setArchives(archiveResult.value);
      setRecentLoading(false);
      // The mirror only learns about a deletion when something asks the server,
      // so confirm the handful of cards the rails are about to show rather than
      // letting the user discover a gone archive by clicking it.
      const missing = await findMissingArchives(server.id, archiveResult.ok ? archiveResult.value.map((archive) => archive.archiveId) : []);
      await randomPromise;
      if (!active || missing.size === 0) return;
      setArchives((current) => current.filter((archive) => !missing.has(archive.archiveId)));
      setRandomArchives((current) => current.filter((archive) => !missing.has(archive.archiveId)));
    })();
    return () => { active = false; };
  }, [loadRandom, serverLoadAttempt]);
  const connected = servers?.ok && servers.value.length > 0;
  const serverFailure = servers && !servers.ok ? servers : undefined;
  const connectionError = serverFailure?.error.message;
  /** 书架与首页的数据源：当前启用的服务器（设置里一次只允许启用一台）。 */
  const homeServer = servers?.ok ? pickServer(servers.value, null) : undefined;
  useEffect(() => {
    const handleInvalidation = (event: Event) => {
      const prefix = (event as CustomEvent<{ prefix?: string }>).detail?.prefix;
      if (!prefix || prefix === 'home:') {
        // In-place re-read, same contract as the shelf pull: the rails on
        // screen refresh under the user instead of swapping for skeletons.
        // 启用服务器切换会广播全量失效，书架必须改读新启用的那台。
        setRecentLoading(true);
        setRandomLoading(true);
        restoredFromSnapshot.current = false;
        setServerLoadAttempt((attempt) => attempt + 1);
      }
    };
    window.addEventListener('yomika:route-cache-invalidated', handleInvalidation);
    return () => window.removeEventListener('yomika:route-cache-invalidated', handleInvalidation);
  }, []);
  const { open: openContextMenu, menu: contextMenu } = useArchiveContextMenu({
    onDeleted: (archiveId) => {
      setArchives((current) => current.filter((archive) => archive.archiveId !== archiveId));
      setRandomArchives((current) => current.filter((archive) => archive.archiveId !== archiveId));
    },
  });
  const recent = useMemo(() => history.slice(0, 6), [history]);
  const archiveById = useMemo(() => new Map(archives.map((archive) => [archive.archiveId, archive])), [archives]);
  /** 「继续阅读」的已读完开关：关闭时把进度超过 95% 的记录从 rail 里隐藏，
   * 其余照旧。历史页面固定显示已读完，不受这个开关影响。 */
  const continueReading = useMemo(() => {
    const showFinished = preferences.continueReadingShowFinished;
    return recent
      .filter((item) => {
        if (showFinished) return true;
        const archive = archiveById.get(item.archiveId);
        return !(archive && isArchiveFinished(archive.pageCount, item.pageIndex + 1));
      })
      .map((item) => archiveById.get(item.archiveId))
      .filter((item): item is ArchiveRecord => Boolean(item));
  }, [archiveById, preferences.continueReadingShowFinished, recent]);
  /** 收藏夹 rail 已移除：watchlist 表里的数据（含从 Readoshi 导入的待看记录）
   * 曾在首页与 /to-read 书架两边同时出现，语义上互相打架。收藏操作本身不受
   * 影响，档案详情页与右键菜单照常读写 watchlist。 */
  const toRead = useMemo(
    () => readingList.filter((item) => !item.deleted).map((item) => archiveById.get(item.archiveId)).filter((item): item is ArchiveRecord => Boolean(item)).slice(0, 8),
    [archiveById, readingList],
  );
  const progressByArchiveId = useMemo(() => new Map(history.map((item) => [item.archiveId, item.pageIndex + 1])), [history]);
  // The effect already picked the random set (server first, newest page as the
  // fallback). Sampling `archives` here would just re-show the shelf, because
  // `archives` now holds only the ids the shelves asked for. The finished
  // filter lives here too — so a toggle (and a snapshot restored before the
  // fresh draw lands) re-renders the rail instead of waiting for a refetch.
  const random = useMemo(() => {
    if (preferences.randomRoamShowFinished) return randomArchives;
    return randomArchives.filter((archive) => !isArchiveFinished(archive.pageCount, progressByArchiveId.get(archive.archiveId) ?? 0));
  }, [preferences.randomRoamShowFinished, randomArchives, progressByArchiveId]);
  // Snapshot for the next visit, so switching tabs and coming back is free.
  useEffect(() => {
    if (!servers) return;
    writeRouteCache(HOME_SNAPSHOT_KEY, { servers, history, readingList, archives, randomArchives } satisfies HomeSnapshot);
  }, [archives, history, randomArchives, readingList, servers]);
  return (
    <div className="workspace-home">
      {connectionError ? (
        // 与 ServerRequiredPrompt 同一层壳：位置归 `.first-run-page` 管，两个状态才落
        // 在同一个高度上。
        <div className="first-run-page">
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
        </div>
      ) : servers !== undefined && !connected && (
        // Only an unusable setup gets a prompt; a working server needs no banner.
        // The gate is "the server list has been read", not "no server known":
        // listServers is an IPC round trip, and until it lands nothing is known —
        // rendering the prompt there meant every cold start flashed 添加你的
        // LANraragi for a beat before the shelves replaced it.
        <ServerRequiredPrompt />
      )}
      {connected && homeServer && <>
      <ArchiveThumbnailRail title="继续阅读" headingIcon={<BookOpen aria-hidden="true" />} archives={continueReading} scopeId={homeServer.scopeId} serverId={homeServer.id} progressByArchiveId={progressByArchiveId} loading={recentLoading} skeletonCount={4} refreshing={recentLoading} onRefresh={reloadShelves} onArchiveContextMenu={openContextMenu} />
      <ArchiveThumbnailRail title="待看档案" headingIcon={<Bookmark aria-hidden="true" />} archives={toRead} scopeId={homeServer.scopeId} serverId={homeServer.id} progressByArchiveId={progressByArchiveId} loading={recentLoading} skeletonCount={4} refreshing={recentLoading} onRefresh={reloadShelves} onArchiveContextMenu={openContextMenu} />
      <ArchiveThumbnailRail title="随机漫游" headingIcon={<Shuffle aria-hidden="true" />} archives={random} scopeId={homeServer.scopeId} serverId={homeServer.id} progressByArchiveId={progressByArchiveId} loading={randomLoading} skeletonCount={6} refreshing={randomLoading} onRefresh={() => { void loadRandom(homeServer.id, { showFinished: preferences.randomRoamShowFinished, progress: progressByArchiveId }); }} onArchiveContextMenu={openContextMenu} />
      {contextMenu}
      </>}
      {recentError && <p className="form-error" role="alert">{recentError}</p>}
      {/* 已读完被隐藏导致的空继续阅读不算「书架是空的」——那只是这个开关的
          正常结果，页面还剩待看与随机漫游。 */}
      {!recentLoading && !recentError && connected && continueReading.length === 0 && toRead.length === 0 && (history.length === 0 || preferences.continueReadingShowFinished) && (
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

interface ShelfSnapshot {
  history: ReadingHistoryRecord[];
  watchlist: WatchlistRecord[];
  archives: ArchiveRecord[];
  serverId: string;
  scopeId: string;
  query: string;
  /** The 🔖 Favorites category's ids, cached so a snapshot restore still shows
   * the server favorites before the next category read. */
  favoritesIds?: string[];
}

function StateWorkspace({ name, detailBasePath }: { name: 'history' | 'watchlist' | 'toRead'; detailBasePath: string }) {
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();
  const serverParam = searchParams.get('server');
  // Per-server cache: two servers keep two shelves, and a snapshot restored
  // across them would paint one server's records under the other's shelf.
  const cacheKey = `state:${name}:${serverParam ?? 'default'}`;
  const snapshot = useRef(readRouteCache<ShelfSnapshot>(cacheKey)).current;
  const [reloadToken, setReloadToken] = useState(0);
  const [history, setHistory] = useState<ReadingHistoryRecord[]>(snapshot?.history ?? []);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>(snapshot?.watchlist ?? []);
  const [archives, setArchives] = useState<ArchiveRecord[]>(snapshot?.archives ?? []);
  /** The LANraragi 🔖 Favorites category's archive ids. 收藏夹 IS that
   * category: when it exists the shelf renders it instead of the local
   * watchlist, which only mirrors what this device hearted. */
  const [favoritesIds, setFavoritesIds] = useState<string[] | undefined>(snapshot?.favoritesIds);
  const [serverId, setServerId] = useState<string | undefined>(snapshot?.serverId);
  const [scopeId, setScopeId] = useState<string | undefined>(snapshot?.scopeId);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(!snapshot);
  const [hasServer, setHasServer] = useState(true);
  /** A pull re-reads the shelf in place: `loading` stays false so the list on
   * screen is not swapped for skeletons, and this only drives the spinner. */
  const [pulling, setPulling] = useState(false);
  /** Filters this shelf's own records in the browser. The bar is the library's,
   * the scope is not: a shelf holds a few dozen entries it already has titles
   * for, so there is nothing to ask the server. */
  const [query, setQuery] = useState(snapshot?.query ?? '');
  /** The style chosen in the library. A shelf shows the same cards, so it shows
   * them the same way. */
  const { cardStyle, setCardStyle } = useCardStyle();
  // A history entry has a time relationship to adjacent entries. The thumbnail
  // grid has no continuous vertical edge for that rail, so history always uses
  // the shared wide row presentation.
  const shelfCardStyle = name === 'history' ? 'wide' : cardStyle;
  // The shelves show the same cards as the library, so they answer a right click
  // the same way. Categories need a server-side list this page does not load.
  // Removing an entry is here rather than in a toolbar: the multi-select bar that
  // used to do it was the only control on the page, and one card at a time is
  // what a right click already addresses.
  /** One place that knows what removing entries does to a shelf, for the context
   * menu and for a whole selection. */
  const removeShelfArchives = useCallback((archiveIds: string[]) => {
    const dropped = new Set(archiveIds);
    setWatchlist((current) => current.filter((item) => !dropped.has(item.archiveId)));
    setArchives((current) => current.filter((archive) => !dropped.has(archive.archiveId)));
  }, []);
  /** 历史的多选清理：清掉的是记录，档案留在书架上（历史页）也留在服务器上。 */
  const [clearingHistory, setClearingHistory] = useState(false);
  async function clearHistoryRecords() {
    const ids = [...selection.props.selectedArchiveIds];
    if (!scopeId || ids.length === 0) return;
    const result = await repository.deleteHistoryRecords(scopeId, ids);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      throw new Error(result.error.message);
    }
    const dropped = new Set(ids);
    setHistory((current) => current.filter((item) => !dropped.has(item.archiveId)));
    showToast(`已清理 ${result.value} 条历史记录`, 'success');
  }
  const { open: openContextMenu, menu: contextMenu } = useArchiveContextMenu({
    onMembershipChange: (archiveId, list, next) => {
      if (!next && ((name === 'toRead' && list === 'reading') || (name === 'watchlist' && list === 'favorites'))) {
        removeShelfArchives([archiveId]);
      }
    },
    onDeleted: (archiveId) => removeShelfArchives([archiveId]),
  });
  useEffect(() => {
    const handleInvalidation = (event: Event) => {
      const prefix = (event as CustomEvent<{ prefix?: string }>).detail?.prefix;
      if (!prefix || prefix === 'state:') {
        // In-place re-read, same contract as the pull: the list on screen is
        // the data the user is looking at, so a membership change or a delete
        // elsewhere refreshes under it instead of swapping it for skeletons.
        setError(undefined);
        setPulling(true);
        setReloadToken((value) => value + 1);
      }
    };
    window.addEventListener('yomika:route-cache-invalidated', handleInvalidation);
    return () => window.removeEventListener('yomika:route-cache-invalidated', handleInvalidation);
  }, []);
  // The shelves show the same cards as the library, so they answer a right click
  // the same way. Categories need a server-side list this page does not load.
  useEffect(() => {
    if (snapshot && reloadToken === 0) return;
    let active = true;
    void (async () => {
      const servers = await repository.listServers();
      if (!active) return;
      if (!servers.ok) { setError(servers.error.message); setLoading(false); return; }
      const server = pickServer(servers.value, serverParam);
      if (!server) { setHasServer(false); setLoading(false); return; }
      setServerId(server.id);
      setScopeId(server.scopeId);
      // 书架列表与收藏分类相互独立，并行拉；只有收藏夹需要那条分类——而且只要
      // 那一条：`readFavoritesCategory` 一次两百毫秒，`listCategories` 在快照过期后
      // 要为每条动态分类各跑一次不分页的全库搜索（1.5 万档案的库上 23 秒）。
      const [shelf, favorites] = await Promise.all([
        name === 'history'
          ? repository.listHistory(server.scopeId)
          : name === 'toRead'
            ? repository.listReadingList(server.scopeId)
            : repository.listWatchlist(server.scopeId),
        name === 'watchlist' ? repository.readFavoritesCategory(server.id) : Promise.resolve(undefined),
      ] as const);
      if (!active) return;
      if (!shelf.ok) { setError(shelf.error.message); setLoading(false); return; }
      const result = shelf;
      if (name === 'history') setHistory(result.value as ReadingHistoryRecord[]);
      else setWatchlist(result.value as WatchlistRecord[]);
      // 收藏夹 reads the LANraragi 🔖 Favorites category; the local table only
      // stands in when the category does not exist (or the read failed).
      let shelfIds = name === 'history'
        ? (result.value as ReadingHistoryRecord[]).map((item) => item.archiveId)
        : (result.value as WatchlistRecord[]).filter((item) => !item.deleted).map((item) => item.archiveId);
      if (name === 'watchlist' && favorites?.ok && favorites.value) {
        setFavoritesIds(favorites.value.archives);
        shelfIds = favorites.value.archives;
      }
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
    })().finally(() => { if (active) setPulling(false); });
    return () => { active = false; };
  }, [name, reloadToken, serverParam, snapshot]);
  useEffect(() => {
    if (loading || error || !serverId || !scopeId) return;
    writeRouteCache(cacheKey, { history, watchlist, archives, serverId, scopeId, query, ...(name === 'watchlist' && favoritesIds ? { favoritesIds } : {}) } satisfies ShelfSnapshot);
  }, [archives, cacheKey, error, favoritesIds, history, loading, name, query, scopeId, serverId, watchlist]);
  const [title, description] = workspaces[name];
  // Saved searches work on every shelf, not just the library.
  const [presets, setPresets] = useState<SearchPreset[]>([]);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetEditTarget, setPresetEditTarget] = useState<SearchPreset>();
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
    // 收藏夹 renders the server category's ids in the server's own order when
    // they are known; otherwise it falls back to the local watchlist.
    const ids = name === 'history'
      ? sortedHistory.map((item) => item.archiveId)
      : name === 'watchlist' && favoritesIds
        ? favoritesIds
        : sortedWatchlist.map((item) => item.archiveId);
    return ids.map((id) => archiveById.get(id)).filter((archive): archive is ArchiveRecord => Boolean(archive));
  }, [archiveById, favoritesIds, name, sortedHistory, sortedWatchlist]);
  const visibleArchives = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return shelfArchives;
    return shelfArchives.filter((archive) => archive.title.toLocaleLowerCase().includes(needle));
  }, [query, shelfArchives]);
  /** The shelf a selection acts on: 待看 and 收藏夹 hold one membership each, so
   * their bulk action takes entries off the shelf; the history has none, so it
   * offers the favourite instead. */
  const selection = useArchiveSelection({
    archives: visibleArchives,
    scopeId,
    serverId,
    membership: name === 'history'
      ? undefined
      : { list: name === 'toRead' ? 'reading' : 'favorites', label: name === 'toRead' ? '待看' : '收藏夹', present: true },
    onRemoved: removeShelfArchives,
  });
  const progressByArchiveId = useMemo(
    () => new Map(history.map((item) => [item.archiveId, item.pageIndex + 1])),
    [history],
  );
  /** When each archive entered the history, shown as a timeline down the right of
   * the list. Only the history has a meaningful time per row. */
  const timelineByArchiveId = useMemo(() => (
    name === 'history'
      ? new Map<string, ShelfTimelineEntry>(history.map((item) => [item.archiveId, formatShelfTimeline(item.visitedAt)]))
      : undefined
  ), [history, name]);
  /** 已读完（进度超过 95%）的档案 id，供多选的「全选已读完」；只对历史有意义，
   * 其它书架没有进度可言。 */
  const finishedArchiveIds = useMemo(() => {
    if (name !== 'history') return undefined;
    const ids = new Set<string>();
    for (const item of history) {
      const archive = archiveById.get(item.archiveId);
      if (archive && isArchiveFinished(archive.pageCount, item.pageIndex + 1)) ids.add(item.archiveId);
    }
    return ids;
  }, [archiveById, history, name]);
  useEffect(() => {
    if (!scopeId) return undefined;
    let active = true;
    void repository.listSearchPresets(scopeId).then((result) => {
      if (active && result.ok) setPresets(result.value);
    });
    return () => { active = false; };
  }, [scopeId]);

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
      {loading && (
        /* Same shell as the library route: the `.library-shell-list` panel is
           what carries the 16px side padding, so without it the shelf's cards
           sat nearly flush against the sidebar. */
        <div className="library-shell">
          <section className="library-shell-list">
            <LibraryWorkspace
              archives={[]}
              listLoading
              showDetail={false}
              detailBasePath={detailBasePath}
              heading={null}
              showToolbar={false}
              cardStyle={shelfCardStyle}
              searchQuery={query}
              onSearchQueryChange={setQuery}
              searchScope={{ label: `搜索${title}`, placeholder: `在${title}中搜索…` }}
            />
          </section>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && !error && !hasServer && <ServerRequiredPrompt />}
      {!loading && !error && hasServer && shelfArchives.length === 0 && (
        <EmptyState icon={FolderHeart} title={`暂无${title}`} description={description} />
      )}
      {!loading && !error && hasServer && shelfArchives.length > 0 && (
        // Same list and card system as the library, and the same search bar, so
        // the only difference is what it searches — including the same
        // `.library-shell-list` panel that sets the cards' side padding.
        <div className="library-shell">
          <section className="library-shell-list">
            <LibraryWorkspace
              archives={visibleArchives}
              heading={null}
              showToolbar={false}
              showDetail={false}
              detailBasePath={detailBasePath}
              cardStyle={shelfCardStyle}
              {...(name === 'history' ? {} : { onCardStyleChange: setCardStyle })}
              searchQuery={query}
              onSearchQueryChange={setQuery}
              searchScope={{ label: `搜索${title}`, placeholder: `在${title}中搜索…` }}
              readingProgressByArchiveId={progressByArchiveId}
              onArchiveContextMenu={openContextMenu}
              presets={presets}
              onApplyPreset={(preset) => setQuery(preset.query)}
              onSavePreset={() => { setPresetEditTarget(undefined); setPresetDialogOpen(true); }}
              onEditPreset={(preset) => { setPresetEditTarget(preset); setPresetDialogOpen(true); }}
              onDeletePreset={(preset) => {
                if (!scopeId) return;
                void repository.deleteSearchPreset(scopeId, preset.presetId).then((result) => {
                  if (result.ok) setPresets((current) => current.filter((item) => item.presetId !== preset.presetId));
                });
              }}
              {...(timelineByArchiveId ? { timelineByArchiveId } : {})}
              {...(scopeId && serverId ? { onLoadThumbnail: loadThumbnail, onReleaseThumbnail: releaseThumbnail } : {})}
              /* Pulling a shelf re-reads the shelf, in place — same gesture, same
                 disc, as the library. */
              refreshing={pulling}
              onRefresh={() => { setPulling(true); setReloadToken((value) => value + 1); }}
              {...selection.props}
              selectionActions={<>
                {selection.actions}
                {/* 历史的清理入口在这里：多选之后清掉的是**记录**（会同步到别的
                    设备），档案本体不动。设置里那条「立即清理」按年龄清，已经去掉——
                    要清哪几条，只有看着列表的人知道。 */}
                {name === 'history' && (
                  <button className="secondary-action is-icon" type="button" aria-label="清理所选记录" title="清理所选记录" disabled={selection.props.selectedArchiveIds.size === 0} onClick={() => setClearingHistory(true)}>
                    <Eraser aria-hidden="true" />
                  </button>
                )}
              </>}
              {...(finishedArchiveIds ? { finishedArchiveIds } : {})}
            />
          </section>
        </div>
      )}
      {contextMenu}
      {selection.dialogs}
      {clearingHistory && (
        <ConfirmDialog
          title="清理历史记录"
          description={`将从历史里移除选中的 ${selection.props.selectedArchiveIds.size} 条记录（档案本身不受影响），其它设备同步后也会移除。`}
          confirmLabel="清理"
          danger
          onClose={() => setClearingHistory(false)}
          onConfirm={clearHistoryRecords}
        />
      )}
      <TextInputDialog
        open={presetDialogOpen}
        onOpenChange={setPresetDialogOpen}
        title={presetEditTarget ? '重命名预设' : '存为预设'}
        description={presetEditTarget ? '只改名字，搜索条件保持不变。' : `保存当前的${title}搜索条件，之后一键恢复。`}
        label="预设名称"
        confirmLabel={presetEditTarget ? '保存名称' : '保存预设'}
        validate={(value) => (value.trim() ? undefined : '请填写预设名称')}
        onConfirm={(value) => {
          if (!scopeId) return;
          void repository.saveSearchPreset({
            scopeId,
            presetId: presetEditTarget?.presetId ?? `preset-${Date.now()}`,
            name: value.trim(),
            query: presetEditTarget?.query ?? query,
            sortBy: 'added',
            sortOrder: 'desc',
            categoryId: null,
          }).then((result) => {
            if (!result.ok) return;
            setPresetEditTarget(undefined);
            setPresets((current) => [...current.filter((item) => item.presetId !== result.value.presetId), result.value]);
          });
        }}
      />
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
  const location = useLocation();
  const navigate = useNavigate();
  /** 一条详情路由与它的列表同属一页：`/library/:id` 归 `/library`，三个书架的
   * `/history/:id` 之类归各自的书架。保留页面按这个键复用（见 RetainedPage）。 */
  const pageKeys: Record<string, string> = { library: '/library', history: '/history', watchlist: '/watchlist', 'to-read': '/to-read' };
  const keyFor = (path: string) => pageKeys[path.split('/')[1] ?? ''] ?? path;
  const routeKey = keyFor(location.pathname);
  const visited = useRef(new Map<string, typeof location>());
  const previousKey = useRef(routeKey);
  const savedLibrary = visited.current.get('/library');
  // A navigation entry to the library resumes its split pane. Explicit close,
  // tag searches and server changes are real new destinations.
  const resume = routeKey === '/library' && previousKey.current !== '/library'
    && location.pathname === '/library' && !location.search
    && savedLibrary?.pathname !== '/library' ? savedLibrary : undefined;
  const current = resume ?? location;
  visited.current.set(routeKey, current);
  useEffect(() => {
    previousKey.current = routeKey;
    if (resume) navigate(`${resume.pathname}${resume.search}`, { replace: true, state: resume.state });
  }, [navigate, resume, routeKey]);
  return <>{[...visited.current].map(([key, saved]) => (
    <RetainedPage key={key} active={routeKey === key} flow={!['/library', '/downloads', '/history', '/watchlist', '/to-read'].includes(key)}>
      <Suspense fallback={<LoadingIndicator size="lg" label="正在加载" />}>
        <Routes location={saved}>
          <Route path="/" element={<HomeWorkspace />} />
          <Route path="/library" element={<LibraryShell />} />
          <Route path="/library/:archiveId" element={<LibraryShell />} />
          <Route path="/history" element={<ShelfShell name="history"><StateWorkspace name="history" detailBasePath="/history" /></ShelfShell>} />
          <Route path="/history/:archiveId" element={<ShelfShell name="history"><StateWorkspace name="history" detailBasePath="/history" /></ShelfShell>} />
          <Route path="/watchlist" element={<ShelfShell name="watchlist"><StateWorkspace name="watchlist" detailBasePath="/watchlist" /></ShelfShell>} />
          <Route path="/watchlist/:archiveId" element={<ShelfShell name="watchlist"><StateWorkspace name="watchlist" detailBasePath="/watchlist" /></ShelfShell>} />
          <Route path="/to-read" element={<ShelfShell name="toRead"><StateWorkspace name="toRead" detailBasePath="/to-read" /></ShelfShell>} />
          <Route path="/to-read/:archiveId" element={<ShelfShell name="toRead"><StateWorkspace name="toRead" detailBasePath="/to-read" /></ShelfShell>} />
          <Route path="/library/:archiveId/edit" element={<MetadataEditRouteRoute />} />
          <Route path="/eh" element={<EhRouteWorkspace />} />
          <Route path="/downloads" element={<LocalArchivesWorkspace />} />
          <Route path="/more" element={<MorePagesRoute />} />
          <Route path="/tools/upload" element={<UploadRoute />} />
          <Route path="/tools/dedup" element={<DeduplicationWorkspace />} />
          <Route path="/dedup" element={routeKey === key ? <Navigate to="/tools/dedup" replace /> : null} />
          <Route path="/sync" element={routeKey === key ? <Navigate to="/settings?section=sync" replace /> : null} />
          <Route path="/settings" element={<SettingsWorkspace />} />
          <Route path="*" element={<HomeWorkspace />} />
        </Routes>
      </Suspense>
    </RetainedPage>
  ))}</>;
}

function MetadataEditRouteRoute() {
  const { archiveId = '' } = useParams();
  return <MetadataEditRoute archiveId={archiveId} />;
}

export function ReaderRoutes() {
  return (
    <Suspense fallback={<LoadingIndicator size="lg" label="正在加载页面" />}>
      <Routes>
        <Route path="/reader/:archiveId" element={<ReaderRoute />} />
      </Routes>
    </Suspense>
  );
}

function ReaderRoute() {
  const { archiveId = '' } = useParams();
  return <ReaderRouteScreen archiveId={archiveId} />;
}
