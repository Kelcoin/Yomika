import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  Bookmark,
  BookmarkX,
  BookOpen,
  Heart,
  MessageCircle,
  Pencil,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { categorizeSearchableTags, parseArchiveTagString, FAVORITES_CATEGORY_NAME } from '../lib/tags';
import { pickSeedTags, rankRecommendations, sameCreatorTags, sortSameCreatorRecommendations } from '../lib/recommendation';
import { pickServer } from '../domain/server';
import { normalizeMyTagKey, prioritizeByMyTags } from '../lib/ehMyTags';
import { useTagTranslations } from '../lib/tagTranslationService';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { invalidateRouteCache, readRouteCache, writeRouteCache } from '../lib/routeCache';
import {
  NativeLibraryRepository,
  type ArchiveMetadata,
} from '../repositories/nativeLibraryRepository';
import type { ArchiveRecord } from '../domain/library';
import { useToast } from './Toast';
import { ArchiveThumbnailRail } from './ArchiveThumbnailCard';
import { useArchiveContextMenu } from './useArchiveContextMenu';
import { useReturnNavigation } from '../lib/useReturnNavigation';
import { ArchiveDeleteDialog } from './ArchiveDeleteDialog';
import { findMissingArchives } from '../lib/archiveExistence';
import { ehGalleryFromTags } from '../lib/archiveDeletion';
import { EhComments } from './EhComments';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { TagSearchLink } from './TagSearchLink';
import { useEhMyTags } from './useEhMyTags';

const repository = new NativeLibraryRepository();
const ehRepository = new NativeEhRepository();
/** Long enough not to fire on a normal tap, short enough to discover by holding.
 * Matches the platform convention rather than the drag thresholds. */
const LONG_PRESS_MS = 500;

/** How long a detail page may paint from the previous visit before it insists on
 * fresh metadata. It revalidates either way; this only decides whether the page
 * shows a loading state first. */
const DETAIL_SNAPSHOT_FRESH_MS = 10 * 60 * 1000;

function DetailGlyph() {
  return (
    <svg className="detail-panel-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M7 16.5 10.5 13l2.5 2.5 2.5-3 2.5 4" />
      <circle cx="9" cy="8.5" r="1.25" />
    </svg>
  );
}

export function ArchiveDetailRoute({ archiveId }: { archiveId: string }) {
  /** The server this archive belongs to, carried by the linking card; without
   * one the first configured server is the default. */
  const [searchParams] = useSearchParams();
  const serverParam = searchParams.get('server');
  // The server scope is only known after listServers IPC. Keep a second,
  // archive-keyed pointer so a route remount can paint cached metadata on its
  // first render instead of flashing the loading shell while that lookup runs.
  const [metadata, setMetadata] = useState<ArchiveMetadata | undefined>(() => (
    readRouteCache<ArchiveMetadata>(`archive-detail:last:${archiveId}`, DETAIL_SNAPSHOT_FRESH_MS)
  ));
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [coverPreviewOpen, setCoverPreviewOpen] = useState(false);
  const [detailPanel, setDetailPanel] = useState<'media' | 'comments'>('media');
  const [ehAccountId, setEhAccountId] = useState<string>();
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
  useEffect(() => {
    if (!coverPreviewOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setCoverPreviewOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [coverPreviewOpen]);

  /** Back means back. This was a hardcoded link to the library, so arriving from
   * the home shelves and pressing it took you somewhere you had never been.
   * A direct visit has nothing to return to, so that case still falls back. */
  const goBack = useReturnNavigation();
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
    const lastSnapshot = readRouteCache<ArchiveMetadata>(`archive-detail:last:${archiveId}`, DETAIL_SNAPSHOT_FRESH_MS);
    setMetadata(lastSnapshot);
    setCover(undefined);
    setCoverLoading(true);
    setMetadataLoading(true);
    setError(undefined);
    setServerId(undefined);
    setScopeId(undefined);
    setFavorite(false);
    setMessage(undefined);
    setEhAccountId(undefined);
    setDetailPanel('media');

    void repository.listServers().then((servers) => {
      if (!active) return;
      const server = servers.ok ? pickServer(servers.value, serverParam) : undefined;
      if (!server) {
        setCoverLoading(false);
        setError(servers.ok ? '尚未配置服务器' : servers.error.message);
        return;
      }

      setServerId(server.id);
      setScopeId(server.scopeId);

      // Stale while revalidating: the page paints from the last visit's metadata
      // and corrects itself a beat later. Skipping the request instead would show
      // a stale title after the metadata editor wrote a new one.
      const scopedLast = readRouteCache<ArchiveMetadata>(`archive-detail:last:${server.id}:${archiveId}`, DETAIL_SNAPSHOT_FRESH_MS);
      const cached = readRouteCache<ArchiveMetadata>(`archive-detail:${server.id}:${archiveId}`, DETAIL_SNAPSHOT_FRESH_MS);
      if (scopedLast) setMetadata(scopedLast);
      if (cached) {
        setMetadata(cached);
        setMetadataLoading(false);
      } else {
        setMetadata(undefined);
      }
      void repository.loadArchiveMetadata(server.id, archiveId).then((result) => {
        if (!active) return;
        if (result.ok) {
          setMetadata(result.value);
          writeRouteCache(`archive-detail:${server.id}:${archiveId}`, result.value);
          writeRouteCache(`archive-detail:last:${server.id}:${archiveId}`, result.value);
          writeRouteCache(`archive-detail:last:${archiveId}`, result.value);
        } else if (result.error.code === 'LRR_NOT_FOUND') {
          // The recommendation rail is intentionally cached. A remote 404 is
          // authoritative, so invalidate every affected snapshot before
          // leaving the route; otherwise the same stale card reappears when
          // the detail page is opened again.
          invalidateRouteCache('archive-detail:');
          invalidateRouteCache('recommendations:');
          invalidateRouteCache('home:');
          invalidateRouteCache('library:');
          invalidateRouteCache('state:');
          showToast('该档案已从 LANraragi 移除，本地索引已清理', 'info');
          navigate('/library', { replace: true });
        } else if (!cached) setError(result.error.message);
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
      void ehRepository.listAccounts().then((result) => {
        if (!active || !result.ok) return;
        setEhAccountId(result.value.find((item) => item.isActive && item.status === 'verified')?.id);
      });
    });

    return () => {
      active = false;
      coverController.abort();
      if (coverHandle) getNativeImageCache().release(coverHandle);
    };
  }, [archiveId, navigate, serverParam, showToast]);

  // 我的标签开启时，每个命名空间组内把账户标记过的标签排到最前（排序发生在
  // 分组之前，分组保持稳定顺序），并把这些芯片染成账户预设的颜色。挂钩必须
  // 全部在早退分支之前。
  const myTags = useEhMyTags();
  const metadataTags = metadata ? parseArchiveTagString(metadata.tags) : [];
  const tagGroups = useMemo(() => categorizeSearchableTags(prioritizeByMyTags(metadataTags, myTags)), [metadataTags, myTags]);
  const myTagColorFor = useCallback((query: string) => myTags.colors.get(normalizeMyTagKey(query.replace(/\$$/, ''))), [myTags.colors]);

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
  const tags = metadataTags;
  const ehGallery = ehGalleryFromTags(tags);
  return (
    <main className={`archive-detail-route${metadataLoading ? ' is-loading-metadata' : ''}`} aria-labelledby="archive-detail-route-title">
      <header className="archive-detail-route-header">
        <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
        {/* While the metadata is in flight the title keeps a skeleton of its own
            size — it used to show the raw archive id at full title weight while
            a fake title line sat in the copy column below. */}
        {metadataLoading && !metadata
          ? <h1 id="archive-detail-route-title" className="archive-detail-title-loading" role="status" aria-label="正在加载档案详情"><span className="skeleton-line" /></h1>
          : <h1 id="archive-detail-route-title">{title}</h1>}
      </header>

      <div className="archive-detail-overview">
        <div className="archive-detail-route-cover">
          {cover
            ? <button className="archive-detail-cover-trigger" type="button" onClick={() => setCoverPreviewOpen(true)} aria-label={`查看${title}大图`} title="查看大图">
                <img src={cover} alt={`${title} 封面`} />
              </button>
            : <div className={`archive-detail-cover-placeholder${coverLoading ? ' is-skeleton' : ''}`} aria-label={coverLoading ? '正在加载封面' : '暂无封面'} />}
        </div>
        <div className="archive-detail-overview-copy">
          {metadataLoading && !metadata && <div className="archive-detail-copy-skeleton" aria-hidden="true"><div className="skeleton-line skeleton-line-short" /><div className="skeleton-line" /><div className="skeleton-line skeleton-line-short" /><div className="skeleton-line" /></div>}
          {tags.length > 0 && (
            <div className="archive-detail-tags" aria-label="档案标签">
              {tagGroups.map((group, groupIndex) => (
                <section className={`tag-group tag-group-${group.namespace}`} key={group.namespace}>
                  <h2>{group.label}</h2>
                  <div className={`archive-detail-tag-row${groupIndex === tagGroups.length - 1 && metadata ? ' has-meta' : ''}`}>
                    <span className="archive-detail-tag-values">
                      {group.values.map((tag, index) => <TagSearchLink label={tag.label} query={tag.query} color={myTagColorFor(tag.query)} key={`${group.namespace}-${tag.query}-${index}`} />)}
                    </span>
                    {groupIndex === tagGroups.length - 1 && metadata && <span className="archive-detail-meta archive-detail-meta-inline"><span className="metadata-chip metadata-chip-page">{metadata.pageCount} 页</span><span className="metadata-chip metadata-chip-size">{formatBytes(metadata.size)}</span></span>}
                  </div>
                </section>
              ))}
            </div>
          )}
          {/* The footer meta appears once the metadata exists; while it loads
              the copy skeleton above is the loading indicator — a second
              skeleton chip under it read as one squeezed blob. */}
          {tags.length === 0 && metadata && <div className="archive-detail-meta archive-detail-meta-footer"><span className="metadata-chip metadata-chip-page">{metadata.pageCount} 页</span><span className="metadata-chip metadata-chip-size">{formatBytes(metadata.size)}</span></div>}
        </div>
      </div>


      <div className="archive-detail-route-actions" role="toolbar" aria-label="档案操作">
        {/* Long-press opens incognito. It used to be a button of its own beside
            阅读, which spent a permanent toolbar slot on a rare choice and put a
            second reading entry point next to the real one. */}
        <Link
          className="archive-action-button archive-action-primary"
          to={`/reader/${archiveId}${serverId ? `?server=${encodeURIComponent(serverId)}` : ''}`}
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
            // 收藏夹 reads the LANraragi 🔖 Favorites category, so the heart
            // mirrors the write there too — best effort, the local row stays
            // as the offline mirror and for WebDAV sync either way.
            if (!serverId) return;
            void repository.listCategories(serverId).then((categories) => {
              const favorites = categories.ok ? categories.value.find((category) => category.name === FAVORITES_CATEGORY_NAME) : undefined;
              if (!favorites) return;
              const mirrored = !favorite
                ? repository.addArchiveToCategory(serverId, favorites.id, archiveId)
                : repository.removeArchiveFromCategory(serverId, favorites.id, archiveId);
              void mirrored.then((mirrorResult) => { if (!mirrorResult.ok) setMessage('未能同步到服务器收藏夹'); });
            });
          });
        }} aria-label={favorite ? '取消收藏' : '收藏'} title={favorite ? '取消收藏' : '收藏'}><Heart aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} /><span className="archive-action-label">{favorite ? '取消收藏' : '收藏'}</span></button>
        <button className="archive-action-button" type="button" aria-label="编辑元数据" title="编辑元数据" onClick={() => navigate(`/library/${archiveId}/edit${serverId ? `?server=${encodeURIComponent(serverId)}` : ''}`, { state: { returnTo: `/library/${archiveId}` } })}><Pencil aria-hidden="true" /><span className="archive-action-label">编辑</span></button>

        {serverId && (
          <><button className="archive-action-button" type="button" aria-label="删除档案" title="删除档案" onClick={() => setDeleteOpen(true)}><Trash2 aria-hidden="true" /><span className="archive-action-label">删除</span></button>
          {deleteOpen && <ArchiveDeleteDialog archive={{ serverId, archiveId, title }} onClose={() => setDeleteOpen(false)} onDeleted={() => navigate('/library', { replace: true })} />}</>
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
                navigate(`/reader/${encodeURIComponent(archiveId)}?incognito=1${serverId ? `&server=${encodeURIComponent(serverId)}` : ''}`);
              }}>无痕阅读</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {coverPreviewOpen && cover && (
        <div className="archive-cover-preview" role="dialog" aria-modal="true" aria-label={`${title}封面大图`} onClick={() => setCoverPreviewOpen(false)}>
          <img src={cover} alt={`${title} 封面大图`} />
        </div>
      )}

      <div className="archive-detail-panel-tabs" role="tablist" aria-label="详情内容">
        <button type="button" role="tab" aria-selected={detailPanel === 'media'} className={detailPanel === 'media' ? 'is-active' : ''} onClick={() => setDetailPanel('media')}><DetailGlyph /><span>详情</span></button>
        <button type="button" role="tab" aria-selected={detailPanel === 'comments'} className={detailPanel === 'comments' ? 'is-active' : ''} onClick={() => setDetailPanel('comments')}><MessageCircle aria-hidden="true" />评论</button>
      </div>

      {detailPanel === 'media' && serverId && scopeId && <Recommendations scopeId={scopeId} serverId={serverId} currentArchiveId={archiveId} tags={tags} />}

      {detailPanel === 'media' && metadata && metadata.pageCount > 0 && serverId && scopeId && (
        <section className="archive-page-thumbnails" aria-label="页面缩略图">
          <div className="archive-page-thumbnails-grid">
            {Array.from({ length: metadata.pageCount }, (_, index) => (
              <ArchivePageThumbnail key={index} serverId={serverId} scopeId={scopeId} archiveId={archiveId} page={index + 1} onOpen={(page) => navigate(`/reader/${encodeURIComponent(archiveId)}?page=${page - 1}&server=${encodeURIComponent(serverId)}`)} />
            ))}
          </div>
        </section>
      )}

      {metadata?.summary && <p className="archive-detail-summary">{metadata.summary}</p>}
      {ehGallery && ehAccountId
        ? <EhComments accountId={ehAccountId} galleryId={ehGallery.galleryId} token={ehGallery.token} prefetch={detailPanel !== 'comments'} />
        : detailPanel === 'comments' && <p className="archive-comments-unavailable">此档案没有可读取的 E-Hentai 评论。</p>}
    </main>
  );
}

interface RecommendationSnapshot {
  similar: ArchiveRecord[];
  sameCreator: ArchiveRecord[];
}

/** Recommendations cost up to a dozen searches on the server, and the answer for
 * one archive does not change minute to minute. Stepping back into a detail page
 * should not pay for them again. */
const RECOMMENDATION_SNAPSHOT_FRESH_MS = 24 * 60 * 60 * 1000;

function Recommendations({ scopeId, serverId, currentArchiveId, tags }: { scopeId: string; serverId: string; currentArchiveId: string; tags: string[] }) {
  const snapshotKey = `recommendations:${serverId}:${currentArchiveId}`;
  const snapshot = readRouteCache<RecommendationSnapshot>(snapshotKey, RECOMMENDATION_SNAPSHOT_FRESH_MS);
  const [similar, setSimilar] = useState<ArchiveRecord[]>(snapshot?.similar ?? []);
  const [sameCreator, setSameCreator] = useState<ArchiveRecord[]>(snapshot?.sameCreator ?? []);
  const [loading, setLoading] = useState(tags.length > 0 && !snapshot);
  const [tab, setTab] = useState<'similar' | 'creator'>('similar');
  const { open: openContextMenu, menu: contextMenu } = useArchiveContextMenu({
    onDeleted: (archiveId) => {
      setSimilar((current) => current.filter((archive) => archive.archiveId !== archiveId));
      setSameCreator((current) => current.filter((archive) => archive.archiveId !== archiveId));
    },
  });
  const creator = useMemo(() => sameCreatorTags(tags), [tags]);

  useEffect(() => {
    if (tags.length === 0) return undefined;
    let active = true;
    const loadProgress = async () => {
      const result = await repository.listHistory(scopeId);
      if (!result.ok) return new Map<string, number>();
      return new Map(result.value.map((item) => [item.archiveId, item.pageIndex + 1]));
    };
    const addProgress = (archives: readonly ArchiveRecord[], progress: ReadonlyMap<string, number>) => archives.map((archive) => ({
      ...archive,
      readPages: progress.get(archive.archiveId) ?? 0,
    }));
    const cached = readRouteCache<RecommendationSnapshot>(snapshotKey, RECOMMENDATION_SNAPSHOT_FRESH_MS);
    if (cached) {
      setLoading(false);
      void loadProgress().then((progress) => {
        if (!active) return;
        const cachedSimilar = addProgress(cached.similar, progress);
        const cachedCreator = sortSameCreatorRecommendations(addProgress(cached.sameCreator, progress));
        setSimilar(cachedSimilar);
        setSameCreator(cachedCreator);
        // A cached recommendation can outlive the remote archive. Revalidate the
        // ids before the next visit writes the stale card back to the DOM.
        return Promise.all([
          findMissingArchives(serverId, cachedSimilar.map((archive) => archive.archiveId)),
          findMissingArchives(serverId, cachedCreator.map((archive) => archive.archiveId)),
        ]).then(([missingSimilar, missingCreator]) => {
        if (!active || (missingSimilar.size === 0 && missingCreator.size === 0)) return;
        const nextSimilar = cachedSimilar.filter((archive) => !missingSimilar.has(archive.archiveId));
        const nextCreator = cachedCreator.filter((archive) => !missingCreator.has(archive.archiveId));
        setSimilar(nextSimilar);
        setSameCreator(nextCreator);
        writeRouteCache(snapshotKey, { similar: nextSimilar, sameCreator: nextCreator } satisfies RecommendationSnapshot);
      });
      });
      return () => { active = false; };
    }
    setLoading(true);
    const searchByTags = async (seeds: readonly string[]) => {
      const found = new Map<string, ArchiveRecord>();
      if (seeds.length === 0) return found;
      for (const seed of seeds) {
        // The native LANraragi adapter treats a trailing `$` as an exact-tag
        // marker and strips it before querying SQLite. Passing the plain tag
        // here keeps the same exact-match semantics while also working with
        // remote/test adapters that return the original tag text verbatim.
        const result = await repository.listArchivesPage(serverId, 0, 100, { query: seed });
        if (!active) return found;
        if (!result.ok) continue;
        const normalizedSeed = seed.trim().toLowerCase();
        for (const archive of result.value.items) {
          // LANraragi's text search is a substring match; a `$` suffix in
          // the seed means an exact tag, so enforce that part here after the
          // broad server query to prevent `artist:foo` matching
          // `artist:foobar` (and the same issue for taste tags).
          const hasExactTag = (archive.tags ?? []).some((tag) => tag.trim().toLowerCase() === normalizedSeed);
          if (archive.archiveId !== currentArchiveId && hasExactTag) found.set(archive.archiveId, archive);
        }
      }
      return found;
    };

    void (async () => {
      const progress = await loadProgress();
      if (!active) return;
      const seeds = pickSeedTags(tags);
      const candidates = await searchByTags(seeds);
      if (!active) return;
      const ranked = rankRecommendations(tags, addProgress([...candidates.values()], progress), Number.MAX_SAFE_INTEGER);
      const creatorMatches = await searchByTags(creator.tags);
      if (!active) return;
      const byCreator = sortSameCreatorRecommendations(addProgress([...creatorMatches.values()], progress));
      // Verify each rail independently. The native verifier intentionally caps
      // one pass, so a large similarity result must not consume the budget and
      // leave the creator rail's first cards unchecked.
      const [missingSimilar, missingCreator] = await Promise.all([
        findMissingArchives(serverId, ranked.map((archive) => archive.archiveId)),
        findMissingArchives(serverId, byCreator.map((archive) => archive.archiveId)),
      ]);
      if (!active) return;
      const nextSimilar = ranked.filter((archive) => !missingSimilar.has(archive.archiveId)).slice(0, 15);
      const nextCreator = byCreator.filter((archive) => !missingCreator.has(archive.archiveId)).slice(0, 15);
      setSimilar(nextSimilar);
      setSameCreator(nextCreator);
      setLoading(false);
      writeRouteCache(snapshotKey, {
        similar: nextSimilar,
        sameCreator: nextCreator,
      } satisfies RecommendationSnapshot);
    })();
    return () => { active = false; };
  }, [creator, currentArchiveId, serverId, snapshotKey, tags]);

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
    return <ArchiveThumbnailRail title="猜你喜欢" headingIcon={<Sparkles aria-hidden="true" />} archives={[]} scopeId={scopeId} serverId={serverId} loading skeletonCount={6} />;
  }
  if (similar.length === 0 && sameCreator.length === 0) return null;

  return (
    <>
    <ArchiveThumbnailRail
      title={activeTab === 'creator' ? `${creatorLabel}作品` : '猜你喜欢'}
      headingIcon={<Sparkles aria-hidden="true" />}
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
    load();
    return () => {
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
