import { usePageActive } from '../app/RetainedPage';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, RotateCcw } from 'lucide-react';

import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { ReaderScreen } from './ReaderScreen';
import { LoadingIndicator } from './LoadingIndicator';
import { getPrefetchPages, type ReaderLayoutPreference, type ReadingDirection } from '../domain/reader';
import { pickServer } from '../domain/server';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { useToast } from './Toast';
import { usePreferences } from '../app/preferences';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { useReturnNavigation } from '../lib/useReturnNavigation';

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
  const pageActive = usePageActive();
  const pageActiveRef = useRef(pageActive);
  pageActiveRef.current = pageActive;
  const [searchParams] = useSearchParams();
  const goBack = useReturnNavigation();
  const { showToast } = useToast();
  const { preferences } = usePreferences();
  const prefetchDistance = preferences.prefetchPages;
  // A backend with no model runs the nearest-neighbour fallback, which returns
  // the same pixels at four times the bytes — strictly worse than the plain
  // page. Upscaling therefore needs a model, not just a backend.
  const upscaleConfigured = preferences.upscaleBackend !== 'off' && preferences.upscaleModel !== '';
  // Settings grant availability; every reading session starts with original images.
  const decensorConfigured = preferences.decensorModel !== '';
  /** Per-session overrides for the two enhancements, driven from the reader's own
   * toolbar. Settings decide whether a model exists; these decide whether this
   * sitting uses it, which is the only way to see what either one does to the
   * page in front of you. */
  const [upscaleWanted, setUpscaleWanted] = useState(false);
  const [decensorWanted, setDecensorWanted] = useState(false);
  useLayoutEffect(() => {
    setUpscaleWanted(false);
    setDecensorWanted(false);
  }, [archiveId]);
  useEffect(() => { if (!upscaleConfigured) setUpscaleWanted(false); }, [upscaleConfigured]);
  useEffect(() => { if (!decensorConfigured) setDecensorWanted(false); }, [decensorConfigured]);
  const upscaleEnabled = upscaleConfigured && upscaleWanted;
  const decensorEnabled = decensorConfigured && decensorWanted;
  /** Bumped whenever a switch flips, so the reader drops the renditions it is
   * holding instead of showing the previous answer until the next page turn. */
  const [enhancementToken, setEnhancementToken] = useState(0);
  // The page param is absent only when the key itself is missing: `?page=0`
  // is an explicit request for the first page (from the detail page's
  // thumbnail grid), not "no page requested".
  const pageParam = searchParams.get('page');
  const requestedPage = pageParam === null
    ? undefined
    : Math.max(0, Number(pageParam) || 0);
  /** Which server this reader session is bound to: an explicit `?server=` id
   * from the linking card wins over the default (first configured) server. */
  const serverParam = searchParams.get('server');
  /** Incognito reading: no progress, no history. The reader shows a marker so it
   * is obvious the session is not being recorded. */
  const incognito = searchParams.get('incognito') === '1';
  const [scopeId, setScopeId] = useState<string>();
  const [initialPage, setInitialPage] = useState(0);
  /** Reading mode and direction for this archive: its own record if it has one,
   * otherwise the global preference. Both were previously ignored — the reader
   * always started on `auto`/`ltr`, which made the two settings do nothing. */
  const [readingLayout, setReadingLayout] = useState<ReaderLayoutPreference>('auto');
  const [readingDirection, setReadingDirection] = useState<ReadingDirection>('ltr');
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
  const derivedHandlesRef = useRef(new Map<number, ImageHandle>());
  const derivedAttemptedRef = useRef(new Set<number>());
  const derivedQueueRef = useRef<Array<{ pageIndex: number; generation: number; decensorModel: string; upscaleModel: string }>>([]);
  const derivedGenerationRef = useRef(0);
  const derivedBusyRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const releasePage = useCallback((pageIndex: number) => {
    const handle = pageHandlesRef.current.get(pageIndex);
    pageHandlesRef.current.delete(pageIndex);
    if (handle) imageCache.release(handle);
    const derived = derivedHandlesRef.current.get(pageIndex);
    derivedHandlesRef.current.delete(pageIndex);
    if (derived) imageCache.release(derived);
    derivedAttemptedRef.current.delete(pageIndex);
    derivedQueueRef.current = derivedQueueRef.current.filter((job) => job.pageIndex !== pageIndex);
    setDerivedPages((current) => {
      if (!current.has(pageIndex)) return current;
      const next = new Map(current);
      next.delete(pageIndex);
      return next;
    });
  }, []);

  const releaseAllPages = useCallback(() => {
    for (const handle of pageHandlesRef.current.values()) imageCache.release(handle);
    pageHandlesRef.current.clear();
    for (const handle of derivedHandlesRef.current.values()) imageCache.release(handle);
    derivedHandlesRef.current.clear();
    derivedAttemptedRef.current.clear();
    derivedQueueRef.current = [];
    derivedGenerationRef.current += 1;
    setDerivedPages((current) => current.size === 0 ? current : new Map());
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

  /** Derived renditions by page index, swapped in when they arrive.
   *
   * `loadPage` used to await these before resolving, so a page was not shown
   * until inference for it had finished — seconds per page, and one run for every
   * page of the prefetch window at once. That is what made the reader look frozen
   * with upscaling on. The plain page goes up immediately and the enhanced one
   * replaces it when it is ready; because that is a `src` swap on a slot whose
   * transform never changes, the zoom survives it.
   *
   * One at a time, and only for pages actually on screen: prefetched neighbours
   * are not worth an ONNX run each, and running several at once only made every
   * one of them slower. */
  const [derivedPages, setDerivedPages] = useState<ReadonlyMap<number, string>>(() => new Map());

  const releaseDerived = useCallback(() => {
    derivedGenerationRef.current += 1;
    for (const handle of derivedHandlesRef.current.values()) imageCache.release(handle);
    derivedHandlesRef.current.clear();
    derivedAttemptedRef.current.clear();
    derivedQueueRef.current = [];
    setDerivedPages((current) => current.size === 0 ? current : new Map());
  }, []);

  const runDerivedQueue = useCallback(async () => {
    if (derivedBusyRef.current) return;
    derivedBusyRef.current = true;
    try {
      while (pageActiveRef.current && derivedQueueRef.current.length > 0) {
        const job = derivedQueueRef.current.shift();
        if (!job) break;
        const { pageIndex } = job;
        const context = contextRef.current;
        if (!context || !mountedRef.current) break;
        derivedAttemptedRef.current.add(pageIndex);
        if (!await loadPage(pageIndex) || job.generation !== derivedGenerationRef.current) continue;
        const identity = { scopeId: context.scopeId, serverId: context.serverId, archiveId: context.archiveId, pageIndex };
        // Both on: de-censor first, then enlarge the finished page. The detector
        // and the inpainter were trained at page scale, so upscaling first would
        // hand the inpainter interpolated pixels and smeared mosaic blocks.
        const censored = job.decensorModel && !job.upscaleModel
          ? await imageCache.load({ ...identity, rendition: 'decensored', modelId: job.decensorModel }).catch(() => undefined)
          : undefined;
        const enhanced = job.generation === derivedGenerationRef.current && job.upscaleModel
          ? await imageCache.load({
            ...identity,
            rendition: 'enhanced',
            modelId: job.upscaleModel,
            ...(job.decensorModel ? { decensorModelId: job.decensorModel } : {}),
          }).catch(() => undefined)
          : undefined;
        const derived = enhanced ?? censored;
        if (enhanced && censored) imageCache.release(censored);
        if (!derived) continue;
        if (!mountedRef.current || contextRef.current?.generation !== context.generation || job.generation !== derivedGenerationRef.current || !pageHandlesRef.current.has(pageIndex)) {
          imageCache.release(derived);
          continue;
        }
        const occupied = derivedHandlesRef.current.get(pageIndex);
        if (occupied) {
          imageCache.release(derived);
          continue;
        }
        derivedHandlesRef.current.set(pageIndex, derived);
        setDerivedPages((current) => new Map(current).set(pageIndex, derived.url));
      }
    } finally {
      derivedBusyRef.current = false;
    }
  }, [loadPage]);
  useEffect(() => { if (pageActive) void runDerivedQueue(); }, [pageActive, runDerivedQueue]);

  /** Called by the reader with the pages actually on screen. */
  const requestDerived = useCallback((indexes: readonly number[]) => {
    if (!decensorEnabled && !upscaleEnabled) return;
    let queued = false;
    for (const index of indexes) {
      if (derivedAttemptedRef.current.has(index) || derivedQueueRef.current.some((job) => job.pageIndex === index)) continue;
      derivedQueueRef.current.push({ pageIndex: index, generation: derivedGenerationRef.current, decensorModel: decensorEnabled ? preferences.decensorModel : '', upscaleModel: upscaleEnabled ? preferences.upscaleModel : '' });
      queued = true;
    }
    if (queued) void runDerivedQueue();
  }, [decensorEnabled, preferences.decensorModel, preferences.upscaleModel, runDerivedQueue, upscaleEnabled]);

  // A switch above the canvas changed what the derived renditions would be, so
  // everything held under the old answer is dropped and re-requested.
  useLayoutEffect(() => {
    releaseDerived();
  }, [decensorEnabled, enhancementToken, preferences.decensorModel, preferences.upscaleModel, releaseDerived, upscaleEnabled]);

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
      if (!mountedRef.current || !servers.ok || !servers.value.length) {
        if (mountedRef.current) setError(servers.ok ? '尚未配置服务器' : servers.error.message);
        return;
      }
      const server = pickServer(servers.value, serverParam);
      if (!server) {
        if (mountedRef.current) setError('尚未配置服务器');
        return;
      }
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
      const firstPage = requestedPage !== undefined
        ? Math.min(requestedPage, Math.max(0, manifest.value.pages.length - 1))
        : progress.ok && progress.value
        ? Math.min(progress.value.pageIndex, Math.max(0, manifest.value.pages.length - 1))
        : 0;
      setInitialPage(firstPage);
      // Reading mode and direction: the archive's own record wins over the global
      // default, because it is the more specific answer. The stored layout only
      // distinguishes paged from continuous — whether paged meant single, double
      // or auto was never recorded, so that part comes from the preference.
      const stored = progress.ok ? progress.value : null;
      setReadingLayout(stored?.layout === 'continuous' ? 'webtoon' : preferences.defaultLayout);
      setReadingDirection(stored?.direction ?? preferences.defaultDirection);
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
  }, [archiveId, loadPage, prefetchDistance, preferences.defaultDirection, preferences.defaultLayout, releaseAllPages, requestedPage, serverParam, retryToken]);

  // Reader failures used to render as inline text only, on a shell-free route
  // with no way out. Surface them through the shared toast as well.
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);

  if (error) {
    // The canvas holds the message and a retry icon, and leaving
    // is the top bar's job rather than a second competing button.
    return (
      <main className="reader-screen reader-screen-error">
        <header className="reader-error-bar">
          <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
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
  // Not just a placeholder: clearing `pages` above when `archiveId` changes routes
  // through here, which unmounts ReaderScreen and is what stops one archive's page
  // index, zoom and per-index page shapes from carrying into the next. React
  // Router reuses this element across param changes, so nothing else would.
  if (pages.length === 0) return <main className="reader-screen reader-screen-loading"><LoadingIndicator label="正在加载页面" size="lg" /></main>;
  return (
    <ReaderScreen
      archiveId={archiveId}
      title={title}
      pages={pages}
      initialPage={initialPage}
      layout={readingLayout}
      direction={readingDirection}
      loadPage={loadPage}
      loadPageThumbnail={loadPageThumbnail}
      prefetchDistance={prefetchDistance}
      releasePage={releasePage}
      info={info}
      upscale={{
        configured: upscaleConfigured,
        active: upscaleEnabled,
        toggle: () => { setUpscaleWanted((value) => !value); setEnhancementToken((value) => value + 1); },
      }}
      decensor={{
        configured: decensorConfigured,
        active: decensorEnabled,
        toggle: () => { setDecensorWanted((value) => !value); setEnhancementToken((value) => value + 1); },
      }}
      derivedPages={derivedPages}
      onVisiblePages={requestDerived}
      onProgress={(pageIndex, reading) => {
        if (!scopeId || incognito) return;
        void repository.saveProgress({
          scopeId,
          archiveId,
          pageIndex,
          pageCount: pages.length,
          layout: reading.layout === 'webtoon' ? 'continuous' : 'paged',
          direction: reading.direction,
        });
      }}
      incognito={incognito}
    />
  );
}
