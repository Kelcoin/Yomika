import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { usePageActive } from '../app/RetainedPage';
import { usePreferences } from '../app/preferences';
import { useReturnNavigation } from '../lib/useReturnNavigation';
import { allocateNativeReaderSession, forgetTileSource, hasNativeReaderTiles, rememberTileSource } from '../lib/readerNativeTiles';
import { NativeInferenceRepository } from '../repositories/nativeInferenceRepository';
import { getNativeComputeRepository } from '../repositories/nativeComputeRepository';
import { loadLocalArchiveManifest, loadLocalArchiveOriginal, loadLocalArchivePage, loadLocalArchiveProgress, openLocalArchiveReaderFile, saveLocalArchiveProgress, type LocalArchiveManifest, type LocalArchiveProgress } from '../repositories/localArchiveReader';
import { LoadingIndicator } from './LoadingIndicator';
import { ReaderRouteChromeShell } from './ReaderRoute';
import { ReaderScreen } from './ReaderScreen';
import { useLocalArchiveCover } from './LocalArchiveCover';
import { useToast } from './Toast';

const inferenceRepository = new NativeInferenceRepository();

export function LocalReaderRoute() {
  const [params] = useSearchParams();
  const path = params.get('file') ?? '';
  const page = params.get('page');
  const active = usePageActive();
  return active ? <LocalReaderSession key={JSON.stringify([path, page])} path={path} page={page} /> : null;
}

function LocalReaderSession({ path, page }: { path: string; page: string | null }) {
  const goBack = useReturnNavigation();
  const [session, setSession] = useState<{ manifest: LocalArchiveManifest; progress: LocalArchiveProgress | null }>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setSession(undefined);
    setError(undefined);
    let current = true;
    void Promise.all([loadLocalArchiveManifest(path), loadLocalArchiveProgress(path)]).then(([manifest, progress]) => {
      if (!current) return;
      if (!manifest.ok || !progress.ok) {
        setError(!manifest.ok ? manifest.error.message : !progress.ok ? progress.error.message : '加载失败');
        return;
      }
      setSession({ manifest: manifest.value, progress: progress.value });
    });
    return () => { current = false; };
  }, [path, retry]);

  if (session) return <LocalReader path={path} page={page} {...session} />;
  return <ReaderRouteChromeShell className={error ? 'reader-screen-error' : 'reader-screen-loading'} title="本地档案" goBack={goBack}>
    {error ? <section className="reader-error">
      <p role="alert">{error}</p>
      <button type="button" className="reader-retry-button" aria-label="重试加载" onClick={() => setRetry(value => value + 1)}><RotateCcw aria-hidden="true" /></button>
    </section> : <LoadingIndicator label="正在加载页面" size="lg" />}
  </ReaderRouteChromeShell>;
}

function LocalReader({ path, page, manifest, progress }: {
  path: string;
  page: string | null;
  manifest: LocalArchiveManifest;
  progress: LocalArchiveProgress | null;
}) {
  const { preferences } = usePreferences();
  const { showToast } = useToast();
  const { cover } = useLocalArchiveCover(path, String(manifest.sizeBytes));
  const pages = useMemo(() => manifest.entries.map(() => ''), [manifest.entries]);
  const [readerSession] = useState(allocateNativeReaderSession);
  const urls = useRef(new Map<number, { url: string; release(): void }>());
  const releasePage = useCallback((index: number) => {
    const cached = urls.current.get(index);
    urls.current.delete(index);
    cached?.release();
  }, []);
  useEffect(() => () => { for (const index of urls.current.keys()) releasePage(index); }, [releasePage]);
  const loadPage = useCallback(async (index: number, signal?: AbortSignal) => {
    const entry = manifest.entries[index];
    if (entry === undefined || signal?.aborted) return undefined;
    const cached = urls.current.get(index);
    if (cached) return cached.url;
    if (hasNativeReaderTiles()) {
      const taskId = `reader-local-file:${crypto.randomUUID()}`;
      const cancel = () => { void inferenceRepository.cancelPage(taskId).catch(() => undefined); };
      signal?.addEventListener('abort', cancel, { once: true });
      const opened = await openLocalArchiveReaderFile(path, entry, taskId, readerSession, index)
        .finally(() => signal?.removeEventListener('abort', cancel));
      if (opened.ok && opened.value) {
        const { lease, contentHash } = opened.value;
        const release = () => {
          forgetTileSource(lease.url);
          void getNativeComputeRepository().releaseArtifact(lease.leaseId).catch(() => undefined);
        };
        const existing = urls.current.get(index);
        if (signal?.aborted || existing) {
          release();
          return signal?.aborted ? undefined : existing?.url;
        }
        rememberTileSource(lease.url, { contentHash, leaseId: lease.leaseId, decodedBytes: lease.estimatedDecodedBytes });
        urls.current.set(index, { url: lease.url, release });
        return lease.url;
      }
      if (signal?.aborted) return undefined;
    }
    const result = await loadLocalArchiveOriginal(path, entry);
    if (signal?.aborted || !result.ok) return undefined;
    const existing = urls.current.get(index);
    if (existing) return existing.url;
    const url = URL.createObjectURL(new Blob([result.value]));
    urls.current.set(index, { url, release: () => URL.revokeObjectURL(url) });
    return url;
  }, [manifest.entries, path, readerSession]);
  const loadPageThumbnail = useCallback((index: number) => {
    const entry = manifest.entries[index];
    return entry === undefined ? Promise.resolve(undefined) : loadLocalArchivePage(path, entry);
  }, [manifest.entries, path]);
  const requestedPage = page !== null && /^\d+$/.test(page) ? Number(page) : progress?.pageIndex ?? 0;
  return <ReaderScreen
    readerSession={readerSession}
    archiveId={path}
    title={manifest.title}
    pages={pages}
    initialPage={Math.min(requestedPage, pages.length - 1)}
    layout={progress?.continuous ? 'webtoon' : preferences.defaultLayout}
    direction={preferences.defaultDirection}
    prefetchDistance={preferences.prefetchPages}
    loadPage={loadPage}
    releasePage={releasePage}
    loadPageThumbnail={loadPageThumbnail}
    info={{ cover, tags: manifest.tags, sizeBytes: manifest.sizeBytes }}
    onProgress={(pageIndex, reading) => {
      void saveLocalArchiveProgress(path, { pageIndex, continuous: reading.layout === 'webtoon' }, preferences.allowProgressRegression).then(result => {
        if (!result.ok) showToast(`阅读进度保存失败：${result.error.message}`, 'error');
      });
    }}
  />;
}
