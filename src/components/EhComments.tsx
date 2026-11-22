import { useEhCommentSort } from '../app/preferences';
import { PositionedMenu } from './PositionedMenu';
import { ContentSkeleton } from './ContentSkeleton';
import { AutoTextarea } from './AutoTextarea';
import { RefreshIcon as RefreshCw } from './RefreshIcon';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MessageCircle, MessageCircleOff, Send } from 'lucide-react';
import { z } from 'zod';
import type { EhComment } from '../services/ehClient';
import { EhCommentSchema, NativeEhRepository } from '../repositories/nativeEhRepository';
import { readStorageSnapshot } from '../lib/storageSnapshot';
import { presentEhError } from '../services/ehClient';
import { useToast } from './Toast';
import { StatusLine } from './StatusLine';
import { EmptyState } from './EmptyState';
import { openExternalUrl } from '../bridge/externalUrl';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import type { ArchiveRecord } from '../domain/library';
import { EhGalleryDetail } from './EhGalleryDetail';
import { readableCommentText } from '../lib/commentText';
import { useLoadingReveal } from '../lib/useLoadingReveal';
import { SvgIcon } from './SvgIcon';
import { StateIcon } from './StateIcon';

const commentBubblePath = 'M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.5-.75L4 20.5l1.25-4.5A8.5 8.5 0 1 1 20.5 11.5Z';

type CommentLoadError = { code: string; message: string };

function commentLoadGlyph(loading: boolean, error?: CommentLoadError): { label: string; path: string } {
  if (loading) return { label: '正在加载评论', path: `${commentBubblePath} M8.5 11.5h.01m3.49 0h.01m3.49 0h.01` };
  if (!error) return { label: '评论加载成功', path: commentBubblePath };

  switch (error.code) {
    case 'NETWORK':
    case 'EH_UNAVAILABLE':
      return { label: '连接失败', path: 'm3 3 18 18M2 8.5a16 16 0 0 1 2.4-1.7m4.2-1.7A16 16 0 0 1 22 8.5M5 12a11 11 0 0 1 3.3-2m4.8-.7A11 11 0 0 1 19 12M8.5 15.5a5 5 0 0 1 4.9-1.15M12 19h.01' };
    case 'EH_GALLERY_DELETED':
    case 'EH_GALLERY_COPYRIGHT_REMOVED':
      return { label: '画廊不可用', path: 'm3 3 18 18M9.5 3.4a8.5 8.5 0 0 1 10.6 10.7M16.75 18.55A8.5 8.5 0 0 1 8.5 19.25L4 20.5l1.25-4.5a8.5 8.5 0 0 1 .2-8.25' };
    case 'EH_UNAUTHORIZED':
    case 'EH_REAUTH_REQUIRED':
    case 'EH_ACCESS_BLOCKED':
    case 'EH_CONTENT_WARNING':
    case 'EH_CLOUDFLARE':
      return { label: '访问受限', path: `${commentBubblePath} M9 11h6v4H9z M10 11V9a2 2 0 0 1 4 0v2` };
    default:
      return { label: '评论加载失败', path: `${commentBubblePath} M12 8v4m0 3h.01` };
  }
}

function GalleryDestinationGlyph({ local = false }: { local?: boolean }) {
  return <SvgIcon>
    {local ? <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></>
      : <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01M16 12l-4 5-2-2-3 3M16 12h-4m4 0v4" /></>}
  </SvgIcon>;
}

const repository = new NativeEhRepository();
const libraryRepository = new NativeLibraryRepository();
const COMMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const COMMENT_CACHE_STORAGE_PREFIX = 'yomika.eh.comments.v1:';
type CommentsResult = Awaited<ReturnType<NativeEhRepository['getComments']>> & { cachedComments?: EhComment[] };
type CommentsCacheEntry = { comments: EhComment[]; cachedAt: number };
const CommentsCacheSchema = z.object({ comments: EhCommentSchema.array(), cachedAt: z.number().finite() });
const commentsCache = new Map<string, CommentsCacheEntry>();
const commentsInflight = new Map<string, Promise<CommentsResult>>();

function commentsCacheKey(accountId: string, galleryId: string, token: string): string {
  return `${accountId}\u0000${galleryId}\u0000${token}`;
}

function loadComments(accountId: string, galleryId: string, token: string, force = false): Promise<CommentsResult> {
  const key = commentsCacheKey(accountId, galleryId, token);
  const cached = commentsCache.get(key) ?? readPersistedComments(key);
  if (cached && !commentsCache.has(key)) commentsCache.set(key, cached);
  if (!force && cached && Date.now() - cached.cachedAt < COMMENT_CACHE_TTL_MS) {
    return Promise.resolve({ ok: true, value: cached.comments });
  }
  const existing = commentsInflight.get(key);
  if (existing) return existing;
  const request = repository.getComments(accountId, galleryId, token).then((result) => {
    if (result.ok) {
      const entry = { comments: result.value, cachedAt: Date.now() };
      commentsCache.set(key, entry);
      writePersistedComments(key, entry);
    } else if (cached) {
      // Preserve the snapshot without disguising a failed refresh as success:
      // the panel must explain why the current gallery could not be read.
      return { ...result, cachedComments: cached.comments };
    }
    return result;
  }).finally(() => {
    commentsInflight.delete(key);
  });
  commentsInflight.set(key, request);
  return request;
}

function invalidateComments(accountId: string, galleryId: string, token: string): void {
  const key = commentsCacheKey(accountId, galleryId, token);
  commentsCache.delete(key);
  try { window.localStorage.removeItem(`${COMMENT_CACHE_STORAGE_PREFIX}${key}`); } catch { /* storage unavailable */ }
}

function readPersistedComments(key: string): CommentsCacheEntry | undefined {
  return readStorageSnapshot(`${COMMENT_CACHE_STORAGE_PREFIX}${key}`, CommentsCacheSchema);
}

function writePersistedComments(key: string, entry: CommentsCacheEntry): void {
  try { window.localStorage.setItem(`${COMMENT_CACHE_STORAGE_PREFIX}${key}`, JSON.stringify(entry)); } catch { /* storage unavailable */ }
}

/** Keeps isolated component tests from sharing module-level comment snapshots. */
export function clearEhCommentsCacheForTests(): void {
  commentsCache.clear();
  commentsInflight.clear();
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(COMMENT_CACHE_STORAGE_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
}

function galleryPath(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!['e-hentai.org', 'exhentai.org', 'www.e-hentai.org', 'www.exhentai.org'].includes(url.hostname.toLowerCase())) return undefined;
    return url.pathname.match(/^\/g\/\d+\/[a-z0-9]+(?=\/|$)/i)?.[0];
  } catch { return undefined; }
}

function renderCommentBody(body: string, openLink: (url: string, event: ReactMouseEvent<HTMLAnchorElement>) => void) {
  const parts = readableCommentText(body).split(/(https?:\/\/[^\s]+)/gi);
  return parts.map((part, index) => /^https?:\/\//i.test(part)
    ? <a key={index} href={part} className="eh-comment-link" onClick={(event) => { event.preventDefault(); openLink(part, event); }} onAuxClick={(event) => { event.preventDefault(); if (event.button === 1) openLink(part, event); }}>{part}</a>
    : <span key={index}>{part}</span>);
}

type EhCommentsProps = { accountId: string; galleryId: string; token: string; prefetch?: boolean; serverId?: string | undefined; onOpenArchive?: ((archive: ArchiveRecord) => void) | undefined };

export function EhComments(props: EhCommentsProps) {
  // Archive routes can reuse this component for another gallery. Drafts and
  // pending mutations belong to the original gallery, never the next one.
  return <EhCommentsPanel key={`${props.serverId ?? ''}:${commentsCacheKey(props.accountId, props.galleryId, props.token)}`} {...props} />;
}

function EhCommentsPanel({ accountId, galleryId, token, prefetch = false, serverId, onOpenArchive }: EhCommentsProps) {
  const { showToast } = useToast();
  const [comments, setComments] = useState<EhComment[]>([]);
  const sort = useEhCommentSort();
  const orderedComments = useMemo(() => {
    const direction = sort === 'score-desc' ? -1 : 1;
    return [...comments].sort((a, b) => {
      if (a.isUploader !== b.isUploader) return a.isUploader ? -1 : 1;
      if (a.isUploader || sort === 'gallery') return 0;
      return direction * (a.score - b.score);
    });
  }, [comments, sort]);
  const [loading, setLoading] = useState(true);
  const sectionRef = useRef<HTMLElement>(null);
  useLoadingReveal(sectionRef, loading);
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<CommentLoadError>();
  const [reload, setReload] = useState(0);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [votingIds, setVotingIds] = useState<ReadonlySet<string>>(new Set());
  const pendingVotes = useRef(new Set<string>());
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const [linkMenu, setLinkMenu] = useState<{ url: string; archives: ArchiveRecord[]; x: number; y: number }>();
  const [linkedGallery, setLinkedGallery] = useState<{ galleryId: string; token: string }>();
  const lookups = useRef(new Map<string, Promise<ArchiveRecord[]>>());
  const linkClick = useRef(0);
  const openExternal = (url: string) => {
    void openExternalUrl(url).then((result) => {
      if (!result.ok) showToast(result.error.message, 'error');
    });
  };
  const openLink = (url: string, event: ReactMouseEvent<HTMLAnchorElement>) => {
    const path = galleryPath(url);
    const openGallery = () => {
      const match = path?.match(/^\/g\/(\d+)\/([a-z0-9]+)$/i);
      if (match) setLinkedGallery({ galleryId: match[1]!, token: match[2]! });
      else openExternal(url);
    };
    const lookup = path && onOpenArchive ? lookups.current.get(path) : undefined;
    const click = ++linkClick.current;
    setLinkMenu(undefined);
    if (!lookup) { openGallery(); return; }
    // Keyboard activation has no pointer position: anchor the menu to the link.
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.detail === 0 ? rect.left : event.clientX;
    const y = event.detail === 0 ? rect.bottom : event.clientY;
    void lookup.then((archives) => {
      if (click !== linkClick.current) return;
      if (archives.length > 0) setLinkMenu({ url, archives, x, y });
      else openGallery();
    });
  };

  const linkedPaths = [...new Set(comments.flatMap((comment) =>
    (comment.body.match(/https?:\/\/[^\s]+/gi) ?? []).flatMap((url) => galleryPath(url) ?? []),
  ))].sort().join('\n');
  useEffect(() => {
    let active = true;
    const pending = new Map<string, Promise<ArchiveRecord[]>>();
    lookups.current = pending;
    setLinkMenu(undefined);
    linkClick.current++;
    // Two queues bound server load while unrelated links can resolve concurrently.
    const queues: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
    if (serverId && linkedPaths) linkedPaths.split('\n').forEach((path, index) => {
      const slot = index % queues.length;
      const request = queues[slot]!.then(async () => {
        if (!active) return [];
        const result = await libraryRepository.searchArchivesPage(serverId, 0, { query: path });
        return result.ok ? result.value.items.filter((archive) => !archive.isDeleted) : [];
      });
      pending.set(path, request);
      queues[slot] = request;
    });
    return () => { active = false; linkClick.current++; };
  }, [serverId, linkedPaths, reload]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setLoadError(undefined);
    void loadComments(accountId, galleryId, token, reload > 0).then((result) => {
      if (!active) return;
      if (result.ok) setComments(result.value);
      else {
        if (result.cachedComments) setComments(result.cachedComments);
        setLoadError({ code: result.error.code, message: presentEhError(result.error.code, result.error.message) });
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [accountId, galleryId, reload, token]);

  const vote = async (comment: EhComment, value: 1 | -1) => {
    if (pendingVotes.current.has(comment.id)) return;
    pendingVotes.current.add(comment.id);
    // Clicking the direction already voted sends the vote again — E-Hentai
    // toggles it off, so the row flips back to an unvoted state.
    const cancelling = comment.myVote === value;
    setVotingIds(new Set(pendingVotes.current));
    setError(undefined);
    // The API answers with the comment's new score, so the row updates in
    // place instead of refetching the whole list.
    const result = await repository.voteComment(accountId, galleryId, token, comment.id, value);
    pendingVotes.current.delete(comment.id);
    setVotingIds(new Set(pendingVotes.current));
    if (result.ok) {
      const nextVote = cancelling ? 0 : value;
      setComments((current) => current.map((item) => (
        item.id === comment.id
          ? { ...item, score: result.value, myVote: nextVote }
          : item
      )));
      // Keep the persisted snapshot in step with the in-place update.
      const key = commentsCacheKey(accountId, galleryId, token);
      const cached = commentsCache.get(key);
      if (cached) {
        const updated = { comments: cached.comments.map((item) => item.id === comment.id ? { ...item, score: result.value, myVote: nextVote } : item), cachedAt: cached.cachedAt };
        commentsCache.set(key, updated);
        writePersistedComments(key, updated);
      }
    }
    else setError(presentEhError(result.error.code, result.error.message));
  };

  const post = async () => {
    const text = body.trim();
    if (!text) return;
    setPosting(true);
    setError(undefined);
    const result = await repository.postComment(accountId, galleryId, token, text);
    setPosting(false);
    if (result.ok) {
      setBody('');
      invalidateComments(accountId, galleryId, token);
      refresh();
    }
    else setError(presentEhError(result.error.code, result.error.message));
  };

  if (prefetch) return null;
  const loadGlyph = commentLoadGlyph(loading, loadError);
  const loadLabel = loadError && comments.length > 0 ? `${loadGlyph.label}，正在显示缓存评论` : loadGlyph.label;

  return (
    <section ref={sectionRef} className="eh-comments" aria-label="E-Hentai 评论">
      <div className="eh-comments-heading">
        <h2>
          <SvgIcon role="img" aria-hidden={false} aria-label={loadLabel}>
            <title>{loadError ? `${loadLabel}。${loadError.message}` : loadLabel}</title>
            <path d={loadGlyph.path} />
          </SvgIcon>
          E-Hentai 评论
        </h2>
        <button className="icon-action" type="button" onClick={refresh} disabled={loading} aria-label="刷新 E-Hentai 评论" title="刷新评论"><RefreshCw aria-hidden="true" className={loading ? 'is-spinning' : undefined} /></button>
      </div>
      <div className="eh-comments-content">
        {loadError && comments.length === 0 && <div className="eh-comments-unavailable" role="alert">
          <EmptyState compact icon={MessageCircleOff} title={loadError.message} />
        </div>}
        {error && <StatusLine tone="error">{error}</StatusLine>}
        {loading && comments.length === 0
          ? <ContentSkeleton label="正在读取评论" variant="comments" rows={2} />
          : !loadError && comments.length === 0 ? <EmptyState compact icon={MessageCircle} title="暂无评论" /> : null}
        {comments.length > 0 && <ul className="eh-comments-list">{orderedComments.map((comment) => (
          <li key={comment.id} className={comment.isUploader ? 'is-uploader' : undefined}>
            <div className="eh-comment-meta">
              <span><strong>{readableCommentText(comment.author) || '匿名用户'}</strong>{comment.isUploader && <small>上传者</small>}</span>
              <time dateTime={comment.postedAt ? comment.postedAt.replace(' ', 'T') : undefined}>{comment.postedAt || '时间未知'}</time>
            </div>
            <p>{renderCommentBody(comment.body, openLink)}</p>
            {!comment.isUploader && <div className="eh-comment-votes">
                <span className="eh-comment-votes-actions" role="group" aria-label={`${comment.author || '匿名用户'} 的评论投票`}>
                  <button type="button" className="is-up" disabled={votingIds.has(comment.id)} aria-label={`赞同 ${comment.author} 的评论`} aria-pressed={comment.myVote === 1} onClick={() => void vote(comment, 1)}><StateIcon name="thumbUp" selected={comment.myVote === 1} /></button>
                  <button type="button" className="is-down" disabled={votingIds.has(comment.id)} aria-label={`反对 ${comment.author} 的评论`} aria-pressed={comment.myVote === -1} onClick={() => void vote(comment, -1)}><StateIcon name="thumbDown" selected={comment.myVote === -1} /></button>
                </span>
              <span className={`eh-comment-score${comment.score < 0 ? ' is-negative' : ''}`} aria-label={`评论分数 ${comment.score}`}>{comment.score > 0 ? `+${comment.score}` : comment.score}</span>
            </div>}
          </li>
        ))}</ul>}
      </div>
      {!loading && !loadError && <div className="eh-comment-composer">
        <AutoTextarea value={body} onChange={(event) => setBody(event.target.value)} aria-label="发表评论" placeholder="发表评论…" rows={3} />
        <button className="primary-action" type="button" disabled={posting || !body.trim()} onClick={() => void post()} aria-label="发送评论"><Send aria-hidden="true" />{posting ? '发送中…' : '发送'}</button>
      </div>}
      {linkMenu && <PositionedMenu at={linkMenu} label="评论链接操作" className="eh-comment-link-menu" onClose={() => setLinkMenu(undefined)}>
            <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => {
              const match = galleryPath(linkMenu.url)?.match(/^\/g\/(\d+)\/([a-z0-9]+)$/i);
              if (match) setLinkedGallery({ galleryId: match[1]!, token: match[2]! });
            }}><GalleryDestinationGlyph />跳转E站详情</DropdownMenu.Item>
            {linkMenu.archives.map((archive) => <DropdownMenu.Item key={archive.archiveId} className="archive-context-menu-item" onSelect={() => onOpenArchive?.(archive)}><GalleryDestinationGlyph local />{linkMenu.archives.length === 1 ? '跳转LRR详情' : `跳转LRR详情：${archive.title}`}</DropdownMenu.Item>)}
          </PositionedMenu>}
      {linkedGallery && <EhGalleryDetail key={`${linkedGallery.galleryId}:${linkedGallery.token}`} accountId={accountId} {...linkedGallery} onClose={() => setLinkedGallery(undefined)} />}
    </section>
  );
}
