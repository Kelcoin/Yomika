import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { RotateCcw, ServerCrash } from 'lucide-react';

import { usePageActive } from '../app/RetainedPage';
import type { ArchiveRecord } from '../domain/library';
import { pickServer } from '../domain/server';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { EmptyState } from './EmptyState';
import { LibraryWorkspace } from './LibraryWorkspace';
import { ServerRequiredPrompt } from './ServerRequiredPrompt';
import { useArchiveSelection } from './useArchiveSelection';
import { useArchiveContextMenu } from './useArchiveContextMenu';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { UNTAGGED_FILTER_ID, assignableCategories } from '../lib/tags';
import { mirrorFavorites } from '../lib/favoritesMirror';
import { readRouteCache, writeRouteCache } from '../lib/routeCache';

/** 分类镜像一次性读取：注水只发生在挂载和换服务器时。原先这读写在
 * 组件体里无条件执行，搜索每敲一键、卡片每次悬停都要 parse 一遍。 */
function readPersistedCategories(serverParam: string | null) {
  try {
    const raw = window.localStorage.getItem(`yomika:library-categories:${serverParam ?? 'default'}`);
    const parsed = raw ? JSON.parse(raw) as import('../repositories/nativeLibraryRepository').Category[] : undefined;
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
import { isCommittableSearchQuery } from '../lib/searchQuery';
import { TextInputDialog } from './TextInputDialog';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { useToast } from './Toast';
import { useCardStyle } from '../app/preferences';

const repository = new NativeLibraryRepository();
const imageCache = getNativeImageCache();

/** The library cache is per server: two configured servers keep two lists, and
 * a snapshot restored across them would paint one server's rows under the
 * other's name for a beat. */
function librarySnapshotKey(requestedServer: string | null): string {
  return `library:workspace:${requestedServer ?? 'default'}`;
}

/** The offline mirror has no page size of its own, so it borrows one. Only the
 * fallback path uses it: online, the page size is LANraragi's to decide. */
const OFFLINE_PAGE_SIZE = 100;

/** First occurrence of each archive id, in order.
 *
 * A page can repeat a row the previous one already carried — the server
 * re-sorting between requests is enough — and two cards sharing an id share a
 * React key. */
function dedupeArchives(items: readonly ArchiveRecord[], seen = new Set<string>()): ArchiveRecord[] {
  const unique: ArchiveRecord[] = [];
  for (const item of items) {
    if (seen.has(item.archiveId)) continue;
    seen.add(item.archiveId);
    unique.push(item);
  }
  return unique;
}

interface LibrarySnapshot {
  archives: ArchiveRecord[];
  /** Rows the server had handed over when the snapshot was taken. Stored apart
   * from `archives.length`, which is what survived de-duplication: restoring the
   * cursor from the rendered length puts it behind the server again. */
  fetchedCount: number;
  categories: import('../repositories/nativeLibraryRepository').Category[];
  selectedArchiveId: string | undefined;
  totalArchives: number;
  hasMoreArchives: boolean;
  searchQuery: string;
  sortMode: 'title' | 'added';
  sortOrder: 'asc' | 'desc';
  categoryFilter: string;
}

export function LibraryRouteWorkspace({ showDetail = true }: { showDetail?: boolean } = {}) {
  const { showToast } = useToast();
  const [urlSearchParams] = useSearchParams();
  const requestedQuery = urlSearchParams.has('q') ? (urlSearchParams.get('q') ?? '').trim() : undefined;
  /** Which server the library browses: the linking `?server=` id wins over the
   * default (first configured) server. */
  const serverParam = urlSearchParams.get('server');
  // Snapshot from the last visit: switching to another route and back used to
  // start from an empty list and a closed detail pane.
  // The route cache is memory-only. Even an old page can be shown immediately
  // while the server refreshes it, provided it belongs to the active query.
  const snapshot = readRouteCache<LibrarySnapshot>(librarySnapshotKey(serverParam), Infinity);
  const cachedPage = requestedQuery === undefined || requestedQuery === snapshot?.searchQuery ? snapshot : undefined;
  const [archives, setArchives] = useState<ArchiveRecord[]>(cachedPage?.archives ?? []);
  const [loading, setLoading] = useState(!cachedPage);
  /** True while any first-page request is outstanding. Separate from `loading`,
   * which only covers the very first one so that refiltering does not unmount the
   * search field. */
  const [pageLoading, setPageLoading] = useState(!cachedPage);
  const [error, setError] = useState<string>();
  const [needsCredentials, setNeedsCredentials] = useState(false);
  const [serverId, setServerId] = useState<string>();
  /** Whether the server list has been read and came back with nothing usable:
   * `undefined` while unknown, which keeps the first-load skeletons (we do not
   * know yet), and `false` only once we do — the state that shows the shared
   * "add a server" prompt instead of skeletons that would never resolve. */
  const [hasServer, setHasServer] = useState<boolean>();
  const [scopeId, setScopeId] = useState<string>();
  const [metadata, setMetadata] = useState<import('../repositories/nativeLibraryRepository').ArchiveMetadata>();
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  /** 分类在会话之间也保持可见：路由快照过期或应用重启后，用上一次的
   * localStorage 镜像同步注水，下拉不再闪骨架——原生六小时快照随后静默
   * 校正。镜像按服务器分开（?server= 未指定时归入 default）。 */
  const persistedCategories = useMemo(() => readPersistedCategories(serverParam), [serverParam]);
  const [categories, setCategories] = useState<import('../repositories/nativeLibraryRepository').Category[]>(snapshot?.categories ?? persistedCategories ?? []);
  const [categoriesLoading, setCategoriesLoading] = useState(!(snapshot?.categories?.length || persistedCategories?.length));
  /** 只要下拉上有可显示的分类，本 effect 的每一次重跑（刷新、换服务器）都
   * 静默进行；骨架只保留给第一无所知的加载。 */
  const categoriesOnScreen = useRef(Boolean(snapshot?.categories?.length || persistedCategories?.length));
  const [categoryError, setCategoryError] = useState<string>();
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | undefined>(cachedPage?.selectedArchiveId);
  const [metadataMessage, setMetadataMessage] = useState<string>();
  const [thumbnail, setThumbnailUrl] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  // True when the list came from the local mirror because LANraragi could not be
  // reached. Worth saying out loud: the list is then as old as the last sync.
  const [offline, setOffline] = useState(false);
  const [totalArchives, setTotalArchives] = useState(cachedPage?.totalArchives ?? 0);
  const [hasMoreArchives, setHasMoreArchives] = useState(cachedPage?.hasMoreArchives ?? false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [watchlist, setWatchlist] = useState<import('../domain/library').WatchlistRecord[]>([]);
  const [readingList, setReadingList] = useState<import('../domain/library').WatchlistRecord[]>([]);
  const [presets, setPresets] = useState<import('../repositories/nativeLibraryRepository').SearchPreset[]>([]);
  const [readingHistory, setReadingHistory] = useState<import('../domain/library').ReadingHistoryRecord[]>([]);
  const pageRequest = useRef(0);
  const loadingMoreRef = useRef(false);
  /** Rows the server has handed over, which is the offset the next page asks for.
   * The rendered list can be shorter once duplicates are dropped. */
  const fetchedCount = useRef(cachedPage?.fetchedCount ?? cachedPage?.archives.length ?? 0);
  const initialArchivesLoaded = useRef(Boolean(cachedPage));
  const [searchQuery, setSearchQuery] = useState(requestedQuery ?? snapshot?.searchQuery ?? '');
  const [sortMode, setSortMode] = useState<'title' | 'added'>(snapshot?.sortMode ?? 'added');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(snapshot?.sortOrder ?? 'desc');
  const [categoryFilter, setCategoryFilter] = useState(snapshot?.categoryFilter ?? '');
  /** 屏幕上这份结果回答的是"哪一问"：查询词 + 排序 + 分类的合成键。任何一次首屏
   * 读取落地（读成留下行、读败留下错误页）都记下它，重读才有比较的对象。
   * 同一个问题的重读只换内容、不清屏——自动同步收尾、整库失效广播、从别的路由回到
   * 档案库都是这一类，用户正看着档案时不该被一个转不完的骨架打断，等新数据到了再变；
   * 换了问题（改搜索词/排序/分类）才必须清掉，因为屏幕上那些行回答的是另一个问题。 */
  const listQueryKey = `${searchQuery}|${sortMode}|${sortOrder}|${categoryFilter}`;
  const settledQueryKey = useRef(cachedPage ? listQueryKey : '');
  const [reloadToken, setReloadToken] = useState(0);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  /** Set when the dialog was opened from a preset's rename action. */
  const [presetEditTarget, setPresetEditTarget] = useState<import('../repositories/nativeLibraryRepository').SearchPreset>();
  /** Card style lives in preferences: the shelves render the same cards, and as
   * component state the choice reset on every navigation. */
  const { cardStyle, setCardStyle } = useCardStyle();
  const navigate = useNavigate();
  /** One place that knows what deleting does to everything derived from the
   * list, whether it was one card or a selection. */
  const removeArchives = useCallback((archiveIds: string[]) => {
    const dropped = new Set(archiveIds);
    setArchives((current) => current.filter((archive) => !dropped.has(archive.archiveId)));
    setTotalArchives((current) => Math.max(0, current - dropped.size));
    setCategories((current) => current.map((category) => ({ ...category, archives: category.archives.filter((id) => !dropped.has(id)) })));
    setMetadata(undefined);
  }, []);
  const { open: openContextMenu, menu: contextMenu, requestDelete } = useArchiveContextMenu({
    onDeleted: (archiveId) => removeArchives([archiveId]),
    inReadingList: (archiveId) => readingList.some((item) => item.archiveId === archiveId && !item.deleted),
    categories: assignableCategories(categories),
    onAddCategory: (archive, categoryId) => {
      if (!serverId) return;
      void repository.addArchiveToCategory(serverId, categoryId, archive.archiveId).then((result) => {
        if (!result.ok) { showToast(result.error.message, 'error'); return; }
        showToast('分类已更新', 'success');
        // Patch the list in place rather than re-reading it: only static
        // categories accept an assignment, so the new membership is known
        // exactly, and a re-read would re-resolve every dynamic category
        // through an unpaged /api/search.
        setCategories((current) => current.map((category) => category.id === categoryId && !category.archives.includes(archive.archiveId)
          ? { ...category, archives: [...category.archives, archive.archiveId] }
          : category));
      });
    },
    onToggleReadingList: (archive, next) => {
      if (!scopeId) return;
      void repository.setReadingList(scopeId, archive.archiveId, next).then((result) => {
        if (!result.ok) { showToast(result.error.message, 'error'); return; }
        setReadingList((current) => [...current.filter((item) => item.archiveId !== archive.archiveId), result.value]);
        showToast(next ? '已加入待看' : '已移出待看', 'success');
      });
    },
  });
  const selection = useArchiveSelection({
    archives,
    scopeId,
    onRemoved: removeArchives,
  });
  const detailRequest = useRef(0);
  const detailThumbnailHandle = useRef<ImageHandle>();
  const detailThumbnailAbort = useRef<AbortController>();

  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);
  useEffect(() => {
    if (deleteError) showToast(deleteError, 'error');
  }, [deleteError, showToast]);
  useEffect(() => {
    if (refreshError) showToast(refreshError, 'error');
  }, [refreshError, showToast]);
  useEffect(() => {
    if (categoryError) showToast(`读取分类失败：${categoryError}`, 'error');
  }, [categoryError, showToast]);
  useEffect(() => {
    // Fires on the transition into offline only: the state does not change again
    // while page after page keeps falling back.
    if (offline) showToast('无法连接 LANraragi，正在显示本机上次同步的档案。', 'error');
  }, [offline, showToast]);
  useEffect(() => {
    if (metadataMessage) showToast(metadataMessage, 'success');
  }, [metadataMessage, showToast]);

  const loadArchiveDetails = useCallback((currentServerId: string, currentScopeId: string, archive: ArchiveRecord) => {
    const request = ++detailRequest.current;
    setSelectedArchiveId(archive.archiveId);
    setMetadata(undefined);
    setMetadataLoading(true);

    detailThumbnailAbort.current?.abort();
    detailThumbnailAbort.current = new AbortController();
    if (detailThumbnailHandle.current) imageCache.release(detailThumbnailHandle.current);
    detailThumbnailHandle.current = undefined;
    setThumbnailUrl(undefined);
    void imageCache.load({
      scopeId: currentScopeId,
      serverId: currentServerId,
      archiveId: archive.archiveId,
      rendition: 'cover',
      pageIndex: 0,
    }, { signal: detailThumbnailAbort.current.signal }).then((handle) => {
      if (request !== detailRequest.current) {
        imageCache.release(handle);
        return;
      }
      detailThumbnailHandle.current = handle;
      setThumbnailUrl(handle.url);
    }, () => undefined);

    void repository.loadArchiveMetadata(currentServerId, archive.archiveId).then((result) => {
      if (request !== detailRequest.current) return;
      if (result.ok) setMetadata(result.value);
      setMetadataLoading(false);
    });
  }, []);

  useEffect(() => () => {
    detailRequest.current += 1;
    detailThumbnailAbort.current?.abort();
    if (detailThumbnailHandle.current) imageCache.release(detailThumbnailHandle.current);
    detailThumbnailHandle.current = undefined;
  }, []);

  const loadLibrary = useCallback(async () => {
    // 屏幕上已经有答案时（列表还在，或那张解释为什么没有列表的错误页），重读是就地的：
    // 不进骨架、也不抹掉错误页——自动同步收尾、整库失效广播、错误页上的「重试」都要
    // 走这里。骨架只留给一无所知的那一次首读。清错误则只在真有行可看时才做；屏幕上是
    // 错误页时清掉它只会露出骨架，而这一读的结果马上就回来了。
    const screenHasAnswer = settledQueryKey.current !== '';
    setLoading(!screenHasAnswer);
    if (screenHasAnswer && initialArchivesLoaded.current) setError(undefined);
    setNeedsCredentials(false);
    const servers = await repository.listServers();
    if (!servers.ok) {
      setError(servers.error.message);
      setLoading(false);
      return;
    }
    const server = pickServer(servers.value, serverParam);
    if (!server) {
      setServerId(undefined);
      setHasServer(false);
      setLoading(false);
      return;
    }
    setHasServer(true);
    setServerId(server.id);
    setScopeId(server.scopeId);
    // Categories are loaded once, by the effect below: it holds the TTL gate and
    // the native side serves a persisted snapshot. Loading them here as well
    // meant every visit to the library re-resolved every dynamic category.
    setCategoryError(undefined);
    const [watchlistResult, historyResult, readingListResult] = await Promise.all([
      repository.listWatchlist(server.scopeId),
      repository.listHistory(server.scopeId),
      repository.listReadingList(server.scopeId),
    ]);
    if (watchlistResult.ok) setWatchlist(watchlistResult.value);
    if (historyResult.ok) setReadingHistory(historyResult.value);
    if (readingListResult.ok) setReadingList(readingListResult.value);
    void repository.listSearchPresets(server.scopeId).then((result) => {
      if (result.ok) setPresets(result.value);
    });
    setLoading(false);
  }, [serverParam]);

  // One page of the list. LANraragi is the source of truth: it owns ordering,
  // filtering and paging, so an archive added on the server shows up the moment
  // the page is fetched. The local index is the offline fallback behind it —
  // asking it first is what left the list stuck on whatever the last successful
  // whole-library pull happened to store.
  const fetchArchivePage = useCallback(async (currentServerId: string, start: number) => {
    // "No tags" arrives through the category menu but is not a category: an
    // untagged archive is in no category, so it goes to LANraragi's own
    // `untaggedonly` switch instead of being resolved as one.
    const untaggedOnly = categoryFilter === UNTAGGED_FILTER_ID;
    const query = {
      query: searchQuery,
      sortBy: sortMode,
      order: sortOrder,
      categoryId: untaggedOnly ? null : categoryFilter || null,
      untaggedOnly,
    };
    const remote = await repository.searchArchivesPage(currentServerId, start, query);
    if (remote.ok) {
      setOffline(false);
      return remote;
    }
    // A missing API key is the user's to fix; falling back would hide it.
    if (remote.error.code === 'PLATFORM_UNAVAILABLE') return remote;
    const local = await repository.listArchivesPage(currentServerId, start, OFFLINE_PAGE_SIZE, query);
    if (!local.ok) return remote;
    setOffline(true);
    return local;
  }, [categoryFilter, searchQuery, sortMode, sortOrder]);

  const loadMoreArchives = useCallback(async () => {
    // Scroll events fire many times before React re-renders, so the state flag
    // alone lets several requests through with the same offset.
    if (!serverId || pageLoading || loadingMoreRef.current || !hasMoreArchives) return;
    const request = pageRequest.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      // The offset is what the server has handed over, not what survived the
      // de-duplication below. Using `archives.length` meant that one repeated row
      // — the server re-sorting between requests is enough — dropped the offset
      // behind the cursor, so the next page overlapped, deduplicated to nothing,
      // and the list stopped growing while `hasMore` kept asking for more.
      const result = await fetchArchivePage(serverId, fetchedCount.current);
      if (request !== pageRequest.current) return;
      if (result.ok) {
        fetchedCount.current += result.value.items.length;
        setArchives((current) => [
          ...current,
          ...dedupeArchives(result.value.items, new Set(current.map((item) => item.archiveId))),
        ]);
        setTotalArchives(result.value.total);
        setHasMoreArchives(result.value.hasMore);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [fetchArchivePage, hasMoreArchives, pageLoading, serverId]);

  const loadThumbnail = useCallback(async (archive: ArchiveRecord, signal?: AbortSignal) => {
    if (!serverId || !scopeId) return undefined;
    try {
      return await imageCache.load({
        scopeId,
        serverId,
        archiveId: archive.archiveId,
        rendition: 'cover',
        pageIndex: 0,
      }, signal ? { signal } : {});
    } catch {
      return undefined;
    }
  }, [scopeId, serverId]);

  const releaseThumbnail = useCallback((handle: ImageHandle) => imageCache.release(handle), []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  // 启用服务器切换以全量失效广播（prefix 为空）：档案库就地整页重读（解析到
  // 新启用的服务器、重读书架作用域与首页），列表留在屏幕上直到新数据到位。
  // 'library:' 是同一条路径的窄化版本——在详情页删掉一条档案、或元数据编辑器改了
  // 标签之后，档案库自己那份快照（服务器、书架作用域、首页）和列表都作废了。
  // 以前这里只认整库失效，于是从检索结果进的详情页删完档案回到列表，那一行还在。
  useEffect(() => {
    const handleInvalidation = (event: Event) => {
      const prefix = (event as CustomEvent<{ prefix?: string }>).detail?.prefix;
      if (!prefix || prefix === 'library:') {
        // 清错误页交给 loadLibrary：它只在真有行可看时才清。空屏上那张错误页是此刻仅有的
        // 情报，先抹掉再等一次可能同样失败的重读，只会留下一段没有解释的骨架。
        // 删除一条档案之后，屏幕上那份列表仍然是要看的那份（只是少一行），所以让首页
        // 重读落在它后面而不是把它清空重建——清空会闪一次骨架，比那行自己消失难看得多。
        // 这件事现在由 listQueryKey/settledQueryKey 统一保证：问题没变的重读一律不清屏，
        // 所以这里不必再特殊照顾 'library:'。
        void loadLibrary().then(() => setReloadToken((value) => value + 1));
      }
    };
    window.addEventListener('yomika:route-cache-invalidated', handleInvalidation);
    return () => window.removeEventListener('yomika:route-cache-invalidated', handleInvalidation);
  }, [loadLibrary]);

  useEffect(() => {
    if (requestedQuery === undefined) return;
    setSearchQuery(requestedQuery);
    setCategoryFilter('');
  }, [requestedQuery]);

  const loadFirstPage = useCallback(async (currentServerId: string, options: { clear?: boolean; silent?: boolean; background?: boolean } = {}) => {
    const request = ++pageRequest.current;
    // Keep the existing input/list mounted while a filter request is in flight.
    // Unmounting the workspace here loses focus after the first typed character.
    // 骨架只留给空屏上的那一次首读：就地重读（background）连 `loading` 都不碰，
    // 否则一张已经解释清楚的错误页会被骨架顶掉（`listLoading` 里 `loading` 一票即中）。
    if (!initialArchivesLoaded.current && !options.background) setLoading(true);
    // Any first-page request, not only the first one ever: `loading` deliberately
    // stays false for a refilter so the input keeps focus, but the list is emptied
    // all the same — which is how 暂无档案库 flashed before the archives arrived.
    // A background read is the entry refresh, and the list it is re-reading is
    // already on screen: neither the skeleton nor the list's busy state may take
    // over the page for a request nobody asked for.
    if (!options.background) setPageLoading(true);
    // 「屏幕上到底有没有一份已经成型的列表」是这次失败该走哪条路的唯一判据。空屏
    // （骨架，或者最初那次还没成功过）时不能清掉错误页：一次静默/入场刷新失败会把
    // 它抹掉，用户只剩一个转不完的骨架和一条几秒后消失的 toast，无从知道发生了什么。
    const hasListOnScreen = initialArchivesLoaded.current;
    if (!options.background || hasListOnScreen) setError(undefined);
    if (options.clear) setArchives([]);
    const result = await fetchArchivePage(currentServerId, 0);
    if (request !== pageRequest.current) return false;
    if (!result.ok) {
      // A silent load is the pull's refresh, and a background one is the entry
      // refresh: the list stays exactly as it is, and the failure is a toast
      // rather than the whole page. That trade only holds while there is a list
      // to keep — with nothing settled on screen the page has to say it itself.
      if ((options.silent || options.background) && hasListOnScreen) setRefreshError(result.error.message);
      else {
        setNeedsCredentials(result.error.code === 'PLATFORM_UNAVAILABLE');
        setError(result.error.code === 'PLATFORM_UNAVAILABLE' ? '服务器凭据不可用，请在设置中重新保存 API Key。' : result.error.message);
      }
      // 失败也在屏幕上留下了一个答案（那张错误页），从这一刻起这个问题的重读就该就地
      // 进行：否则每次自动同步收尾都会先把错误页抹成骨架，再把它写回来。
      settledQueryKey.current = listQueryKey;
      setLoading(false);
      setPageLoading(false);
      return false;
    }
    // The first page needs the same de-duplication the later ones get: a repeated
    // row rendered twice, and gave two cards the same React key.
    const unique = dedupeArchives(result.value.items);
    setArchives(unique);
    fetchedCount.current = result.value.items.length;
    initialArchivesLoaded.current = true;
    settledQueryKey.current = listQueryKey;
    // 就地重读成功时把上一轮的错误页收掉——它当初是因为屏幕上没有行才留下的。
    setError(undefined);
    setNeedsCredentials(false);
    setTotalArchives(result.value.total);
    setHasMoreArchives(result.value.hasMore);
    setLoading(false);
    setPageLoading(false);
    return true;
  }, [fetchArchivePage, listQueryKey]);

  const refreshVisiblePage = useCallback(async (currentServerId: string) => {
    // A refresh re-reads the page on screen: one LANraragi request, list in
    // place until it lands. Rebuilding the offline mirror is a whole-library
    // walk — minutes of it against a big library — and doing that inside the
    // gesture is what made the pull look hung.
    await loadFirstPage(currentServerId, { silent: true });
    // The mirror is only worth rebuilding when LANraragi actually has archives
    // it does not know yet, which one probe page answers. That happens behind
    // the gesture, so nothing on screen waits for it.
    void repository.probeNewArchives(currentServerId).then((probe) => {
      if (probe.ok && probe.value) void repository.refreshArchives(currentServerId, { sortby: 'date_added', order: 'desc' });
    });
  }, [loadFirstPage]);

  useEffect(() => {
    if (!serverId) return;
    // A matching cached page remains visible while its first page is re-read, and
    // so does whatever already answers this very question — rows, or the failure
    // that explained why there are none. Clearing is reserved for a changed query,
    // whose old rows describe a different result set.
    const sameQuery = settledQueryKey.current !== '' && settledQueryKey.current === listQueryKey;
    void loadFirstPage(serverId, sameQuery ? { background: true } : { clear: true });
  }, [listQueryKey, loadFirstPage, reloadToken, serverId]);

  // The library route is retained while another route is on screen, so leaving and
  // coming back is not a remount and the effect above never re-runs — which is why
  // an archive added since the last visit only turned up after a manual refresh.
  // Coming back is the moment to re-read the page; the loader and the server id are
  // read through refs so that a filter change cannot fire a second, duplicate read.
  const pageActive = usePageActive();
  const wasActiveRef = useRef(pageActive);
  const loadFirstPageRef = useRef(loadFirstPage);
  loadFirstPageRef.current = loadFirstPage;
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = pageActive;
    if (!pageActive || wasActive || !serverIdRef.current) return;
    void loadFirstPageRef.current(serverIdRef.current, { background: true });
    if (scopeId) void repository.listHistory(scopeId).then((result) => {
      if (result.ok) setReadingHistory(result.value);
    });
  }, [pageActive, scopeId]);

  useEffect(() => {
    if (!serverId) return;
    // Categories are only needed for the filter menu and the "add to category"
    // entries, not for filtering itself — LANraragi resolves that. The native side
    // serves a persisted snapshot for six hours, and drops it the moment an
    // assignment, a tag edit or a delete makes it wrong.
    //
    // Never forced from here. A five-minute throttle used to decide `force`, and
    // `force` skips that snapshot outright: the effective interval was therefore
    // five minutes, not six hours, and every lapse re-ran one unpaged
    // whole-library search per dynamic category. Reading a chapter takes longer
    // than five minutes, so coming back from the reader always paid it. A pull
    // does not force it either any more: it re-reads the page on screen, and the
    // six-hour snapshot is exactly what keeps that one request.
    //
    // 缓存已在屏（快照恢复或上一轮结果还在）时静默刷新：下拉保持显示，绝不
    // 因刷新回到骨架；骨架只在分类一无所知时出现。
    if (categoriesOnScreen.current) {
      void repository.listCategories(serverId).then((categoryResult) => {
        if (categoryResult.ok) {
          categoriesOnScreen.current = true;
          setCategories(categoryResult.value);
        } else setCategoryError(categoryResult.error.message);
      });
      return;
    }
    setCategoriesLoading(true);
    void repository.listCategories(serverId).then((categoryResult) => {
      if (categoryResult.ok) {
        categoriesOnScreen.current = true;
        setCategories(categoryResult.value);
      } else setCategoryError(categoryResult.error.message);
    }).finally(() => setCategoriesLoading(false));
  }, [reloadToken, serverId]);

  useEffect(() => {
    if (!serverId || !scopeId || archives.length === 0) return;
    if (!showDetail) return;
    if (selectedArchiveId && archives.some((archive) => archive.archiveId === selectedArchiveId)) return;
    const firstArchive = archives[0];
    if (firstArchive) loadArchiveDetails(serverId, scopeId, firstArchive);
  }, [archives, loadArchiveDetails, scopeId, selectedArchiveId, serverId, showDetail]);

  const readingProgressByArchiveId = useMemo(
    () => new Map(readingHistory.map((item) => [item.archiveId, item.pageIndex + 1])),
    [readingHistory],
  );

  // Keep the snapshot current so the next visit renders instantly.
  useEffect(() => {
    if (archives.length === 0) return;
    writeRouteCache(librarySnapshotKey(serverParam), {
      archives,
      fetchedCount: fetchedCount.current,
      categories,
      selectedArchiveId,
      totalArchives,
      hasMoreArchives,
      searchQuery,
      sortMode,
      sortOrder,
      categoryFilter,
    } satisfies LibrarySnapshot);
  }, [archives, categories, categoryFilter, hasMoreArchives, searchQuery, selectedArchiveId, serverParam, sortMode, sortOrder, totalArchives]);

  // The categories' own durable mirror: the route snapshot lives in memory and
  // dies with the app, while the dropdown is the one control that must not
  // flash a skeleton over data the native snapshot would answer instantly.
  useEffect(() => {
    if (categories.length === 0) return;
    try {
      window.localStorage.setItem(`yomika:library-categories:${serverParam ?? 'default'}`, JSON.stringify(categories));
    } catch {
      // Storage full or unavailable: the mirror is an optimization, never a
      // source of truth — the native snapshot re-answers in milliseconds.
    }
  }, [categories, serverParam]);

  // 读不出来的这一页只说「怎么办」，不再复读原生报错。
  //
  // 原始错误已经由上面那条 toast 说过了；这一页原先把它塞进一条整宽的红色
  // `role="alert"` 里，右边再挂一个「打开设置重新保存 API Key」——两个元素都
  // 撑在一条 flex 行上（`.form-error` 的基线是 320px），在 390px 的手机上那颗
  // 按钮直接被挤出屏幕，重试按钮还落在红条外面。现在换成各处共用的空状态：一句
  // 人话、一颗主按钮（能修就修、不能修就重试）。
  if (error) {
    const retry = (
      <button className={needsCredentials ? 'secondary-action' : 'primary-action'} type="button" onClick={() => void loadLibrary().then(() => setReloadToken((value) => value + 1))}><RotateCcw aria-hidden="true" />重试读取档案库</button>
    );
    return (
      <div>
        <h1 className="visually-hidden">档案库</h1>
        <EmptyState
          icon={ServerCrash}
          title="档案库没有读出来"
          description={needsCredentials
            ? '本机读不到这台服务器的凭据，档案库连不上。到设置里重新保存一次 API Key，再回来看这一页。'
            : '这次没能连上服务器。稍后再试；一直不行就到设置里检查服务器地址与凭据。'}
          action={needsCredentials
            ? <div className="empty-state-actions"><Link className="primary-action" to="/settings">打开设置重新保存 API Key</Link>{retry}</div>
            : retry}
        />
      </div>
    );
  }

  // 读完服务器列表、确认没有可用服务器时，一次都不拉取，直接给各页共用的引导。
  // 之前 listLoading 只判断「首屏还没到」，于是没配服务器时骨架屏会一直转下去。
  if (hasServer === false) {
    return (
      <div>
        <h1 className="visually-hidden">档案库</h1>
        <ServerRequiredPrompt />
      </div>
    );
  }

  return (
    <>
      <LibraryWorkspace
        showDetail={showDetail}
        archives={archives}
        metadata={metadata}
        metadataLoading={metadataLoading}
        thumbnail={thumbnail}
        refreshing={refreshing}
        onRefresh={() => {
          if (!serverId) return;
          setRefreshError(undefined);
          setRefreshing(true);
          void refreshVisiblePage(serverId).catch((cause: unknown) => {
            setRefreshError(cause instanceof Error ? cause.message : '刷新档案库失败');
          }).finally(() => setRefreshing(false));
        }}
        categories={categories}
        categoriesLoading={categoriesLoading}
        totalCount={totalArchives}
        hasMore={hasMoreArchives}
        loadingMore={loadingMore}
        listLoading={loading || pageLoading || (archives.length === 0 && !error && !initialArchivesLoaded.current)}
        onLoadMore={loadMoreArchives}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        sortMode={sortMode}
        onSortModeChange={setSortMode}
        sortOrder={sortOrder}
        onSortOrderChange={setSortOrder}
        categoryFilter={categoryFilter}
        onCategoryFilterChange={setCategoryFilter}
        readingProgressByArchiveId={readingProgressByArchiveId}
        isFavorite={!!watchlist.find((item) => item.archiveId === selectedArchiveId && !item.deleted)}
        onToggleFavorite={async () => {
          if (!serverId || !selectedArchiveId) return;
          if (!scopeId) return;
          const next = !watchlist.some((item) => item.archiveId === selectedArchiveId && !item.deleted);
          const result = await repository.setWatchlist(scopeId, selectedArchiveId, next);
          if (result.ok) setWatchlist((current) => [...current.filter((item) => item.archiveId !== selectedArchiveId), result.value]);
          // 收藏夹 shelf reads the LANraragi 🔖 Favorites category, so the heart
          // mirrors the write there too — best effort, the local row is kept for
          // the offline mirror and WebDAV sync either way.
          const mirrored = await mirrorFavorites(serverId, [selectedArchiveId], next);
          if (mirrored > 0) showToast('未能同步到服务器收藏夹', 'error');
        }}
        onLoadThumbnail={loadThumbnail}
        onReleaseThumbnail={releaseThumbnail}
        onUpdateMetadata={async (input) => {
          if (!serverId || !selectedArchiveId) return { ok: false, error: { message: '档案未选择' } };
          const result = await repository.updateArchiveMetadata(serverId, selectedArchiveId, input);
          if (!result.ok) return result;
          const refreshed = await repository.loadArchiveMetadata(serverId, selectedArchiveId);
          if (refreshed.ok) setMetadata(refreshed.value);
          setMetadataMessage('元数据已更新');
          return result;
        }}
        onDelete={async (archive) => {
        requestDelete(archive);
        return { ok: true };
      }}
      onSelect={(archive) => {
        if (!serverId || !scopeId) return;
        loadArchiveDetails(serverId, scopeId, archive);
        }}
      onArchiveContextMenu={openContextMenu}
      cardStyle={cardStyle}
      onCardStyleChange={setCardStyle}
      presets={presets}
      onApplyPreset={(preset) => {
        // A preset restores the whole toolbar state, not just the query text.
        setSearchQuery(preset.query);
        setSortMode(preset.sortBy);
        setSortOrder(preset.sortOrder);
        setCategoryFilter(preset.categoryId ?? '');
      }}
      onSavePreset={() => { setPresetEditTarget(undefined); setPresetDialogOpen(true); }}
      onEditPreset={(preset) => { setPresetEditTarget(preset); setPresetDialogOpen(true); }}
      onDeletePreset={(preset) => {
        if (!scopeId) return;
        void repository.deleteSearchPreset(scopeId, preset.presetId).then((result) => {
          if (!result.ok) { showToast(result.error.message, 'error'); return; }
          setPresets((current) => current.filter((item) => item.presetId !== preset.presetId));
        });
      }}
      {...selection.props}
      selectionActions={selection.actions}
      />
      {contextMenu}
      {selection.dialogs}
      {/* Drawn, not `window.prompt`: the native one is unstyled, unpositioned and
          on Windows renders as browser chrome, and it cannot refuse a value. A
          preset with no complete tag is not saveable. */}
      <TextInputDialog
        open={presetDialogOpen}
        onOpenChange={setPresetDialogOpen}
        title={presetEditTarget ? '重命名预设' : '存为预设'}
        description={presetEditTarget ? '只改名字，搜索与排序条件保持不变。' : '预设会记住当前的搜索、排序与分类。'}
        label="预设名称"
        confirmLabel={presetEditTarget ? '保存名称' : '保存预设'}
        defaultValue={presetEditTarget ? presetEditTarget.name : (searchQuery || '全部档案')}
        validate={(value) => {
          if (!value.trim()) return '请填写预设名称';
          if (searchQuery.trim() && !isCommittableSearchQuery(searchQuery)) return '搜索框里的标签还不完整，补完后再存为预设';
          return undefined;
        }}
        onConfirm={(name) => {
          if (!scopeId) return;
          void repository.saveSearchPreset({
            scopeId,
            presetId: presetEditTarget?.presetId ?? `preset-${Date.now()}`,
            name,
            query: presetEditTarget?.query ?? searchQuery,
            sortBy: presetEditTarget?.sortBy ?? sortMode,
            sortOrder: presetEditTarget?.sortOrder ?? sortOrder,
            categoryId: presetEditTarget ? (presetEditTarget.categoryId ?? null) : (categoryFilter || null),
          }).then((result) => {
            if (!result.ok) { showToast(result.error.message, 'error'); return; }
            setPresets((current) => [...current.filter((item) => item.presetId !== result.value.presetId), result.value]);
            showToast(presetEditTarget ? '预设已重命名' : '预设已保存', 'success');
            setPresetEditTarget(undefined);
          });
        }}
      />
    </>
  );
}
