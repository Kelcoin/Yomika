import { useEffect, useState } from 'react';

import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { ReaderScreen } from './ReaderScreen';
import { getPrefetchPages } from '../domain/reader';

const repository = new NativeLibraryRepository();

function bytesToDataUrl(bytes: ArrayBuffer): string {
  const values = new Uint8Array(bytes);
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return `data:application/octet-stream;base64,${btoa(binary)}`;
}

export function ReaderRoute({ archiveId }: { archiveId: string }) {
  const [serverId, setServerId] = useState<string>();
  const [initialPage, setInitialPage] = useState(0);
  const [title, setTitle] = useState('阅读器');
  const [pages, setPages] = useState<string[]>([]);
  const [pagePaths, setPagePaths] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void (async () => {
      const servers = await repository.listServers();
      if (!servers.ok || !servers.value[0]) {
        setError(servers.ok ? '尚未配置服务器' : servers.error.message);
        return;
      }
      const selectedServerId = servers.value[0].id;
      setServerId(selectedServerId);
      const manifest = await repository.loadReaderManifest(selectedServerId, archiveId);
      if (!active) return;
      if (!manifest.ok) {
        setError(manifest.error.message);
        return;
      }
      setTitle(manifest.value.title);
      setPagePaths(manifest.value.pages);
      const progress = await repository.loadProgress(selectedServerId, archiveId);
      if (!active) return;
      if (progress.ok && progress.value) {
        setInitialPage(Math.min(progress.value.pageIndex, Math.max(0, manifest.value.pages.length - 1)));
      }
      const firstPage = progress.ok && progress.value
        ? Math.min(progress.value.pageIndex, Math.max(0, manifest.value.pages.length - 1))
        : 0;
      const indices = [firstPage, ...getPrefetchPages(firstPage, manifest.value.pages.length, 1)];
      const loaded = await Promise.all(indices.map(async (index) => {
        const path = manifest.value.pages[index];
        return [index, path ? await repository.loadReaderPage(selectedServerId, archiveId, index, path) : { ok: false as const, error: { code: 'INVALID_RESPONSE' as const, message: 'Invalid reader page path', retryable: false } }] as const;
      }));
      if (!active) return;
      const failed = loaded.find(([, result]) => !result.ok);
      if (failed && !failed[1].ok) {
        setError(failed[1].error.message);
        return;
      }
      const pageSources = Array<string>(manifest.value.pages.length).fill('');
      for (const [index, result] of loaded) if (result.ok) pageSources[index] = bytesToDataUrl(result.value);
      setPages(pageSources);
    })();
    return () => { active = false; };
  }, [archiveId]);

  if (error) return <main className="reader-screen"><section className="reader-error"><h1>阅读器加载失败</h1><p role="alert">{error}</p></section></main>;
  if (pages.length === 0) return <main className="reader-screen"><p role="status">正在加载页面...</p></main>;

  return (
    <ReaderScreen
      archiveId={archiveId}
      title={title}
      pages={pages}
      initialPage={initialPage}
      loadPage={async (pageIndex) => {
        if (!serverId) return undefined;
        const path = pagePaths[pageIndex];
        if (!path) return undefined;
        const result = await repository.loadReaderPage(serverId, archiveId, pageIndex, path);
        return result.ok ? bytesToDataUrl(result.value) : undefined;
      }}
      onProgress={(pageIndex) => {
        if (!serverId) return;
        void repository.saveProgress({
          scopeId: serverId,
          archiveId,
          pageIndex,
          pageCount: pages.length,
          layout: 'paged',
          direction: 'ltr',
        });
      }}
    />
  );
}
