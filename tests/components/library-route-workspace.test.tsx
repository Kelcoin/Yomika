import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { invalidateRouteCache, simulateRouteCacheRestartForTests, writeRouteCache } from '../../src/lib/routeCache';
import { getNativeImageCache } from '../../src/lib/nativeImageCache';
import { peekCachedImageUrl } from '../../src/lib/unifiedImageCache';

afterEach(() => {
  resetInvokeAdapterForTests();
  // 落盘的路由快照也要收掉：它比进程活得久，正是这条用例要利用的性质。
  window.localStorage.removeItem('yomika.route-cache.v1');
  vi.restoreAllMocks();
});

function renderLibrary(path = '/library') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

/** One page of `search_archives_page`. The library list comes from LANraragi, so
 * tests about something else — metadata, covers, menus — still have to answer
 * the page request before they get to their own subject. */
function servedPage(items: unknown[]) {
  return { ok: true, value: { items, total: items.length, hasMore: false } };
}

describe('library route workspace', () => {
  it('keeps scrolled-in pages when refreshing on return to the library', async () => {
    const row = (id: string) => ({ serverId: 'scope-a', archiveId: id, title: `Archive ${id}`, pageCount: 2, updatedAt: '2026-10-20T00:00:00Z' });
    let headRequests = 0;
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') {
        const start = (args?.input as { start: number }).start;
        if (start === 0) headRequests++;
        return { ok: true, value: { items: start === 0 ? [row('head')] : [row('tail')], total: 2, hasMore: start === 0 } };
      }
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderLibrary();
    await screen.findByRole('button', { name: /^Archive head\b/ });
    fireEvent.scroll(screen.getByRole('list', { name: '档案' }), { target: { scrollTop: 10000 } });
    await screen.findByRole('button', { name: /^Archive tail\b/ });
    const requests = headRequests;
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: '更多' }));
    await user.click(screen.getAllByRole('link', { name: '档案库' })[0]!);
    await waitFor(() => expect(headRequests).toBeGreaterThan(requests));
    expect(await screen.findByRole('button', { name: /^Archive tail\b/ })).toBeInTheDocument();
  });
  it('ignores a malformed persisted library page after restart', async () => {
    writeRouteCache('library:workspace:default', { archives: [null], categories: [null] }, { persist: true });
    simulateRouteCacheRestartForTests();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'fresh', title: 'Recovered Archive', pageCount: 2, updatedAt: '2026-08-27T00:00:00Z' }]);
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderLibrary();
    expect(await screen.findByRole('button', { name: /^Recovered Archive\b/ })).toBeInTheDocument();
  });

  it('ignores malformed persisted categories and loads current server categories', async () => {
    localStorage.setItem('yomika:library-categories:default', '[null]');
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'fresh', title: 'Current Archive', pageCount: 2, updatedAt: '2026-08-27T00:00:00Z' }]);
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    try {
      renderLibrary();
      expect(await screen.findByRole('button', { name: /^Current Archive\b/ })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('yomika:library-categories:default');
    }
  });

  it('shows an old in-memory page while revalidating it', async () => {
    const now = Date.now();
    writeRouteCache('library:workspace:default', {
      archives: [{ serverId: 'scope-a', archiveId: 'cached', title: 'Cached Archive', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }],
      fetchedCount: 1,
      categories: [],
      selectedArchiveId: undefined,
      totalArchives: 1,
      hasMoreArchives: false,
      searchQuery: '',
      sortMode: 'added',
      sortOrder: 'desc',
      categoryFilter: '',
    });
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    let resolvePage!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return new Promise((resolve) => { resolvePage = resolve; });
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    renderLibrary();
    expect(screen.getByRole('button', { name: /^Cached Archive\b/ })).toBeInTheDocument();
    await waitFor(() => expect(resolvePage).toBeDefined());
    expect(screen.getByRole('button', { name: /^Cached Archive\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '正在读取档案' })).not.toBeInTheDocument();

    await act(async () => resolvePage(servedPage([{ serverId: 'scope-a', archiveId: 'fresh', title: 'Fresh Archive', pageCount: 2, updatedAt: '2026-08-27T00:00:00Z' }])));
    expect(await screen.findByRole('button', { name: /^Fresh Archive\b/ })).toBeInTheDocument();
  });

  it('renders a persisted snapshot after a restart instead of a skeleton', async () => {
    // 新进程里内存快照一无所有——能救第一帧的只有上一个进程落盘的那一份。
    writeRouteCache('library:workspace:default', {
      archives: [{ serverId: 'scope-a', archiveId: 'persisted', title: 'Persisted Archive', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }],
      fetchedCount: 1,
      categories: [],
      selectedArchiveId: undefined,
      totalArchives: 1,
      hasMoreArchives: false,
      searchQuery: '',
      sortMode: 'added',
      sortOrder: 'desc',
      categoryFilter: '',
    }, { persist: true });
    simulateRouteCacheRestartForTests();

    let resolvePage!: (value: unknown) => void;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return new Promise((resolve) => { resolvePage = resolve; });
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);

    renderLibrary();

    expect(screen.getByRole('button', { name: /^Persisted Archive\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '正在读取档案' })).not.toBeInTheDocument();
    expect(document.querySelector('.archive-list-skeleton-layer')).toBeNull();

    // 快照只负责先显示：首页照样在后台重读，回来了就换成新数据。
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('search_archives_page', expect.anything()));

    await act(async () => resolvePage(servedPage([{ serverId: 'scope-a', archiveId: 'fresh', title: 'Fresh Archive', pageCount: 2, updatedAt: '2026-08-27T00:00:00Z' }])));
    expect(await screen.findByRole('button', { name: /^Fresh Archive\b/ })).toBeInTheDocument();
  });

  it('does not show a cached page for a different URL query', async () => {
    writeRouteCache('library:workspace:default', {
      archives: [{ serverId: 'scope-a', archiveId: 'cached', title: 'Old Query', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }],
      fetchedCount: 1,
      categories: [],
      selectedArchiveId: undefined,
      totalArchives: 1,
      hasMoreArchives: false,
      searchQuery: 'artist:old',
      sortMode: 'added',
      sortOrder: 'desc',
      categoryFilter: '',
    });
    let resolvePage!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return new Promise((resolve) => { resolvePage = resolve; });
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    renderLibrary('/library?q=artist%3Anew');
    await waitFor(() => expect(resolvePage).toBeDefined());
    expect(screen.queryByRole('button', { name: /^Old Query\b/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '正在读取档案' })).toBeInTheDocument();
    await act(async () => resolvePage(servedPage([])));
  });

  it('keeps the library shell mounted and shows card skeletons during the first request', async () => {
    let resolveServers!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return new Promise((resolve) => { resolveServers = resolve; });
      if (command === 'list_tasks') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });

    renderLibrary();

    expect(await screen.findByRole('status', { name: '正在读取档案' })).toHaveClass('archive-list-skeleton');

    await act(async () => resolveServers({ ok: true, value: [] }));
  });

  it('uses a tag query from the URL instead of a cached library search', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return servedPage([]);
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);

    renderLibrary('/library?q=female%3Abig+breasts%24');

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('search_archives_page', {
      input: expect.objectContaining({ query: 'female:big breasts$' }),
    }));
    expect(screen.getByRole('combobox', { name: '搜索档案' })).toHaveValue('female:big breasts$');
  });

  it('discards an old pagination response after the sort changes', async () => {
    let complete!: (value: unknown) => void;
    const row = (title: string) => ({ serverId: 's', archiveId: title, title, pageCount: 3, updatedAt: '2026-09-06T00:00:00Z' });
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'search_archives_page') {
        const input = args?.input as { start: number; sortBy: string };
        if (input.start > 0) return new Promise((resolve) => { complete = resolve; });
        return { ok: true, value: { items: [row(input.sortBy === 'title' ? 'New result' : 'Original result')], total: 2, hasMore: true } };
      }
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderLibrary();
    await screen.findByRole('button', { name: /^Original result/ });
    fireEvent.scroll(screen.getByRole('list', { name: '档案' }), { target: { scrollTop: 10_000 } });
    await waitFor(() => expect(complete).toBeDefined());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '排序字段' }), 'title');
    await screen.findByRole('button', { name: /^New result/ });
    await act(async () => complete(servedPage([row('Stale result')])));
    expect(screen.queryByRole('button', { name: /^Stale result/ })).not.toBeInTheDocument();
  });

  it('explains how to recover when history has no configured server', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/history']}><App /></MemoryRouter>);

    // 各页共用同一份引导（ServerRequiredPrompt）：同一个标题、同样的两个入口，
    // 不再各画一版。
    expect(await screen.findByRole('heading', { name: '添加你的 LANraragi' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '添加服务器' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: /导入数据/ })).toHaveAttribute('href', '/settings?section=data');
  });

  it('switches to a page that already knows there is no server without showing its skeletons first', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/history']}><App /></MemoryRouter>);
    // 这一页读到的是「一台服务器都没有」，答案留在会话里给后面的页面用。
    await screen.findByRole('heading', { name: '添加你的 LANraragi' });

    fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '档案库' }));

    // 切过去的第一帧就得是引导。骨架的意思是「还不知道」，而这一次已经知道了——
    // 从前这里会先把档案库的骨架转一帧，等这次 IPC 落地才换成引导。保留页里那几页
    // 都还在 DOM 里（只是 hidden），所以能查到的那个引导一定是刚切过去的这一页的。
    expect(screen.getByRole('heading', { name: '添加你的 LANraragi' }).closest('.library-shell-list')).not.toBeNull();
    expect(screen.queryByRole('status', { name: '正在读取档案' })).not.toBeInTheDocument();
    expect(document.querySelector('.archive-list-skeleton-layer')).toBeNull();

    // 书架（收藏夹）同理：它的 hasServer 初值从前无条件写 true，于是也是先骨架后引导。
    fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '收藏夹' }));
    expect(screen.getByRole('heading', { name: '添加你的 LANraragi' }).closest('.library-shell-list')).not.toBeNull();
    expect(screen.queryByRole('status', { name: '正在读取档案' })).not.toBeInTheDocument();
    expect(document.querySelector('.archive-list-skeleton-layer')).toBeNull();

    // 首页从前是一帧空屏：快照过期时 servers 还是 undefined，门两边都不成立。
    fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '首页' }));
    expect(screen.getByRole('heading', { name: '添加你的 LANraragi' })).toBeInTheDocument();
    expect(document.querySelector('.archive-list-skeleton-layer')).toBeNull();

    // 收尾：这几次 list_servers 的落地也放进 act 里，不留悬挂的更新告警。
    await act(async () => {});
  });

  it('resolves history records to archive titles and server context', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1 }] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: '历史档案标题', pageCount: 12, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/history']}><App /></MemoryRouter>);

    // History reuses the library card, so the row is a button and the progress
    // renders in the shared card metadata slot.
    expect(await screen.findByRole('button', { name: /历史档案标题/ })).toBeInTheDocument();
    expect(screen.getByText('5/12 页')).toBeInTheDocument();
  });

  it('keeps history in wide rows so its external timeline remains visible', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1 }] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Timeline archive', pageCount: 12, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, cardStyle: 'thumbnail' } };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/history']}><App /></MemoryRouter>);

    await screen.findByRole('button', { name: /Timeline archive/ });
    const list = screen.getByRole('list', { name: '档案' });
    expect(list).toHaveClass('is-wide');
    expect(list.querySelector('.archive-row-timeline')).not.toBeNull();
  });

  it('orders history by most recent visit regardless of native return order', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [
        { scopeId: 'scope-a', archiveId: 'older', pageIndex: 1, visitedAt: '2026-08-27T00:00:00Z', deviceId: 'device-a', revision: 1 },
        { scopeId: 'scope-a', archiveId: 'newer', pageIndex: 2, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 2 },
      ] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [
        { serverId: 'scope-a', archiveId: 'older', title: 'Older visit', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' },
        { serverId: 'scope-a', archiveId: 'newer', title: 'Newer visit', pageCount: 3, updatedAt: '2026-08-28T00:00:00Z' },
      ] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/history']}><App /></MemoryRouter>);

    const newer = await screen.findByRole('button', { name: /Newer visit/ });
    const older = screen.getByRole('button', { name: /Older visit/ });
    expect(newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('searches a shelf with the library search bar, newest entry first', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'read_favorites_category') return { ok: true, value: { id: 'favorites', archives: ['a', 'b'] } };
      if (command === 'list_archives_by_ids') return { ok: true, value: [
        { serverId: 'scope-a', archiveId: 'a', title: 'Alpha archive', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z' },
        { serverId: 'scope-a', archiveId: 'b', title: 'Beta archive', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' },
      ] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/watchlist']}><App /></MemoryRouter>);

    // Most recently added first. The sort control offered "title" or "recent";
    // recency is the only order that says anything about a shelf.
    const alpha = await screen.findByRole('button', { name: /Alpha archive/ });
    const beta = screen.getByRole('button', { name: /Beta archive/ });
    expect(alpha.compareDocumentPosition(beta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The library's own search bar, scoped to this shelf: it filters the records
    // the page already holds, so it applies per keystroke rather than on Enter.
    await user.type(screen.getByRole('searchbox', { name: '搜索收藏夹' }), 'beta');
    expect(screen.queryByRole('button', { name: /Alpha archive/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta archive/ })).toBeInTheDocument();
  });

  it('removes a shelf entry from the card context menu', async () => {
    const user = userEvent.setup();
    let removed = false;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'read_favorites_category') return { ok: true, value: { id: 'favorites', archives: removed ? [] : ['a'] } };
      // 右键菜单现在只探两个布尔，不再拉全量列表。
      if (command === 'get_archive_membership') return { ok: true, value: { reading: false, favorites: !removed } };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a', title: 'Remove archive', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'remove_archive_from_category') { removed = true; return { ok: true, value: { operation: 'remove_from_category', success: 1 } }; }
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/watchlist']}><App /></MemoryRouter>);

    // The multi-select bar this replaces was the only control on the page, and a
    // right click already addresses one card.
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Remove archive/ }));
    await user.click(await screen.findByRole('menuitem', { name: /移出收藏夹/ }));

    expect(adapter).toHaveBeenCalledWith('remove_archive_from_category', { serverId: 'scope-a', categoryId: 'favorites', archiveId: 'a' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Remove archive/ })).not.toBeInTheDocument());
    expect(await screen.findByText('已移出收藏夹')).toBeInTheDocument();
  });

  it('asks LANraragi for untagged archives when that filter is picked', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [{ id: 'SET_1613080290', name: 'Reading', pinned: false, search: null, archives: [] }] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'a1', title: 'Untagged Archive', pageCount: 1, updatedAt: '2026-08-28T00:00:00Z' }]);
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    await screen.findByRole('button', { name: /^Untagged Archive\b/ });
    // Offered in the category menu because that is where someone looks for it,
    // but sent as LANraragi's own switch: an archive with no tags is in no
    // category, so resolving it as one would always come back empty.
    await user.selectOptions(screen.getByRole('combobox', { name: '分类筛选' }), 'yomika:untagged');

    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('search_archives_page', {
      input: { serverId: 'scope-a', query: '', sortBy: 'added', order: 'desc', categoryId: null, untaggedOnly: true, start: 0 },
    }));
  });

  it('hydrates the category dropdown from the mirror instead of flashing a skeleton', async () => {
    // 应用重启或路由快照过期后，原生六小时快照也能立刻回答分类：下拉用上
    // 一次的镜像同步注水，骨架只留给一无所知的首次加载。
    window.localStorage.setItem('yomika:library-categories:default', JSON.stringify([
      { id: 'SET_1613080290', name: 'Reading', pinned: false, search: null, archives: [] },
    ]));
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'a1', title: 'Hydrated', pageCount: 1, updatedAt: '2026-09-01T00:00:00Z' }]);
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      // 分类请求永不返回：下拉仍然立即出现，证明它来自镜像。
      if (command === 'list_categories') return new Promise(() => undefined);
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    const dropdown = await screen.findByRole('combobox', { name: '分类筛选' });
    expect(dropdown).toHaveTextContent('Reading');
    expect(screen.queryByText('正在读取分类')).toBeNull();
  });

  it('refreshes categories silently while the cached dropdown is on screen', async () => {
    const user = userEvent.setup();
    let categoryRequests = 0;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') {
        categoryRequests += 1;
        return { ok: true, value: [{ id: 'SET_1613080290', name: 'Reading', pinned: false, search: null, archives: [] }] };
      }
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'a1', title: 'Cached Refresh', pageCount: 1, updatedAt: '2026-09-02T00:00:00Z' }]);
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    await screen.findByRole('button', { name: /^Cached Refresh\b/ });
    expect(screen.getByRole('combobox', { name: '分类筛选' })).toBeInTheDocument();
    const requestsBefore = categoryRequests;

    // 全量失效广播（启用服务器切换的形状）重跑分类加载：下拉保持显示，
    // 不进骨架。
    window.dispatchEvent(new CustomEvent('yomika:route-cache-invalidated', { detail: {} }));
    await vi.waitFor(() => expect(categoryRequests).toBeGreaterThan(requestsBefore));
    expect(screen.queryByText('正在读取分类')).toBeNull();
    expect(screen.getByRole('combobox', { name: '分类筛选' })).toBeInTheDocument();
  });

  it('loads archives from the first configured server scope', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') {
        return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      }
      if (command === 'search_archives_page') {
        return servedPage([{ serverId: 'scope-a', archiveId: 'a1', title: 'Loaded Archive', pageCount: 12, updatedAt: '2026-08-26T00:00:00Z' }]);
      }
      if (command === 'list_categories' || command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'load_archive_thumbnail') return { ok: true, value: [255, 216, 255] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderLibrary();

    expect(await screen.findByRole('button', { name: /^Loaded Archive\b/ })).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('search_archives_page', {
      input: { serverId: 'scope-a', query: '', sortBy: 'added', order: 'desc', categoryId: null, untaggedOnly: false, start: 0 },
    });
  });

  it('shows repository failures instead of a misleading empty library', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') {
        return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      }
      return { ok: false, error: { code: 'UNKNOWN', message: '数据库读取失败', retryable: true } };
    });

    renderLibrary();

    // 原始报错走 toast（portal 到 body，不在 main 里），页面上只剩一句人话与重试。
    expect(await screen.findByText('数据库读取失败')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '档案库没有读出来' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '暂无档案库' })).not.toBeInTheDocument();
  });

  it('reports an archive load failure as a toast instead of a page-wide alert bar', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'LRR 不可用', retryable: true } };
    });

    renderLibrary();

    // 精确匹配只会命中错误 toast，不会命中「读取分类失败：LRR 不可用」那条。
    expect(await screen.findByText('LRR 不可用')).toBeInTheDocument();
  });

  it('turns missing server credentials into an actionable settings link', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      return { ok: false, error: { code: 'PLATFORM_UNAVAILABLE', message: 'No matching entry found in secure storage', retryable: false } };
    });

    renderLibrary();

    expect(await screen.findByText('服务器凭据不可用，请在设置中重新保存 API Key。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '档案库没有读出来' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开设置重新保存 API Key' })).toHaveAttribute('href', '/settings');
  });

  it('retries an initial archive load failure', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        attempts += 1;
        return attempts === 1
          ? { ok: false, error: { code: 'UNKNOWN', message: '数据库读取失败', retryable: true } }
          : servedPage([{ serverId: 'scope-a', archiveId: 'recovered', title: 'Recovered', pageCount: 1, updatedAt: '2026-08-28T00:00:00Z' }]);
      }
      if (command === 'list_archives_page') return { ok: false, error: { code: 'UNKNOWN', message: '本机索引也读不到', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderLibrary();

    await user.click(await screen.findByRole('button', { name: '重试读取档案库' }));

    expect(await screen.findByRole('button', { name: /^Recovered\b/ })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('keeps a failed entry refresh on the page instead of leaving skeletons behind', async () => {
    const user = userEvent.setup();
    let pageRequests = 0;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        pageRequests += 1;
        return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'LRR 不可用', retryable: true } };
      }
      if (command === 'list_archives_page') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '本机索引也读不到', retryable: true } };
      return { ok: true, value: [] };
    });
    renderLibrary();

    expect(await screen.findByRole('heading', { name: '档案库没有读出来' })).toBeInTheDocument();

    // 离开再回来走的是入场刷新（background）。它失败时曾经连错误页一起抹掉，只留一条
    // 几秒后消失的 toast——屏幕上没有列表可留，于是骨架一直转（用户图①）。
    const sidebar = within(screen.getByRole('navigation', { name: '主导航' }));
    await user.click(sidebar.getByRole('link', { name: '本地档案' }));
    await screen.findByRole('heading', { name: '本地档案' });
    await user.click(sidebar.getByRole('link', { name: '档案库' }));

    await waitFor(() => expect(pageRequests).toBe(2));
    expect(screen.getByRole('heading', { name: '档案库没有读出来' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试读取档案库' })).toBeInTheDocument();
  });

  it('keeps the list on screen when an automatic refresh re-reads the same query', async () => {
    let pageRequests = 0;
    let resolvePage!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        pageRequests += 1;
        if (pageRequests === 1) return servedPage([{ serverId: 'scope-a', archiveId: 'kept', title: 'Kept Archive', pageCount: 3, updatedAt: '2026-08-26T00:00:00Z' }]);
        return new Promise((resolve) => { resolvePage = resolve; });
      }
      return { ok: true, value: [] };
    });
    renderLibrary();

    expect(await screen.findByRole('button', { name: /^Kept Archive\b/ })).toBeInTheDocument();

    // 自动同步收尾、整库失效广播都会带着同一套查询条件重读首页。用户要的是「保持缓存
    // 显示，有更新再进行变化」：清屏会闪一次骨架，把正在看的整页档案拿走。
    await act(async () => { invalidateRouteCache(); });
    await waitFor(() => expect(pageRequests).toBe(2));

    expect(screen.getByRole('button', { name: /^Kept Archive\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '正在读取档案' })).not.toBeInTheDocument();

    await act(async () => resolvePage(servedPage([{ serverId: 'scope-a', archiveId: 'fresh', title: 'Fresh Archive', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' }])));
    expect(await screen.findByRole('button', { name: /^Fresh Archive\b/ })).toBeInTheDocument();
  });

  it('marks only the rows a background refresh brought in, then clears the mark', async () => {
    let pageRequests = 0;
    let resolvePage!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        pageRequests += 1;
        if (pageRequests === 1) return servedPage([{ serverId: 'scope-a', archiveId: 'kept', title: 'Kept Archive', pageCount: 3, updatedAt: '2026-08-26T00:00:00Z' }]);
        return new Promise((resolve) => { resolvePage = resolve; });
      }
      return { ok: true, value: [] };
    });
    renderLibrary();

    const keptRow = (await screen.findByRole('button', { name: /^Kept Archive\b/ })).closest('.archive-row-wrap');
    // 第一次成功加载是骨架换列表：整屏都是「新挂上来的」，不是后台刷新带回来的新档案。
    expect(keptRow).not.toHaveClass('is-fresh');

    await act(async () => { invalidateRouteCache(); });
    await waitFor(() => expect(pageRequests).toBe(2));
    await act(async () => resolvePage(servedPage([
      { serverId: 'scope-a', archiveId: 'kept', title: 'Kept Archive', pageCount: 3, updatedAt: '2026-08-26T00:00:00Z' },
      { serverId: 'scope-a', archiveId: 'fresh', title: 'Fresh Archive', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' },
    ])));

    // 图⑤：后台刷新冒出来的新档案要有入场动画，已经在屏幕上的那些不能跟着一起动
    // ——列表整体被替换，只有发起请求的那一层知道谁是新来的。
    const freshRow = (await screen.findByRole('button', { name: /^Fresh Archive\b/ })).closest('.archive-row-wrap');
    expect(freshRow).toHaveClass('is-fresh');
    expect(screen.getByRole('button', { name: /^Kept Archive\b/ }).closest('.archive-row-wrap')).not.toHaveClass('is-fresh');

    // 标记是「刚来的」这一句话，不是行的常态：动画跑完就撤掉。
    await waitFor(() => expect(freshRow).not.toHaveClass('is-fresh'), { timeout: 2000 });
  });

  it('loads archive metadata when an archive is selected', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') {
        return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      }
      if (command === 'search_archives_page') {
        return servedPage([
          { serverId: 'scope-a', archiveId: 'a1', title: 'First', pageCount: 12, updatedAt: '2026-08-26T00:00:00Z' },
          { serverId: 'scope-a', archiveId: 'a2', title: 'Second', pageCount: 8, updatedAt: '2026-08-26T00:00:00Z' },
        ]);
      }
      if (command === 'load_archive_metadata') {
        return {
          ok: true,
          value: {
            archiveId: 'a2', title: 'Second', filename: 'second.cbz', tags: 'artist:test',
            summary: 'Remote summary', extension: 'cbz', progress: 0, pageCount: 8,
            lastReadTime: 0, size: 1024,
          },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    await user.click(await screen.findByRole('button', { name: /^Second\b/ }));

    expect(await screen.findByRole('heading', { name: 'Second' })).toBeInTheDocument();
    expect(screen.queryByText('second.cbz')).not.toBeInTheDocument();
    expect(screen.getByText('Remote summary')).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('load_archive_metadata', { serverId: 'scope-a', archiveId: 'a2' });
  });

  it('loads the first archive detail without requiring a redundant row click', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'first', title: 'First archive', pageCount: 3, updatedAt: '2026-08-28T00:00:00Z' }]);
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'first', title: 'First archive', filename: 'first.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 3, lastReadTime: 0, size: 3 } };
      if (command === 'load_archive_thumbnail') return { ok: true, value: [255, 216, 255] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary('/library/first');

    expect(await screen.findByRole('heading', { name: 'First archive' })).toBeInTheDocument();
    expect(screen.queryByText('first.cbz')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '阅读' })).toHaveAttribute('href', '/reader/first?server=scope-a');
    expect(adapter).toHaveBeenCalledWith('load_archive_metadata', { serverId: 'scope-a', archiveId: 'first' });
  });

  it('requires confirmation before deleting the selected archive', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'a1', title: 'Delete me', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }]);
      if (command === 'list_categories' || command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'a1', title: 'Delete me', filename: 'delete.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 2, lastReadTime: 0, size: 1 } };
      if (command === 'delete_archive') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary('/library/a1');

    await user.click(await screen.findByRole('button', { name: /^Delete me\b/ }));
    // 同上：菜单点开之后才渲染，整轮并行跑时要等它出现。
    await user.click(await screen.findByRole('button', { name: '档案菜单' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除档案' }));

    expect(screen.getByRole('dialog', { name: '确认删除' })).toBeInTheDocument();
    expect(adapter).not.toHaveBeenCalledWith('delete_archive', expect.anything());
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(adapter).toHaveBeenCalledWith('delete_archive', { serverId: 'scope-a', archiveId: 'a1' });
  });

  it('drops a deleted archive from the results it was opened from', async () => {
    const user = userEvent.setup();
    let deleted = false;
    const rows = [{ serverId: 'scope-a', archiveId: 'a2', title: 'Surviving search hit', pageCount: 1, updatedAt: '2026-08-25T00:00:00Z' }];
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      // 删除之后服务器不再返回这一条。
      if (command === 'search_archives_page') {
        return servedPage(deleted ? rows : [{ ...rows[0], archiveId: 'a1', title: 'Doomed search hit' }, ...rows]);
      }
      if (command === 'list_categories' || command === 'list_watchlist' || command === 'list_reading_list' || command === 'list_reading_history') return { ok: true, value: [] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'a1', title: 'Doomed search hit', filename: 'a.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 2, lastReadTime: 0, size: 1 } };
      if (command === 'delete_archive') { deleted = true; return { ok: true, value: null }; }
      return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'not needed here', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    // 检索进来：列表是这次检索的结果。
    renderLibrary('/library?q=Found');

    await user.click(await screen.findByRole('button', { name: /^Doomed search hit\b/ }));
    expect(await screen.findByRole('button', { name: '档案菜单' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '档案菜单' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除档案' }));
    await user.click(await screen.findByRole('button', { name: '确认删除' }));
    expect(adapter).toHaveBeenCalledWith('delete_archive', { serverId: 'scope-a', archiveId: 'a1' });

    // 删除会带着 'library:' 前缀让快照失效，列表必须跟着重读：以前它只认整库失效，
    // 于是这一行在检索结果里一直留着，直到手动刷新。重读落在列表后面，所以剩下的
    // 那一条从按下确认到重读回来都在屏幕上。
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Doomed search hit\b/ })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Surviving search hit\b/ })).toBeInTheDocument();
  });

  it('assigns an archive to a static category from the card menu', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'server-a', name: 'Home', baseUrl: 'https://lrr.test', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') {
        return { ok: true, value: { items: [{ serverId: 'server-a', archiveId: 'a1', title: 'Categorize me', pageCount: 2, updatedAt: '2026-09-03T00:00:00Z' }], total: 1, hasMore: false } };
      }
      if (command === 'list_categories') return { ok: true, value: [
        { id: 'SET_1613080290', name: 'Static shelf', pinned: false, search: null, archives: [] },
        { id: 'SET_1613080291', name: 'Dynamic shelf', pinned: false, search: 'artist:someone$', archives: [] },
      ] };
      if (command === 'list_watchlist' || command === 'list_reading_history' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'load_archive_metadata') {
        return { ok: true, value: { archiveId: 'a1', title: 'Categorize me', filename: 'a.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 2, lastReadTime: 0, size: 100 } };
      }
      if (command === 'add_archive_to_category') return { ok: true, value: { operation: 'add_to_category', success: 1 } };
      return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'not needed here', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);

    render(<MemoryRouter initialEntries={['/library']}><App /></MemoryRouter>);

    fireEvent.contextMenu(await screen.findByRole('button', { name: /^Categorize me/ }), { clientX: 120, clientY: 80 });
    const menu = await screen.findByRole('menu');
    // A dynamic category's contents come from its search expression, so it is
    // not an assignment target.
    expect(within(menu).queryByRole('menuitem', { name: 'Dynamic shelf' })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Static shelf' }));

    expect(adapter).toHaveBeenCalledWith('add_archive_to_category', { serverId: 'server-a', categoryId: 'SET_1613080290', archiveId: 'a1' });
    expect(await screen.findByText('分类已更新')).toBeInTheDocument();
  });

  it('edits current archive metadata and refreshes the detail pane', async () => {
    const user = userEvent.setup();
    let metadataTitle = 'Original title';
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'a1', title: 'Original title', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }]);
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'a1', title: metadataTitle, filename: 'a.cbz', tags: 'artist:old', extension: 'cbz', progress: 0, pageCount: 2, lastReadTime: 0, size: 1 } };
      if (command === 'update_archive_metadata') {
        metadataTitle = String((args?.metadata as { title?: string })?.title);
        return { ok: true, value: { operation: 'update_metadata', success: 1 } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary('/library/a1');

    await user.click(await screen.findByRole('button', { name: /^Original title\b/ }));
    await user.click(await screen.findByRole('button', { name: '档案菜单' }));
    // 菜单是点开之后才渲染的：整轮并行跑（161 个文件）时这一拍会被压后，同步的
    // `getByRole` 抓不到就报「找不到 menuitem」——判据等它出现，别跟机器抢时间。
    await user.click(await screen.findByRole('menuitem', { name: '编辑元数据' }));
    const titleInput = await screen.findByRole('textbox', { name: '标题' });
    expect(titleInput).toHaveValue('Original title');
    fireEvent.change(titleInput, { target: { value: 'Updated title' } });
    expect(titleInput).toHaveValue('Updated title');
    await user.click(screen.getByRole('button', { name: '保存元数据' }));

    expect(adapter).toHaveBeenCalledWith('update_archive_metadata', expect.objectContaining({
      serverId: 'scope-a', archiveId: 'a1',
      metadata: expect.objectContaining({ title: 'Updated title' }),
    }));
    expect(await screen.findByText('元数据已更新')).toBeInTheDocument();
  });

  it('shows a native thumbnail for the selected archive', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'cover-a', title: 'Covered', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }]);
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'cover-a', title: 'Covered', filename: 'a.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 2, lastReadTime: 0, size: 1 } };
      if (command === 'load_archive_thumbnail') return { ok: true, value: [255, 216, 255] };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderLibrary();

    await user.click(await screen.findByRole('button', { name: /^Covered\b/ }));

    expect(await screen.findByRole('img', { name: 'Covered 封面' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
  });

  it('uses and releases a persistent cached cover without requesting LANraragi', async () => {
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'server-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-persistent' }] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'server-a', archiveId: 'persistent-cover', title: 'Persistent cover', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }]);
      if (command === 'list_categories' || command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'persistent-cover', title: 'Persistent cover', filename: 'cached.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 2, lastReadTime: 0, size: 1 } };
      if (command === 'cache_read_image') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'load_archive_thumbnail') throw new Error('cover network should not be called');
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    const view = renderLibrary();

    await screen.findByRole('button', { name: /^Persistent cover\b/ });
    await waitFor(() => expect(view.container.querySelector('.archive-row-thumb img')).toHaveAttribute('src', expect.stringMatching(/^blob:/)));
    expect(adapter).not.toHaveBeenCalledWith('load_archive_thumbnail', expect.anything());
    view.unmount();
    // ⑥：封面句柄归零后**不再**立刻 revokeObjectURL。切走再回来闪一下的真根因就是
    // 「卸载＝撤销 URL＝缓存忘了这张图」，所以留一句「缓存还记得」才是修复本身；
    // 真正的回收交给 96MiB/256 条的 LRU 上限，而同步种子 peekCachedImageUrl 让重挂载的
    // 第一帧就是真图、不必等异步 load。
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    expect(peekCachedImageUrl(getNativeImageCache(), {
      scopeId: 'scope-persistent',
      serverId: 'server-a',
      archiveId: 'persistent-cover',
      rendition: 'cover',
      pageIndex: 0,
    })).toMatch(/^blob:/);
  });

  it('answers a pull by re-reading the page on screen, not by rebuilding the whole index', async () => {
    let refreshCount = 0;
    let pendingPage: Promise<unknown> | undefined;
    let probe = false;
    // The server owns the list, so what it answers on the first page is what the
    // user sees — no full-library pull stands between them.
    let served = [{ serverId: 'scope-a', archiveId: 'a1', title: 'Newest Archive', pageCount: 5, updatedAt: '2026-08-26T00:00:00Z' }];
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') return pendingPage ?? { ok: true, value: { items: served, total: served.length, hasMore: false } };
      if (command === 'probe_new_archives') return { ok: true, value: probe };
      if (command === 'refresh_archives') {
        refreshCount += 1;
        return { ok: true, value: served };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    expect(await screen.findByRole('button', { name: /^Newest Archive\b/ })).toBeInTheDocument();
    // Entering the library used to trigger a whole-library pull, which against a
    // real library timed out and left the list stale.
    expect(refreshCount).toBe(0);
    // The offset is an item offset, and LANraragi decides the page size.
    expect(adapter).toHaveBeenCalledWith('search_archives_page', {
      input: { serverId: 'scope-a', query: '', sortBy: 'added', order: 'desc', categoryId: null, untaggedOnly: false, start: 0 },
    });

    served = [{ serverId: 'scope-a', archiveId: 'a2', title: 'Fresh Archive', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' }];
    let finishRefresh!: (value: unknown) => void;
    pendingPage = new Promise(resolve => { finishRefresh = resolve; });
    fireEvent.wheel(screen.getByRole('list', { name: '档案' }), { deltaY: -300 });
    expect(screen.getByRole('button', { name: /^Newest Archive\b/ })).toBeInTheDocument();
    expect(document.querySelector('.archive-list-skeleton-layer:not(.is-exiting)')).toBeNull();
    await act(async () => { finishRefresh({ ok: true, value: { items: served, total: served.length, hasMore: false } }); });
    pendingPage = undefined;

    // One request, and the list is the new one — that is the whole refresh.
    expect(await screen.findByRole('button', { name: /^Fresh Archive\b/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Fresh Archive\b/ }).closest('.archive-row-wrap')).toHaveClass('is-fresh');
    // With nothing new to index, the offline mirror is left alone.
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('probe_new_archives', { serverId: 'scope-a' }));
    expect(refreshCount).toBe(0);

    // Something in LANraragi the local index has never seen: the mirror is
    // rebuilt behind the gesture, without the list waiting on it.
    probe = true;
    fireEvent.wheel(screen.getByRole('list', { name: '档案' }), { deltaY: -300 });

    await waitFor(() => expect(refreshCount).toBe(1));
    expect(adapter).toHaveBeenCalledWith('refresh_archives', {
      input: { serverId: 'scope-a', params: { sortby: 'date_added', order: 'desc' } },
    });
    expect(await screen.findByRole('button', { name: /^Fresh Archive\b/ })).toBeInTheDocument();
  });

  it('re-reads the page behind a restored list instead of leaving it as it was', async () => {
    const user = userEvent.setup();
    let pageRequests = 0;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        pageRequests += 1;
        // The second read is the entry refresh, and it has something new to say.
        return servedPage([{
          serverId: 'scope-a',
          archiveId: pageRequests === 1 ? 'a1' : 'a2',
          title: pageRequests === 1 ? 'Cached Archive' : 'Added Since',
          pageCount: 5,
          updatedAt: '2026-08-26T00:00:00Z',
        }]);
      }
      if (command === 'list_tasks') return { ok: true, value: [] };
      return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'not needed here', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    expect(await screen.findByRole('button', { name: /^Cached Archive\b/ })).toBeInTheDocument();
    expect(pageRequests).toBe(1);

    const sidebar = within(screen.getByRole('navigation', { name: '主导航' }));
    await user.click(sidebar.getByRole('link', { name: '本地档案' }));
    expect(await screen.findByRole('heading', { name: '本地档案' })).toBeInTheDocument();
    await user.click(sidebar.getByRole('link', { name: '档案库' }));

    // The restored list is on screen at once — no skeleton, no empty flash — and
    // the same page is re-read behind it. "Fresh" is a 90-second guess, and the
    // library is exactly where an archive added since the last visit has to turn
    // up, so skipping the request left the list as old as the last visit.
    expect(await screen.findByRole('button', { name: /^Added Since\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cached Archive\b/ })).not.toBeInTheDocument();
    expect(pageRequests).toBe(2);
  });

  it('pages by what the server handed over, not by what survived de-duplication', async () => {
    const offsets: number[] = [];
    // Page two repeats a row from page one — the server re-sorting between
    // requests is enough to cause that. The repeat is dropped from the list, so
    // an offset taken from the rendered length falls one behind the cursor, and
    // from then on every request asks for a window it has already seen.
    const pages: Record<number, Array<{ serverId: string; archiveId: string; title: string; pageCount: number; updatedAt: string }>> = {
      0: [
        { serverId: 'scope-a', archiveId: 'a1', title: 'One', pageCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
        { serverId: 'scope-a', archiveId: 'a2', title: 'Two', pageCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
      ],
      2: [
        { serverId: 'scope-a', archiveId: 'a2', title: 'Two', pageCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
        { serverId: 'scope-a', archiveId: 'a3', title: 'Three', pageCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
      ],
      4: [
        { serverId: 'scope-a', archiveId: 'a5', title: 'Five', pageCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
        { serverId: 'scope-a', archiveId: 'a6', title: 'Six', pageCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
      ],
    };
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        const start = Number((args?.input as { start?: number } | undefined)?.start ?? 0);
        offsets.push(start);
        const items = pages[start] ?? [];
        return { ok: true, value: { items, total: 6, hasMore: items.length > 0 && start + items.length < 6 } };
      }
      return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'not needed here', retryable: false } };
    });
    renderLibrary();

    await screen.findByRole('button', { name: /^One\b/ });
    const list = screen.getByRole('list', { name: '档案' });
    fireEvent.scroll(list, { target: { scrollTop: 10_000 } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Three\b/ })).toBeInTheDocument());

    // Three rows are on screen but four have been handed over, so the next
    // request has to ask for 4. Asking for 3 lands on a window the server has no
    // page for and the list stops growing.
    fireEvent.scroll(list, { target: { scrollTop: 20_000 } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Five\b/ })).toBeInTheDocument());
    expect(offsets).toEqual([0, 2, 4]);
  });

  it('restores the paging cursor with the list, not the rendered length', async () => {
    const offsets: number[] = [];
    const pages: Record<number, Array<{ serverId: string; archiveId: string; title: string; pageCount: number; updatedAt: string }>> = {
      0: [
        { serverId: 'scope-a', archiveId: 'a1', title: 'One', pageCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
        { serverId: 'scope-a', archiveId: 'a1', title: 'One', pageCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
      ],
      2: [{ serverId: 'scope-a', archiveId: 'a3', title: 'Three', pageCount: 1, updatedAt: '2026-08-26T00:00:00Z' }],
    };
    const adapter = vi.fn(async (command: string, args) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        const start = Number((args?.input as { start?: number } | undefined)?.start ?? 0);
        offsets.push(start);
        const items = pages[start] ?? [];
        return { ok: true, value: { items, total: 3, hasMore: items.length > 0 && start + items.length < 3 } };
      }
      if (command === 'list_tasks') return { ok: true, value: [] };
      return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'not needed here', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderLibrary();

    // The server hands over two rows that collapse to one on screen.
    await screen.findByRole('button', { name: /^One\b/ });
    expect(offsets).toEqual([0]);

    // Leave and come back: the page is re-read behind the restored list.
    const sidebar = within(screen.getByRole('navigation', { name: '主导航' }));
    await user.click(sidebar.getByRole('link', { name: '本地档案' }));
    await screen.findByRole('heading', { name: '本地档案' });
    await user.click(sidebar.getByRole('link', { name: '档案库' }));
    await screen.findByRole('button', { name: /^One\b/ });
    await waitFor(() => expect(offsets).toEqual([0, 0]));

    // The restored cursor has to be the server's (2), not the rendered length (1).
    fireEvent.scroll(screen.getByRole('list', { name: '档案' }), { target: { scrollTop: 10_000 } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Three\b/ })).toBeInTheDocument());
    expect(offsets).toEqual([0, 0, 2]);
  });

  it('shows the loading indicator instead of claiming the library is empty', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      // Never resolves: the first page is still in flight.
      if (command === 'search_archives_page') return new Promise(() => undefined);
      return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'not needed here', retryable: false } };
    });
    renderLibrary();

    // An in-flight request is not an empty library. These shared one branch, so
    // arriving at the library flashed 暂无档案库 before the first page landed.
    // Re-queried rather than held: the route swaps its own loading branch for the
    // workspace's as the server list resolves, so a captured node goes stale.
    await waitFor(() => expect(screen.getByRole('status', { name: '正在读取档案' })).toBeInTheDocument());
    expect(screen.queryByText('暂无档案库')).not.toBeInTheDocument();
  });

  it('saves a search preset through a drawn dialog that can refuse the value', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'a1', title: 'Preset me', pageCount: 2, updatedAt: '2026-09-05T00:00:00Z' }]);
      if (command === 'list_search_presets') return { ok: true, value: [] };
      if (command === 'save_search_preset') return { ok: true, value: { scopeId: 'scope-a', presetId: 'p1', name: '我的预设', query: '', sortBy: 'added', sortOrder: 'desc', categoryId: null, createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z', deviceId: 'd', revision: 1, deleted: false } };
      return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'not needed here', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    await screen.findByRole('button', { name: /^Preset me\b/ });
    // The add action is the last line of the preset menu.
    await user.click(screen.getByRole('button', { name: '检索预设' }));
    await user.click(await screen.findByRole('menuitem', { name: '新增预设' }));

    // A real dialog, not window.prompt: that one is unstyled, renders as browser
    // chrome on Windows, and cannot refuse a value.
    const dialog = await screen.findByRole('dialog', { name: '存为预设' });
    const name = within(dialog).getByLabelText('预设名称');
    await user.clear(name);
    expect(within(dialog).getByRole('button', { name: '保存预设' })).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请填写预设名称');

    await user.type(name, '我的预设');
    await user.click(within(dialog).getByRole('button', { name: '保存预设' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('save_search_preset', expect.objectContaining({
      input: expect.objectContaining({ name: '我的预设' }),
    })));
  });

  it('falls back to the local mirror when the server cannot be reached', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'error sending request for url', retryable: true } };
      if (command === 'list_archives_page') {
        return { ok: true, value: { items: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Last Seen Archive', pageCount: 5, updatedAt: '2026-08-26T00:00:00Z' }], total: 1, hasMore: false } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    // An unreachable server means a stale list, not an empty one.
    expect(await screen.findByRole('button', { name: /^Last Seen Archive\b/ })).toBeInTheDocument();
    expect(await screen.findByText('无法连接 LANraragi，正在显示本机上次同步的档案。')).toBeInTheDocument();
  });

  it('keeps the archive list when a refresh fails', async () => {
    // A refresh that cannot reach the server is a toast, not an empty page: the
    // list the user was reading stays exactly as it is.
    let failing = false;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        if (failing) return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'Network error', retryable: true } };
        return { ok: true, value: { items: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Stable Archive', pageCount: 5, updatedAt: '2026-08-26T00:00:00Z' }], total: 1, hasMore: false } };
      }
      if (command === 'probe_new_archives') return { ok: true, value: false };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    expect(await screen.findByRole('button', { name: /^Stable Archive\b/ })).toBeInTheDocument();

    failing = true;
    fireEvent.wheel(screen.getByRole('list', { name: '档案' }), { deltaY: -300 });

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    expect(screen.getByRole('button', { name: /^Stable Archive\b/ })).toBeInTheDocument();
  });

  it('opens a card context menu with incognito reading and the reading list', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'server-a', name: 'Home', baseUrl: 'https://lrr.test', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page') {
        return { ok: true, value: { items: [{ serverId: 'server-a', archiveId: 'a1', title: 'Archive One', pageCount: 4, updatedAt: '2026-09-03T00:00:00Z' }], total: 1, hasMore: false } };
      }
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'list_watchlist' || command === 'list_reading_history' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'load_archive_metadata') {
        return { ok: true, value: { archiveId: 'a1', title: 'Archive One', filename: 'a.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 4, lastReadTime: 0, size: 100 } };
      }
      if (command === 'set_reading_list') {
        return { ok: true, value: { scopeId: 'scope-a', archiveId: String((args as { archiveId?: string }).archiveId), addedAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false } };
      }
      return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'not needed here', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/library']}><App /></MemoryRouter>);

    const card = await screen.findByRole('button', { name: /^Archive One/ });
    // Only cards answer a right click.
    fireEvent.contextMenu(card, { clientX: 120, clientY: 80 });

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '无痕阅读' })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: '加入待看' }));
    expect(await screen.findByText('已加入待看')).toBeInTheDocument();
  });
});


it('refreshes presets on narrow invalidation without refetching archive pages', async () => {
  let presetName = 'Before update';
  const adapter = vi.fn(async (command: string) => {
    if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', scopeId: 'scope-a', name: 'Server', baseUrl: 'https://lrr.test' }] };
    if (command === 'search_archives_page') return servedPage([{ serverId: 'scope-a', archiveId: 'a', title: 'Stable archive', pageCount: 3, updatedAt: 'now' }]);
    if (command === 'list_search_presets') return { ok: true, value: [{ scopeId: 'scope-a', presetId: 'p', name: presetName, query: '', sortBy: 'added', sortOrder: 'desc', categoryId: null, createdAt: 'now', updatedAt: 'now', deviceId: 'd', revision: 1, deleted: false }] };
    if (command.startsWith('list_')) return { ok: true, value: [] };
    return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'unused', retryable: false } };
  });
  setInvokeAdapterForTests(adapter);
  renderLibrary();
  await screen.findByRole('button', { name: /^Stable archive/ });
  await userEvent.setup().click(screen.getByRole('button', { name: '检索预设' }));
  await screen.findByRole('menuitem', { name: /^Before update$/ });
  const pages = adapter.mock.calls.filter(([command]) => command === 'search_archives_page').length;
  presetName = 'After update';
  act(() => invalidateRouteCache('presets:'));
  await screen.findByRole('menuitem', { name: /^After update$/ });
  expect(screen.queryByRole('menuitem', { name: /^Before update$/ })).toBeNull();
  expect(adapter.mock.calls.filter(([command]) => command === 'search_archives_page')).toHaveLength(pages);
});
