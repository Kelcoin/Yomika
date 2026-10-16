import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('E-Hentai comments', () => {
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
    fireEvent.click(await screen.findByRole('menuitem', { name: '打开档案详情' }));
    expect(onOpenArchive).toHaveBeenCalledWith(expect.objectContaining({ archiveId: 'matched' }));
    expect(adapter.mock.calls.some(([command]) => command === 'open_external_url')).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'https://e-hentai.org/g/4256859/531b16d2ae' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '打开链接' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('open_external_url', { url: 'https://e-hentai.org/g/4256859/531b16d2ae' }));
    expect(adapter.mock.calls.filter(([command]) => command === 'search_archives_page')).toHaveLength(1);
  });

  it.each([false, true])('opens unmatched or failed EH lookups externally (failure=%s)', async failure => {
    const url = 'https://e-hentai.org/g/4256859/531b16d2ae';
    const adapter = vi.fn(async (command: string) => {
      if (command === 'get_eh_comments') return { ok: true, value: [{ ...comment, body: url }] };
      if (command === 'search_archives_page') return failure
        ? { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'Offline', retryable: true } }
        : { ok: true, value: { items: [], total: 0, hasMore: false } };
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    render(<EhComments accountId="eh-a" galleryId="12345" token="abc" serverId="s" onOpenArchive={vi.fn()} />);
    fireEvent.click(await screen.findByRole('link', { name: url }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('open_external_url', { url }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
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
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByText('Useful comment')).not.toBeInTheDocument();
    await act(async () => { finishSecond({ ok: true, value: [] }); });
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

  it('reports a classified failure through the global toast without an inline error block', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'get_eh_comments') return { ok: false, error: { code: 'EH_CLOUDFLARE', message: 'challenge', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><EhComments accountId="eh-a" galleryId="12345" token="abc" /></ToastProvider>);

    const region = await screen.findByRole('region', { name: 'E-Hentai 评论' });
    expect(within(region).queryByRole('alert')).toBeNull();
    expect(await screen.findByRole('alert')).toHaveTextContent('Cloudflare 验证');
  });
});
