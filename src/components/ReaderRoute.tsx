import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, RotateCcw } from 'lucide-react';

import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { ReaderScreen } from './ReaderScreen';
import { getPrefetchPages } from '../domain/reader';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { useToast } from './Toast';
import { usePreferences } from '../app/preferences';
import type { ImageHandle } from '../lib/unifiedImageCache';

const repository = new NativeLibraryRepository();
const imageCache = getNativeImageCache();

interface ReaderContext {
  generation: number;
  serverId: string;
  scopeId: string;
  archiveId: string;
  paths: string[];
}

export function ReaderRoute({ archiveId }: { archiveId: string }) {
  const [searchParams] = useSearchParams();
  const { showToast } = useToast();
  const { preferences } = usePreferences();
  const prefetchDistance = preferences.prefetchPages;
  const upscaleEnabled = preferences.upscaleBackend !== 'off';
  const requestedPage = Math.max(0, Number(searchParams.get('page') ?? '0') || 0);
  const [scopeId, setScopeId] = useState<string>();
  const [initialPage, setInitialPage] = useState(0);
  const [title, setTitle] = useState('阅读器');
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);
  /** Cover, tags and byte size for the overview panel. Fetched once alongside
   * the manifest; the panel is the only consumer. */
  const [info, setInfo] = useState<{ cover?: string | undefined; tags?: string[] | undefined; sizeBytes?: number | undefined }>();
  const coverHandleRef = useRef<ImageHandle>();
  const contextRef = useRef<ReaderContext>();
  const pageHandlesRef = useRef(new Map<number, ImageHandle>());
  const thumbnailHandlesRef = useRef(new Map<number, ImageHandle>());
  const pendingPagesRef = useRef(new Map<number, Promise<string | undefined>>());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const releasePage = useCallback((pageIndex: number) => {
    const handle = pageHandlesRef.current.get(pageIndex);
    if (!handle) return;
    pageHandlesRef.current.delete(pageIndex);
    imageCache.release(handle);
  }, []);

  const releaseAllPages = useCallback(() => {
    for (const handle of pageHandlesRef.current.values()) imageCache.release(handle);
    pageHandlesRef.current.clear();
    for (const handle of thumbnailHandlesRef.current.values()) imageCache.release(handle);
    thumbnailHandlesRef.current.clear();
    if (coverHandleRef.current) imageCache.release(coverHandleRef.current);
    coverHandleRef.current = undefined;
    pendingPagesRef.current.clear();
  }, []);

  // Small per-page rendition for the thumbnail panel; the reader-page rendition
  // would pull every page of the archive in at full size.
  const loadPageThumbnail = useCallback(async (pageIndex: number) => {
    const context = contextRef.current;
    if (!context || pageIndex < 0 || pageIndex >= context.paths.length) return undefined;
    const existing = thumbnailHandlesRef.current.get(pageIndex);
    if (existing) return existing.url;
    try {
      const handle = await imageCache.load({
        scopeId: context.scopeId,
        serverId: context.serverId,
        archiveId: context.archiveId,
        pageIndex,
        rendition: 'page-thumbnail',
      });
      if (!mountedRef.current || contextRef.current?.generation !== context.generation) {
        imageCache.release(handle);
        return undefined;
      }
      const occupied = thumbnailHandlesRef.current.get(pageIndex);
      if (occupied) {
        imageCache.release(handle);
        return occupied.url;
      }
      thumbnailHandlesRef.current.set(pageIndex, handle);
      return handle.url;
    } catch {
      return undefined;
    }
  }, []);

  const loadPage = useCallback(async (pageIndex: number, signal?: AbortSignal) => {
    const context = contextRef.current;
    const path = context?.paths[pageIndex];
    if (!context || !path || pageIndex < 0) return undefined;
    const existing = pageHandlesRef.current.get(pageIndex);
    if (existing) return existing.url;
    const pending = pendingPagesRef.current.get(pageIndex);
    if (pending) return pending;

    const promise = (async () => {
      const handle = await imageCache.load({
        scopeId: context.scopeId,
        serverId: context.serverId,
        archiveId: context.archiveId,
        pageIndex,
        rendition: 'reader-page',
        sourcePath: path,
      }, signal ? { signal } : {});
      // With upscaling on, swap in the enhanced rendition once the plain page is
      // cached; a failure keeps the plain page rather than blanking the reader.
      const enhanced = upscaleEnabled
        ? await imageCache.load({
          scopeId: context.scopeId,
          serverId: context.serverId,
          archiveId: context.archiveId,
          pageIndex,
          rendition: 'enhanced',
          ...(preferences.upscaleModel ? { modelVersion: preferences.upscaleModel } : {}),
        }, signal ? { signal } : {}).catch(() => undefined)
        : undefined;
      if (enhanced) {
        imageCache.release(handle);
        pageHandlesRef.current.set(pageIndex, enhanced);
        return enhanced.url;
      }
      const current = contextRef.current;
      if (!mountedRef.current || !current || current.generation !== context.generation || signal?.aborted) {
        imageCache.release(handle);
        return undefined;
      }
      const occupied = pageHandlesRef.current.get(pageIndex);
      if (occupied) {
        imageCache.release(handle);
        return occupied.url;
      }
      pageHandlesRef.current.set(pageIndex, handle);
      return handle.url;
    })().catch(() => undefined);
    pendingPagesRef.current.set(pageIndex, promise);
    void promise.then(() => {
      if (pendingPagesRef.current.get(pageIndex) === promise) pendingPagesRef.current.delete(pageIndex);
    }, () => {
      if (pendingPagesRef.current.get(pageIndex) === promise) pendingPagesRef.current.delete(pageIndex);
    });
    return promise;
  }, [preferences.upscaleModel, upscaleEnabled]);

  useEffect(() => {
    mountedRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    contextRef.current = undefined;
    releaseAllPages();
    setScopeId(undefined);
    setPages([]);
    setError(undefined);

    void (async () => {
      const servers = await repository.listServers();
      if (!mountedRef.current || !servers.ok || !servers.value[0]) {
        if (mountedRef.current) setError(servers.ok ? '尚未配置服务器' : servers.error.message);
        return;
      }
      const server = servers.value[0];
      const manifest = await repository.loadReaderManifest(server.id, archiveId);
      if (!mountedRef.current || !manifest.ok) {
        if (mountedRef.current && !manifest.ok) setError(manifest.error.message);
        return;
      }
      const context: ReaderContext = {
        generation,
        serverId: server.id,
        scopeId: server.scopeId,
        archiveId,
        paths: manifest.value.pages,
      };
      contextRef.current = context;
      setScopeId(server.scopeId);
      setTitle(manifest.value.title);
      // Overview facts load in the background: the panel is optional chrome, so
      // it must not delay the first page.
      void repository.loadArchiveMetadata(server.id, archiveId).then((metadata) => {
        if (!mountedRef.current || contextRef.current !== context || !metadata.ok) return;
        setInfo((current) => ({
          ...current,
          tags: metadata.value.tags ? metadata.value.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
          sizeBytes: metadata.value.size,
        }));
      });
      void imageCache.load({ scopeId: server.scopeId, serverId: server.id, archiveId, rendition: 'cover', pageIndex: 0 })
        .then((handle) => {
          if (!mountedRef.current || contextRef.current !== context) {
            imageCache.release(handle);
            return;
          }
          coverHandleRef.current = handle;
          setInfo((current) => ({ ...current, cover: handle.url }));
        })
        .catch(() => undefined);
      const progress = await repository.loadProgress(server.scopeId, archiveId);
      if (!mountedRef.current || contextRef.current !== context) return;
      const firstPage = requestedPage > 0
        ? Math.min(requestedPage, Math.max(0, manifest.value.pages.length - 1))
        : progress.ok && progress.value
        ? Math.min(progress.value.pageIndex, Math.max(0, manifest.value.pages.length - 1))
        : 0;
      setInitialPage(firstPage);
      const indices = [firstPage, ...getPrefetchPages(firstPage, manifest.value.pages.length, prefetchDistance)];
      const loaded = await Promise.all(indices.map(async (index) => [index, await loadPage(index, controller.signal)] as const));
      if (!mountedRef.current || contextRef.current !== context) return;
      // Only the page the reader opens on is required. A failed neighbour
      // prefetch must not block reading a page that loaded fine.
      if (!loaded.find(([index]) => index === firstPage)?.[1]) {
        setError('阅读页面加载失败');
        return;
      }
      const pageSources = Array<string>(manifest.value.pages.length).fill('');
      for (const [index, source] of loaded) if (source) pageSources[index] = source;
      setPages(pageSources);
    })();

    return () => {
      mountedRef.current = false;
      controller.abort();
      if (contextRef.current?.generation === generation) contextRef.current = undefined;
      releaseAllPages();
    };
  }, [archiveId, loadPage, prefetchDistance, releaseAllPages, requestedPage, retryToken]);

  // Reader failures used to render as inline text only, on a shell-free route
  // with no way out. Surface them through the shared toast as well.
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);

  if (error) {
    // JHenTai-style: the canvas holds the message and a retry icon, and leaving
    // is the top bar's job rather than a second competing button.
    return (
      <main className="reader-screen reader-screen-error">
        <header className="reader-error-bar">
          <Link className="reader-icon-button" to="/library" aria-label="返回档案库"><ArrowLeft aria-hidden="true" /></Link>
          <strong>{title}</strong>
        </header>
        <section className="reader-error">
          <p role="alert">{error}</p>
          <button type="button" className="reader-retry-button" aria-label="重试加载" onClick={() => setRetryToken((value) => value + 1)}>
            <RotateCcw aria-hidden="true" />
          </button>
        </section>
      </main>
    );
  }
  if (pages.length === 0) return <main className="reader-screen"><p role="status">正在加载页面…</p></main>;

  return (
    <ReaderScreen
      archiveId={archiveId}
      title={title}
      pages={pages}
      initialPage={initialPage}
      loadPage={loadPage}
      loadPageThumbnail={loadPageThumbnail}
      prefetchDistance={prefetchDistance}
      releasePage={releasePage}
      onRetry={() => setRetryToken((value) => value + 1)}
      info={info}
      onProgress={(pageIndex, reading) => {
        if (!scopeId) return;
        void repository.saveProgress({
          scopeId,
          archiveId,
          pageIndex,
          pageCount: pages.length,
          layout: reading.layout === 'webtoon' ? 'continuous' : 'paged',
          direction: reading.direction,
        });
      }}
    />
  );
}
