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
  const requestedPage = Math.max(0, Number(searchParams.get('page') ?? '0') || 0);
  const [scopeId, setScopeId] = useState<string>();
  const [initialPage, setInitialPage] = useState(0);
  const [title, setTitle] = useState('阅读器');
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);
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
  }, []);

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
    return (
      <main className="reader-screen">
        <section className="reader-error">
          <h1>阅读器加载失败</h1>
          <p role="alert">{error}</p>
          <div className="reader-error-actions">
            <button className="secondary-action" type="button" onClick={() => setRetryToken((value) => value + 1)}>
              <RotateCcw aria-hidden="true" />重试
            </button>
            <Link className="primary-action" to="/library"><ArrowLeft aria-hidden="true" />返回档案库</Link>
          </div>
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
