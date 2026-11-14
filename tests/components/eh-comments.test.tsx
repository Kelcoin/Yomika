import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { clearEhCommentsCacheForTests, EhComments } from '../../src/components/EhComments';
import { ToastProvider } from '../../src/components/Toast';

afterEach(() => {
  resetInvokeAdapterForTests();
  clearEhCommentsCacheForTests();
  vi.restoreAllMocks();
});

const comment = {
  id: '777',
  author: 'Reader',
  body: 'Useful comment',
  score: 4,
  postedAt: '2026-09-07 10:30',
  isUploader: false,
  isEditable: false,
  myVote: 0,
};

const gallery = {
  title: 'Linked EH gallery', category: 'Manga', uploader: 'Artist', pageCount: 42,
  size: '20 MB', posted: '2026-11-13', tags: [], cover: null,
  favoriteCategory: null, favoriteCategories: ['Default', 'Comics'], favoriteNote: '', thumbnails: [], thumbnailPageCount: 1,
};

describe('E-Hentai comments', () => {
  it.each([-1, 0, 1])('draws only the current vote as filled (vote=%s)', async myVote => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: [{ ...comment, myVote }] }));
    render(<EhComments accountId="eh-a" galleryId="vote-icons" token="abc" />);
    const up = await screen.findByRole('button', { name: '赞同 Reader 的评论' });
    const down = screen.getByRole('button', { name: '反对 Reader 的评论' });
    expect(up).toHaveAttribute('aria-pressed', String(myVote === 1));
    expect(down).toHaveAttribute('aria-pressed', String(myVote === -1));
    expect(up.querySelector('svg')).toHaveAttribute('data-icon-state', myVote === 1 ? 'filled' : 'outline');
    expect(down.querySelector('svg')).toHaveAttribute('data-icon-state', myVote === -1 ? 'filled' : 'outline');
  });

  it('preloads EH suffix matches, deduplicates hosts and offers an anchored archive choice', async () => {
    const archive = { serverId: 's', archiveId: 'matched', title: 'Matched archive', pageCount: 10, updatedAt: 'now' };
    const onOpenArchive = vi.fn();
    let finishSearch!: (value: unknown) => void;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'get_eh_comments') return { ok: true, value: [{ ...comment, body: 'https://e-hentai.org/g/4256859/531b16d2ae https://exhentai.org/g/4256859/531b16d2ae/' }] };
      if (command === 'search_archives_page') return new Promise(resolve => { finishSearch = resolve; });
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" serverId="s" onOpenArchive={onOpenArchive} />);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('search_archives_page', { input: expect.objectContaining({ serverId: 's', query: '/g/4256859/531b16d2ae' }) }));
    expect(adapter.mock.calls.filter(([command]) => command === 'search_archives_page')).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: 'https://exhentai.org/g/4256859/531b16d2ae/' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await act(async () => finishSearch({ ok: true, value: { items: [archive], total: 1, hasMore: false } }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '跳转LRR详情' }));
    expect(onOpenArchive).toHaveBeenCalledWith(expect.objectContaining({ archiveId: 'matched' }));
    expect(adapter.mock.calls.some(([command]) => command === 'open_external_url')).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'https://e-hentai.org/g/4256859/531b16d2ae' }));
    expect(await screen.findByRole('menuitem', { name: '跳转E站详情' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: '打开链接' })).not.toBeInTheDocument();
    expect(adapter.mock.calls.filter(([command]) => command === 'search_archives_page')).toHaveLength(1);
  });

  it.each([false, true])('opens unmatched or failed EH lookups in authenticated gallery details (failure=%s)', async failure => {
    const url = 'https://e-hentai.org/g/4256859/531b16d2ae';
    const adapter = vi.fn(async (command: string) => {
      if (command === 'get_eh_gallery') return { ok: true, value: gallery };
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'get_eh_comments') return { ok: true, value: [{ ...comment, body: url }] };
      if (command === 'search_archives_page') return failure
        ? { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'Offline', retryable: true } }
        : { ok: true, value: { items: [], total: 0, hasMore: false } };
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" serverId="s" onOpenArchive={vi.fn()} />);
    fireEvent.click(await screen.findByRole('link', { name: url }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('get_eh_gallery', { accountId: 'eh-a', galleryId: '4256859', token: '531b16d2ae', page: 0 }));
    expect(await screen.findByRole('heading', { name: gallery.title })).toBeInTheDocument();
    expect(adapter.mock.calls.some(([command]) => command === 'open_external_url')).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens EH links directly without a LANraragi match and saves the chosen EH favorite category and note', async () => {
    const url = 'https://exhentai.org/g/4256859/531b16d2ae/';
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_eh_gallery') return { ok: true, value: gallery };
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'get_eh_comments') return { ok: true, value: args?.galleryId === '12345' ? [{ ...comment, body: url }] : [] };
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><EhComments accountId="eh-a" galleryId="12345" token="abc" /></ToastProvider>);
    fireEvent.click(await screen.findByRole('link', { name: url }));
    await screen.findByRole('heading', { name: gallery.title });
    expect(within(screen.getByRole('toolbar', { name: '画廊操作' })).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑收藏备注' }));
    fireEvent.change(screen.getByRole('textbox', { name: '收藏备注' }), { target: { value: 'Keep this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comics' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('set_eh_gallery_favorite', {
      accountId: 'eh-a', galleryId: '4256859', token: '531b16d2ae', category: 1, note: 'Keep this',
    }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '收藏' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    expect(screen.getByRole('button', { name: 'Comics' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('set_eh_gallery_favorite', {
      accountId: 'eh-a', galleryId: '4256859', token: '531b16d2ae', category: 0, note: 'Keep this',
    }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: '选择收藏夹' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('remove_eh_favorite', { accountId: 'eh-a', galleryId: '4256859', token: '531b16d2ae' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '收藏' })).toHaveAttribute('aria-pressed', 'false'));
    fireEvent.click(screen.getByRole('button', { name: '返回评论' }));
    expect(screen.queryByRole('dialog', { name: '画廊详情' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: url })).toBeVisible();
  });

  it('loads authenticated cover and shared thumbnail sprites, translates category and paginates', async () => {
    const url = 'https://exhentai.org/g/4256859/531b16d2ae/';
    const cover = 'https://s.exhentai.org/t/cover.jpg';
    const sprite = 'https://test.hath.network/sprite.jpg';
    const image = 'data:image/png;base64,aGVsbG8=';
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'get_eh_comments') return { ok: true, value: args?.galleryId === '12345' ? [{ ...comment, body: url }] : [] };
      if (command === 'get_eh_gallery_image') return { ok: true, value: image };
      if (command === 'get_eh_gallery') return { ok: true, value: { ...gallery, cover, pageCount: 4, thumbnailPageCount: 2, thumbnails: [
        { url: sprite, page: args?.page === 1 ? 3 : 1, width: 100, height: 150, offset: 0 },
        { url: sprite, page: args?.page === 1 ? 4 : 2, width: 100, height: 150, offset: -100 },
      ] } };
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    render(<StrictMode><ToastProvider><EhComments accountId="eh-a" galleryId="12345" token="abc" /></ToastProvider></StrictMode>);
    fireEvent.click(await screen.findByRole('link', { name: url }));
    expect(await screen.findByAltText('第 1 页缩略图')).toHaveAttribute('src', image);
    expect(screen.getByAltText('第 2 页缩略图')).toHaveStyle({ left: '-100%' });
    expect(screen.getByText('漫画')).toBeVisible();
    expect(adapter.mock.calls.filter(([command, args]) => command === 'get_eh_gallery_image' && args?.url === sprite)).toHaveLength(1);
    expect(adapter).toHaveBeenCalledWith('get_eh_gallery_image', { accountId: 'eh-a', url: cover });
    expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
    expect(await screen.findByAltText('第 3 页缩略图')).toBeVisible();
    expect(adapter).toHaveBeenCalledWith('get_eh_gallery', { accountId: 'eh-a', galleryId: '4256859', token: '531b16d2ae', page: 1 });
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    expect(screen.getByRole('dialog', { name: '选择收藏夹' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '编辑收藏备注' }));
    const input = screen.getByRole('textbox', { name: '收藏备注' });
    input.focus();
    expect(input).toHaveFocus();
  });

  it('discards a pending link choice when the gallery changes', async () => {
    const url = 'https://exhentai.org/g/4256859/531b16d2ae';
    let finishSearch!: (value: unknown) => void;
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_eh_comments') return { ok: true, value: args?.galleryId === '12345' ? [{ ...comment, body: url }] : [] };
      if (command === 'search_archives_page') return new Promise(resolve => { finishSearch = resolve; });
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    const { rerender } = render(<EhComments accountId="eh-a" galleryId="12345" token="abc" serverId="s" onOpenArchive={vi.fn()} />);
    const link = await screen.findByRole('link', { name: url });
    await vi.waitFor(() => expect(finishSearch).toBeTypeOf('function'));
    fireEvent.click(link);
    rerender(<EhComments accountId="eh-a" galleryId="other" token="abc" serverId="s" onOpenArchive={vi.fn()} />);
    await act(async () => finishSearch({ ok: true, value: { items: [{ serverId: 's', archiveId: 'old', title: 'Old archive', pageCount: 1, updatedAt: 'now' }], total: 1, hasMore: false } }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(adapter.mock.calls.some(([command]) => command === 'open_external_url')).toBe(false);
  });

  it('opens comment links externally without navigating the app and aligns time and voting in separate rows', async () => {
    const adapter = vi.fn(async (command: string) => ({ ok: true, value: command === 'get_eh_comments' ? [{ ...comment, body: 'See https://example.com/gallery?id=1' }] : null }));
    setInvokeAdapterForTests(adapter);
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);
    const link = await screen.findByRole('link', { name: 'https://example.com/gallery?id=1' });
    expect(fireEvent.click(link)).toBe(false);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('open_external_url', { url: 'https://example.com/gallery?id=1' }));
    const card = link.closest('li')!;
    expect(card.querySelector('.eh-comment-meta time')).not.toBeNull();
    expect(card.querySelector('.eh-comment-votes .eh-comment-score')).not.toBeNull();
    expect(card.querySelector('.eh-comment-votes time')).toBeNull();
    expect(fireEvent(link, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))).toBe(false);
    await vi.waitFor(() => expect(adapter.mock.calls.filter(([command]) => command === 'open_external_url')).toHaveLength(2));
  });
  it('ignores malformed persisted comments and loads the current gallery', async () => {
    localStorage.setItem('yomika.eh.comments.v1:eh-a\u000012345\u0000abc', JSON.stringify({
      comments: [null], cachedAt: Date.now(),
    }));
    const adapter = vi.fn(async () => ({ ok: true, value: [comment] }));
    setInvokeAdapterForTests(adapter);
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);
    expect(await screen.findByText('Useful comment')).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('get_eh_comments', expect.anything());
  });

  it('manual refresh bypasses the fresh snapshot', async () => {
    let requests = 0;
    setInvokeAdapterForTests(async () => ({ ok: true, value: [{ ...comment, body: ++requests === 1 ? 'Old comment' : 'Updated comment' }] }));
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);
    await screen.findByText('Old comment');
    fireEvent.click(screen.getByRole('button', { name: '刷新 E-Hentai 评论' }));
    await screen.findByText('Updated comment');
    expect(requests).toBe(2);
  });

  it('retains the updated vote in memory when reopening the same gallery', async () => {
    setInvokeAdapterForTests(async (command) => command === 'vote_eh_comment'
      ? { ok: true, value: 6 } : { ok: true, value: [comment] });
    const first = render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);
    await screen.findByText('+4');
    fireEvent.click(screen.getByRole('button', { name: '赞同 Reader 的评论' }));
    await screen.findByText('+6');
    first.unmount();
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);
    await screen.findByText('+6');
    expect(screen.getByRole('button', { name: '赞同 Reader 的评论' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not carry a composer draft or old comments into another gallery', async () => {
    let finishSecond!: (result: unknown) => void;
    setInvokeAdapterForTests(async (_command, args) => args?.galleryId === 'other'
      ? new Promise((resolve) => { finishSecond = resolve; })
      : { ok: true, value: [comment] });
    const { rerender } = render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);
    await screen.findByText('Useful comment');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft for the first gallery' } });
    rerender(<EhComments accountId="eh-a" galleryId="other" token="def" />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Useful comment')).not.toBeInTheDocument();
    await act(async () => { finishSecond({ ok: true, value: [] }); });
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('renders comment metadata and updates the score in place after voting', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'get_eh_comments') return { ok: true, value: [comment] };
      // The API answers with the comment's new score.
      if (command === 'vote_eh_comment') return { ok: true, value: 6 };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);

    const region = await screen.findByRole('region', { name: 'E-Hentai 评论' });
    expect(within(region).getByText('Reader')).toBeInTheDocument();
    expect(within(region).getByText('2026-09-07 10:30')).toBeInTheDocument();
    expect(within(region).getByText('+4')).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: '赞同 Reader 的评论' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('vote_eh_comment', {
      accountId: 'eh-a', galleryId: '12345', token: 'abc', commentId: '777', vote: 1,
    }));
    // The row shows the new score without a list refetch.
    expect(await within(region).findByText('+6')).toBeInTheDocument();
    expect(adapter.mock.calls.filter(([name]) => name === 'get_eh_comments')).toHaveLength(1);
  });

  it('posts a comment and reloads the list', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'get_eh_comments') return { ok: true, value: [] };
      if (command === 'post_eh_comment') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);

    await screen.findByText('暂无评论');
    await user.type(screen.getByLabelText('发表评论'), 'New comment');
    await user.click(screen.getByRole('button', { name: '发送评论' }));
    expect(adapter).toHaveBeenCalledWith('post_eh_comment', {
      accountId: 'eh-a', galleryId: '12345', token: 'abc', body: 'New comment',
    });
    await vi.waitFor(() => expect(adapter.mock.calls.filter(([name]) => name === 'get_eh_comments')).toHaveLength(2));
    expect(screen.getByLabelText('发表评论')).toHaveValue('');
  });

  it('shares one native request between concurrent panels for the same gallery', async () => {
    let resolveRequest!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveRequest = resolve; });
    const adapter = vi.fn(async (command: string) => {
      if (command === 'get_eh_comments') {
        await pending;
        return { ok: true, value: [comment] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><><EhComments accountId="eh-a" galleryId="12345" token="abc" /><EhComments accountId="eh-a" galleryId="12345" token="abc" /></></ToastProvider>);

    await vi.waitFor(() => expect(adapter.mock.calls.filter(([name]) => name === 'get_eh_comments')).toHaveLength(1));
    resolveRequest(undefined);
    await vi.waitFor(() => expect(screen.getAllByText('Reader')).toHaveLength(2));
  });

  it.each([
    ['EH_CLOUDFLARE', 'challenge', 'Cloudflare 验证'],
    ['EH_GALLERY_COPYRIGHT_REMOVED', 'removed', '版权要求被移除'],
    ['EH_GALLERY_DELETED', 'missing', '不存在或已被删除'],
    ['EH_UNAVAILABLE', '网络连接失败，请重试。', '网络连接失败'],
  ])('shows a full unavailable state without a composer for %s', async (code, message, reason) => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'get_eh_comments') return { ok: false, error: { code, message, retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><EhComments accountId="eh-a" galleryId="12345" token="abc" /></ToastProvider>);

    const region = await screen.findByRole('region', { name: 'E-Hentai 评论' });
    const unavailable = await within(region).findByRole('alert');
    expect(unavailable).toHaveTextContent(reason);
    expect(within(unavailable).getByRole('heading', { name: new RegExp(reason) })).toBeVisible();
    expect(unavailable.querySelector('svg')).not.toBeNull();
    expect(within(region).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: '发送评论' })).not.toBeInTheDocument();
    expect(within(region).queryByText('暂无评论')).not.toBeInTheDocument();
    expect(within(region).getByRole('button', { name: '刷新 E-Hentai 评论' })).toBeEnabled();
  });

  it('keeps cached comments visible while explaining a failed refresh and clears the error on retry', async () => {
    let requests = 0;
    setInvokeAdapterForTests(async () => ++requests === 2
      ? { ok: false, error: { code: 'EH_GALLERY_COPYRIGHT_REMOVED', message: 'removed', retryable: false } }
      : { ok: true, value: [comment] });
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);
    await screen.findByText('Useful comment');
    fireEvent.click(screen.getByRole('button', { name: '刷新 E-Hentai 评论' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('版权要求被移除');
    expect(screen.getByText('Useful comment')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新 E-Hentai 评论' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '刷新 E-Hentai 评论' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '发表评论' })).toBeVisible();
  });

  it('waits for an available comments response before showing the composer', async () => {
    let finish!: (result: unknown) => void;
    setInvokeAdapterForTests(async () => new Promise(resolve => { finish = resolve; }));
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await act(async () => { finish({ ok: true, value: [] }); });
    expect(screen.getByText('暂无评论')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '发表评论' })).toBeVisible();
  });

  it('retains the composer draft after a posting error on an available gallery', async () => {
    setInvokeAdapterForTests(async command => command === 'get_eh_comments'
      ? { ok: true, value: [] }
      : { ok: false, error: { code: 'EH_UNAVAILABLE', message: '发送失败，请重试。', retryable: true } });
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" />);
    const input = await screen.findByRole('textbox', { name: '发表评论' });
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: '发送评论' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('发送失败');
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
    expect(screen.getByRole('button', { name: '发送评论' })).toBeEnabled();
  });

});
