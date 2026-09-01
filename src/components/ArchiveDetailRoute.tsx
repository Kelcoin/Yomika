import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  BookOpen,
  Heart,
  LoaderCircle,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { categorizeTags, parseArchiveTagString } from '../lib/tags';
import { useTagTranslations } from '../lib/tagTranslationService';
import { getNativeImageCache } from '../lib/nativeImageCache';
import {
  NativeLibraryRepository,
  type ArchiveMetadata,
} from '../repositories/nativeLibraryRepository';
import type { ArchiveRecord } from '../domain/library';
import { useToast } from './Toast';
import { ArchiveThumbnailRail } from './ArchiveThumbnailCard';

const repository = new NativeLibraryRepository();

export function ArchiveDetailRoute({ archiveId }: { archiveId: string }) {
  const [metadata, setMetadata] = useState<ArchiveMetadata>();
  const [cover, setCover] = useState<string>();
  const [coverLoading, setCoverLoading] = useState(true);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [serverId, setServerId] = useState<string>();
  const [scopeId, setScopeId] = useState<string>();
  const [favorite, setFavorite] = useState(false);
  const [message, setMessage] = useState<string>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  useTagTranslations();

  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);
  useEffect(() => {
    if (message) showToast(message, 'error');
  }, [message, showToast]);

  useEffect(() => {
    let active = true;
    const coverController = new AbortController();
    let coverHandle: import('../lib/unifiedImageCache').ImageHandle | undefined;
    setMetadata(undefined);
    setCover(undefined);
    setCoverLoading(true);
    setMetadataLoading(true);
    setError(undefined);
    setServerId(undefined);
    setScopeId(undefined);
    setFavorite(false);
    setMessage(undefined);

    void repository.listServers().then((servers) => {
      if (!active) return;
      const server = servers.ok ? servers.value[0] : undefined;
      if (!server) {
        setCoverLoading(false);
        setError(servers.ok ? '尚未配置服务器' : servers.error.message);
        return;
      }

      setServerId(server.id);
      setScopeId(server.scopeId);

      void repository.loadArchiveMetadata(server.id, archiveId).then((result) => {
        if (!active) return;
        if (result.ok) setMetadata(result.value);
        else if (result.error.code === 'LRR_NOT_FOUND') {
          showToast('该档案已从 LANraragi 移除，本地索引已清理', 'info');
          navigate('/library', { replace: true });
        } else setError(result.error.message);
        setMetadataLoading(false);
      });
      void getNativeImageCache().load({
        scopeId: server.scopeId,
        serverId: server.id,
        archiveId,
        rendition: 'cover',
        pageIndex: 0,
      }, { signal: coverController.signal }).then((handle) => {
        if (!active) { getNativeImageCache().release(handle); return; }
        coverHandle = handle;
        setCover(handle.url);
      }).catch(() => undefined).finally(() => {
        if (active) setCoverLoading(false);
      });
      void repository.listWatchlist(server.scopeId).then((result) => {
        if (!active || !result.ok) return;
        setFavorite(result.value.some((item) => item.archiveId === archiveId && !item.deleted));
      });
    });

    return () => {
      active = false;
      coverController.abort();
      if (coverHandle) getNativeImageCache().release(coverHandle);
    };
  }, [archiveId, navigate, showToast]);

  if (error && !metadata && !serverId) {
    return (
      <main className="archive-detail-route">
        <Link className="secondary-action" to="/library"><ArrowLeft aria-hidden="true" />返回档案库</Link>
        <p className="form-error" role="alert">{error}</p>
      </main>
    );
  }
  if (!metadata && !serverId) {
    return (
      <main className="archive-detail-route archive-detail-route-loading">
        <div className="archive-detail-skeleton archive-detail-loading-status" role="status" aria-label="正在加载档案详情">
          <div className="skeleton-block skeleton-cover" />
          <div className="skeleton-copy"><div className="skeleton-line skeleton-line-title" /><div className="skeleton-line" /><div className="skeleton-line skeleton-line-short" /></div>
        </div>
      </main>
    );
  }

  const title = metadata?.title || archiveId;
  const tags = metadata ? parseArchiveTagString(metadata.tags) : [];
  const tagGroups = categorizeTags(tags);
  return (
    <main className={`archive-detail-route${metadataLoading ? ' is-loading-metadata' : ''}`} aria-labelledby="archive-detail-route-title">
      <header className="archive-detail-route-header">
        <Link className="reader-icon-button" to="/library" aria-label="关闭详情"><ArrowLeft aria-hidden="true" /></Link>
        <div><h1 id="archive-detail-route-title">{title}</h1></div>
      </header>

      <div className="archive-detail-overview">
        <div className="archive-detail-route-cover">
          {cover
            ? <img src={cover} alt={`${title} 封面`} />
            : <div className={`archive-detail-cover-placeholder${coverLoading ? ' is-skeleton' : ''}`} aria-label={coverLoading ? '正在加载封面' : '暂无封面'}>{coverLoading && <LoaderCircle className="spin" aria-hidden="true" />}</div>}
        </div>
        <div className="archive-detail-overview-copy">
          {metadataLoading && !metadata && <div className="archive-detail-copy-skeleton" aria-hidden="true"><div className="skeleton-line skeleton-line-title" /><div className="skeleton-line" /><div className="skeleton-line skeleton-line-short" /></div>}
          {tags.length > 0 && (
            <div className="archive-detail-tags" aria-label="档案标签">
              {tagGroups.map((group, groupIndex) => (
                <section className={`tag-group tag-group-${group.namespace}`} key={group.namespace}>
                  <h2>{group.label}</h2>
                  <div className={`archive-detail-tag-row${groupIndex === tagGroups.length - 1 && metadata ? ' has-meta' : ''}`}>
                    <span className="archive-detail-tag-values">
                      {group.values.map((tag, index) => <span className="metadata-chip" key={`${group.namespace}-${tag}-${index}`}>{tag}</span>)}
                    </span>
                    {groupIndex === tagGroups.length - 1 && metadata && <span className="archive-detail-meta archive-detail-meta-inline"><span className="metadata-chip metadata-chip-page">{metadata.pageCount} 页</span><span className="metadata-chip metadata-chip-size">{formatBytes(metadata.size)}</span></span>}
                  </div>
                </section>
              ))}
            </div>
          )}
          {tags.length === 0 && <div className="archive-detail-meta archive-detail-meta-footer">{metadata ? <><span className="metadata-chip metadata-chip-page">{metadata.pageCount} 页</span><span className="metadata-chip metadata-chip-size">{formatBytes(metadata.size)}</span></> : <span className="archive-detail-inline-loading" role="status"><LoaderCircle className="spin" aria-hidden="true" />正在加载档案详情…</span>}</div>}
        </div>
      </div>


      <div className="archive-detail-route-actions" role="toolbar" aria-label="档案操作">
        <Link className="archive-action-button archive-action-primary" to={`/reader/${archiveId}`} aria-label="阅读" title="阅读"><BookOpen aria-hidden="true" /><span className="archive-action-label">阅读</span></Link>
        <button className="archive-action-button" type="button" aria-pressed={favorite} onClick={() => {
          if (!scopeId) return;
          void repository.setWatchlist(scopeId, archiveId, !favorite).then((result) => {
            if (result.ok) setFavorite(!result.value.deleted);
            else setMessage(result.error.message);
          });
        }} aria-label={favorite ? '取消收藏' : '收藏'} title={favorite ? '取消收藏' : '收藏'}><Heart aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} /><span className="archive-action-label">{favorite ? '取消收藏' : '收藏'}</span></button>
        <button className="archive-action-button" type="button" aria-label="编辑元数据" title="编辑元数据" onClick={() => navigate(`/library/${archiveId}/edit`)}><Pencil aria-hidden="true" /><span className="archive-action-label">编辑</span></button>

        {serverId && (
          <Dialog.Root>
            <Dialog.Trigger asChild><button className="archive-action-button" type="button" aria-label="删除档案" title="删除档案"><Trash2 aria-hidden="true" /><span className="archive-action-label">删除</span></button></Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-content">
                <Dialog.Title>确认删除</Dialog.Title>
                <Dialog.Description>将从 LANraragi 删除“{title}”，此操作不可撤销。</Dialog.Description>
                <div className="dialog-actions">
                  <Dialog.Close asChild><button className="secondary-action" type="button">取消</button></Dialog.Close>
                  <Dialog.Close asChild><button className="primary-action archive-confirm-delete" type="button" onClick={() => {
                    void repository.deleteArchive(serverId, archiveId).then((result) => {
                      if (result.ok) navigate('/library');
                      else setMessage(result.error.message);
                    });
                  }}>确认删除</button></Dialog.Close>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      </div>

      {metadata && metadata.pageCount > 0 && serverId && scopeId && (
        <section className="archive-page-thumbnails" aria-label="页面缩略图">
          <div className="archive-page-thumbnails-grid">
            {Array.from({ length: metadata.pageCount }, (_, index) => (
              <ArchivePageThumbnail key={index} serverId={serverId} scopeId={scopeId} archiveId={archiveId} page={index + 1} onOpen={(page) => navigate(`/reader/${encodeURIComponent(archiveId)}?page=${page - 1}`)} />
            ))}
          </div>
        </section>
      )}

      {metadata?.summary && <p className="archive-detail-summary">{metadata.summary}</p>}
      {serverId && scopeId && <Recommendations scopeId={scopeId} serverId={serverId} currentArchiveId={archiveId} />}
    </main>
  );
}

function Recommendations({ scopeId, serverId, currentArchiveId }: { scopeId: string; serverId: string; currentArchiveId: string }) {
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  useEffect(() => { void repository.listArchives(serverId).then((result) => { if (result.ok) setArchives(result.value.filter((item) => item.archiveId !== currentArchiveId).slice(0, 8)); }); }, [currentArchiveId, serverId]);
  return <ArchiveThumbnailRail title="推荐档案" archives={archives} scopeId={scopeId} serverId={serverId} />;
}

function ArchivePageThumbnail({
  serverId,
  scopeId,
  archiveId,
  page,
  onOpen,
}: {
  serverId: string;
  scopeId: string;
  archiveId: string;
  page: number;
  onOpen: (page: number) => void;
}) {
  const [src, setSrc] = useState<string>();
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [retry, setRetry] = useState(0);
  const [node, setNode] = useState<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!node) return undefined;
    const controller = new AbortController();
    let handle: import('../lib/unifiedImageCache').ImageHandle | undefined;
    let retryTimer: number | undefined;
    const load = () => {
      setState('loading');
      void getNativeImageCache().load({
        scopeId,
        serverId,
        archiveId,
        rendition: 'page-thumbnail',
        pageIndex: page - 1,
      }, { signal: controller.signal }).then((loaded) => {
        handle = loaded;
        setSrc(loaded.url);
        setState('ready');
      }).catch(() => {
        if (!controller.signal.aborted) {
          setState('error');
          if (retry < 2) retryTimer = window.setTimeout(() => setRetry((value) => value + 1), 1200 * (retry + 1));
        }
      });
    };
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === 'undefined') load();
    else {
      observer = new IntersectionObserver(([entry]) => {
        if (!entry?.isIntersecting) return;
        observer?.disconnect();
        load();
      }, { rootMargin: '320px' });
      observer.observe(node);
    }
    return () => {
      observer?.disconnect();
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (handle) getNativeImageCache().release(handle);
    };
  }, [archiveId, node, page, retry, scopeId, serverId]);
  return (
    <button ref={setNode} className="archive-page-thumbnail" type="button" aria-label={`查看第 ${page} 页`} onClick={() => onOpen(page)}>
      {src ? <img src={src} alt={`第 ${page} 页`} loading="lazy" /> : <span>{state === 'loading' ? '加载中…' : state === 'error' ? '重试中…' : `P. ${page}`}</span>}
    </button>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
