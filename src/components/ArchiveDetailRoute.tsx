import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  Bookmark,
  BookmarkX,
  BookOpen,
  Heart,
  Download,
  EyeOff,
  MoreVertical,
  X,
  MessageCircle,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { parseArchiveTagString, FAVORITES_CATEGORY_NAME } from '../lib/tags';
import { pickSeedTags, rankRecommendations, sameCreatorTags, sortSameCreatorRecommendations } from '../lib/recommendation';
import { pickServer } from '../domain/server';
import { useTagTranslations } from '../lib/tagTranslationService';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { observeOnceInScroll } from '../lib/sharedIntersectionObserver';
import { invalidateRouteCache, readRouteCache, writeRouteCache } from '../lib/routeCache';
import {
  NativeLibraryRepository,
  type ArchiveMetadata,
} from '../repositories/nativeLibraryRepository';
import type { ArchiveRecord } from '../domain/library';
import { downloadResultMessage, downloadResultTone } from '../lib/downloadResult';
import { useToast } from './Toast';
import { ArchiveThumbnailRail } from './ArchiveThumbnailCard';
import { useArchiveContextMenu } from './useArchiveContextMenu';
import { useReturnNavigation } from '../lib/useReturnNavigation';
import { ArchiveDeleteDialog } from './ArchiveDeleteDialog';
import { findMissingArchives } from '../lib/archiveExistence';
import { ehGalleryFromTags } from '../lib/archiveDeletion';
import { EhComments } from './EhComments';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { ArchiveDetailCover, ArchiveDetailFacts, ArchiveDetailTagSection, detailTagTime, useArchiveCover, useDetailTagGroups, useTwoLineTitle } from './ArchiveDetailSections';
import { useDetailActions, useDetailDateKind } from '../app/preferences';

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
    readRouteCache<ArchiveMetadata>(`archive-detail:last:${serverParam ? `${serverParam}:` : ''}${archiveId}`, DETAIL_SNAPSHOT_FRESH_MS)
  ));
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
  // 返回手势先关这个确认框，而不是把页面带走（见 overlayBackGuard）。
  useOverlayBackGuard(incognitoAsk, () => setIncognitoAsk(false));
  const [deleteOpen, setDeleteOpen] = useState(false);
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
    const lastSnapshot = readRouteCache<ArchiveMetadata>(`archive-detail:last:${serverParam ? `${serverParam}:` : ''}${archiveId}`, DETAIL_SNAPSHOT_FRESH_MS);
    setMetadata(lastSnapshot);
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

    return () => { active = false; };
  }, [archiveId, navigate, serverParam, showToast]);

  // A retained detail does not remount after saving metadata in the editor.
  // Refresh only its metadata on explicit invalidation, never on tab changes.
  useEffect(() => {
    if (!serverId) return;
    let active = true;
    let request = 0;
    const refresh = (event: Event) => {
      const prefix = (event as CustomEvent<{ prefix?: string }>).detail?.prefix;
      if (prefix !== 'archive-detail:') return;
      const current = ++request;
      void repository.loadArchiveMetadata(serverId, archiveId).then((result) => {
        if (!active || request !== current || !result.ok) return;
        setMetadata(result.value);
        writeRouteCache(`archive-detail:${serverId}:${archiveId}`, result.value);
        writeRouteCache(`archive-detail:last:${serverId}:${archiveId}`, result.value);
        writeRouteCache(`archive-detail:last:${archiveId}`, result.value);
      });
    };
    window.addEventListener('yomika:route-cache-invalidated', refresh);
    return () => { active = false; window.removeEventListener('yomika:route-cache-invalidated', refresh); };
  }, [archiveId, serverId]);

  // 我的标签开启时，每个命名空间组内把账户标记过的标签排到最前（排序发生在
  // 分组之前，分组保持稳定顺序），并把这些芯片染成账户预设的颜色。挂钩必须
  // 全部在早退分支之前。
  const metadataTags = useMemo(() => metadata ? parseArchiveTagString(metadata.tags) : [], [metadata?.tags]);
  const { groups: tagGroups, colorFor: myTagColorFor } = useDetailTagGroups(metadataTags);
  const { cover, loading: coverLoading } = useArchiveCover({ scopeId, serverId, archiveId, enabled: Boolean(scopeId && serverId) });

  const detailActions = useDetailActions();
  const detailDateKind = useDetailDateKind();
  const [downloading, setDownloading] = useState(false);
  const { open: openMenu, menu } = useArchiveContextMenu({
    onMembershipChange: (_id, list, next) => list === 'reading' ? setInReadingList(next) : setFavorite(next),
    onDeleted: () => navigate('/library', { replace: true }),
  });

  if (error && !metadata) {
    return (
      <main className="archive-detail-route">
        <button className="secondary-action" type="button" onClick={goBack}><ArrowLeft aria-hidden="true" />返回</button>
        <p className="form-error" role="alert">{error}</p>
      </main>
    );
  }

  const title = metadata?.title || '';
  const tags = metadataTags;
  const ehGallery = ehGalleryFromTags(tags);
  // The category (and reclass, its override) moved down into the fact grid —
  // the chip row above the facts duplicated it and styled it differently.
  const categoryLabel = tagGroups
    .filter((group) => ['category', 'reclass'].includes(group.namespace))
    .flatMap((group) => group.values.map((tag) => tag.label))
    .join(' · ');
  const dateKind = detailDateKind;
  const facts = [
    { kind: 'pages' as const, label: '页数', value: `${metadata?.pageCount ?? 0} 页` },
    { kind: 'size' as const, label: '体积', value: formatBytes(metadata?.size ?? 0) },
    { kind: 'category' as const, label: '分类', value: categoryLabel },
    dateKind === 'added'
      ? { kind: 'added' as const, label: '添加时间', value: detailTagTime(tags, 'date_added') }
      : { kind: 'published' as const, label: '发布时间', value: detailTagTime(tags, 'timestamp') },
  ];
  /** Title fitting: at most two lines, stepping the font down a notch at a
   * time when the text still overflows, and letting the CSS line-clamp cut the
   * rest to an ellipsis only when even the smallest size cannot fit. */
  const titleRef = useTwoLineTitle(title);

  return (
    <main className={`archive-detail-route${metadataLoading ? ' is-loading-metadata' : ''}`} aria-labelledby="archive-detail-route-title">
      <header className="archive-detail-route-header">
        <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
        <h1 id="archive-detail-route-title" className="archive-detail-route-title" ref={titleRef}>{title || <span className="skeleton-line skeleton-line-title" aria-label="正在加载档案详情" role="status" />}</h1>
        <button className="reader-icon-button" type="button" aria-label="档案菜单" aria-haspopup="menu" title="档案菜单" disabled={!metadata || !serverId} onClick={(event) => {
          if (!metadata || !serverId) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          openMenu({ serverId, archiveId, title, pageCount: metadata.pageCount, fileSize: metadata.size, tags, updatedAt: '' }, { x: bounds.right, y: bounds.bottom });
        }}><MoreVertical aria-hidden="true" /></button>
      </header>

      <div className="archive-detail-overview">
        <ArchiveDetailCover title={title} cover={cover} loading={coverLoading} />
        <div className="archive-detail-overview-copy">
          <ArchiveDetailFacts facts={facts} loading={!metadata} />
        </div>
      </div>


      <div className="archive-detail-route-actions" role="toolbar" aria-label="档案操作" hidden={detailActions.length === 0}>
        {/* Long-press opens incognito. It used to be a button of its own beside
            阅读, which spent a permanent toolbar slot on a rare choice and put a
            second reading entry point next to the real one. */}
        {detailActions.includes('read') && <Link
          className="primary-action"
          to={`/reader/${archiveId}${serverId ? `?server=${encodeURIComponent(serverId)}` : ''}`}
          aria-label="阅读"
          title="阅读（长按进入无痕阅读）"
          onPointerDown={startIncognitoPress}
          onPointerUp={cancelIncognitoPress}
          onPointerLeave={cancelIncognitoPress}
          onPointerCancel={cancelIncognitoPress}
          onClick={(event) => { if (incognitoPrompted.current) { event.preventDefault(); incognitoPrompted.current = false; } }}
          onContextMenu={(event) => event.preventDefault()}
        ><BookOpen aria-hidden="true" /><span className="archive-action-label">阅读</span></Link>}
        {detailActions.includes('readingList') && <button className="secondary-action" type="button" aria-pressed={inReadingList} onClick={() => {
          if (!scopeId) return;
          void repository.setReadingList(scopeId, archiveId, !inReadingList).then((result) => {
            if (result.ok) setInReadingList(!result.value.deleted);
            else setMessage(result.error.message);
          });
        }} aria-label={inReadingList ? '移出待看' : '加入待看'} title={inReadingList ? '移出待看' : '加入待看'}>
          {inReadingList ? <BookmarkX aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
          <span className="archive-action-label">{inReadingList ? '移出待看' : '待看'}</span>
        </button>}
        {detailActions.includes('favorites') && <button className="secondary-action" type="button" aria-pressed={favorite} onClick={() => {
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
        }} aria-label={favorite ? '取消收藏' : '收藏'} title={favorite ? '取消收藏' : '收藏'}><Heart aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} /><span className="archive-action-label">{favorite ? '取消收藏' : '收藏'}</span></button>}
        {detailActions.includes('download') && <button className="secondary-action" type="button" aria-label="下载档案" title="下载档案" disabled={!serverId || downloading} aria-busy={downloading} onClick={() => {
          if (!serverId || downloading) return;
          setDownloading(true);
          void repository.downloadArchive(serverId, archiveId).then((result) => showToast(result.ok ? downloadResultMessage(result.value) : result.error.message, result.ok ? downloadResultTone(result.value) : 'error')).finally(() => setDownloading(false));
        }}><Download aria-hidden="true" /><span className="archive-action-label">下载</span></button>}
        {detailActions.includes('edit') && <button className="secondary-action" type="button" aria-label="编辑元数据" title="编辑元数据" onClick={() => navigate(`/library/${archiveId}/edit${serverId ? `?server=${encodeURIComponent(serverId)}` : ''}`, { state: { returnTo: `/library/${archiveId}` } })}><Pencil aria-hidden="true" /><span className="archive-action-label">编辑</span></button>}

        {serverId && detailActions.includes('delete') && (
          <><button className="secondary-action" type="button" aria-label="删除档案" title="删除档案" onClick={() => setDeleteOpen(true)}><Trash2 aria-hidden="true" /><span className="archive-action-label">删除</span></button>
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
              <Dialog.Close asChild><button className="secondary-action" type="button"><X aria-hidden="true" />取消</button></Dialog.Close>
              <button className="primary-action" type="button" onClick={() => {
                setIncognitoAsk(false);
                navigate(`/reader/${encodeURIComponent(archiveId)}?incognito=1${serverId ? `&server=${encodeURIComponent(serverId)}` : ''}`);
              }}><EyeOff aria-hidden="true" />无痕阅读</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="archive-detail-panel-tabs" role="tablist" aria-label="详情内容">
        <button type="button" role="tab" aria-selected={detailPanel === 'media'} className={detailPanel === 'media' ? 'is-active' : ''} onClick={() => setDetailPanel('media')}><DetailGlyph /><span>详情</span></button>
        <button type="button" role="tab" aria-selected={detailPanel === 'comments'} className={detailPanel === 'comments' ? 'is-active' : ''} onClick={() => setDetailPanel('comments')}><MessageCircle aria-hidden="true" />评论</button>
      </div>

      <div role="tabpanel" aria-label="详情" hidden={detailPanel !== 'media'}>
        {/* 分类、日期这些记账标签在事实网格里已经各占一格，标签墙上不再重复。 */}
        <ArchiveDetailTagSection
          groups={tagGroups.filter((group) => !['category', 'reclass', 'date_added', 'timestamp', 'rating'].includes(group.namespace))}
          loading={metadataLoading && !metadata}
          colorFor={myTagColorFor}
        />
      {serverId && scopeId && <Recommendations scopeId={scopeId} serverId={serverId} currentArchiveId={archiveId} tags={tags} />}

      {metadata && metadata.pageCount > 0 && serverId && scopeId && (
        <section className="archive-page-thumbnails" aria-label="页面缩略图">
          <div className="archive-page-thumbnails-grid">
            {Array.from({ length: metadata.pageCount }, (_, index) => (
              <ArchivePageThumbnail key={index} serverId={serverId} scopeId={scopeId} archiveId={archiveId} page={index + 1} onOpen={(page) => navigate(`/reader/${encodeURIComponent(archiveId)}?page=${page - 1}&server=${encodeURIComponent(serverId)}`)} />
            ))}
          </div>
        </section>
      )}

      {metadata?.summary && <p className="archive-detail-summary">{metadata.summary}</p>}
      </div>
      <div role="tabpanel" aria-label="评论" hidden={detailPanel !== 'comments'}>
      {ehGallery && ehAccountId
        ? <EhComments accountId={ehAccountId} galleryId={ehGallery.galleryId} token={ehGallery.token} />
        : <p className="archive-comments-unavailable">此档案没有可读取的 E-Hentai 评论。</p>}
      </div>
      {menu}
    </main>
  );
}

interface RecommendationSnapshot {
  similar: ArchiveRecord[];
  sameCreator: ArchiveRecord[];
}

type RecommendationTab = 'similar' | 'creator';

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
  const [tab, setTab] = useState<RecommendationTab>('similar');
  const [reloadToken, setReloadToken] = useState(0);
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
      // 四路并发：一打种子串行要付一打 RTT，推荐栏才出得来。
      const searchOne = async (seed: string) => ({
        seed,
        result: await repository.listArchivesPage(serverId, 0, 100, { query: seed }),
      });
      for (let index = 0; index < seeds.length; index += 4) {
        if (!active) return found;
        const responses = await Promise.all(seeds.slice(index, index + 4).map(searchOne));
        if (!active) return found;
        for (const { seed, result } of responses) {
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
      }
      return found;
    };

    void (async () => {
      const progress = await loadProgress();
      if (!active) return;
      const seeds = pickSeedTags(tags);
      // 相似与同作者两条搜索互不依赖，并行。
      const [candidates, creatorMatches] = await Promise.all([
        searchByTags(seeds),
        searchByTags(creator.tags),
      ]);
      if (!active) return;
      const ranked = rankRecommendations(tags, addProgress([...candidates.values()], progress), Number.MAX_SAFE_INTEGER);
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
  }, [creator, currentArchiveId, scopeId, serverId, snapshotKey, tags, reloadToken]);

  // One rail with tabs instead of two stacked rails: the section used to take
  // two full card rows before the page thumbnails were even reachable.
  const creatorLabel = creator.namespace === 'cosplayer' ? '同 Coser' : '同作者';
  const hasSimilar = similar.length > 0;
  const hasCreator = sameCreator.length > 0;
  // 推荐 is what the strip reads by default and it never leaves; the creator
  // segment only exists once there is something behind it. A tab whose list came
  // back empty must not be the one on screen either, or the whole rail vanished
  // while the other tab had matches.
  const activeTab: RecommendationTab = tab === 'creator' && hasCreator ? 'creator'
    : tab === 'similar' && hasSimilar ? 'similar'
      : hasCreator ? 'creator' : 'similar';
  const visible = activeTab === 'creator' ? sameCreator : similar;
  // The rail draws the panel, so the tabs go inside it as its heading. Rendered
  // as a sibling above, they floated outside the component they belonged to.
  const tabs = (
    <div className={`archive-recommendations-tabs${hasCreator ? ' has-creator' : ''}`} role="tablist" aria-label="推荐分组">
      <button type="button" role="tab" aria-selected={activeTab === 'similar'} className={activeTab === 'similar' ? 'is-active' : ''} disabled={!hasSimilar && hasCreator} onClick={() => setTab('similar')}>推荐</button>
      {/* In the DOM from the start, collapsed to nothing: the segment grows out of
          the strip rather than popping in and shoving the heading sideways. */}
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'creator'}
        aria-hidden={!hasCreator}
        tabIndex={hasCreator ? 0 : -1}
        disabled={!hasCreator}
        className={`archive-recommendations-tab-creator${activeTab === 'creator' ? ' is-active' : ''}`}
        onClick={() => setTab('creator')}
      >{creatorLabel}</button>
    </div>
  );

  // A skeleton while the searches run, rather than nothing at all: the section
  // used to pop into existence and shove the page thumbnails down.
  if (loading && !hasSimilar && !hasCreator) {
    return <ArchiveThumbnailRail title="推荐" archives={[]} scopeId={scopeId} serverId={serverId} loading skeletonCount={6} headingContent={tabs} />;
  }
  if (!hasSimilar && !hasCreator) return null;

  return (
    <>
    <ArchiveThumbnailRail
      title="推荐"
      archives={visible}
      scopeId={scopeId}
      serverId={serverId}
      headingContent={tabs}
      onRefresh={() => { invalidateRouteCache(snapshotKey); setReloadToken((value) => value + 1); }}
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
        if (controller.signal.aborted) { getNativeImageCache().release(loaded); return; }
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
    // Browser loading="lazy" only delays decoding an existing URL. Delay the
    // native IPC request as well — but generously: 1200px 约等于视口下方
    // 好几行，正常滚动时缩略图总是先到一步，而不是滚到跟前才出现骨架。
    const stopObserving = observeOnceInScroll(node, load, '1200px');
    return () => {
      stopObserving();
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (handle) getNativeImageCache().release(handle);
    };
  }, [archiveId, node, page, retry, scopeId, serverId]);
  return (
    <button ref={setNode} className={`archive-page-thumbnail${src ? '' : ' is-skeleton'}`} type="button" aria-label={`查看第 ${page} 页`} onClick={() => onOpen(page)}>
      {/* Loading is conveyed by the shimmer, the same as library covers; no
          "加载中" text on top of the image slot. */}
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <span className="archive-page-thumbnail-placeholder" aria-hidden="true">{state === 'idle' ? page : ''}</span>}
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
