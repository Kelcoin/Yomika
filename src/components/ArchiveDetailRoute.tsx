import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  Bookmark,
  BookmarkX,
  BookOpen,
  Heart,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { categorizeTags, parseArchiveTagString } from '../lib/tags';
import { pickSeedTags, rankRecommendations, sameCreatorTags } from '../lib/recommendation';
import { useTagTranslations } from '../lib/tagTranslationService';
import { getNativeImageCache } from '../lib/nativeImageCache';
import {
  NativeLibraryRepository,
  type ArchiveMetadata,
} from '../repositories/nativeLibraryRepository';
import type { ArchiveRecord } from '../domain/library';
import { useToast } from './Toast';
import { ArchiveThumbnailRail } from './ArchiveThumbnailCard';
import { useArchiveContextMenu } from './useArchiveContextMenu';

const repository = new NativeLibraryRepository();
/** Long enough not to fire on a normal tap, short enough to discover by holding.
 * Matches the platform convention rather than the drag thresholds. */
const LONG_PRESS_MS = 500;

export function ArchiveDetailRoute({ archiveId }: { archiveId: string }) {
  const [metadata, setMetadata] = useState<ArchiveMetadata>();
  const [cover, setCover] = useState<string>();
  const [coverLoading, setCoverLoading] = useState(true);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [serverId, setServerId] = useState<string>();
  const [scopeId, setScopeId] = useState<string>();
  const [favorite, setFavorite] = useState(false);
  const [inReadingList, setInReadingList] = useState(false);
  const [message, setMessage] = useState<string>();
  const navigate = useNavigate();
  /** Long-press on 阅读 offers incognito. A press that becomes the prompt must not
   * also follow the link, so the click is swallowed once. */
  const [incognitoAsk, setIncognitoAsk] = useState(false);
  const incognitoTimer = useRef<number>();
  const incognitoPrompted = useRef(false);

  const startIncognitoPress = useCallback(() => {
    incognitoPrompted.current = false;
    if (incognitoTimer.current !== undefined) window.clearTimeout(incognitoTimer.current);
    incognitoTimer.current = window.setTimeout(() => {
      incognitoPrompted.current = true;
      setIncognitoAsk(true);
    }, LONG_PRESS_MS);
  }, []);

  const cancelIncognitoPress = useCallback(() => {
    if (incognitoTimer.current !== undefined) window.clearTimeout(incognitoTimer.current);
    incognitoTimer.current = undefined;
  }, []);

  useEffect(() => () => { if (incognitoTimer.current !== undefined) window.clearTimeout(incognitoTimer.current); }, []);

  /** Back means back. This was a hardcoded link to the library, so arriving from
   * the home shelves and pressing it took you somewhere you had never been.
   * A direct visit has nothing to return to, so that case still falls back. */
  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/library');
  }, [navigate]);
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
      void repository.listReadingList(server.scopeId).then((result) => {
        if (!active || !result.ok) return;
        setInReadingList(result.value.some((item) => item.archiveId === archiveId && !item.deleted));
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
        <button className="secondary-action" type="button" onClick={goBack}><ArrowLeft aria-hidden="true" />返回</button>
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
        <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
        <div><h1 id="archive-detail-route-title">{title}</h1></div>
      </header>

      <div className="archive-detail-overview">
        <div className="archive-detail-route-cover">
          {cover
            ? <img src={cover} alt={`${title} 封面`} />
            : <div className={`archive-detail-cover-placeholder${coverLoading ? ' is-skeleton' : ''}`} aria-label={coverLoading ? '正在加载封面' : '暂无封面'} />}
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
                      {group.values.map((tag, index) => <span className="metadata-chip" key={`${group.namespace}-${tag}-${index}`} title={tag}>{tag}</span>)}
                    </span>
                    {groupIndex === tagGroups.length - 1 && metadata && <span className="archive-detail-meta archive-detail-meta-inline"><span className="metadata-chip metadata-chip-page">{metadata.pageCount} 页</span><span className="metadata-chip metadata-chip-size">{formatBytes(metadata.size)}</span></span>}
                  </div>
                </section>
              ))}
            </div>
          )}
          {tags.length === 0 && <div className="archive-detail-meta archive-detail-meta-footer">{metadata ? <><span className="metadata-chip metadata-chip-page">{metadata.pageCount} 页</span><span className="metadata-chip metadata-chip-size">{formatBytes(metadata.size)}</span></> : <span className="metadata-chip skeleton-line skeleton-line-short" role="status" aria-label="正在加载档案详情" />}</div>}
        </div>
      </div>


      <div className="archive-detail-route-actions" role="toolbar" aria-label="档案操作">
        {/* Long-press opens incognito. It used to be a button of its own beside
            阅读, which spent a permanent toolbar slot on a rare choice and put a
            second reading entry point next to the real one. */}
        <Link
          className="archive-action-button archive-action-primary"
          to={`/reader/${archiveId}`}
          aria-label="阅读"
          title="阅读（长按进入无痕阅读）"
          onPointerDown={startIncognitoPress}
          onPointerUp={cancelIncognitoPress}
          onPointerLeave={cancelIncognitoPress}
          onPointerCancel={cancelIncognitoPress}
          onClick={(event) => { if (incognitoPrompted.current) { event.preventDefault(); incognitoPrompted.current = false; } }}
          onContextMenu={(event) => event.preventDefault()}
        ><BookOpen aria-hidden="true" /><span className="archive-action-label">阅读</span></Link>
        <button className="archive-action-button" type="button" aria-pressed={inReadingList} onClick={() => {
          if (!scopeId) return;
          void repository.setReadingList(scopeId, archiveId, !inReadingList).then((result) => {
            if (result.ok) setInReadingList(!result.value.deleted);
            else setMessage(result.error.message);
          });
        }} aria-label={inReadingList ? '移出待看' : '加入待看'} title={inReadingList ? '移出待看' : '加入待看'}>
          {inReadingList ? <BookmarkX aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
          <span className="archive-action-label">{inReadingList ? '移出待看' : '待看'}</span>
        </button>
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

      {/* Confirms the long press. Incognito changes what the app records, so it
          says what it will not do rather than switching mode silently. */}
      <Dialog.Root open={incognitoAsk} onOpenChange={setIncognitoAsk}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>无痕阅读</Dialog.Title>
            <Dialog.Description>本次阅读不会记录进度，也不会写入历史。</Dialog.Description>
            <div className="dialog-actions">
              <Dialog.Close asChild><button className="secondary-action" type="button">取消</button></Dialog.Close>
              <button className="primary-action" type="button" onClick={() => {
                setIncognitoAsk(false);
                navigate(`/reader/${encodeURIComponent(archiveId)}?incognito=1`);
              }}>无痕阅读</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Recommendations sit above the page thumbnails: they are about what to
          read next, not about this archive's pages. */}
      {serverId && scopeId && <Recommendations scopeId={scopeId} serverId={serverId} currentArchiveId={archiveId} tags={tags} />}

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
    </main>
  );
}

function Recommendations({ scopeId, serverId, currentArchiveId, tags }: { scopeId: string; serverId: string; currentArchiveId: string; tags: string[] }) {
  const [similar, setSimilar] = useState<ArchiveRecord[]>([]);
  const [sameCreator, setSameCreator] = useState<ArchiveRecord[]>([]);
  const [loading, setLoading] = useState(tags.length > 0);
  const [tab, setTab] = useState<'similar' | 'creator'>('similar');
  const { open: openContextMenu, menu: contextMenu } = useArchiveContextMenu();
  const creator = useMemo(() => sameCreatorTags(tags), [tags]);

  useEffect(() => {
    if (tags.length === 0) return undefined;
    let active = true;
    setLoading(true);
    const searchByTags = async (seeds: readonly string[]) => {
      const found = new Map<string, ArchiveRecord>();
      for (const seed of seeds) {
        const result = await repository.listArchivesPage(serverId, 0, 100, { query: seed });
        if (!active) return found;
        if (!result.ok) continue;
        for (const archive of result.value.items) {
          if (archive.archiveId !== currentArchiveId) found.set(archive.archiveId, archive);
        }
      }
      return found;
    };

    void (async () => {
      const seeds = pickSeedTags(tags);
      const candidates = await searchByTags(seeds);
      if (!active) return;
      setSimilar(rankRecommendations(tags, [...candidates.values()]).slice(0, 12));
      const creatorMatches = await searchByTags(creator.tags);
      if (!active) return;
      setSameCreator([...creatorMatches.values()].slice(0, 12));
      setLoading(false);
    })();
    return () => { active = false; };
  }, [creator, currentArchiveId, serverId, tags]);

  // One rail with tabs instead of two stacked rails: the section used to take
  // two full card rows before the page thumbnails were even reachable.
  const creatorLabel = creator.namespace === 'cosplayer' ? '同 Coser' : '同作者';
  const activeTab = tab === 'creator' && sameCreator.length === 0 ? 'similar' : tab;
  const visible = activeTab === 'creator' ? sameCreator : similar;
  // The rail draws the panel, so the tabs go inside it as its heading. Rendered
  // as a sibling above, they floated outside the component they belonged to.
  const tabs = (
    <div className="archive-recommendations-tabs" role="tablist" aria-label="推荐分组">
      {similar.length > 0 && (
        <button type="button" role="tab" aria-selected={activeTab === 'similar'} className={activeTab === 'similar' ? 'is-active' : ''} onClick={() => setTab('similar')}>推荐</button>
      )}
      {sameCreator.length > 0 && (
        <button type="button" role="tab" aria-selected={activeTab === 'creator'} className={activeTab === 'creator' ? 'is-active' : ''} onClick={() => setTab('creator')}>{creatorLabel}</button>
      )}
    </div>
  );

  // A skeleton while the searches run, rather than nothing at all: the section
  // used to pop into existence and shove the page thumbnails down.
  if (loading && similar.length === 0 && sameCreator.length === 0) {
    return <ArchiveThumbnailRail title="猜你喜欢" archives={[]} scopeId={scopeId} serverId={serverId} loading skeletonCount={6} />;
  }
  if (similar.length === 0 && sameCreator.length === 0) return null;

  return (
    <>
    <ArchiveThumbnailRail
      title={activeTab === 'creator' ? `${creatorLabel}作品` : '猜你喜欢'}
      archives={visible}
      scopeId={scopeId}
      serverId={serverId}
      headingContent={tabs}
      onArchiveContextMenu={openContextMenu}
    />
    {contextMenu}
    </>
  );
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
    <button ref={setNode} className={`archive-page-thumbnail${src ? '' : ' is-skeleton'}`} type="button" aria-label={`查看第 ${page} 页`} onClick={() => onOpen(page)}>
      {/* Loading is conveyed by the shimmer, the same as library covers; no
          "加载中" text on top of the image slot. */}
      {src ? <img src={src} alt="" loading="lazy" /> : <span className="archive-page-thumbnail-placeholder" aria-hidden="true">{state === 'idle' ? page : ''}</span>}
      <span className="archive-page-thumbnail-number" aria-hidden="true">{page}</span>
    </button>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
