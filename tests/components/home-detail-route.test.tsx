import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter } from 'react-router-dom';

// 这一组测的是**路由归属**：详情挂在哪一页上。详情本身长什么样由它自己的用例负责，
// 所以这里把它换成一行标题——路由把哪一页、哪一段 URL 交给了它，一眼可断。
vi.mock('../../src/components/ArchiveDetailRoute', () => ({
  ArchiveDetailRoute: ({ archiveId }: { archiveId: string }) => <h1>{`detail:${archiveId}`}</h1>,
}));
// 同理：档案库那一页只要能被认出来就够了，不必在这里拉起它的一整套请求。
vi.mock('../../src/components/LibraryRouteWorkspace', () => ({
  LibraryRouteWorkspace: () => <h1>library-list</h1>,
}));

import { WorkspaceRoutes } from '../../src/app/routes';
import { PreferencesProvider } from '../../src/app/preferences';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

/** 首页那一排卡片开的详情：用户报的是「在首页打开一个档案，当前页实际跳去了档案库」。 */
const archive = (index: number) => ({
  serverId: 'server-1',
  archiveId: `archive-${index}`,
  title: `Archive ${index}`,
  pageCount: 40,
  updatedAt: '2026-09-01T00:00:00.000Z',
});

// 未读完（0/40）：首页「继续阅读」默认不显示已读完的那几条。
const history = [
  { scopeId: 'scope-1', archiveId: 'archive-0', pageIndex: 0, visitedAt: '2026-09-02T10:00:00.000Z', deviceId: 'device-1', revision: 1 },
  { scopeId: 'scope-1', archiveId: 'archive-1', pageIndex: 0, visitedAt: '2026-09-01T10:00:00.000Z', deviceId: 'device-1', revision: 1 },
];

function makeAdapter() {
  return vi.fn(async (command: string) => {
    if (command === 'list_servers') return { ok: true, value: [{ id: 'server-1', scopeId: 'scope-1', name: 'Home', baseUrl: 'https://example.com', enabled: true }] };
    if (command === 'list_reading_history') return { ok: true, value: history };
    if (command === 'list_reading_list' || command === 'list_watchlist' || command === 'list_search_presets') return { ok: true, value: [] };
    if (command === 'list_archives_by_ids') return { ok: true, value: [archive(0), archive(1)] };
    if (command === 'verify_archives_exist') return { ok: true, value: [] };
    if (command === 'search_random_archives') return { ok: true, value: [] };
    if (command === 'list_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
    if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
    if (command === 'list_tasks') return { ok: true, value: [] };
    return { ok: true, value: [] };
  });
}

function renderApp(initialEntry: string, adapter: ReturnType<typeof makeAdapter>) {
  setInvokeAdapterForTests(adapter);
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PreferencesProvider><ToastProvider>
        <Link to="/">to-home</Link>
        <Link to="/library">to-library</Link>
        <WorkspaceRoutes />
      </ToastProvider></PreferencesProvider>
    </MemoryRouter>,
  );
}

afterEach(resetInvokeAdapterForTests);

describe('home detail route', () => {
  it('opens a home rail card on the home page instead of the library', async () => {
    renderApp('/', makeAdapter());
    const rail = await screen.findByRole('region', { name: '继续阅读' });
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    expect(rail).toContainElement(card);
    // 首页的卡片是首页的详情：从前这里写死 `/library/:id`，所以「在首页打开档案」
    // 实际是「跳到档案库再打开它」。
    expect(card).toHaveAttribute('href', '/home/archive-0?server=server-1');

    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    // 左边那一栏还是首页自己的两排，而不是档案库的列表。
    expect(screen.getByRole('region', { name: '继续阅读' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'library-list' })).not.toBeInTheDocument();
  });

  it('does not leave the library showing that detail after going home and opening the library', async () => {
    renderApp('/', makeAdapter());
    fireEvent.click(await screen.findByRole('link', { name: /Archive 0/ }));
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();

    // 返回首页：首页重新是当前页。
    fireEvent.click(screen.getByRole('link', { name: 'to-home' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'detail:archive-0' })).not.toBeInTheDocument());
    expect(screen.getByRole('region', { name: '继续阅读' })).toBeInTheDocument();

    // 再点「档案库」：用户看到的却是刚才那份详情——档案库替首页记下了那个详情地址。
    fireEvent.click(screen.getByRole('link', { name: 'to-library' }));
    expect(await screen.findByRole('heading', { name: 'library-list' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'detail:archive-0' })).not.toBeInTheDocument();
  });
});
