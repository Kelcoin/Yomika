import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { ArchiveRecord } from '../domain/library';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { LibraryWorkspace } from './LibraryWorkspace';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { markLibrarySynced, shouldSyncLibrary } from '../lib/librarySync';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { useToast } from './Toast';

const repository = new NativeLibraryRepository();
const imageCache = getNativeImageCache();

export function LibraryRouteWorkspace({ showDetail = true }: { showDetail?: boolean } = {}) {
  const { showToast } = useToast();
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [needsCredentials, setNeedsCredentials] = useState(false);
  const [serverId, setServerId] = useState<string>();
  const [scopeId, setScopeId] = useState<string>();
  const [metadata, setMetadata] = useState<import('../repositories/nativeLibraryRepository').ArchiveMetadata>();
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [categories, setCategories] = useState<import('../repositories/nativeLibraryRepository').Category[]>([]);
  const [categoryError, setCategoryError] = useState<string>();
  const [categoryMessage, setCategoryMessage] = useState<string>();
  const [selectedArchiveId, setSelectedArchiveId] = useState<string>();
  const [metadataMessage, setMetadataMessage] = useState<string>();
  const [thumbnail, setThumbnailUrl] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [totalArchives, setTotalArchives] = useState(0);
  const [hasMoreArchives, setHasMoreArchives] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [watchlist, setWatchlist] = useState<import('../domain/library').WatchlistRecord[]>([]);
  const [readingHistory, setReadingHistory] = useState<import('../domain/library').ReadingHistoryRecord[]>([]);
  const pageRequest = useRef(0);
  const loadingMoreRef = useRef(false);
  const initialArchivesLoaded = useRef(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<'title' | 'added'>('added');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
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
    // Category discovery may fan out into dynamic searches. Load it in the
    // background so the archive list can render immediately.
    setCategoryError(undefined);
    void repository.listCategories(server.id).then((categoryResult) => {
      if (categoryResult.ok) setCategories(categoryResult.value);
      else setCategoryError(categoryResult.error.message);
    });
    const [watchlistResult, historyResult] = await Promise.all([
      repository.listWatchlist(server.scopeId),
      repository.listHistory(server.scopeId),
    ]);
    if (watchlistResult.ok) setWatchlist(watchlistResult.value);
    if (historyResult.ok) setReadingHistory(historyResult.value);
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

  useEffect(() => {
    if (!serverId) return;
    const request = ++pageRequest.current;
    // Keep the existing input/list mounted while a filter request is in flight.
    // Unmounting the workspace here loses focus after the first typed character.
    if (!initialArchivesLoaded.current) setLoading(true);
    setError(undefined);
    setArchives([]);
    void repository.listArchivesPage(serverId, 0, 100, { query: searchQuery, sortBy: sortMode, order: sortOrder, categoryId: categoryFilter || null }).then((result) => {
      if (request !== pageRequest.current) return;
      if (!result.ok) {
        setNeedsCredentials(result.error.code === 'PLATFORM_UNAVAILABLE');
        setError(result.error.code === 'PLATFORM_UNAVAILABLE' ? '服务器凭据不可用，请在设置中重新保存 API Key。' : result.error.message);
      } else {
        setArchives(result.value.items);
        initialArchivesLoaded.current = true;
        setTotalArchives(result.value.total);
        setHasMoreArchives(result.value.hasMore);
        // The list above came from the local index. Pull the remote index once
        // per TTL so archives added in LANraragi since the last sync show up
        // without the user pressing refresh.
        if (shouldSyncLibrary(serverId)) {
          markLibrarySynced(serverId);
          void repository.refreshArchives(serverId, { sortby: 'date_added', order: 'desc' }).then((synced) => {
            if (!synced.ok || request !== pageRequest.current) return;
            if (!searchQuery.trim() && sortMode === 'added' && sortOrder === 'desc' && !categoryFilter) {
              setArchives(synced.value.slice(0, 100));
              setTotalArchives(synced.value.length);
              setHasMoreArchives(synced.value.length > 100);
            } else {
              setReloadToken((value) => value + 1);
            }
          });
        }
        // Dynamic LANraragi categories expose a search expression instead of
        // archive IDs; refresh the category cache after the archive index exists
        // so those IDs can be materialized into local membership rows.
        void repository.listCategories(serverId).then((categoryResult) => {
          if (categoryResult.ok) setCategories(categoryResult.value);
          else setCategoryError(categoryResult.error.message);
        });
      }
      setLoading(false);
    });
  }, [categoryFilter, reloadToken, searchQuery, sortMode, sortOrder, serverId]);

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
          void repository.refreshArchives(serverId, { sortby: 'date_added', order: 'desc' }).then(async (result) => {
            if (result.ok) {
              markLibrarySynced(serverId);
              if (!searchQuery.trim() && sortMode === 'added' && sortOrder === 'desc' && !categoryFilter) {
                setArchives(result.value.slice(0, 100));
                setTotalArchives(result.value.length);
                setHasMoreArchives(result.value.length > 100);
              } else {
                const page = await repository.listArchivesPage(serverId, 0, 100, {
                  query: searchQuery,
                  sortBy: sortMode,
                  order: sortOrder,
                  categoryId: categoryFilter || null,
                });
                if (!page.ok) { setRefreshError(page.error.message); return; }
                setArchives(page.value.items);
                setTotalArchives(page.value.total);
                setHasMoreArchives(page.value.hasMore);
              }
            } else {
              setRefreshError(result.error.message);
            }
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
      />
    </>
  );
}
