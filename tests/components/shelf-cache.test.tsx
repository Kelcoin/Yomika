import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter } from 'react-router-dom';
import { WorkspaceRoutes } from '../../src/app/routes';
import { PreferencesProvider } from '../../src/app/preferences';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';
import { invalidateRouteCache, readRouteCache, resetRouteCacheForTests, writeRouteCache } from '../../src/lib/routeCache';
import { rememberServerPresence } from '../../src/lib/serverPresence';

afterEach(() => {
  resetInvokeAdapterForTests();
  resetRouteCacheForTests();
});

describe('shelf snapshots', () => {

  it('shows cached history cards while missing archive metadata is still downloading', async () => {
    let finishMetadata!: () => void;
    const pendingMetadata = new Promise<void>(resolve => { finishMetadata = resolve; });
    const archive = (archiveId: string, title: string) => ({ serverId: 's', archiveId, title, pageCount: 8, updatedAt: 'now' });
    const cached = archive('cached', 'Cached history archive');
    const remote = archive('remote', 'Remote history archive');
    let resolved = false;
    const calls: string[] = [];
    setInvokeAdapterForTests(async (command: string) => {
      calls.push(command);
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'list_reading_history') return { ok: true, value: [cached, remote].map(({ archiveId }) => ({ scopeId: 's', archiveId, pageIndex: 7, visitedAt: '2026-11-14T10:00:00Z', deviceId: 'd', revision: 1 })) };
      if (command === 'list_archives_by_ids') return { ok: true, value: resolved ? [cached, remote] : [cached] };
      if (command === 'load_archive_metadata') {
        await pendingMetadata;
        resolved = true;
        return { ok: true, value: { ...remote, filename: 'remote.cbz', tags: '', extension: 'cbz', progress: 0, lastReadTime: 0, size: 100 } };
      }
      return { ok: true, value: [] };
    });
    render(<MemoryRouter initialEntries={['/history']}><PreferencesProvider><WorkspaceRoutes /></PreferencesProvider></MemoryRouter>);
    try {
      await waitFor(() => expect(calls).toContain('load_archive_metadata'));
      expect(await screen.findByText('Cached history archive')).toBeInTheDocument();
    } finally {
      finishMetadata();
    }
    expect((await screen.findByText('Remote history archive')).closest('.archive-row-wrap')).toHaveClass('is-fresh');
    expect(screen.getByText('Cached history archive').closest('.archive-row-wrap')).not.toHaveClass('is-fresh');
  });
  it('offers three labelled history actions and exits with the selection toggle', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 's', archiveId: 'a', pageIndex: 7, visitedAt: '2026-11-14T10:00:00Z', deviceId: 'd', revision: 1 }] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 's', archiveId: 'a', title: 'History archive', pageCount: 8, updatedAt: 'now' }] };
      return { ok: true, value: [] };
    });
    render(<MemoryRouter initialEntries={['/history']}><PreferencesProvider><WorkspaceRoutes /></PreferencesProvider></MemoryRouter>);
    await screen.findByText('History archive');
    fireEvent.click(screen.getByRole('button', { name: '多选' }));
    const toolbar = screen.getByRole('toolbar', { name: '多选操作' });
    expect(within(toolbar).getAllByRole('button').map(button => button.textContent)).toEqual(['全选当前', '全选已读', '清理记录']);
    expect(within(toolbar).queryByRole('button', { name: /收藏|完成/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出多选' }));
    expect(screen.getByRole('button', { name: '多选' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('finishes a favorites refresh without waiting for unrelated categories or existence probes', async () => {
    let ids = ['kept', 'removed'];
    const adapter = vi.fn(async (command: string, args: unknown) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'read_favorites_category') return { ok: true, value: { id: 'SET_1785040778', archives: ids } };
      if (command === 'list_categories' || command === 'verify_archives_exist') return new Promise(() => {});
      if (command === 'list_archives_by_ids') return { ok: true, value: (args as { archiveIds: string[] }).archiveIds.map(archiveId => ({ serverId: 's', archiveId, title: archiveId === 'kept' ? '保留的收藏' : '移除的收藏', pageCount: 8, updatedAt: 'now' })) };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/watchlist']}><PreferencesProvider><WorkspaceRoutes /></PreferencesProvider></MemoryRouter>);
    await screen.findByText('保留的收藏');
    expect(screen.getByText('移除的收藏')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '多选' }));
    expect(screen.getByRole('button', { name: '移除收藏' })).toHaveTextContent('移除收藏');
    ids = ['kept'];
    act(() => invalidateRouteCache('state:'));
    await waitFor(() => expect(adapter.mock.calls.filter(([command]) => command === 'read_favorites_category').length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByText('移除的收藏')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('正在刷新档案库…')).not.toBeInTheDocument());
    expect(adapter.mock.calls.some(([command]) => command === 'verify_archives_exist')).toBe(false);
  });

  it.each([['history', 'history'], ['to-read', 'toRead']])('rejects a valid-shaped A snapshot stored under the B key on %s', async (path, name) => {
    writeRouteCache(`state:${name}:B`, { serverId: 'A', scopeId: 'A', history: [], watchlist: [], archives: [], query: '' });
    const adapter = vi.fn(async command => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'B', scopeId: 'B', name: 'B', baseUrl: 'https://b.example.com' }] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={[`/${path}?server=B`]}><PreferencesProvider><WorkspaceRoutes /></PreferencesProvider></MemoryRouter>);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('list_servers', {}));
    await waitFor(() => expect(readRouteCache<{ serverId: string }>(`state:${name}:B`)?.serverId).toBe('B'));
  });

  it.each([['history', 'state:history:default', '暂无历史'], ['to-read', 'state:toRead:default', '暂无待看档案'], ['watchlist', 'favorites:last:default', '暂无收藏夹']])('recovers from a malformed startup snapshot on %s', async (path, key, emptyTitle) => {
    writeRouteCache(key, { favoritesSource: 'remote', serverId: 's', scopeId: 's', history: [], watchlist: [], archives: {}, query: '' });
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'read_favorites_category') return { ok: true, value: { id: 'SET_1613080290', archives: [] } };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      return { ok: true, value: [] };
    });
    expect(() => render(<MemoryRouter initialEntries={[`/${path}`]}><PreferencesProvider><WorkspaceRoutes /></PreferencesProvider></MemoryRouter>)).not.toThrow();
    await screen.findByRole('heading', { name: emptyTitle });
  });

  it('reloads categories when the enabled default server changes', async () => {
    let chosen = 'A';
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [{ id: chosen, scopeId: chosen, name: chosen, baseUrl: 'https://example.com' }] };
      if (command === 'list_reading_list') return { ok: true, value: [{ scopeId: chosen, archiveId: 'shared', addedAt: 'now', updatedAt: 'now', deviceId: 'test', revision: 1, deleted: false }] };
      if (command === 'list_categories') return { ok: true, value: [{ id: chosen === 'A' ? 'SET_1613080290' : 'SET_1613080291', name: `${chosen} category`, search: null, pinned: false, archives: ['shared'] }] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: chosen, archiveId: 'shared', title: `${chosen} archive`, pageCount: 1, updatedAt: 'now' }] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      return { ok: true, value: [] };
    });
    render(<MemoryRouter initialEntries={['/to-read']}><PreferencesProvider><WorkspaceRoutes /></PreferencesProvider></MemoryRouter>);
    await screen.findByRole('button', { name: /^A archive\b/ });
    expect(screen.getByRole('combobox', { name: '分类筛选' })).toHaveTextContent('A category');
    fireEvent.change(screen.getByRole('combobox', { name: '分类筛选' }), { target: { value: 'SET_1613080290' } });
    chosen = 'B';
    act(() => invalidateRouteCache('state:'));
    await screen.findByRole('button', { name: /^B archive\b/ });
    expect(screen.getByRole('combobox', { name: '分类筛选' })).toHaveTextContent('B category');
    expect(screen.getByRole('combobox', { name: '分类筛选' })).not.toHaveTextContent('A category');
  });

  it.each([['history', 'history'], ['to-read', 'toRead']])('does not retain a cached A shelf when switching server on %s', async (path, name) => {
    const makeArchive = (serverId: string) => ({ serverId, archiveId: 'shared', title: `${serverId} cached shelf`, pageCount: 3, updatedAt: 'now' });
    const makeHistory = (scopeId: string) => ({ scopeId, archiveId: 'shared', pageIndex: 0, visitedAt: 'now', deviceId: 'test', revision: 1 });
    const makeReading = (scopeId: string) => ({ scopeId, archiveId: 'shared', addedAt: 'now', updatedAt: 'now', deviceId: 'test', revision: 1, deleted: false });
    writeRouteCache(`state:${name}:A`, { serverId: 'A', scopeId: 'A', history: [makeHistory('A')], watchlist: [makeReading('A')], archives: [makeArchive('A')], query: '', categories: [] });
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return { ok: true, value: ['A', 'B'].map(id => ({ id, scopeId: id, name: id, baseUrl: `https://${id}.example.com` })) };
      if (command === 'list_reading_history') return { ok: true, value: [makeHistory(String(args?.scopeId))] };
      if (command === 'list_reading_list') return { ok: true, value: [makeReading(String(args?.scopeId))] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [makeArchive(String(args?.serverId))] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={[`/${path}?server=A`]}><PreferencesProvider><Link to={`/${path}?server=B`}>Switch server</Link><WorkspaceRoutes /></PreferencesProvider></MemoryRouter>);
    await screen.findByRole('button', { name: /^A cached shelf\b/ });
    fireEvent.click(screen.getByText('Switch server'));
    await screen.findByRole('button', { name: /^B cached shelf\b/ });
    expect(screen.queryByRole('button', { name: /^A cached shelf\b/ })).not.toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('list_archives_by_ids', { serverId: 'B', archiveIds: ['shared'] });
  });

  it('retains an expired verified remote snapshot with an offline explanation', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    writeRouteCache('favorites:last:default', {
      favoritesSource: 'remote', history: [], serverId: 's', scopeId: 's', query: '',
      watchlist: [{ scopeId: 's', archiveId: 'remote', addedAt: '', updatedAt: '', deviceId: '', revision: 1, deleted: false }],
      archives: [{ serverId: 's', archiveId: 'remote', title: 'Verified old remote favorite', pageCount: 3, updatedAt: '2026-01-01' }],
    });
    clock.mockReturnValue(1000 + 24 * 60 * 60 * 1000);
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'offline', retryable: true } };
    });
    render(<MemoryRouter initialEntries={['/watchlist']}><PreferencesProvider><ToastProvider><WorkspaceRoutes /></ToastProvider></PreferencesProvider></MemoryRouter>);
    expect(await screen.findByText(/离线缓存：显示上次收藏快照/)).toBeInTheDocument();
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(screen.getByText('Verified old remote favorite')).toBeInTheDocument();
    clock.mockRestore();
  });

  it.each([false, true])('does not reuse A favorites for an offline B (default=%s)', async (defaultServer) => {
    let chosen = 'A';
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: chosen, scopeId: chosen, name: chosen, baseUrl: 'https://example.com' }, ...(chosen === 'A' ? [{ id: 'B', scopeId: 'B', name: 'B', baseUrl: 'https://b.example.com' }] : [])] };
      if (command === 'read_favorites_category') return args?.serverId === 'B' ? pending : { ok: true, value: { id: 'fav', archives: ['a'] } };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'A', archiveId: 'a', title: 'Only server A', pageCount: 3, updatedAt: '2026-01-01' }] };
      if (['list_categories', 'find_missing_archives'].includes(command)) return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      return { ok: false, error: { code: 'NETWORK', message: 'unused', retryable: true } };
    });
    render(<MemoryRouter initialEntries={[defaultServer ? '/watchlist' : '/watchlist?server=A']}><PreferencesProvider><ToastProvider><Link to="/watchlist?server=B">server-B</Link><WorkspaceRoutes /></ToastProvider></PreferencesProvider></MemoryRouter>);
    await screen.findByText('Only server A');
    if (defaultServer) { chosen = 'B'; act(() => invalidateRouteCache('state:')); }
    else fireEvent.click(screen.getByText('server-B'));
    await waitFor(() => expect(screen.queryByText('Only server A')).toBeNull());
    expect(readRouteCache('favorites:last:B')).toBeUndefined();
    await act(async () => finish({ ok: false, error: { code: 'NETWORK', message: 'B offline', retryable: true } }));
    await screen.findByText('B offline');
    expect(screen.queryByText('Only server A')).toBeNull();
    expect(readRouteCache('favorites:last:B')).toBeUndefined();
  });

  it('explains a missing category separately from an existing empty category', async () => {
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'read_favorites_category') return { ok: true, value: null };
      if (['list_categories', 'find_missing_archives'].includes(command)) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/watchlist']}><PreferencesProvider><ToastProvider><WorkspaceRoutes /></ToastProvider></PreferencesProvider></MemoryRouter>);
    expect(await screen.findByText('服务器尚未创建 🔖 Favorites 分类')).toBeInTheDocument();
    expect(screen.queryByText('暂无收藏夹')).toBeNull();
    expect(readRouteCache<{ favoritesCategoryPresent: boolean }>('favorites:last:default')?.favoritesCategoryPresent).toBe(false);
  });

  it('restores separate shelves without reload and invalidates after reading-list mutation', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (['list_reading_history', 'list_watchlist', 'list_reading_list', 'list_archives_by_ids'].includes(command)) return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'set_reading_list') return { ok: true, value: { scopeId: 's', archiveId: 'a', addedAt: '2026-09-07', updatedAt: '2026-09-07', deviceId: 'device', deleted: false, revision: 1 } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/history']}><PreferencesProvider><ToastProvider>
      <Link to="/history">history-nav</Link><Link to="/to-read">to-read-nav</Link><WorkspaceRoutes />
    </ToastProvider></PreferencesProvider></MemoryRouter>);
    await screen.findByText('暂无历史');
    fireEvent.click(screen.getByText('to-read-nav'));
    await screen.findByText('暂无待看档案');
    fireEvent.click(screen.getByText('history-nav'));
    expect(screen.getByText('暂无历史')).toBeInTheDocument();
    expect(adapter.mock.calls.filter(([command]) => command === 'list_reading_history')).toHaveLength(1);
    const mutation = await new NativeLibraryRepository().setReadingList('s', 'a', true);
    expect(mutation.ok).toBe(true);
    fireEvent.click(screen.getByText('to-read-nav'));
    await waitFor(() => expect(adapter.mock.calls.filter(([command]) => command === 'list_reading_list')).toHaveLength(2));
  });

  it('picks up a server that showed up after the shelf had already said there was none', async () => {
    // 用户报的那一条：导入服务器凭据之后，历史/收藏夹还挂着「添加你的 LANraragi」。
    // 书架把「有服务器吗」记成一个布尔量，但它原先只会往 false 走：装载重跑读到
    // 服务器也不撤销结论，于是提示一直挂在已经读回来的书架上面。导入自己会发一次
    // 全量作废（`invalidateRouteCache()`），所以这里照那条路重演。
    let servers: { id: string; scopeId: string; name: string; baseUrl: string }[] = [];
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: servers };
      if (['list_reading_history', 'list_watchlist', 'list_reading_list', 'list_archives_by_ids'].includes(command)) return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      return { ok: false, error: { code: 'UNKNOWN', message: `unused ${command}`, retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/history']}><PreferencesProvider><ToastProvider>
      <WorkspaceRoutes />
    </ToastProvider></PreferencesProvider></MemoryRouter>);
    await screen.findByRole('heading', { name: '添加你的 LANraragi' });

    servers = [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }];
    await act(async () => { invalidateRouteCache(); });

    await waitFor(() => expect(screen.queryByRole('heading', { name: '添加你的 LANraragi' }), '服务器已经在列表里了，这道提示必须撤掉').toBeNull());
    expect(await screen.findByText('暂无历史')).toBeInTheDocument();
  });

  it('drops the home and shelf snapshots when history records are removed', async () => {
    // 用户报的那一条：历史里清掉（多选「全选已读完」→「清理所选记录」）或自动清理掉记录
    // 之后，首页「继续阅读」那一排还在显示它们。清理后需要作废书架快照，
    // 界面上的快照没人作废——首页那一份就一直停在旧数据上。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'delete_history_records') return { ok: true, value: 2 };
      if (command === 'prune_history') return { ok: true, value: 3 };
      return { ok: false, error: { code: 'UNKNOWN', message: `unused ${command}`, retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeLibraryRepository();

    writeRouteCache('home:shelves', { history: [] });
    writeRouteCache('state:history:default', { history: [] });
    expect(await repository.deleteHistoryRecords('s', ['a1', 'a2'])).toEqual({ ok: true, value: 2 });
    expect(readRouteCache('home:shelves')).toBeUndefined();
    expect(readRouteCache('state:history:default')).toBeUndefined();

    // 自动清理（启动后的巡检、设置里的「立即清理」）走的是同一条路。
    writeRouteCache('home:shelves', { history: [] });
    writeRouteCache('state:history:default', { history: [] });
    expect(await repository.pruneHistory()).toEqual({ ok: true, value: 3 });
    expect(readRouteCache('home:shelves')).toBeUndefined();
    expect(readRouteCache('state:history:default')).toBeUndefined();
  });

  it('drops the shelf snapshots when an archive is added to a category', async () => {
    // 用户报的那一条：加进收藏夹之后收藏夹页面还是不显示它。本机那张收藏表先写，写完
    // 广播一次 `state:` 作废，书架于是**立刻重读一次**——而那一刻服务器镜像还没发出去
    // （PUT 在后面），读回来的是「加之前」的名单，还会被写进 localStorage 快照自己续命。
    // 所以这条镜像写也必须作废快照；移出收藏夹那条一直有，症状才会单向。
    setInvokeAdapterForTests(vi.fn(async (command: string) => {
      if (command === 'add_archive_to_category') return { ok: true, value: { operation: 'add_to_category', success: 1 } };
      return { ok: false, error: { code: 'UNKNOWN', message: `unused ${command}`, retryable: false } };
    }));
    const repository = new NativeLibraryRepository();
    writeRouteCache('home:shelves', { watchlist: [] });
    writeRouteCache('state:watchlist:default', { watchlist: [] });

    expect(await repository.addArchiveToCategory('s', 'SET_1785040778', 'a1')).toEqual({ ok: true, value: { operation: 'add_to_category', success: 1 } });
    expect(readRouteCache('home:shelves')).toBeUndefined();
    expect(readRouteCache('state:watchlist:default')).toBeUndefined();
  });

  it('leaves the snapshots alone when the category write failed', async () => {
    // 服务器那边没写成（离线、分类不在）时别作废：书架白重排一遍，用户还会看到刚才
    // 那一下「加进去」的假象被重读抹掉。
    setInvokeAdapterForTests(vi.fn(async () => ({ ok: false, error: { code: 'NETWORK', message: 'offline', retryable: true } })));
    const repository = new NativeLibraryRepository();
    writeRouteCache('home:shelves', { watchlist: [] });
    writeRouteCache('state:watchlist:default', { watchlist: [] });

    expect((await repository.addArchiveToCategory('s', 'SET_1785040778', 'a1')).ok).toBe(false);
    expect(readRouteCache('home:shelves')).toEqual({ watchlist: [] });
    expect(readRouteCache('state:watchlist:default')).toEqual({ watchlist: [] });
  });

  it('excludes stale local favorites when the remote category is empty', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'read_favorites_category') return { ok: true, value: { id: 'SET_1785040778', archives: [] } };
      if (command === 'list_watchlist') {
        return { ok: true, value: [{ scopeId: 's', archiveId: 'a1', addedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', deviceId: 'device', deleted: false, revision: 1 }] };
      }
      if (command === 'list_archives_by_ids') {
        return { ok: true, value: [{ serverId: 's', archiveId: 'a1', title: '本机记着的收藏档案', pageCount: 8, updatedAt: '2026-10-01T00:00:00Z' }] };
      }
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'find_missing_archives') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: `unused ${command}`, retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/watchlist']}><PreferencesProvider><ToastProvider>
      <WorkspaceRoutes />
    </ToastProvider></PreferencesProvider></MemoryRouter>);

    expect(await screen.findByText('暂无收藏夹')).toBeInTheDocument();
    expect(adapter.mock.calls.some(([command]) => command === 'list_watchlist')).toBe(false);
    expect(screen.queryByText('本机记着的收藏档案')).toBeNull();
    // 空名单也不许落进快照：它被持久化之后，下一次恢复还是会把它当成「已知」。
    await waitFor(() => expect(readRouteCache('state:watchlist:default')).toBeTruthy());
    expect((readRouteCache<{ favoritesIds?: string[] }>('state:watchlist:default') ?? {}).favoritesIds).toBeUndefined();
  });

  it('draws remote-only favorites regardless of obsolete local records', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'read_favorites_category') return { ok: true, value: { id: 'SET_1785040778', archives: ['server-only', 'mine'] } };
      if (command === 'list_watchlist') {
        return { ok: true, value: [{ scopeId: 's', archiveId: 'mine', addedAt: '2026-10-11T08:23:20Z', updatedAt: '2026-10-11T08:23:20Z', deviceId: 'device', deleted: false, revision: 1 }] };
      }
      if (command === 'list_archives_by_ids') {
        return { ok: true, value: [
          { serverId: 's', archiveId: 'mine', title: '本机记着的收藏', pageCount: 8, updatedAt: '2026-10-11T08:23:20Z' },
          { serverId: 's', archiveId: 'server-only', title: '服务器上那条', pageCount: 9, updatedAt: '2026-10-11T08:23:20Z' },
        ] };
      }
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'find_missing_archives') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: `unused ${command}`, retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/watchlist']}><PreferencesProvider><ToastProvider>
      <WorkspaceRoutes />
    </ToastProvider></PreferencesProvider></MemoryRouter>);

    expect(await screen.findByText('本机记着的收藏')).toBeInTheDocument();
    // The category is authoritative, including items added by other clients.
    expect(adapter.mock.calls.find(([command]) => command === 'list_archives_by_ids')).toEqual(['list_archives_by_ids', { serverId: 's', archiveIds: ['server-only', 'mine'] }]);
    expect(await screen.findByText('服务器上那条')).toBeInTheDocument();
  });

  it('ignores an empty favorites id list that was persisted before the fix', async () => {
    rememberServerPresence(true);
    setInvokeAdapterForTests(vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      return { ok: false, error: { code: 'UNKNOWN', message: `unused ${command}`, retryable: false } };
    }));
    writeRouteCache('state:watchlist:default', {
      history: [],
      watchlist: [{ scopeId: 's', archiveId: 'a1', addedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', deviceId: 'device', deleted: false, revision: 1 }],
      archives: [{ serverId: 's', archiveId: 'a1', title: '快照里的收藏档案', pageCount: 8, updatedAt: '2026-10-01T00:00:00Z' }],
      serverId: 's',
      scopeId: 's',
      query: '',
      favoritesIds: [],
    });
    render(<MemoryRouter initialEntries={['/watchlist']}><PreferencesProvider><ToastProvider>
      <WorkspaceRoutes />
    </ToastProvider></PreferencesProvider></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('unused list_servers')).toBeInTheDocument());
  });

  it('leaves the snapshots alone when nothing was actually removed', async () => {
    // 六小时一次的巡检绝大多数时候一条也没清：那时不该作废快照，首页不会白重排一遍
    // （随机漫游也会跟着重抽）。
    setInvokeAdapterForTests(vi.fn(async (command: string) => {
      if (command === 'prune_history') return { ok: true, value: 0 };
      if (command === 'delete_history_records') return { ok: true, value: 0 };
      return { ok: false, error: { code: 'UNKNOWN', message: `unused ${command}`, retryable: false } };
    }));
    const repository = new NativeLibraryRepository();
    writeRouteCache('home:shelves', { history: [] });

    expect(await repository.pruneHistory()).toEqual({ ok: true, value: 0 });
    expect(await repository.deleteHistoryRecords('s', ['a1'])).toEqual({ ok: true, value: 0 });
    expect(readRouteCache('home:shelves')).toEqual({ history: [] });
  });
});
