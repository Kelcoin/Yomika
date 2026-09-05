import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { ArchiveRecord } from '../domain/library';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { LibraryWorkspace } from './LibraryWorkspace';
import { LoadingIndicator } from './LoadingIndicator';
import { useArchiveContextMenu } from './useArchiveContextMenu';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { markCategoriesRefreshed, shouldRefreshCategories } from '../lib/librarySync';
import { assignableCategories } from '../lib/tags';
import { readRouteCache, routeCacheAge, writeRouteCache } from '../lib/routeCache';
import { isCommittableSearchQuery } from '../lib/searchQuery';
import { TextInputDialog } from './TextInputDialog';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { useToast } from './Toast';

const repository = new NativeLibraryRepository();
const imageCache = getNativeImageCache();

const LIBRARY_SNAPSHOT_KEY = 'library:workspace';

/** How long a restored list is trusted without a re-fetch. Long enough that
 * switching to settings and back is free; short enough that an archive added on
 * the server shows up on the next visit rather than the next hour. */
const LIBRARY_SNAPSHOT_FRESH_MS = 90_000;

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
  const [categoriesLoading, setCategoriesLoading] = useState(!snapshot?.categories?.length);
  const [categoryError, setCategoryError] = useState<string>();
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | undefined>(snapshot?.selectedArchiveId);
  const [metadataMessage, setMetadataMessage] = useState<string>();
  const [thumbnail, setThumbnailUrl] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  // True when the list came from the local mirror because LANraragi could not be
  // reached. Worth saying out loud: the list is then as old as the last sync.
  const [offline, setOffline] = useState(false);
  const [totalArchives, setTotalArchives] = useState(snapshot?.totalArchives ?? 0);
  const [hasMoreArchives, setHasMoreArchives] = useState(snapshot?.hasMoreArchives ?? false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [watchlist, setWatchlist] = useState<import('../domain/library').WatchlistRecord[]>([]);
  const [readingList, setReadingList] = useState<import('../domain/library').WatchlistRecord[]>([]);
  const [presets, setPresets] = useState<import('../repositories/nativeLibraryRepository').SearchPreset[]>([]);
  const [readingHistory, setReadingHistory] = useState<import('../domain/library').ReadingHistoryRecord[]>([]);
  const pageRequest = useRef(0);
  const loadingMoreRef = useRef(false);
  /** Rows the server has handed over, which is the offset the next page asks for.
   * The rendered list can be shorter once duplicates are dropped. */
  const fetchedCount = useRef(snapshot?.fetchedCount ?? snapshot?.archives.length ?? 0);
  const initialArchivesLoaded = useRef(Boolean(snapshot));
  const snapshotIsFresh = useRef(
    Boolean(snapshot?.archives.length) && (routeCacheAge(LIBRARY_SNAPSHOT_KEY) ?? Infinity) < LIBRARY_SNAPSHOT_FRESH_MS,
  );
  const [searchQuery, setSearchQuery] = useState(snapshot?.searchQuery ?? '');
  const [sortMode, setSortMode] = useState<'title' | 'added'>(snapshot?.sortMode ?? 'added');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(snapshot?.sortOrder ?? 'desc');
  const [categoryFilter, setCategoryFilter] = useState(snapshot?.categoryFilter ?? '');
  const [reloadToken, setReloadToken] = useState(0);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const navigate = useNavigate();
  const { open: openContextMenu, menu: contextMenu } = useArchiveContextMenu({
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
    void repository.listSearchPresets(server.scopeId).then((result) => {
      if (result.ok) setPresets(result.value);
    });
    setLoading(false);
  }, []);

  // One page of the list. LANraragi is the source of truth: it owns ordering,
  // filtering and paging, so an archive added on the server shows up the moment
  // the page is fetched. The local index is the offline fallback behind it —
  // asking it first is what left the list stuck on whatever the last successful
  // whole-library pull happened to store.
  const fetchArchivePage = useCallback(async (currentServerId: string, start: number) => {
    const query = { query: searchQuery, sortBy: sortMode, order: sortOrder, categoryId: categoryFilter || null };
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
    if (!serverId || loadingMoreRef.current || !hasMoreArchives) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      // The offset is what the server has handed over, not what survived the
      // de-duplication below. Using `archives.length` meant that one repeated row
      // — the server re-sorting between requests is enough — dropped the offset
      // behind the cursor, so the next page overlapped, deduplicated to nothing,
      // and the list stopped growing while `hasMore` kept asking for more.
      const result = await fetchArchivePage(serverId, fetchedCount.current);
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
  }, [fetchArchivePage, hasMoreArchives, serverId]);

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
    const result = await fetchArchivePage(currentServerId, 0);
    if (request !== pageRequest.current) return false;
    if (!result.ok) {
      setNeedsCredentials(result.error.code === 'PLATFORM_UNAVAILABLE');
      setError(result.error.code === 'PLATFORM_UNAVAILABLE' ? '服务器凭据不可用，请在设置中重新保存 API Key。' : result.error.message);
      setLoading(false);
      return false;
    }
    // The first page needs the same de-duplication the later ones get: a repeated
    // row rendered twice, and gave two cards the same React key.
    const unique = dedupeArchives(result.value.items);
    setArchives(unique);
    fetchedCount.current = result.value.items.length;
    initialArchivesLoaded.current = true;
    setTotalArchives(result.value.total);
    setHasMoreArchives(result.value.hasMore);
    setLoading(false);
    return true;
  }, [fetchArchivePage]);

  const syncRemoteIndex = useCallback(async (currentServerId: string) => {
    // Rebuilds the offline mirror. The list itself no longer waits on this — it
    // reads LANraragi directly — so this is the user asking for the local copy to
    // be brought up to date, plus a re-resolution of the dynamic categories.
    const synced = await repository.refreshArchives(currentServerId, { sortby: 'date_added', order: 'desc' });
    if (!synced.ok) return synced;
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
    // Re-runs whenever the query, sort or category changes, because all three are
    // resolved by the server now. A list restored from a fresh snapshot skips the
    // first run: the page it would fetch is the page already on screen, and it is
    // an HTTP round trip rather than the local query it used to be.
    if (snapshotIsFresh.current) {
      snapshotIsFresh.current = false;
      return;
    }
    void loadFirstPage(serverId, { clear: true });
  }, [loadFirstPage, reloadToken, serverId]);

  useEffect(() => {
    if (!serverId) return;
    // Categories are only needed for the filter menu and the "add to category"
    // entries, not for filtering itself — LANraragi resolves that. The native
    // side serves a persisted snapshot, so a mount costs no HTTP; only a lapsed
    // TTL pays to re-resolve the dynamic ones.
    const wantsFreshCategories = shouldRefreshCategories(serverId);
    if (wantsFreshCategories) markCategoriesRefreshed(serverId);
    setCategoriesLoading(true);
    void repository.listCategories(serverId, wantsFreshCategories).then((categoryResult) => {
      if (categoryResult.ok) setCategories(categoryResult.value);
      else setCategoryError(categoryResult.error.message);
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
    writeRouteCache(LIBRARY_SNAPSHOT_KEY, {
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
  }, [archives, categories, categoryFilter, hasMoreArchives, searchQuery, selectedArchiveId, sortMode, sortOrder, totalArchives]);

  if (loading) {
    return (
      <div>
        <header className="workspace-heading"><h1>档案库</h1></header>
        <LoadingIndicator label="正在读取档案" size="lg" />
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
        categoriesLoading={categoriesLoading}
        totalCount={totalArchives}
        hasMore={hasMoreArchives}
        loadingMore={loadingMore}
        listLoading={loading || (archives.length === 0 && !error && !initialArchivesLoaded.current)}
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
        // A static category was still listing it.
        setCategories((current) => current.map((category) => category.archives.includes(archive.archiveId)
          ? { ...category, archives: category.archives.filter((id) => id !== archive.archiveId) }
          : category));
        setMetadata(undefined);
        return result;
      }}
      onSelect={(archive) => {
        if (!serverId || !scopeId) return;
        loadArchiveDetails(serverId, scopeId, archive);
        }}
      onArchiveContextMenu={openContextMenu}
      presets={presets}
      onApplyPreset={(preset) => {
        // A preset restores the whole toolbar state, not just the query text.
        setSearchQuery(preset.query);
        setSortMode(preset.sortBy);
        setSortOrder(preset.sortOrder);
        setCategoryFilter(preset.categoryId ?? '');
      }}
      onSavePreset={() => setPresetDialogOpen(true)}
      onDeletePreset={(preset) => {
        if (!scopeId) return;
        void repository.deleteSearchPreset(scopeId, preset.presetId).then((result) => {
          if (!result.ok) { showToast(result.error.message, 'error'); return; }
          setPresets((current) => current.filter((item) => item.presetId !== preset.presetId));
        });
      }}
      />
      {contextMenu}
      {/* Drawn, not `window.prompt`: the native one is unstyled, unpositioned and
          on Windows renders as browser chrome, and it cannot refuse a value. A
          preset with no complete tag is not saveable. */}
      <TextInputDialog
        open={presetDialogOpen}
        onOpenChange={setPresetDialogOpen}
        title="存为预设"
        description="预设会记住当前的搜索、排序与分类。"
        label="预设名称"
        confirmLabel="保存预设"
        defaultValue={searchQuery || '全部档案'}
        validate={(value) => {
          if (!value.trim()) return '请填写预设名称';
          if (searchQuery.trim() && !isCommittableSearchQuery(searchQuery)) return '搜索框里的标签还不完整，补完后再存为预设';
          return undefined;
        }}
        onConfirm={(name) => {
          if (!scopeId) return;
          void repository.saveSearchPreset({
            scopeId,
            presetId: `preset-${Date.now()}`,
            name,
            query: searchQuery,
            sortBy: sortMode,
            sortOrder,
            categoryId: categoryFilter || null,
          }).then((result) => {
            if (!result.ok) { showToast(result.error.message, 'error'); return; }
            setPresets((current) => [...current.filter((item) => item.presetId !== result.value.presetId), result.value]);
            showToast('预设已保存', 'success');
          });
        }}
      />
    </>
  );
}
