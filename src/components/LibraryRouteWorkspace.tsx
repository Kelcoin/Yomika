import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { ArchiveRecord } from '../domain/library';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { LibraryWorkspace } from './LibraryWorkspace';
import { ArchiveContextMenu, type ArchiveContextMenuTarget } from './ArchiveContextMenu';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { markCategoriesRefreshed, markLibrarySynced, shouldRefreshCategories, shouldSyncLibrary } from '../lib/librarySync';
import { readRouteCache, writeRouteCache } from '../lib/routeCache';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { useToast } from './Toast';

const repository = new NativeLibraryRepository();
const imageCache = getNativeImageCache();

const LIBRARY_SNAPSHOT_KEY = 'library:workspace';

interface LibrarySnapshot {
  archives: ArchiveRecord[];
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
  // Snapshot from the last visit: switching to another route and back used to
  // start from an empty list and a closed detail pane.
  const snapshot = readRouteCache<LibrarySnapshot>(LIBRARY_SNAPSHOT_KEY);
  const [archives, setArchives] = useState<ArchiveRecord[]>(snapshot?.archives ?? []);
  const [loading, setLoading] = useState(!snapshot);
  const [error, setError] = useState<string>();
  const [needsCredentials, setNeedsCredentials] = useState(false);
  const [serverId, setServerId] = useState<string>();
  const [scopeId, setScopeId] = useState<string>();
  const [metadata, setMetadata] = useState<import('../repositories/nativeLibraryRepository').ArchiveMetadata>();
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [categories, setCategories] = useState<import('../repositories/nativeLibraryRepository').Category[]>(snapshot?.categories ?? []);
  const [categoryError, setCategoryError] = useState<string>();
  const [categoryMessage, setCategoryMessage] = useState<string>();
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | undefined>(snapshot?.selectedArchiveId);
  const [metadataMessage, setMetadataMessage] = useState<string>();
  const [thumbnail, setThumbnailUrl] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [totalArchives, setTotalArchives] = useState(snapshot?.totalArchives ?? 0);
  const [hasMoreArchives, setHasMoreArchives] = useState(snapshot?.hasMoreArchives ?? false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [watchlist, setWatchlist] = useState<import('../domain/library').WatchlistRecord[]>([]);
  const [readingList, setReadingList] = useState<import('../domain/library').WatchlistRecord[]>([]);
  const [readingHistory, setReadingHistory] = useState<import('../domain/library').ReadingHistoryRecord[]>([]);
  const pageRequest = useRef(0);
  const loadingMoreRef = useRef(false);
  const initialArchivesLoaded = useRef(Boolean(snapshot));
  const [searchQuery, setSearchQuery] = useState(snapshot?.searchQuery ?? '');
  const [sortMode, setSortMode] = useState<'title' | 'added'>(snapshot?.sortMode ?? 'added');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(snapshot?.sortOrder ?? 'desc');
  const [categoryFilter, setCategoryFilter] = useState(snapshot?.categoryFilter ?? '');
  const [reloadToken, setReloadToken] = useState(0);
  const [contextTarget, setContextTarget] = useState<ArchiveContextMenuTarget>();
  const navigate = useNavigate();
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
    if (categoryMessage) showToast(categoryMessage, 'success');
  }, [categoryMessage, showToast]);
  useEffect(() => {
    if (categoryError) showToast(`读取分类失败：${categoryError}`, 'error');
  }, [categoryError, showToast]);
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
    setLoading(true);
    setError(undefined);
    setNeedsCredentials(false);
    const servers = await repository.listServers();
    if (!servers.ok) {
      setError(servers.error.message);
      setLoading(false);
      return;
    }
    const server = servers.value[0];
    if (!server) {
      setServerId(undefined);
      setLoading(false);
      return;
    }
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
    setLoading(false);
  }, []);

  const loadMoreArchives = useCallback(async () => {
    // Scroll events fire many times before React re-renders, so the state flag
    // alone lets several requests through with the same offset.
    if (!serverId || loadingMoreRef.current || !hasMoreArchives) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await repository.listArchivesPage(serverId, archives.length, 100, { query: searchQuery, sortBy: sortMode, order: sortOrder, categoryId: categoryFilter || null });
      if (result.ok) {
        setArchives((current) => {
          const seen = new Set(current.map((item) => item.archiveId));
          return [...current, ...result.value.items.filter((item) => !seen.has(item.archiveId))];
        });
        setTotalArchives(result.value.total);
        setHasMoreArchives(result.value.hasMore);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [archives.length, categoryFilter, hasMoreArchives, searchQuery, sortMode, sortOrder, serverId]);

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

  const loadFirstPage = useCallback(async (currentServerId: string, options: { clear?: boolean } = {}) => {
    const request = ++pageRequest.current;
    // Keep the existing input/list mounted while a filter request is in flight.
    // Unmounting the workspace here loses focus after the first typed character.
    if (!initialArchivesLoaded.current) setLoading(true);
    setError(undefined);
    if (options.clear) setArchives([]);
    const result = await repository.listArchivesPage(currentServerId, 0, 100, { query: searchQuery, sortBy: sortMode, order: sortOrder, categoryId: categoryFilter || null });
    if (request !== pageRequest.current) return false;
    if (!result.ok) {
      setNeedsCredentials(result.error.code === 'PLATFORM_UNAVAILABLE');
      setError(result.error.code === 'PLATFORM_UNAVAILABLE' ? '服务器凭据不可用，请在设置中重新保存 API Key。' : result.error.message);
      setLoading(false);
      return false;
    }
    setArchives(result.value.items);
    initialArchivesLoaded.current = true;
    setTotalArchives(result.value.total);
    setHasMoreArchives(result.value.hasMore);
    setLoading(false);
    return true;
  }, [categoryFilter, searchQuery, sortMode, sortOrder]);

  const syncRemoteIndex = useCallback(async (currentServerId: string) => {
    // The list is served from the local index, so a remote pull is the only way
    // archives added in LANraragi become visible. Re-read page one afterwards
    // instead of slicing the returned array: ordering and paging belong to the
    // query, and the array is the whole library.
    const synced = await repository.refreshArchives(currentServerId, { sortby: 'date_added', order: 'desc' });
    if (!synced.ok) return synced;
    markLibrarySynced(currentServerId);
    // An explicit refresh is also the moment to re-resolve dynamic categories.
    markCategoriesRefreshed(currentServerId);
    void repository.listCategories(currentServerId, true).then((categoryResult) => {
      if (categoryResult.ok) setCategories(categoryResult.value);
      else setCategoryError(categoryResult.error.message);
    });
    await loadFirstPage(currentServerId);
    return synced;
  }, [loadFirstPage]);

  useEffect(() => {
    if (!serverId) return;
    void loadFirstPage(serverId, { clear: true }).then((loaded) => {
      if (!loaded) return;
      if (shouldSyncLibrary(serverId)) {
        markLibrarySynced(serverId);
        void syncRemoteIndex(serverId);
      } else {
        // The sync TTL alone means an archive added in LANraragi stays invisible
        // for minutes. Probing the newest page costs one paged search, so ask
        // whether a full pull is actually warranted.
        void repository.probeNewArchives(serverId).then((probe) => {
          if (!probe.ok || !probe.value) return;
          markLibrarySynced(serverId);
          void syncRemoteIndex(serverId);
        });
      }
      // Dynamic LANraragi categories expose a search expression instead of
      // archive IDs, and resolving each one is an unpaged /api/search. Read the
      // native snapshot on every mount (local, no HTTP) and only pay for a real
      // re-resolution when the TTL says the snapshot is due.
      const wantsFreshCategories = shouldRefreshCategories(serverId);
      if (wantsFreshCategories) markCategoriesRefreshed(serverId);
      void repository.listCategories(serverId, wantsFreshCategories).then((categoryResult) => {
        if (categoryResult.ok) setCategories(categoryResult.value);
        else setCategoryError(categoryResult.error.message);
      });
    });
  }, [loadFirstPage, reloadToken, serverId, syncRemoteIndex]);

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
    writeRouteCache(LIBRARY_SNAPSHOT_KEY, {
      archives,
      categories,
      selectedArchiveId,
      totalArchives,
      hasMoreArchives,
      searchQuery,
      sortMode,
      sortOrder,
      categoryFilter,
    } satisfies LibrarySnapshot);
  }, [archives, categories, categoryFilter, hasMoreArchives, searchQuery, selectedArchiveId, sortMode, sortOrder, totalArchives]);

  if (loading) {
    return (
      <div>
        <header className="workspace-heading"><h1>档案库</h1></header>
        <p className="server-list-message" role="status">正在读取档案…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <header className="workspace-heading"><h1>档案库</h1></header>
        <div className="workspace-alert" role="alert">
          <p className="form-error">{error}</p>
          {needsCredentials && <Link className="secondary-action" to="/settings">打开设置重新保存 API Key</Link>}
        </div>
            <button className="secondary-action" type="button" onClick={() => void loadLibrary().then(() => setReloadToken((value) => value + 1))}>重试读取档案库</button>
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
          void syncRemoteIndex(serverId).then((result) => {
            if (!result.ok) setRefreshError(result.error.message);
          }).catch((cause: unknown) => {
            setRefreshError(cause instanceof Error ? cause.message : '刷新档案库失败');
          }).finally(() => setRefreshing(false));
        }}
        categories={categories}
        totalCount={totalArchives}
        hasMore={hasMoreArchives}
        loadingMore={loadingMore}
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
          const result = await repository.setWatchlist(
            scopeId, selectedArchiveId,
            !watchlist.some((item) => item.archiveId === selectedArchiveId && !item.deleted),
          );
          if (result.ok) setWatchlist((current) => [...current.filter((item) => item.archiveId !== selectedArchiveId), result.value]);
        }}
        onLoadThumbnail={loadThumbnail}
        onReleaseThumbnail={releaseThumbnail}
        onAddCategory={(categoryId) => {
          const selectedArchive = archives.find((archive) => archive.archiveId === selectedArchiveId) ?? archives[0];
          if (!serverId || !selectedArchive) return;
          void repository.addArchiveToCategory(serverId, categoryId, selectedArchive.archiveId).then((result) => {
            if (result.ok) setCategoryMessage('分类已更新');
            else setDeleteError(result.error.message);
          });
        }}
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
        if (!serverId) return { ok: false, error: { message: '服务器未就绪' } };
        const result = await repository.deleteArchive(serverId, archive.archiveId);
        if (!result.ok) {
          setDeleteError(result.error.message);
          return result;
        }
        setArchives((current) => current.filter((item) => item.archiveId !== archive.archiveId));
        setMetadata(undefined);
        return result;
      }}
      onSelect={(archive) => {
        if (!serverId || !scopeId) return;
        loadArchiveDetails(serverId, scopeId, archive);
        }}
      onArchiveContextMenu={(archive, at) => setContextTarget({ archive, ...at })}
      />
      <ArchiveContextMenu
        target={contextTarget}
        onClose={() => setContextTarget(undefined)}
        onRead={(archive) => navigate(`/reader/${encodeURIComponent(archive.archiveId)}`)}
        onReadIncognito={(archive) => navigate(`/reader/${encodeURIComponent(archive.archiveId)}?incognito=1`)}
        onEditMetadata={(archive) => navigate(`/library/${encodeURIComponent(archive.archiveId)}/edit`)}
        onCopyId={(archive) => {
          void navigator.clipboard?.writeText(archive.archiveId).then(
            () => showToast('档案 ID 已复制', 'success'),
            () => showToast('复制失败', 'error'),
          );
        }}
        inReadingList={contextTarget ? readingList.some((item) => item.archiveId === contextTarget.archive.archiveId && !item.deleted) : false}
        onToggleReadingList={(archive, next) => {
          if (!scopeId) return;
          void repository.setReadingList(scopeId, archive.archiveId, next).then((result) => {
            if (!result.ok) { showToast(result.error.message, 'error'); return; }
            setReadingList((current) => [...current.filter((item) => item.archiveId !== archive.archiveId), result.value]);
            showToast(next ? '已加入待看' : '已移出待看', 'success');
          });
        }}
      />
    </>
  );
}
