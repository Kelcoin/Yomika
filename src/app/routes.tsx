import { RefreshIcon as RefreshCw } from '../components/RefreshIcon';
import { loadFavoriteArchives } from '../lib/favoritesMirror';
import { Bookmark, BookOpen, Eraser, FolderHeart, Server, Shuffle } from 'lucide-react';
import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { z } from 'zod';
import { Link, Navigate, NavigationType, Route, Routes, UNSAFE_LocationContext, useLocation, useParams, useSearchParams } from 'react-router-dom';

import { RetainedPage, usePageActive } from './RetainedPage';
import { useRouteDirection } from '../lib/useRouteDirection';
import type { RouteDirection } from './RetainedPage';
import type { RouteMotion } from '../lib/routeMotion';
import { useWorkspaceRouteMotion } from '../lib/useWorkspaceRouteMotion';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { EmptyState } from '../components/EmptyState';
import { LibraryShell } from '../components/LibraryShell';
import { HomeShell } from '../components/HomeShell';
import { ShelfShell } from '../components/ShelfShell';
import { LibraryWorkspace, type ShelfTimelineEntry } from '../components/LibraryWorkspace';
import { WorkspaceLoadingSkeleton } from '../components/WorkspaceLoadingSkeleton';
import { UploadPanel } from '../components/UploadPanel';
import { DeduplicationWorkspace } from '../components/DeduplicationWorkspace';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { pickServer } from '../domain/server';
import { ServerRequiredPrompt } from '../components/ServerRequiredPrompt';
import { MorePagesRoute } from '../components/MorePagesRoute';

/** Navigation and startup share the same import loaders. Startup runs bounded
 * batches; main shells stay eager, while tools/editors/readers only warm code. */
export const lazyPages = {
  reader: () => import('../components/ReaderRoute'),
  settings: () => import('../components/SettingsWorkspace'),
  localArchives: () => import('../components/LocalArchivesWorkspace'),
  eh: () => import('../components/EhRouteWorkspace'),
  metadataEdit: () => import('../components/MetadataEditRoute'),
} as const;

/** Readers and larger editors load on first entry. Everything else — home, library
 * and the three shelves — stays in the main chunk: those five panels are the
 * app's shell, are kept mounted across visits, and would pay a Suspense flash
 * on every return for no further savings. The leaves were the bulk of the
 * parsed bytes on boot even though they are one route deep. Upload and dedup
 * keep their real frame eager to avoid swapping an approximate cold fallback. */
const ReaderRouteScreen = lazy(() => lazyPages.reader().then((module) => ({ default: module.ReaderRoute })));
const SettingsWorkspace = lazy(() => lazyPages.settings().then((module) => ({ default: module.SettingsWorkspace })));
const LocalArchivesWorkspace = lazy(() => lazyPages.localArchives().then((module) => ({ default: module.LocalArchivesWorkspace })));
const EhRouteWorkspace = lazy(() => lazyPages.eh().then((module) => ({ default: module.EhRouteWorkspace })));
const MetadataEditRoute = lazy(() => lazyPages.metadataEdit().then((module) => ({ default: module.MetadataEditRoute })));

/** Code warming never mounts a route or invokes its effects. */
export function preloadLazyPages(getForegroundPath: () => string = () => '/'): () => void {
  let stopped = false;
  const allowed = (path: string) => !stopped && typeof document !== 'undefined'
    && document.visibilityState !== 'hidden' && !getForegroundPath().startsWith('/reader/')
    && !getForegroundPath().startsWith(path);
  const stop = scheduleStartupWarmup([
    // Common leaves first; main shells including home/library/more are already eager.
    lazyPages.settings, lazyPages.localArchives,
    ...Object.entries(lazyPages).filter(([key]) => key !== 'settings' && key !== 'localArchives').map(([, load]) => load),
    ...(['toRead', 'history', 'watchlist'] as const).map(name => () => warmShelfSnapshot(name,
      () => allowed(name === 'toRead' ? '/to-read' : `/${name}`))),
  ]);
  return () => { stopped = true; stop(); };
}
import { scheduleStartupWarmup } from './startupWarmup';
import { shelfRead, warmShelfSnapshot } from './shelfWarmup';
import { CategorySchema, NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { ArchiveThumbnailRail } from '../components/ArchiveThumbnailCard';
import { useArchiveContextMenu } from '../components/useArchiveContextMenu';
import { useArchiveSelection } from '../components/useArchiveSelection';
import { TextInputDialog } from '../components/TextInputDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { findMissingArchives } from '../lib/archiveExistence';
import { historyShelfArchives } from '../lib/historyShelf';
import { FAVORITES_CATEGORY_NAME, UNTAGGED_FILTER_ID } from '../lib/tags';
import { pickRandomSample } from '../lib/archiveCardPresentation';
import { readRouteCache, writeRouteCache } from '../lib/routeCache';
import { readKnownServerPresence } from '../lib/serverPresence';
import { useReturnNavigation } from '../lib/useReturnNavigation';
import { isArchiveFinished } from '../lib/archiveCardPresentation';
import { useCardStyle, usePreferences } from './preferences';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { peekCachedImageUrl, type ImageHandle } from '../lib/unifiedImageCache';
import type { ArchiveRecord, ReadingHistoryRecord, WatchlistRecord } from '../domain/library';
import { ArchiveRecordSchema, ReadingHistoryRecordSchema, ServerRecordSchema, WatchlistRecordSchema } from '../domain/library';
import { DomainErrorSchema } from '../domain/errors';
import type { SearchPreset, Category } from '../repositories/nativeLibraryRepository';


const workspaces = {
  history: ['历史', '开始阅读后，进度会保存在这里。'],
  watchlist: ['收藏夹', '收藏的档案会显示在这里。'],
  // Separate from the watchlist on purpose: "I plan to read this" is not the
  // same statement as "I liked this".
  toRead: ['待看档案', '加入待看的档案会排在这里，读完可以移出。'],
} as const;

/** Timeline facts for a shelf row: the day it belongs to (for grouping), a short
 * day label for the day's first row, and the clock time for the row itself. The
 * history rail reads as a sequence instead of one repeated date. `at` is the raw
 * epoch millisecond value, which the history quick-jump rail needs to size its
 * time buckets by how recent a row is. */
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
  return { date, dayLabel, time: at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), at: at.getTime() };
}

const HOME_SNAPSHOT_KEY = 'home:shelves';/** Same reasoning as the library list: switching tabs and coming back should not
 * re-resolve the shelves and draw a new random set. */
// Revalidate on activation; an older local snapshot still supplies the first frame.
const HOME_SNAPSHOT_FRESH_MS = Infinity;

/** 首页「继续阅读」与「待看档案」两排的显示上限：一排横向书架摆满一屏之后，
 * 剩下的既看不见也懒得翻；20 本够翻一会儿，又不至于让首屏挂上几百张卡片。
 * 历史页、待看书架页与搜索仍然是全量，这里只收首页这两排的口。 */
const HOME_RAIL_LIMIT = 20;

interface HomeSnapshot {
  servers: Awaited<ReturnType<NativeLibraryRepository['listServers']>>;
  history: ReadingHistoryRecord[];
  readingList: WatchlistRecord[];
  archives: ArchiveRecord[];
  randomArchives: ArchiveRecord[];
}

const HomeSnapshotSchema = z.object({
  servers: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: ServerRecordSchema.array() }),
    z.object({ ok: z.literal(false), error: DomainErrorSchema }),
  ]),
  history: ReadingHistoryRecordSchema.array(),
  readingList: WatchlistRecordSchema.array(),
  archives: ArchiveRecordSchema.array(),
  randomArchives: ArchiveRecordSchema.array(),
});

function HomeWorkspace() {
  const pageActive = usePageActive();
  const { preferences } = usePreferences();
  const [snapshot] = useState(() => {
    const parsed = HomeSnapshotSchema.safeParse(readRouteCache<unknown>(HOME_SNAPSHOT_KEY, HOME_SNAPSHOT_FRESH_MS));
    return parsed.success ? parsed.data : undefined;
  });
  const [servers, setServers] = useState<Awaited<ReturnType<NativeLibraryRepository['listServers']>> | undefined>(
    // 快照之外还认会话里读到过的那个答案：这次运行已经问过「有没有服务器」的话，
    // 第一帧就能直接给引导，而不是先空一帧（见 src/lib/serverPresence.ts）。
    snapshot?.servers ?? (readKnownServerPresence() === false ? { ok: true, value: [] } : undefined),
  );
  const [history, setHistory] = useState<ReadingHistoryRecord[]>(snapshot?.history ?? []);
  const [readingList, setReadingList] = useState<WatchlistRecord[]>(snapshot?.readingList ?? []);
  const [archives, setArchives] = useState<ArchiveRecord[]>(snapshot?.archives ?? []);
  const [randomArchives, setRandomArchives] = useState<ArchiveRecord[]>(snapshot?.randomArchives ?? []);
  const [recentLoading, setRecentLoading] = useState(!snapshot);
  const [recentError, setRecentError] = useState<string>();
  const [randomLoading, setRandomLoading] = useState(!snapshot);
  const [serverLoadAttempt, setServerLoadAttempt] = useState(0);
  const restoredFromSnapshot = useRef(Boolean(snapshot));
  /** 现在这一排随机漫游画的是哪台服务器抽出来的那一批。换服务器要重抽；同一台
   * 服务器只是书架数据变了（翻一页就写一次阅读进度、加收藏、删档案都会广播失效）
   * 就不重抽——随机漫游「自己刷新」正是从那儿来的。 */
  const randomServerRef = useRef<string | undefined>(undefined);
  const randomRequestRef = useRef(0);
  const randomOwnerRef = useRef(snapshot?.servers.ok ? pickServer(snapshot.servers.value, null)?.id : undefined);
  useEffect(() => () => { randomRequestRef.current += 1; }, []);
  // Manual refresh belongs to one shelf; route invalidation still reloads both.
  const [refreshingShelf, setRefreshingShelf] = useState({ history: false, reading: false });
  const shelfRequests = useRef({ history: 0, reading: 0 });
  const shelfBusy = useRef({ history: false, reading: false });
  const refreshShelf = async (kind: 'history' | 'reading') => {
    const server = servers?.ok ? pickServer(servers.value, null) : undefined;
    if (!server || shelfBusy.current[kind]) return;
    shelfBusy.current[kind] = true;
    const request = ++shelfRequests.current[kind];
    const owns = () => shelfRequests.current[kind] === request && randomOwnerRef.current === server.id;
    setRefreshingShelf(current => ({ ...current, [kind]: true }));
    setRecentError(undefined);
    try {
      const result = kind === 'history' ? await repository.listHistory(server.scopeId) : await repository.listReadingList(server.scopeId);
      if (!owns()) return;
      if (!result.ok) { setRecentError(result.error.message); return; }
      const ids = result.value.filter(item => !('deleted' in item) || !item.deleted).map(item => item.archiveId);
      const resolved = await repository.listArchivesByIds(server.id, kind === 'history' ? ids : ids.slice(0, 24));
      if (!owns()) return;
      if (!resolved.ok) { setRecentError(resolved.error.message); return; }
      // Commit the membership and its resolved cards together; the other shelf keeps its data.
      setArchives(current => [...new Map([...current, ...resolved.value].map(archive => [archive.archiveId, archive])).values()]);
      if (kind === 'history') setHistory(result.value as ReadingHistoryRecord[]);
      else setReadingList(result.value as WatchlistRecord[]);
    } finally {
      if (owns()) {
        shelfBusy.current[kind] = false;
        setRefreshingShelf(current => ({ ...current, [kind]: false }));
      }
    }
  };
  // LANraragi picks the random set. Behind a callback so the rail's refresh
  // button can ask for another draw without reloading the whole page.
  // The draw keeps going until the rail's width is full: the caller says how
  // many finished archives count as invisible, and a batch that comes back
  // mostly finished asks the server again rather than leaving the rail short.
  const loadRandom = useCallback(async (
    serverId: string,
    context: { showFinished: boolean; progress: ReadonlyMap<string, number> },
  ) => {
    const request = ++randomRequestRef.current;
    const ownsRequest = () => randomRequestRef.current === request && randomOwnerRef.current === serverId;
    setRandomLoading(true);
    // 记在这台服务器名下：下一次刷新（失效广播、换服务器）据此判断要不要重抽。
    randomServerRef.current = serverId;
    // Rail step: a 150px card plus its 12px gap — the same measure the rail's
    // skeleton uses. Counting the whole window and letting the rail scroll the
    // spare overcosts nothing and never leaves a visible gap.
    const needed = Math.max(8, Math.ceil(window.innerWidth / 150) + 2);
    const accepted = (archive: ArchiveRecord) => context.showFinished
      || !isArchiveFinished(archive.pageCount, context.progress.get(archive.archiveId) ?? 0);
    const collected = new Map<string, ArchiveRecord>();
    for (let draw = 0; draw < 3 && collected.size < needed; draw += 1) {
      const random = await repository.searchRandomArchives(serverId, 24);
      if (!ownsRequest()) return;
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
      if (!ownsRequest()) return;
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
    if (!pageActive) return;
    restoredFromSnapshot.current = false;
    let active = true;
    shelfRequests.current.history++;
    shelfRequests.current.reading++;
    shelfBusy.current = { history: false, reading: false };
    setRefreshingShelf({ history: false, reading: false });
    void (async () => {
      setRecentLoading(true);
      setRecentError(undefined);
      const result = await repository.listServers();
      if (!active) return;
      const nextRandomOwner = result.ok ? pickServer(result.value, null)?.id : undefined;
      if (randomOwnerRef.current !== nextRandomOwner) {
        // Shelf re-reads on the same server keep their draw; server changes
        // retire both remote draws and their pending local fallback.
        randomRequestRef.current += 1;
        randomOwnerRef.current = nextRandomOwner;
        randomServerRef.current = undefined;
        setRandomArchives([]);
        setRandomLoading(Boolean(nextRandomOwner));
      }
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
      // 历史那一批解析的是**整条历史**的档案，和历史页面解析的是同一批：只解析一排
      // 要显示的那六条，被隐藏的已读完、或镜像里暂时解析不出来的记录就会在这一排里
      // 留下空格——两页看的是同一份历史，不该有两套口径。整条历史都是本地索引上的一次
      // 点查（历史页面本来就这么解析），多出来的存在性探测由 `findMissingArchives` 分次
      // 问完（每次至多 192 个，答案在会话里记住）。
      const shelfIds = [...new Set([
        ...historyResult.value.map((item) => item.archiveId),
        ...readingListResult.value.filter((item) => !item.deleted).slice(0, 24).map((item) => item.archiveId),
      ])];
      // 书架 id 解析与随机漫游互不依赖，重叠拉取：原先是先等完书架、
      // 再等随机、最后等缺失确认，三条链串行只让首屏更晚齐。
      const archivePromise = repository.listArchivesByIds(server.id, shelfIds);
      // 已经为这台服务器抽过的那一批就留着：书架里绝大多数失效广播都来自书架自身的
      // 写入（阅读进度每翻一页写一次），重抽会让随机漫游在用户没碰它的时候换一批。
      // 换服务器时 `randomServerRef` 是另一台的名字，照旧重抽。
      const randomPromise = randomServerRef.current === server.id
        ? Promise.resolve()
        : loadRandom(server.id, {
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
    return () => { active = false; shelfRequests.current.history++; shelfRequests.current.reading++; };
  }, [loadRandom, serverLoadAttempt, pageActive]);
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
        // 随机漫游不跟着亮加载态：只有换服务器才会重抽（见载入 effect 里那条判断），
        // 让它先闪一下再换回同一批卡片没有意义。
        setRecentLoading(true);
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
  const archiveById = useMemo(() => new Map(archives.map((archive) => [archive.archiveId, archive])), [archives]);
  /** 「继续阅读」的已读完开关：关闭时不把进度超过 95% 的记录放进这一排，其余照旧。
   * 口径与历史页面共用（`historyShelfArchives`），首页这一排只取前 `HOME_RAIL_LIMIT`
   * 条——历史页仍然列全量，这里只是一屏书架的量。横向滚动本来就不用取太多：封面是
   * 懒加载的（`ArchiveThumbMedia` 用共享 IntersectionObserver，480px rootMargin 之内
   * 才去取图），挂上去的只是一层轻量卡片。 */
  const continueReading = useMemo(
    () => historyShelfArchives(history, archiveById, {
      hideFinished: !preferences.continueReadingShowFinished,
      limit: HOME_RAIL_LIMIT,
    }),
    [archiveById, history, preferences.continueReadingShowFinished],
  );
  /** 首页待看只读 reading_list；收藏详情与菜单统一读写远端 Favorites 分类。 */
  const toRead = useMemo(
    () => readingList.filter((item) => !item.deleted).map((item) => archiveById.get(item.archiveId)).filter((item): item is ArchiveRecord => Boolean(item)).slice(0, HOME_RAIL_LIMIT),
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
    // 首页快照也落盘：它带自己的 90 秒 TTL，过期数据不会因此复活。
    writeRouteCache(HOME_SNAPSHOT_KEY, { servers, history, readingList, archives, randomArchives } satisfies HomeSnapshot, { persist: true });
  }, [archives, history, randomArchives, readingList, servers]);
  return (
    <div className="workspace-home" data-bounce-surface="">
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
              <Link className="secondary-action" to="/settings" state={{ homeEntry: true }}>打开设置</Link>
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
      {(servers === undefined || connected) && <>
      <ArchiveThumbnailRail title="继续阅读" headingIcon={<BookOpen aria-hidden="true" />} archives={continueReading} scopeId={homeServer?.scopeId ?? ''} serverId={homeServer?.id ?? ''} detailBasePath="/home" progressByArchiveId={progressByArchiveId} progressScope="history" loading={recentLoading} skeletonCount={4} refreshing={recentLoading || refreshingShelf.history} onRefresh={() => { void refreshShelf('history'); }} resetScrollKey={`${homeServer?.id ?? ''}:${continueReading[0]?.archiveId ?? ''}`} onArchiveContextMenu={openContextMenu} />
      <ArchiveThumbnailRail title="待看档案" headingIcon={<Bookmark aria-hidden="true" />} archives={toRead} scopeId={homeServer?.scopeId ?? ''} serverId={homeServer?.id ?? ''} detailBasePath="/home" progressByArchiveId={progressByArchiveId} loading={recentLoading} skeletonCount={4} refreshing={recentLoading || refreshingShelf.reading} onRefresh={() => { void refreshShelf('reading'); }} onArchiveContextMenu={openContextMenu} />
      <ArchiveThumbnailRail title="随机漫游" headingIcon={<Shuffle aria-hidden="true" />} archives={random} scopeId={homeServer?.scopeId ?? ''} serverId={homeServer?.id ?? ''} detailBasePath="/home" progressByArchiveId={progressByArchiveId} loading={randomLoading} skeletonCount={6} refreshing={randomLoading} onRefresh={homeServer ? () => { void loadRandom(homeServer.id, { showFinished: preferences.randomRoamShowFinished, progress: progressByArchiveId }); } : undefined} onArchiveContextMenu={openContextMenu} />
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
  /** Startup mirror-only preparation still needs the normal foreground existence check. */
  needsForegroundVerification?: boolean;
  favoritesSource?: 'remote';
  favoritesCategoryPresent?: boolean;
  history: ReadingHistoryRecord[];
  watchlist: WatchlistRecord[];
  archives: ArchiveRecord[];
  serverId: string;
  scopeId: string;
  query: string;
  /** The server's categories, cached for the same reason: the toolbar's filter
   * needs them, and asking for them is the one expensive read on this page. */
  categories?: Category[];
}

const ShelfSnapshotSchema = z.object({
  needsForegroundVerification: z.boolean().optional(),
  favoritesSource: z.literal('remote').optional(),
  favoritesCategoryPresent: z.boolean().optional(),
  history: ReadingHistoryRecordSchema.array(),
  // Remote Favorites uses membership placeholders without local timestamps.
  watchlist: WatchlistRecordSchema.extend({ addedAt: z.string(), updatedAt: z.string(), deviceId: z.string() }).array(),
  archives: ArchiveRecordSchema.array(),
  serverId: z.string().min(1),
  scopeId: z.string().min(1),
  query: z.string(),
  categories: CategorySchema.array().optional(),
});

function readShelfSnapshot(key: string, maxAgeMs?: number) {
  const parsed = ShelfSnapshotSchema.safeParse(readRouteCache<unknown>(key, maxAgeMs));
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return value.archives.every(archive => archive.serverId === value.serverId)
    && value.history.every(item => item.scopeId === value.scopeId)
    && value.watchlist.every(item => item.scopeId === value.scopeId) ? value : undefined;
}

function StateWorkspace({ name, detailBasePath }: { name: 'history' | 'watchlist' | 'toRead'; detailBasePath: string }) {
  const [searchParams] = useSearchParams();
  return <StateWorkspaceContent key={JSON.stringify([name, searchParams.get('server')])} name={name} detailBasePath={detailBasePath} />;
}

function StateWorkspaceContent({ name, detailBasePath }: { name: 'history' | 'watchlist' | 'toRead'; detailBasePath: string }) {
  const pageActive = usePageActive();
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();
  const serverParam = searchParams.get('server');
  // Per-server cache: two servers keep two shelves, and a snapshot restored
  // across them would paint one server's records under the other's shelf.
  const cacheKey = `state:${name}:${serverParam ?? 'default'}`;
  const favoriteFallbackKey = `favorites:last:${serverParam ?? 'default'}`;
  const [snapshot] = useState(() => {
    if (name !== 'watchlist') {
      const cached = readShelfSnapshot(cacheKey);
      return !serverParam || cached?.serverId === serverParam ? cached : undefined;
    }
    return undefined; // Favorites provenance is checked after resolving the server.
  });
  const verifiedSnapshot = useRef(!snapshot?.needsForegroundVerification);
  const [verificationPending, setVerificationPending] = useState(Boolean(snapshot?.needsForegroundVerification));
  const [favoritesCategoryPresent, setFavoritesCategoryPresent] = useState<boolean>();
  const [hasFavoriteSnapshot, setHasFavoriteSnapshot] = useState(Boolean(snapshot && name === 'watchlist'));
  const canShowStale = name === 'watchlist' && hasFavoriteSnapshot;
  const [reloadToken, setReloadToken] = useState(0);
  const [history, setHistory] = useState<ReadingHistoryRecord[]>(snapshot?.history ?? []);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>(snapshot?.watchlist ?? []);
  const [archives, setArchives] = useState<ArchiveRecord[]>(snapshot?.archives ?? []);
  /** 收藏与待看的顶栏与档案库同一套（分类筛选、排序方式、多选、显示模式）。
   * 历史没有：它的顺序就是那列时间线，按标题重排会把它读的东西弄丢。 */
  const showShelfToolbar = name !== 'history';
  const [sortMode, setSortMode] = useState<'title' | 'added'>('added');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [categoryFilter, setCategoryFilter] = useState('');
  /** Categories come from the server, so they ride along with the shelf snapshot:
   * `list_categories` is the one read here that can cost real time (see the load
   * effect), and a return to this shelf should not pay it again. */
  const [categories, setCategories] = useState<Category[] | undefined>(snapshot?.categories);
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const [serverId, setServerId] = useState<string | undefined>(snapshot?.serverId);
  const [scopeId, setScopeId] = useState<string | undefined>(snapshot?.scopeId);
  const loadedShelfServer = useRef(snapshot?.serverId);
  const shelfIdentity = JSON.stringify([name, serverParam, serverId, scopeId]);
  const shelfOwner = useRef({ identity: shelfIdentity });
  if (shelfOwner.current.identity !== shelfIdentity) shelfOwner.current = { identity: shelfIdentity };
  const currentShelfOwner = shelfOwner.current;
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(!snapshot);
  /** 初值不再无条件写 `true`：会话里已经读到过「一台服务器都没有」时，第一帧就该
   * 是引导（下面的渲染门因此也不再等 `loading`）。没读到过仍是 `true`——先给骨架。 */
  const [hasServer, setHasServer] = useState(readKnownServerPresence() ?? true);
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
  useEffect(() => { setClearingHistory(false); }, [shelfIdentity]);
  async function clearHistoryRecords() {
    const ids = [...selection.props.selectedArchiveIds];
    if (!scopeId || ids.length === 0) return;
    const owner = shelfOwner.current;
    const result = await repository.deleteHistoryRecords(scopeId, ids);
    if (shelfOwner.current !== owner) return;
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
      if (shelfOwner.current !== currentShelfOwner) return;
      if (!next && ((name === 'toRead' && list === 'reading') || (name === 'watchlist' && list === 'favorites'))) {
        removeShelfArchives([archiveId]);
      }
    },
    onDeleted: (archiveId) => { if (shelfOwner.current === currentShelfOwner) removeShelfArchives([archiveId]); },
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
    if (!pageActive) return;
    if (snapshot && verifiedSnapshot.current && reloadToken === 0 && name !== 'watchlist') return;
    let active = true;
    if (name === 'watchlist') {
      setError(undefined);
    }
    void (async () => {
      const servers = await shelfRead('servers', () => repository.listServers());
      if (!active) return;
      if (!servers.ok) { setError(servers.error.message); setLoading(false); return; }
      const server = pickServer(servers.value, serverParam);
      if (!server) { setHasServer(false); setLoading(false); return; }
      // 这台服务器是这一趟刚读出来的：以前这里只往 false 走，于是导入凭据（或任何
      // 之后才出现的服务器）之后，这一页的提示会一直挂着——装载重跑了、书架也读回
      // 来了，结论却没人撤销。
      setHasServer(true);
      const changedServer = loadedShelfServer.current !== server.id;
      loadedShelfServer.current = server.id;
      if (changedServer) {
        setCategoryFilter('');
        setHistory([]);
        setWatchlist([]);
        setArchives([]);
        setCategories(undefined);
        categoriesRef.current = undefined;
        setLoading(true);
      }
      if (name === 'watchlist' && changedServer) {
        const cached = readShelfSnapshot(`favorites:last:${server.id}`, Infinity)
          ?? readShelfSnapshot(favoriteFallbackKey, Infinity);
        const valid = cached?.favoritesSource === 'remote' && cached.serverId === server.id
          && cached.scopeId === server.scopeId && cached.archives.every(archive => archive.serverId === server.id);
        setHasFavoriteSnapshot(Boolean(valid));
        setArchives(valid ? cached.archives : []);
        setWatchlist(valid ? cached.watchlist : []);
        setFavoritesCategoryPresent(valid ? cached.favoritesCategoryPresent : undefined);
        setLoading(!valid);
      }
      setServerId(server.id);
      setScopeId(server.scopeId);
      const needsCategories = showShelfToolbar && (changedServer || name === 'watchlist' || categoriesRef.current === undefined);
      // Dynamic category searches must not block favorites membership refresh.
      if (needsCategories && name === 'watchlist') {
        void repository.listCategories(server.id).then(result => {
          if (active) setCategories(result.ok ? result.value : []);
        }).catch(() => { if (active) setCategories([]); });
      }
      const [shelf, categoryResult] = await Promise.all([
        name === 'history'
          ? shelfRead(`history:${server.scopeId}`, () => repository.listHistory(server.scopeId))
          : name === 'toRead'
            ? shelfRead(`toRead:${server.scopeId}`, () => repository.listReadingList(server.scopeId))
            : shelfRead(`favorites:${server.id}`, () => repository.readFavoritesCategory(server.id)),
        needsCategories && name !== 'watchlist' ? repository.listCategories(server.id) : Promise.resolve(undefined),
      ] as const);
      if (!active) return;
      if (categoryResult) setCategories(categoryResult.ok ? categoryResult.value : []);
      if (!shelf.ok) { setError(shelf.error.message); setLoading(false); return; }
      const favoriteIds = name === 'watchlist' ? (shelf.value as { archives: string[] } | null)?.archives ?? [] : [];
      const shelfIds = name === 'history'
        ? (shelf.value as ReadingHistoryRecord[]).map(item => item.archiveId)
        : name === 'watchlist' ? favoriteIds : (shelf.value as WatchlistRecord[]).filter(item => !item.deleted).map(item => item.archiveId);
      const archiveResult = name === 'watchlist'
        ? { ok: true as const, value: await loadFavoriteArchives(server.id, shelfIds) }
        : await shelfRead(`archives:${server.id}:${JSON.stringify([...new Set(shelfIds)])}`, () => repository.listArchivesByIds(server.id, [...new Set(shelfIds)]));
      if (!active) return;
      if (!archiveResult.ok) setError(archiveResult.error.message);
      else {
      if (name === 'history') setHistory(shelf.value as ReadingHistoryRecord[]);
      else if (name === 'toRead') setWatchlist(shelf.value as WatchlistRecord[]);
      else setWatchlist(favoriteIds.map(archiveId => ({ scopeId: server.scopeId, archiveId, addedAt: '', deleted: false, deviceId: '', updatedAt: '', revision: 1 })));
        setArchives(archiveResult.value);
        setError(undefined);
        if (name === 'watchlist') {
          const favoritesCategoryPresent = shelf.value !== null;
          setFavoritesCategoryPresent(favoritesCategoryPresent);
          setHasFavoriteSnapshot(true);
          const value: ShelfSnapshot = {
            favoritesSource: 'remote', favoritesCategoryPresent, history: [],
            watchlist: favoriteIds.map(archiveId => ({ scopeId: server.scopeId, archiveId, addedAt: '', deleted: false, deviceId: '', updatedAt: '', revision: 1 })),
            archives: archiveResult.value, serverId: server.id, scopeId: server.scopeId, query: '',
            categories: categoryResult?.ok ? categoryResult.value : categoriesRef.current ?? [],
          };
          writeRouteCache(cacheKey, value, { persist: true });
          writeRouteCache(favoriteFallbackKey, value, { persist: true });
          writeRouteCache(`favorites:last:${server.id}`, value, { persist: true });
        }
      }
      setLoading(false);
      if (name === 'watchlist') {
        // Fresh remote membership supersedes redundant per-archive probes.
        verifiedSnapshot.current = true;
        setVerificationPending(false);
        return;
      }
      // Same reason as the home rails: the mirror does not hear about deletions,
      // so a shelf would keep offering archives the server no longer has.
      const missing = await findMissingArchives(server.id, archiveResult.ok ? archiveResult.value.map((archive) => archive.archiveId) : []);
      if (!active) return;
      if (missing.size > 0) setArchives((current) => current.filter((archive) => !missing.has(archive.archiveId)));
      verifiedSnapshot.current = true;
      setVerificationPending(false);
    })().catch(error => { if (active) { setError(String(error)); setLoading(false); } }).finally(() => { if (active) setPulling(false); });
    return () => { active = false; };
  }, [name, pageActive, reloadToken, serverParam, snapshot]);
  useEffect(() => {
    if (name === 'watchlist' || loading || verificationPending || error || !serverId || !scopeId) return;
    // 书架快照同理：读的时候走默认 10 分钟 TTL，落盘不会让过期数据复活。
    const value = { history, watchlist, archives, serverId, scopeId, query, ...(categories ? { categories } : {}) } satisfies ShelfSnapshot;
    writeRouteCache(cacheKey, value, { persist: true });
  }, [archives, cacheKey, categories, error, favoriteFallbackKey, history, loading, name, query, scopeId, serverId, watchlist, verificationPending]);
  const [title, description] = workspaces[name];
  // Saved searches work on every shelf, not just the library.
  const [presets, setPresets] = useState<SearchPreset[]>([]);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetEditTarget, setPresetEditTarget] = useState<SearchPreset>();
  const presetIdentity = `${serverParam ?? 'default'}:${serverId ?? ''}:${scopeId ?? ''}`;
  const presetOwner = useRef({ identity: presetIdentity });
  if (presetOwner.current.identity !== presetIdentity) presetOwner.current = { identity: presetIdentity };
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
    // 历史与首页「继续阅读」共用同一份口径（顺序、解析、已读完过滤）；这里全都要。
    if (name === 'history') return historyShelfArchives(history, archiveById);
    // Membership is remote Favorites for favorites, local reading_list for pending reading.
    const ids = sortedWatchlist.map((item) => item.archiveId);
    return ids.map((id) => archiveById.get(id)).filter((archive): archive is ArchiveRecord => Boolean(archive));
  }, [archiveById, history, name, sortedWatchlist]);
  // 待看按本地加入时间；收藏按档案添加时间，不能用远端分类成员的排列顺序。
  const readingListDates = useMemo(() => new Map(activeWatchlist.map(item =>
    [item.archiveId, Date.parse(item.addedAt) / 1000 || 0])), [activeWatchlist]);
  const sortedArchives = useMemo(() => {
    if (name === 'history') return shelfArchives;
    const direction = sortOrder === 'asc' ? 1 : -1;
    return [...shelfArchives].sort((left, right) => direction * (sortMode === 'title'
      ? left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' })
      : name === 'toRead'
        ? (readingListDates.get(left.archiveId) ?? 0) - (readingListDates.get(right.archiveId) ?? 0)
        : (left.addedAt ?? 0) - (right.addedAt ?? 0)));
  }, [shelfArchives, name, readingListDates, sortMode, sortOrder]);
  /** 分类筛选同样在本地做。档案库那条 `untaggedOnly` 是服务器搜索的参数，书架没有
   * 对应的查询，所以按已有分类的成员表算：「无标签」= 不在任何分类里的档案。 */
  const categoryFilterIds = useMemo(() => {
    if (!categoryFilter || categoryFilter === UNTAGGED_FILTER_ID) return undefined;
    return new Set(categories?.find((category) => category.id === categoryFilter)?.archives ?? []);
  }, [categories, categoryFilter]);
  const taggedArchiveIds = useMemo(() => {
    if (categoryFilter !== UNTAGGED_FILTER_ID) return undefined;
    // 收藏夹那条分类不算标签：它是「收藏」这个书架本身，档案库那边也一样排除。
    return new Set((categories ?? [])
      .filter((category) => category.name !== FAVORITES_CATEGORY_NAME)
      .flatMap((category) => category.archives));
  }, [categories, categoryFilter]);
  const visibleArchives = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sortedArchives.filter((archive) => {
      if (needle && !archive.title.toLocaleLowerCase().includes(needle)) return false;
      if (taggedArchiveIds) return !taggedArchiveIds.has(archive.archiveId);
      if (categoryFilterIds) return categoryFilterIds.has(archive.archiveId);
      return true;
    });
  }, [categoryFilterIds, query, sortedArchives, taggedArchiveIds]);
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
    // 历史页的多选不给「删除所选」：那一页的清理入口是「清理所选记录」，
    // 误点删除会连带把档案本体从服务器上删掉。
    allowDelete: name !== 'history',
    allowFavorite: name !== 'history',
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
    setPresets([]);
    setPresetDialogOpen(false);
    setPresetEditTarget(undefined);
    if (!scopeId || (serverParam && serverId !== serverParam)) return undefined;
    let active = true;
    void repository.listSearchPresets(scopeId).then((result) => {
      if (active && result.ok) setPresets(result.value);
    });
    return () => { active = false; };
  }, [scopeId, serverId, serverParam]);

  const loadThumbnail = useCallback(async (archive: ArchiveRecord, signal?: AbortSignal) => {
    if (!scopeId || !serverId) return undefined;
    try {
      return await stateImageCache.load(
        { scopeId, serverId, archiveId: archive.archiveId, rendition: 'cover', pageIndex: 0 },
        { retain: true, ...(signal ? { signal } : {}) },
      );
    } catch {
      return undefined;
    }
  }, [scopeId, serverId]);
  const releaseThumbnail = useCallback((handle: ImageHandle) => stateImageCache.release(handle), []);
  const peekThumbnail = useCallback((archive: ArchiveRecord) => (scopeId && serverId
    ? peekCachedImageUrl(stateImageCache, { scopeId, serverId, archiveId: archive.archiveId, rendition: 'cover', pageIndex: 0 })
    : undefined), [scopeId, serverId]);

  /** 顶栏那套受控属性。档案库把这几项写进 URL 查询，书架的筛选与排序只活在这一页
   * （它没有查询要分享，切走再回来也不该丢掉选中的分类），所以状态留在这里，只把
   * 控件要的值和回调交出去。历史没有顶栏，所以一个都不传。 */
  const toolbarProps = showShelfToolbar ? {
    sortTimeLabel: name === 'toRead' ? '加入待看时间' : '添加时间',
    archiveDateById: name === 'toRead' ? readingListDates : undefined,
    categories,
    categoriesLoading: categories === undefined,
    sortMode,
    onSortModeChange: setSortMode,
    sortOrder,
    onSortOrderChange: setSortOrder,
    categoryFilter,
    onCategoryFilterChange: setCategoryFilter,
  } : {};

  return (
    <div className="shelf-workspace">
      {/* No page title: the sidebar already names the shelf, and a 40px heading
          above an empty state was most of what the page showed. 收藏与待看现在有
          档案库那条顶栏（分类筛选、排序方式、多选、显示模式）；历史没有，它的顺序
          就是那列时间线，重排会把它读的东西弄丢。 */}
      {error && <p className="form-error" role="alert">{canShowStale ? `离线缓存：显示上次收藏快照，可能已过期。${error}` : error}</p>}
      {/* 已知没有服务器时不等 loading：这次拉取的结果只会再确认一遍这个事实，
          而它落地之前用户看到的就是这一页该给的引导（`!loading` 那版会让骨架
          先转一帧）。 */}
      {!error && hasServer === false && <ServerRequiredPrompt />}
      {hasServer && (!error || canShowStale) && (
        // Same list and card system as the library, and the same search bar, so
        // the only difference is what it searches. The 16px side padding comes
        // from the ShelfShell panel; this page adds none of its own.
        <LibraryWorkspace
          archives={visibleArchives}
          listLoading={loading}
          emptyContent={<EmptyState icon={FolderHeart} title={name === 'watchlist' && favoritesCategoryPresent === false ? '服务器尚未创建 🔖 Favorites 分类' : `暂无${title}`} description={name === 'watchlist' && favoritesCategoryPresent === false ? '请先在 LANraragi 中创建名为 🔖 Favorites 的静态分类，之后才能添加收藏。' : description} />}
          heading={null}
          showToolbar={showShelfToolbar}
          showDetail={false}
          detailBasePath={detailBasePath}
          cardStyle={shelfCardStyle}
          {...toolbarProps}
          {...(name === 'history' ? {} : { onCardStyleChange: setCardStyle })}
          searchQuery={query}
          onSearchQueryChange={setQuery}
          searchScope={{ label: `搜索${title}`, placeholder: `在${title}中搜索…` }}
          readingProgressByArchiveId={progressByArchiveId}
          progressScope={name === 'history' ? 'history' : 'elsewhere'}
          onArchiveContextMenu={openContextMenu}
          presets={presets}
          onApplyPreset={(preset) => setQuery(preset.query)}
          onSavePreset={() => { setPresetEditTarget(undefined); setPresetDialogOpen(true); }}
          onEditPreset={(preset) => { setPresetEditTarget(preset); setPresetDialogOpen(true); }}
          onDeletePreset={(preset) => {
            if (!scopeId) return;
            const owner = presetOwner.current;
            void repository.deleteSearchPreset(scopeId, preset.presetId).then((result) => {
              if (presetOwner.current !== owner) return;
              if (!result.ok) { showToast(result.error.message, 'error'); return; }
              if (result.ok) setPresets((current) => current.filter((item) => item.presetId !== preset.presetId));
            });
          }}
          {...(timelineByArchiveId ? { timelineByArchiveId } : {})}
          {...(scopeId && serverId ? { onLoadThumbnail: loadThumbnail, onReleaseThumbnail: releaseThumbnail, peekThumbnail } : {})}
          /* Pulling a shelf re-reads the shelf, in place — same gesture, same
             disc, as the library. */
          refreshing={pulling}
          onRefresh={() => { setPulling(true); setReloadToken((value) => value + 1); }}
          {...selection.props}
          selectionActions={<>
            {selection.actions}
            {/* 历史的清理入口在这里：多选之后清掉的是**记录**（启用服务器托管时影响共享数据），档案本体不动。设置里那条「立即清理」按年龄清，已经去掉——
                要清哪几条，只有看着列表的人知道。 */}
            {name === 'history' && (
              <button className="secondary-action has-action-label" type="button" aria-label="清理所选记录" title="清理所选记录" disabled={selection.props.selectedArchiveIds.size === 0} onClick={() => setClearingHistory(true)}>
                <Eraser aria-hidden="true" /><span className="action-label">清理记录</span>
              </button>
            )}
          </>}
          {...(finishedArchiveIds ? { finishedArchiveIds } : {})}
        />
      )}
      {contextMenu}
      {selection.dialogs}
      {clearingHistory && (
        <ConfirmDialog
          title="清理历史记录"
          description={`将从历史里移除选中的 ${selection.props.selectedArchiveIds.size} 条记录（档案本身不受影响），启用服务器托管时，其它设备读取的共享历史也会移除。`}
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
        onConfirm={async (value) => {
          if (!scopeId) throw new Error('尚未连接服务器，请稍后重试');
          const owner = presetOwner.current;
          const result = await repository.saveSearchPreset({
            scopeId,
            presetId: presetEditTarget?.presetId ?? `preset-${Date.now()}`,
            name: value.trim(),
            query: presetEditTarget?.query ?? query,
            sortBy: 'added',
            sortOrder: 'desc',
            categoryId: null,
          });
          if (presetOwner.current !== owner) return;
          if (!result.ok) throw new Error(result.error.message);
          setPresets((current) => [...current.filter((item) => item.presetId !== result.value.presetId), result.value]);
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

export function WorkspaceRoutes({ direction: navigationDirection, motion: outerMotion, surfaceRef, previewLocation }: { direction?: RouteDirection; motion?: RouteMotion; surfaceRef?: MutableRefObject<HTMLElement | null>; previewLocation?: ReturnType<typeof useLocation> | undefined } = {}) {
  const routerLocation = useLocation();
  const detectedDirection = useRouteDirection();
  const direction = navigationDirection ?? detectedDirection;
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
  const active = usePageActive();
  // App normally stages the whole shell; standalone routes keep that behavior
  // too. Never run a second exit animation beneath App's saved-location router.
  const transition = useWorkspaceRouteMotion(routerLocation, compact, direction, active && !outerMotion);
  const { location } = transition;
  const motion = outerMotion ?? transition.motion;
  const surface = surfaceRef ?? transition.surface;
  /** 一条详情路由与它的列表同属一页：`/library/:id` 归 `/library`，三个书架的
   * `/history/:id` 之类归各自的书架，首页的 `/home/:id` 归 `/`。保留页面按这个键
   * 复用（见 RetainedPage）。 */
  const pageKeys: Record<string, string> = { home: '/', library: '/library', history: '/history', watchlist: '/watchlist', 'to-read': '/to-read' };
  // Editors are temporary destinations, not the library tab's remembered page.
  const keyFor = (path: string) => path.endsWith('/edit') ? path : pageKeys[path.split('/')[1] ?? ''] ?? path;
  const routeKey = keyFor(location.pathname);
  const preview = previewLocation ?? transition.previewLocation;
  const previewKey = preview ? keyFor(preview.pathname) : undefined;
  const visited = useRef(new Map<string, typeof location>());
  visited.current.set(routeKey, location);
  if (preview && previewKey) visited.current.set(previewKey, preview);
  return <>{[...visited.current].map(([key, saved]) => (
    <RetainedWorkspacePage key={key} saved={saved} direction={routeKey === key ? direction : 1} motion={routeKey === key ? motion : previewKey === key ? { kind: 'none', axis: 'x', direction: 1 } : undefined} surfaceRef={routeKey === key ? surface : undefined} active={routeKey === key || previewKey === key} flow={!['/library', '/downloads', '/history', '/watchlist', '/to-read'].includes(key)} />
  ))}</>;
}

function ActiveRedirect({ to }: { to: string }) {
  return usePageActive() ? <Navigate to={to} replace /> : null;
}

function WorkspaceRouteFallback({ path }: { path: string }) {
  const goBack = useReturnNavigation();
  return <WorkspaceLoadingSkeleton path={path} onBack={goBack} />;
}

/** Stable route elements keep unrelated retained pages out of navigation renders.
 * Active context still reaches consumers for freshness and scroll restoration. */
const RetainedWorkspacePage = memo(function RetainedWorkspacePage({ saved, active, flow, direction, motion, surfaceRef }: {
  saved: ReturnType<typeof useLocation>; active: boolean; flow: boolean; direction: RouteDirection; motion?: RouteMotion | undefined; surfaceRef?: MutableRefObject<HTMLElement | null> | undefined;
}) {
  // Routes(location=...) still subscribes to the outer LocationContext. Isolate
  // that subscription too, otherwise every hidden useLocation consumer updates.
  // Keep the navigator inherited so links and back continue to use the real router.
  const routeLocation = useMemo(() => ({ location: saved, navigationType: NavigationType.Pop }), [saved]);
  const content = useMemo(() => (
      <Suspense fallback={<WorkspaceRouteFallback path={saved.pathname} />}>
        <Routes location={saved}>
          <Route path="/" element={<HomeShell><HomeWorkspace /></HomeShell>} />
          {/* 首页自己的详情：卡片开在 `/home/:id` 上，返回与再进首页都落在首页，
              不会把档案库那一页也带上这份详情。 */}
          <Route path="/home/:archiveId" element={<HomeShell><HomeWorkspace /></HomeShell>} />
          <Route path="/library/:archiveId?" element={<LibraryShell />} />
          <Route path="/history/:archiveId?" element={<ShelfShell name="history" detailBasePath="/history"><StateWorkspace name="history" detailBasePath="/history" /></ShelfShell>} />
          <Route path="/watchlist/:archiveId?" element={<ShelfShell name="watchlist" detailBasePath="/watchlist"><StateWorkspace name="watchlist" detailBasePath="/watchlist" /></ShelfShell>} />
          <Route path="/to-read/:archiveId?" element={<ShelfShell name="toRead" detailBasePath="/to-read"><StateWorkspace name="toRead" detailBasePath="/to-read" /></ShelfShell>} />
          <Route path="/library/:archiveId/edit" element={<MetadataEditRouteRoute />} />
          <Route path="/eh" element={<EhRouteWorkspace />} />
          <Route path="/downloads" element={<LocalArchivesWorkspace />} />
          <Route path="/more" element={<MorePagesRoute />} />
          <Route path="/tools/upload" element={<UploadRoute />} />
          <Route path="/tools/dedup" element={<DeduplicationWorkspace />} />
          <Route path="/dedup" element={<ActiveRedirect to="/tools/dedup" />} />
          <Route path="/settings" element={<SettingsWorkspace />} />
          <Route path="*" element={<HomeWorkspace />} />
        </Routes>
      </Suspense>
  ), [saved]);
  const transitionKey = saved.pathname === '/downloads' ? `${saved.pathname}:${new URLSearchParams(saved.search).get('path') ?? ''}` : saved.pathname;
  return <RetainedPage active={active} motionSurface flow={flow} direction={direction} motion={motion} surfaceRef={surfaceRef} transitionKey={transitionKey}>
    <UNSAFE_LocationContext.Provider value={routeLocation}>{content}</UNSAFE_LocationContext.Provider>
  </RetainedPage>;
});

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


