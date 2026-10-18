import { AutoTextarea } from './AutoTextarea';
import { RefreshIcon as RefreshCw } from './RefreshIcon';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookOpen, ExternalLink, MessageCircle, Send } from 'lucide-react';
import { z } from 'zod';
import type { EhComment } from '../services/ehClient';
import { EhCommentSchema, NativeEhRepository } from '../repositories/nativeEhRepository';
import { readStorageSnapshot } from '../lib/storageSnapshot';
import { presentEhError } from '../services/ehClient';
import { useToast } from './Toast';
import { StatusLine } from './StatusLine';
import { openExternalUrl } from '../bridge/externalUrl';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import type { ArchiveRecord } from '../domain/library';

/** 投票用的实心拇指：Material 的 `thumb_up` 那条路径（用户给的图 4 就是这个形状），
 *  不是 Lucide 那套描边字形——描边在 16px 下只剩一圈轮廓，投票方向读不出来。向下那
 *  一枚把同一条路径转 180°，两枚因此永远同形。 */
function ThumbGlyph({ down = false }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
      <path transform={down ? 'rotate(180 12 12)' : undefined} d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66-.23-.45-.52-.86-.88-1.22L14 2 7.59 8.41C7.21 8.79 7 9.3 7 9.83v7.84C7 18.95 8.05 20 9.34 20h8.11c.7 0 1.36-.37 1.72-.97l2.66-6.15z" />
    </svg>
  );
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
  const parts = body.split(/(https?:\/\/[^\s]+)/gi);
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [votingIds, setVotingIds] = useState<ReadonlySet<string>>(new Set());
  const pendingVotes = useRef(new Set<string>());
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const [linkMenu, setLinkMenu] = useState<{ url: string; archives: ArchiveRecord[]; x: number; y: number }>();
  const lookups = useRef(new Map<string, Promise<ArchiveRecord[]>>());
  const linkClick = useRef(0);
  const openExternal = (url: string) => {
    void openExternalUrl(url).then((result) => {
      if (!result.ok) showToast(result.error.message, 'error');
    });
  };
  const openLink = (url: string, event: ReactMouseEvent<HTMLAnchorElement>) => {
    const path = galleryPath(url);
    const lookup = path && onOpenArchive ? lookups.current.get(path) : undefined;
    const click = ++linkClick.current;
    setLinkMenu(undefined);
    if (!lookup) { openExternal(url); return; }
    // Keyboard activation has no pointer position: anchor the menu to the link.
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.detail === 0 ? rect.left : event.clientX;
    const y = event.detail === 0 ? rect.bottom : event.clientY;
    void lookup.then((archives) => {
      if (click !== linkClick.current) return;
      if (archives.length > 0) setLinkMenu({ url, archives, x, y });
      else openExternal(url);
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
    void loadComments(accountId, galleryId, token, reload > 0).then((result) => {
      if (!active) return;
      if (result.ok) setComments(result.value);
      else {
        if (result.cachedComments) setComments(result.cachedComments);
        setError(presentEhError(result.error.code, result.error.message));
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
  return (
    <section className="eh-comments" aria-label="E-Hentai 评论">
      <div className="eh-comments-heading">
        <h2><MessageCircle aria-hidden="true" />E-Hentai 评论</h2>
        <button className="icon-action" type="button" onClick={refresh} disabled={loading} aria-label="刷新 E-Hentai 评论" title="刷新评论"><RefreshCw aria-hidden="true" className={loading ? 'is-spinning' : undefined} /></button>
      </div>
      {error && <StatusLine tone="error">{error}</StatusLine>}
      {loading && comments.length === 0
        ? <StatusLine busy>正在读取评论…</StatusLine>
        : !error && comments.length === 0 ? <StatusLine>暂无评论</StatusLine> : null}
      {comments.length > 0 && <ul className="eh-comments-list">{comments.map((comment) => (
        <li key={comment.id} className={comment.isUploader ? 'is-uploader' : undefined}>
          <div className="eh-comment-meta">
            <span><strong>{comment.author || '匿名用户'}</strong>{comment.isUploader && <small>上传者</small>}</span>
            <time dateTime={comment.postedAt ? comment.postedAt.replace(' ', 'T') : undefined}>{comment.postedAt || '时间未知'}</time>
          </div>
          <p>{renderCommentBody(comment.body, openLink)}</p>
          {!comment.isUploader && <div className="eh-comment-votes">
              <span className="eh-comment-votes-actions" role="group" aria-label={`${comment.author || '匿名用户'} 的评论投票`}>
                {/* Colour and aria-pressed identify the selected direction. */}
                <button type="button" className="is-up" disabled={votingIds.has(comment.id)} aria-label={`赞同 ${comment.author} 的评论`} aria-pressed={comment.myVote === 1} onClick={() => void vote(comment, 1)}><ThumbGlyph /></button>
                <button type="button" className="is-down" disabled={votingIds.has(comment.id)} aria-label={`反对 ${comment.author} 的评论`} aria-pressed={comment.myVote === -1} onClick={() => void vote(comment, -1)}><ThumbGlyph down /></button>
              </span>
            <span className={`eh-comment-score${comment.score < 0 ? ' is-negative' : ''}`} aria-label={`评论分数 ${comment.score}`}>{comment.score > 0 ? `+${comment.score}` : comment.score}</span>
          </div>}
        </li>
      ))}</ul>}
      <div className="eh-comment-composer">
        <AutoTextarea value={body} onChange={(event) => setBody(event.target.value)} aria-label="发表评论" placeholder="发表评论…" rows={3} />
        <button className="primary-action" type="button" disabled={posting || !body.trim()} onClick={() => void post()} aria-label="发送评论"><Send aria-hidden="true" />{posting ? '发送中…' : '发送'}</button>
      </div>
      {linkMenu && <DropdownMenu.Root open onOpenChange={(open) => { if (!open) setLinkMenu(undefined); }}>
        <DropdownMenu.Trigger asChild><span aria-hidden="true" style={{ position: 'fixed', left: linkMenu.x, top: linkMenu.y, width: 0, height: 0 }} /></DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="archive-context-menu" align="start" sideOffset={2} aria-label="评论链接操作">
            <DropdownMenu.Item className="archive-context-menu-item" onSelect={() => openExternal(linkMenu.url)}><ExternalLink aria-hidden="true" />打开链接</DropdownMenu.Item>
            {linkMenu.archives.map((archive) => <DropdownMenu.Item key={archive.archiveId} className="archive-context-menu-item" onSelect={() => onOpenArchive?.(archive)}><BookOpen aria-hidden="true" />{linkMenu.archives.length === 1 ? '打开档案详情' : `打开档案详情：${archive.title}`}</DropdownMenu.Item>)}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>}
    </section>
  );
}
