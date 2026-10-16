import { useArchiveReadingProgress } from './useArchiveReadingProgress';
import { usePageActive } from '../app/RetainedPage';
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
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';

import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { parseArchiveTagString } from '../lib/tags';
import { mirrorFavorites } from '../lib/favoritesMirror';
import { createRecommendationSeed, createSeededShuffle, pickSeedTags, rankRecommendations, sameCreatorTags, sortSameCreatorRecommendations } from '../lib/recommendation';
import { pickServer } from '../domain/server';
import { useTagTranslations } from '../lib/tagTranslationService';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { observeOnceInScroll } from '../lib/sharedIntersectionObserver';
import { invalidateRouteCache, readRouteCache, writeRouteCache } from '../lib/routeCache';
import {
  ArchiveMetadataSchema,
  NativeLibraryRepository,
  type ArchiveMetadata,
} from '../repositories/nativeLibraryRepository';
import type { ArchiveRecord } from '../domain/library';
import { ArchiveRecordSchema } from '../domain/library';
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
import { ArchiveDetailCover, ArchiveDetailFacts, ArchiveDetailTagSection, detailTagTime, useArchiveCover, useDetailTagGroups, useSingleLineTitle } from './ArchiveDetailSections';
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

function readDetailSnapshot(key: string, archiveId: string) {
  const parsed = ArchiveMetadataSchema.safeParse(readRouteCache<unknown>(key, DETAIL_SNAPSHOT_FRESH_MS));
  return parsed.success && parsed.data.archiveId === archiveId ? parsed.data : undefined;
}

function DetailGlyph() {
  return (
    <svg className="detail-panel-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M7 16.5 10.5 13l2.5 2.5 2.5-3 2.5 4" />
      <circle cx="9" cy="8.5" r="1.25" />
    </svg>
  );
}

export function ArchiveDetailRoute({ archiveId, detailBasePath = '/library' }: { archiveId: string; /** See `ArchiveThumbnailCard`: which page owns this detail. The 推荐 rail
 * lives inside the detail, so its cards must keep the detail in the page the
 * reader is already on instead of pulling the left pane over to the library. */
detailBasePath?: string | undefined }) {
  /** The server this archive belongs to, carried by the linking card; without
   * one the first configured server is the default. */
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const serverParam = searchParams.get('server');
  // The server scope is only known after listServers IPC. Keep a second,
  // archive-keyed pointer so a route remount can paint cached metadata on its
  // first render instead of flashing the loading shell while that lookup runs.
  const [metadata, setMetadata] = useState<ArchiveMetadata | undefined>(() => (
    readDetailSnapshot(`archive-detail:last:${serverParam ? `${serverParam}:` : ''}${archiveId}`, archiveId)
  ));
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);
  const [serverId, setServerId] = useState<string>();
  const [scopeId, setScopeId] = useState<string>();
  const favoritePageActive = usePageActive();
  const [favorite, setFavorite] = useState(false);
  const [favoriteReady, setFavoriteReady] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [inReadingList, setInReadingList] = useState(false);
  const [readingBusy, setReadingBusy] = useState(false);
  const readingIdentity = `${serverParam ?? 'default'}:${archiveId}`;
  const readingOwner = useRef({ identity: readingIdentity, generation: 0, busy: false });
  if (readingOwner.current.identity !== readingIdentity) {
    readingOwner.current = { identity: readingIdentity, generation: readingOwner.current.generation + 1, busy: false };
  }
  const [message, setMessage] = useState<string>();
  const favoriteIdentity = `${serverParam ?? 'default'}:${serverId ?? ''}:${archiveId}`;
  const favoriteOwner = useRef({ identity: favoriteIdentity, generation: 0 });
  if (favoriteOwner.current.identity !== favoriteIdentity) {
    favoriteOwner.current = { identity: favoriteIdentity, generation: favoriteOwner.current.generation + 1 };
  }
  const favoriteGeneration = favoriteOwner.current.generation;
  useEffect(() => { setFavorite(false); setFavoriteReady(false); setFavoriteBusy(false); setMessage(undefined); }, [favoriteIdentity]);
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

  useLayoutEffect(() => {
    setIncognitoAsk(false);
    setDeleteOpen(false);
    incognitoPrompted.current = false;
    return () => {
      if (incognitoTimer.current !== undefined) window.clearTimeout(incognitoTimer.current);
      incognitoTimer.current = undefined;
    };
  }, [archiveId, serverParam, favoritePageActive]);

  /** 详情可能开在档案库，也可能开在某个书架上（`/history/…`、`/watchlist/…`、
   *  `/to-read/…`）或首页自己的详情（`/home/…`）：返回与「档案没了」都要回到它来的
   *  那一边——一律送回档案库，从书架或首页点进来的人就换了一个页面。 */
  const shelfBase = useMemo(() => {
    const head = location.pathname.split('/')[1] ?? '';
    if (head === 'home') return '/';
    return ['library', 'history', 'watchlist', 'to-read'].includes(head) ? `/${head}` : '/library';
  }, [location.pathname]);

  /** Back means back. This was a hardcoded link to the library, so arriving from
   * the home shelves and pressing it took you somewhere you had never been.
   * A direct visit has nothing to return to, so that case still falls back. */
  const goBack = useReturnNavigation(shelfBase);
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
    const lastSnapshot = readDetailSnapshot(`archive-detail:last:${serverParam ? `${serverParam}:` : ''}${archiveId}`, archiveId);
    setMetadata(lastSnapshot);
    setMetadataLoading(true);
    setError(undefined);
    setServerId(undefined);
    setScopeId(undefined);
    setFavorite(false);
    setInReadingList(false);
    setReadingBusy(false);
    setFavoriteReady(false);
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
      const scopedLast = readDetailSnapshot(`archive-detail:last:${server.id}:${archiveId}`, archiveId);
      const cached = readDetailSnapshot(`archive-detail:${server.id}:${archiveId}`, archiveId);
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
          navigate(shelfBase, { replace: true });
        } else if (!cached) setError(result.error.message);
        setMetadataLoading(false);
      });
      void ehRepository.listAccounts().then((result) => {
        if (!active || !result.ok) return;
        setEhAccountId(result.value.find((item) => item.isActive && item.status === 'verified')?.id);
      });
    });

    return () => { active = false; };
  }, [archiveId, navigate, serverParam, showToast, retryToken]);

  useEffect(() => {
    if (!serverId) return;
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void repository.readFavoritesCategory(serverId).then(result => {
        if (!active || current !== request) return;
        if (!result.ok) { setMessage(result.error.message); return; }
        setFavorite(result.value?.archives.includes(archiveId) ?? false); setFavoriteReady(true);
      });
    };
    const invalidate = (event: Event) => {
      const prefix = (event as CustomEvent<{ prefix?: string }>).detail?.prefix;
      if (!prefix || prefix === 'favorites:') refresh();
    };
    if (favoritePageActive) refresh();
    window.addEventListener('yomika:route-cache-invalidated', invalidate);
    return () => { active = false; window.removeEventListener('yomika:route-cache-invalidated', invalidate); };
  }, [serverId, archiveId, favoritePageActive]);
  // Sync and other local mutations must update retained detail membership too.
  useEffect(() => {
    if (!scopeId) return;
    let active = true;
    let request = 0;
    const refresh = () => {
      const token = ++request;
      const generation = readingOwner.current.generation;
      void repository.archiveMembership(scopeId, archiveId).then(result => {
        if (!active || token !== request || !result.ok || readingOwner.current.generation !== generation) return;
        setInReadingList(result.value.reading);
      });
    };
    const invalidate = (event: Event) => {
      const prefix = (event as CustomEvent<{ prefix?: string }>).detail?.prefix;
      if (!prefix || prefix === 'state:') refresh();
    };
    if (favoritePageActive) refresh();
    window.addEventListener('yomika:route-cache-invalidated', invalidate);
    return () => { active = false; window.removeEventListener('yomika:route-cache-invalidated', invalidate); };
  }, [scopeId, archiveId, favoritePageActive]);
  // A retained detail does not remount after saving metadata in the editor.
  // Refresh only its metadata on explicit invalidation, never on tab changes.
  useEffect(() => {
    if (!serverId) return;
    let active = true;
    let request = 0;
    const refresh = (event: Event) => {
      const prefix = (event as CustomEvent<{ prefix?: string }>).detail?.prefix;
      if (prefix && prefix !== 'archive-detail:') return;
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
  const progress = useArchiveReadingProgress(scopeId, archiveId);
  const [downloading, setDownloading] = useState(false);
  const downloadOwner = useRef({ identity: readingIdentity, busy: false, active: true });
  if (downloadOwner.current.identity !== readingIdentity) downloadOwner.current = { identity: readingIdentity, busy: false, active: true };
  const currentDownloadOwner = downloadOwner.current;
  useEffect(() => {
    currentDownloadOwner.active = true;
    setDownloading(false);
    return () => { currentDownloadOwner.active = false; };
  }, [currentDownloadOwner]);
  const { open: openMenu, menu } = useArchiveContextMenu({
    hiddenActions: detailActions.filter(action => action !== 'clearProgress' || progress.hasProgress),
    onMembershipChange: (id, list, next) => {
      if (id !== archiveId || favoriteOwner.current.identity !== favoriteIdentity || favoriteOwner.current.generation !== favoriteGeneration) return;
      if (list === 'reading') { readingOwner.current.generation++; readingOwner.current.busy = false; setReadingBusy(false); setInReadingList(next); } else { favoriteOwner.current.generation++; setFavorite(next); }
    },
    onDeleted: () => navigate(shelfBase, { replace: true }),
  });
  const title = metadata?.title || '';
  /** Title fitting: one stable line, stepping the font down a notch at a
   * time when the text still overflows, and letting CSS ellipsis cut the
   * rest to an ellipsis only when even the smallest size cannot fit.
   *
   * 它必须在下面那个早退之前：服务器离线时第一次渲染走的是完整骨架（全部挂钩都
   * 在），metadata 请求失败后第二次渲染落到「读不到」那一支——若这一支少调一个
   * 挂钩，React 会抛 #300（「Rendered fewer hooks than expected」）并**整个应用
   * 一起卸载**，页面就成了一块纯色。 */
  const titleRef = useSingleLineTitle(title);

  if (error && !metadata) {
    return (
      <main className="archive-detail-route">
        <button className="secondary-action" type="button" onClick={goBack}><ArrowLeft aria-hidden="true" />返回</button>
        <p className="form-error" role="alert">{error}</p>
        <button className="secondary-action" type="button" onClick={() => setRetryToken(value => value + 1)}><RotateCcw aria-hidden="true" />重试加载详情</button>
      </main>
    );
  }

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

  return (
    <main data-bounce-surface="" className={`archive-detail-route${metadataLoading ? ' is-loading-metadata' : ''}`} aria-labelledby="archive-detail-route-title">
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
          className="secondary-action"
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
        {detailActions.includes('readingList') && <button className="secondary-action" type="button" disabled={!scopeId || readingBusy} aria-busy={readingBusy} aria-pressed={inReadingList} onClick={() => {
          if (!scopeId || readingOwner.current.busy) return;
          const identity = readingIdentity;
          const generation = ++readingOwner.current.generation;
          const ownsMutation = () => readingOwner.current.identity === identity && readingOwner.current.generation === generation;
          readingOwner.current.busy = true;
          setReadingBusy(true);
          void repository.setReadingList(scopeId, archiveId, !inReadingList).then((result) => {
            if (!ownsMutation()) return;
            if (result.ok) setInReadingList(!result.value.deleted);
            else setMessage(result.error.message);
          }).finally(() => { if (ownsMutation()) { readingOwner.current.busy = false; setReadingBusy(false); } });
        }} aria-label={inReadingList ? '移出待看' : '加入待看'} title={inReadingList ? '移出待看' : '加入待看'}>
          {inReadingList ? <BookmarkX aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
          <span className="archive-action-label">{inReadingList ? '移出待看' : '待看'}</span>
        </button>}
        {detailActions.includes('favorites') && <button disabled={!favoriteReady || favoriteBusy} className="secondary-action" type="button" aria-pressed={favorite} onClick={() => {
          if (!serverId) return;
          const identity = favoriteIdentity;
          const generation = ++favoriteOwner.current.generation;
          const ownsMutation = () => favoriteOwner.current.identity === identity && favoriteOwner.current.generation === generation;
          setFavoriteBusy(true);
          const next = !favorite;
          void mirrorFavorites(serverId, [archiveId], next).then(failed => {
            if (!ownsMutation()) return;
            if (failed) setMessage('未能更新服务器收藏夹');
            else setFavorite(next);
          }).finally(() => { if (ownsMutation()) setFavoriteBusy(false); });
        }} aria-label={favorite ? '取消收藏' : '收藏'} title={favorite ? '取消收藏' : '收藏'}><Heart aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} /><span className="archive-action-label">{favorite ? '取消收藏' : '收藏'}</span></button>}
        {detailActions.includes('download') && <button className="secondary-action" type="button" aria-label="下载档案" title="下载档案" disabled={!serverId || downloading} aria-busy={downloading} onClick={() => {
          if (!serverId || currentDownloadOwner.busy || !currentDownloadOwner.active) return;
          currentDownloadOwner.busy = true;
          setDownloading(true);
          void repository.downloadArchive(serverId, archiveId).then((result) => {
            if (downloadOwner.current !== currentDownloadOwner || !currentDownloadOwner.active) return;
            showToast(result.ok ? downloadResultMessage(result.value) : result.error.message, result.ok ? downloadResultTone(result.value) : 'error');
          }).finally(() => {
            currentDownloadOwner.busy = false;
            if (downloadOwner.current === currentDownloadOwner && currentDownloadOwner.active) setDownloading(false);
          });
        }}><Download aria-hidden="true" /><span className="archive-action-label">下载</span></button>}
        {detailActions.includes('edit') && <button className="secondary-action" type="button" aria-label="编辑元数据" title="编辑元数据" onClick={() => navigate(`/library/${archiveId}/edit${serverId ? `?server=${encodeURIComponent(serverId)}` : ''}`, { state: { returnTo: `${location.pathname}${location.search}`, returnViaHistory: true } })}><Pencil aria-hidden="true" /><span className="archive-action-label">编辑</span></button>}

        {detailActions.includes('clearProgress') && progress.hasProgress && <button className="secondary-action" type="button" aria-label="清除阅读进度" title="清除阅读进度" disabled={progress.busy} aria-busy={progress.busy} onClick={() => { void progress.clear(); }}><RotateCcw aria-hidden="true" /><span className="archive-action-label">清除进度</span></button>}
        {serverId && detailActions.includes('delete') && (
          <><button className="secondary-action" type="button" aria-label="删除档案" title="删除档案" onClick={() => setDeleteOpen(true)}><Trash2 aria-hidden="true" /><span className="archive-action-label">删除</span></button>
          {deleteOpen && <ArchiveDeleteDialog archive={{ serverId, archiveId, title }} onClose={() => setDeleteOpen(false)} onDeleted={() => navigate(shelfBase, { replace: true })} />}</>
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
      {serverId && scopeId && <Recommendations scopeId={scopeId} serverId={serverId} currentArchiveId={archiveId} tags={tags} detailBasePath={detailBasePath} />}

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
        ? <EhComments accountId={ehAccountId} galleryId={ehGallery.galleryId} token={ehGallery.token} serverId={serverId} onOpenArchive={(archive) => navigate(`${detailBasePath}/${encodeURIComponent(archive.archiveId)}?server=${encodeURIComponent(archive.serverId)}`)} />
        : <p className="archive-comments-unavailable">此档案没有可读取的 E-Hentai 评论。</p>}
      </div>
      {menu}
    </main>
  );
}

interface RecommendationSnapshot {
  /** 池子而不是面板：面板那 15 张每次进来要重新按新种子排一遍，池子保持不变就能既
   *  省掉重复搜索、又不让推荐栏每天都是同一份。 */
  similarPool: ArchiveRecord[];
  sameCreator: ArchiveRecord[];
  /** 上一次取数有没有被自己的上限截断（页数用满、中途出错或整段走了镜像回退）。
   *
   * 缓存只是先把上一次的答案画出来；`false` 的意思是「这份答案可能是短的」，
   * 命中缓存后要再搜一次补齐，而不是让一个短答案在这里钉一天。 */
  complete: boolean;
}

type RecommendationTab = 'similar' | 'creator';

/** Recommendations cost up to a dozen searches on the server, and the answer for
 * one archive does not change minute to minute. Stepping back into a detail page
 * should not pay for them again. */
const RECOMMENDATION_SNAPSHOT_FRESH_MS = 24 * 60 * 60 * 1000;

const RecommendationArchiveSchema = ArchiveRecordSchema.extend({ readPages: z.number().int().nonnegative().optional() });
const RecommendationSnapshotSchema = z.object({
  similarPool: RecommendationArchiveSchema.array(),
  sameCreator: RecommendationArchiveSchema.array(),
  complete: z.boolean().default(false),
});

function readRecommendationSnapshot(key: string, serverId: string) {
  const parsed = RecommendationSnapshotSchema.safeParse(readRouteCache<unknown>(key, RECOMMENDATION_SNAPSHOT_FRESH_MS));
  return parsed.success && [...parsed.data.similarPool, ...parsed.data.sameCreator].every(archive => archive.serverId === serverId) ? parsed.data : undefined;
}

/** 一条轨最多摆几张卡。取数不再受它限制：搜到的候选先全进池子（排序后只切给面板）。 */
const RECOMMENDATION_VISIBLE_LIMIT = 15;

/** 池子的上限：够大，能让抖动每次挑出不同的一批；又小到可以整份进快照。 */
const RECOMMENDATION_POOL_LIMIT = 60;

/** 一个种子在服务端翻几页。服务端自己决定一页多大，所以这是往返次数的上限，
 * 不是「这个种子最多贡献多少条」。 */
const RECOMMENDATION_SEED_PAGES = 3;

/** 服务端联系不上时改问镜像，这是给一个种子在镜像上留的额度。 */
const RECOMMENDATION_SEED_LIMIT = 100;

function Recommendations({ scopeId, serverId, currentArchiveId, tags, detailBasePath }: { scopeId: string; serverId: string; currentArchiveId: string; tags: string[]; detailBasePath: string }) {
  const snapshotKey = `recommendations:${serverId}:${currentArchiveId}`;
  const snapshot = useMemo(() => readRecommendationSnapshot(snapshotKey, serverId), [snapshotKey, serverId]);
  // 这次进来用哪个种子：抖动靠它决定，同一次挂载内部（含后台补搜后的重排）保持稳定。
  const [seed] = useState(createRecommendationSeed);
  const [similarPool, setSimilarPool] = useState<ArchiveRecord[]>(snapshot?.similarPool ?? []);
  const [sameCreator, setSameCreator] = useState<ArchiveRecord[]>(snapshot?.sameCreator ?? []);
  // 面板上摆的是池子按本次种子重排后的前几张：池子里的分数带抖动，顺序因此每次不
  // 一样；池子本身不受影响，所以「每次都看到的还是这一批」不会变成看不到新东西。
  const similar = useMemo(
    () => rankRecommendations(tags, similarPool, RECOMMENDATION_VISIBLE_LIMIT, { seed }),
    [seed, similarPool, tags],
  );
  const [loading, setLoading] = useState(tags.length > 0 && !snapshot);
  const [tab, setTab] = useState<RecommendationTab>('similar');
  const [reloadToken, setReloadToken] = useState(0);
  const { open: openContextMenu, menu: contextMenu } = useArchiveContextMenu({
    onDeleted: (archiveId) => {
      setSimilarPool((current) => current.filter((archive) => archive.archiveId !== archiveId));
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
    /** 服务端联系不上时改问镜像：它只有同步过的那部分，但总比空白强。一问镜像就等于
     * 承认这次答案是短的，`complete` 因此恒为 false。 */
    const mirrorSeed = async (seed: string): Promise<{ items: ArchiveRecord[]; complete: boolean }> => {
      const mirrored = await repository.listArchivesPage(serverId, 0, RECOMMENDATION_SEED_LIMIT, { query: seed });
      return { items: mirrored.ok ? mirrored.value.items : [], complete: false };
    };
    /** 服务端才是标签的权威：镜像只有同步过的那一部分，把它当全集时答案就会短一截
     * （同作者栏从前正是这样，而且搜到的条数还被当成 24 小时的定论）。
     *
     * 一个种子按 `has_more` 往后翻，翻不动或到上限为止；半途失败也把已经拿到的那几条
     * 交出来，只有一条都没拿到才回去问镜像。`complete` 记的是这次取数有没有被我们
     * 自己的上限截断——它决定这份答案配不配被缓存锁住。 */
    const searchSeed = async (seed: string): Promise<{ items: ArchiveRecord[]; complete: boolean }> => {
      const items: ArchiveRecord[] = [];
      let start = 0;
      for (let page = 0; page < RECOMMENDATION_SEED_PAGES; page += 1) {
        const result = await repository.searchArchivesPage(serverId, start, { query: seed });
        if (!result.ok) {
          return items.length > 0 ? { items, complete: false } : mirrorSeed(seed);
        }
        items.push(...result.value.items);
        if (!result.value.hasMore || result.value.items.length === 0) return { items, complete: true };
        start += result.value.items.length;
      }
      return { items, complete: false };
    };
    const searchByTags = async (seeds: readonly string[]) => {
      const found = new Map<string, ArchiveRecord>();
      let complete = true;
      if (seeds.length === 0) return { found, complete };
      // 四路并发：一打种子串行要付一打 RTT，推荐栏才出得来。
      const searchOne = async (seed: string) => ({ seed, ...(await searchSeed(seed)) });
      for (let index = 0; index < seeds.length; index += 4) {
        if (!active) return { found, complete: false };
        const responses = await Promise.all(seeds.slice(index, index + 4).map(searchOne));
        if (!active) return { found, complete: false };
        for (const { seed, items, complete: seedComplete } of responses) {
          if (!seedComplete) complete = false;
          const normalizedSeed = seed.trim().toLowerCase();
          for (const archive of items) {
            // LANraragi's text search is a prefix match, not an equality test:
            // `artist:foo` also answers with `artist:foobar`. The seed is a tag
            // copied off this archive, so only the exact tag may come back.
            const hasExactTag = (archive.tags ?? []).some((tag) => tag.trim().toLowerCase() === normalizedSeed);
            if (archive.archiveId !== currentArchiveId && hasExactTag) found.set(archive.archiveId, archive);
          }
        }
      }
      return { found, complete };
    };
    const runSearch = async (progress: ReadonlyMap<string, number>) => {
      // 问哪几个标签也由种子决定：从前的种子集是固定的，同一份标签每次都问同样几个。
      const seeds = pickSeedTags(tags, undefined, createSeededShuffle(seed));
      // 相似与同作者两条搜索互不依赖，并行。
      const [candidates, creatorMatches] = await Promise.all([
        searchByTags(seeds),
        searchByTags(creator.tags),
      ]);
      if (!active) return undefined;
      const ranked = rankRecommendations(tags, addProgress([...candidates.found.values()], progress), Number.MAX_SAFE_INTEGER, { seed });
      const byCreator = sortSameCreatorRecommendations(addProgress([...creatorMatches.found.values()], progress));
      // Verify each rail independently. The native verifier intentionally caps
      // one pass, so a large similarity result must not consume the budget and
      // leave the creator rail's first cards unchecked.
      const [missingSimilar, missingCreator] = await Promise.all([
        findMissingArchives(serverId, ranked.map((archive) => archive.archiveId)),
        findMissingArchives(serverId, byCreator.map((archive) => archive.archiveId)),
      ]);
      if (!active) return undefined;
      return {
        similarPool: ranked.filter((archive) => !missingSimilar.has(archive.archiveId)).slice(0, RECOMMENDATION_POOL_LIMIT),
        sameCreator: byCreator.filter((archive) => !missingCreator.has(archive.archiveId)).slice(0, RECOMMENDATION_VISIBLE_LIMIT),
        complete: candidates.complete && creatorMatches.complete,
      };
    };

    const cached = readRecommendationSnapshot(snapshotKey, serverId);
    if (cached) {
      setLoading(false);
      void (async () => {
        const progress = await loadProgress();
        if (!active) return;
        const cachedSimilar = addProgress(cached.similarPool, progress);
        const cachedCreator = sortSameCreatorRecommendations(addProgress(cached.sameCreator, progress));
        setSimilarPool(cachedSimilar);
        setSameCreator(cachedCreator);
        // A cached recommendation can outlive the remote archive. Revalidate the
        // ids before the next visit writes the stale card back to the DOM.
        const [missingSimilar, missingCreator] = await Promise.all([
          findMissingArchives(serverId, cachedSimilar.map((archive) => archive.archiveId)),
          findMissingArchives(serverId, cachedCreator.map((archive) => archive.archiveId)),
        ]);
        if (!active) return;
        const nextSimilar = cachedSimilar.filter((archive) => !missingSimilar.has(archive.archiveId));
        const nextCreator = cachedCreator.filter((archive) => !missingCreator.has(archive.archiveId));
        setSimilarPool(nextSimilar);
        setSameCreator(nextCreator);
        writeRouteCache(snapshotKey, { similarPool: nextSimilar, sameCreator: nextCreator, complete: cached.complete === true } satisfies RecommendationSnapshot);
        // 上面那份答案可能是短的（页数用满、半途失败、或整段走了镜像），也可能是修复
        // 之前写下的老缓存：卡片先在屏幕上，补齐的那次搜索在后台跑。
        if (cached.complete === true) return;
        const fresh = await runSearch(progress);
        if (!active || !fresh) return;
        setSimilarPool(fresh.similarPool);
        setSameCreator(fresh.sameCreator);
        writeRouteCache(snapshotKey, { similarPool: fresh.similarPool, sameCreator: fresh.sameCreator, complete: fresh.complete } satisfies RecommendationSnapshot);
      })();
      return () => { active = false; };
    }
    setLoading(true);
    void (async () => {
      const progress = await loadProgress();
      if (!active) return;
      const fresh = await runSearch(progress);
      if (!active || !fresh) return;
      setSimilarPool(fresh.similarPool);
      setSameCreator(fresh.sameCreator);
      setLoading(false);
      writeRouteCache(snapshotKey, {
        similarPool: fresh.similarPool,
        sameCreator: fresh.sameCreator,
        complete: fresh.complete,
      } satisfies RecommendationSnapshot);
    })();
    return () => { active = false; };
  }, [creator, currentArchiveId, scopeId, serverId, seed, snapshotKey, tags, reloadToken]);

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
          the strip rather than popping in and shoving the heading sideways.
          `role="presentation"` 不是装饰：这个 span 是 tablist 的直接子节点，不加这一条
          就等于把创建者那个 `role="tab"` 塞进一个通用节点底下——读屏可能不再把它当这条
          tablist 的页签（testing-library 不看归属，所以测试一直是绿的）。 */}
      <span className="archive-recommendations-creator-track" role="presentation">
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
      </span>
    </div>
  );

  // Keep the same rail, header and tab nodes mounted while its data arrives.
  // Replacing the loading root used to discard the CSS transition's starting state.
  if (!loading && !hasSimilar && !hasCreator) return null;

  return (
    <>
    <ArchiveThumbnailRail
      title="推荐"
      archives={visible}
      loading={loading}
      refreshing={loading}
      skeletonCount={6}
      scopeId={scopeId}
      serverId={serverId}
      headingContent={tabs}
      onRefresh={() => { invalidateRouteCache(snapshotKey); setReloadToken((value) => value + 1); }}
      onArchiveContextMenu={openContextMenu}
      detailBasePath={detailBasePath}
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
