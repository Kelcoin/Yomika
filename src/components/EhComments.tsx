import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, RefreshCw, Send, ThumbsDown, ThumbsUp } from 'lucide-react';
import { z } from 'zod';
import type { EhComment } from '../services/ehClient';
import { EhCommentSchema, NativeEhRepository } from '../repositories/nativeEhRepository';
import { readStorageSnapshot } from '../lib/storageSnapshot';
import { presentEhError } from '../services/ehClient';
import { useToast } from './Toast';
import { StatusLine } from './StatusLine';

const repository = new NativeEhRepository();
const COMMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const COMMENT_CACHE_STORAGE_PREFIX = 'yomika.eh.comments.v1:';
type CommentsResult = Awaited<ReturnType<NativeEhRepository['getComments']>>;
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
      // Keep a stale snapshot visible when the refresh is blocked by a
      // transient network or Cloudflare failure. A later manual refresh can
      // replace it once the service is reachable again.
      return { ok: true as const, value: cached.comments };
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

function renderCommentBody(body: string) {
  const parts = body.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, index) => /^https?:\/\//i.test(part)
    ? <a key={index} href={part} target="_blank" rel="noreferrer" className="eh-comment-link">{part}</a>
    : <span key={index}>{part}</span>);
}

type EhCommentsProps = { accountId: string; galleryId: string; token: string; prefetch?: boolean };

export function EhComments(props: EhCommentsProps) {
  // Archive routes can reuse this component for another gallery. Drafts and
  // pending mutations belong to the original gallery, never the next one.
  return <EhCommentsPanel key={commentsCacheKey(props.accountId, props.galleryId, props.token)} {...props} />;
}

function EhCommentsPanel({ accountId, galleryId, token, prefetch = false }: EhCommentsProps) {
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

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void loadComments(accountId, galleryId, token, reload > 0).then((result) => {
      if (!active) return;
      if (result.ok) setComments(result.value);
      else setError(presentEhError(result.error.code, result.error.message));
      setLoading(false);
    });
    return () => { active = false; };
  }, [accountId, galleryId, reload, token]);

  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);

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
        <h2><MessageCircle aria-hidden="true" />E-Hentai 评论{comments.length > 0 && <span className="eh-comments-count" aria-label={`${comments.length} 条评论`}>{comments.length}</span>}</h2>
        <button className="icon-action" type="button" onClick={refresh} disabled={loading} aria-label="刷新 E-Hentai 评论" title="刷新评论"><RefreshCw aria-hidden="true" className={loading ? 'is-spinning' : undefined} /></button>
      </div>
      {loading && comments.length === 0
        ? <StatusLine busy>正在读取评论…</StatusLine>
        : !error && comments.length === 0 ? <StatusLine>暂无评论</StatusLine> : null}
      {comments.length > 0 && <ul className="eh-comments-list">{comments.map((comment) => (
        <li key={comment.id} className={comment.isUploader ? 'is-uploader' : undefined}>
          <div className="eh-comment-meta">
            <span><strong>{comment.author || '匿名用户'}</strong>{comment.isUploader && <small>上传者</small>}</span>
            {!comment.isUploader && <span className={`eh-comment-score${comment.score < 0 ? ' is-negative' : ''}`} aria-label={`评论分数 ${comment.score}`}>{comment.score > 0 ? `+${comment.score}` : comment.score}</span>}
          </div>
          <p>{renderCommentBody(comment.body)}</p>
          <div className="eh-comment-votes">
            <time dateTime={comment.postedAt ? comment.postedAt.replace(' ', 'T') : undefined}>{comment.postedAt || '时间未知'}</time>
            {!comment.isUploader && (
              <span className="eh-comment-votes-actions" role="group" aria-label={`${comment.author || '匿名用户'} 的评论投票`}>
                {/* The paired controls share one frame; the selected
                    direction is announced by the theme fill and aria-pressed,
                    and clicking it again cancels the vote. */}
                <button type="button" className="is-up" disabled={votingIds.has(comment.id)} aria-label={`赞同 ${comment.author} 的评论`} aria-pressed={comment.myVote === 1} onClick={() => void vote(comment, 1)}><ThumbsUp aria-hidden="true" /></button>
                <button type="button" className="is-down" disabled={votingIds.has(comment.id)} aria-label={`反对 ${comment.author} 的评论`} aria-pressed={comment.myVote === -1} onClick={() => void vote(comment, -1)}><ThumbsDown aria-hidden="true" /></button>
              </span>
            )}
          </div>
        </li>
      ))}</ul>}
      <div className="eh-comment-composer">
        <textarea value={body} onChange={(event) => setBody(event.target.value)} aria-label="发表评论" placeholder="发表评论…" rows={3} />
        <button className="primary-action" type="button" disabled={posting || !body.trim()} onClick={() => void post()} aria-label="发送评论"><Send aria-hidden="true" />{posting ? '发送中…' : '发送'}</button>
      </div>
    </section>
  );
}
