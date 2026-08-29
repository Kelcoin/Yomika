import { useCallback, useEffect, useRef, useState } from 'react';

import type { ArchiveRecord } from '../domain/library';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { LibraryWorkspace } from './LibraryWorkspace';
import { getThumbnail, setThumbnail } from '../lib/thumbnailCache';

const repository = new NativeLibraryRepository();

export function LibraryRouteWorkspace() {
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [serverId, setServerId] = useState<string>();
  const [metadata, setMetadata] = useState<import('../repositories/nativeLibraryRepository').ArchiveMetadata>();
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [categories, setCategories] = useState<import('../repositories/nativeLibraryRepository').Category[]>([]);
  const [categoryMessage, setCategoryMessage] = useState<string>();
  const [selectedArchiveId, setSelectedArchiveId] = useState<string>();
  const [metadataMessage, setMetadataMessage] = useState<string>();
  const [thumbnail, setThumbnailUrl] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const detailRequest = useRef(0);

  const loadArchiveDetails = useCallback((currentServerId: string, archive: ArchiveRecord) => {
    const request = ++detailRequest.current;
    setSelectedArchiveId(archive.archiveId);
    setMetadata(undefined);
    setMetadataLoading(true);

    const cached = getThumbnail(currentServerId, archive.archiveId);
    if (cached) {
      setThumbnailUrl(cached);
    } else {
      setThumbnailUrl(undefined);
      void repository.loadArchiveThumbnail(currentServerId, archive.archiveId).then((result) => {
        if (request !== detailRequest.current || !result.ok) return;
        const values = new Uint8Array(result.value);
        let binary = '';
        for (const value of values) binary += String.fromCharCode(value);
        const url = `data:application/octet-stream;base64,${btoa(binary)}`;
        setThumbnail(currentServerId, archive.archiveId, url);
        setThumbnailUrl(url);
      });
    }

    void repository.loadArchiveMetadata(currentServerId, archive.archiveId).then((result) => {
      if (request !== detailRequest.current) return;
      if (result.ok) setMetadata(result.value);
      setMetadataLoading(false);
    });
  }, []);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    setError(undefined);
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
    const categoryResult = await repository.listCategories(server.id);
    if (categoryResult.ok) setCategories(categoryResult.value);
    const result = await repository.listArchives(server.id);
    if (result.ok) setArchives(result.value);
    else setError(result.error.message);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (!serverId || archives.length === 0) return;
    if (selectedArchiveId && archives.some((archive) => archive.archiveId === selectedArchiveId)) return;
    const firstArchive = archives[0];
    if (firstArchive) loadArchiveDetails(serverId, firstArchive);
  }, [archives, loadArchiveDetails, selectedArchiveId, serverId]);

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
        <p className="form-error" role="alert">{error}</p>
        <button className="secondary-action" type="button" onClick={() => void loadLibrary()}>重试读取档案库</button>
      </div>
    );
  }

  return (
    <>
      {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
      {refreshError && <p className="form-error" role="alert">{refreshError}</p>}
      <LibraryWorkspace
        archives={archives}
        metadata={metadata}
        metadataLoading={metadataLoading}
        thumbnail={thumbnail}
        refreshing={refreshing}
        onRefresh={() => {
          if (!serverId) return;
          setRefreshError(undefined);
          setRefreshing(true);
          void repository.refreshArchives(serverId, {}).then((result) => {
            if (result.ok) {
              setArchives(result.value);
            } else {
              setRefreshError(result.error.message);
            }
            setRefreshing(false);
          });
        }}
        categories={categories}
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
        if (!serverId) return;
        loadArchiveDetails(serverId, archive);
        }}
      />
      {categoryMessage && <p role="status">{categoryMessage}</p>}
      {metadataMessage && <p role="status">{metadataMessage}</p>}
    </>
  );
}
