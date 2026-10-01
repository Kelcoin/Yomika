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

/** 与 `renderApp` 同一棵树，只是外面套上 AppShell 那个工作区：首页两态的滚动容器
 * 互换了这件事只有在 `.workspace` 真的存在时才谈得上（`HomeShell` 用它当「详情没开
 * 时在滚谁」的答案）。 */
function renderAppInWorkspace(initialEntry: string, adapter: ReturnType<typeof makeAdapter>) {
  setInvokeAdapterForTests(adapter);
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PreferencesProvider><ToastProvider>
        <main className="workspace" id="main-content">
          <Link to="/">to-home</Link>
          <Link to="/library">to-library</Link>
          <WorkspaceRoutes />
        </main>
      </ToastProvider></PreferencesProvider>
    </MemoryRouter>,
  );
}

/** jsdom has no layout, so `scrollTop` reads 0 no matter what a component writes into
 * it: make it a plain writable property that the test (and the shell) can both set. */
function scrollHost(element: HTMLElement): HTMLElement {
  Object.defineProperty(element, 'scrollTop', { value: 0, configurable: true, writable: true });
  return element;
}

afterEach(resetInvokeAdapterForTests);

/** 某个面板当前的比例。react-resizable-panels 把「id → flexGrow」这份布局写在内联样式
 * 上，所以 DOM 里读得到真正生效的比例，而不是我们以为写了多少。（按 id 取而不是按
 * `[data-panel]` 的顺序取：书架那一页的列表里还嵌着档案库自己的一层单面板 Group。） */
function panelGrow(id: string): string | undefined {
  return document.getElementById(id)?.style.flexGrow;
}

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

  it('carries the reading position over when the detail opens and closes', async () => {
    renderAppInWorkspace('/', makeAdapter());
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    // jsdom has no layout: `scrollTop` needs to be a real, writable property or the
    // assignment the shell makes below is swallowed by the platform getter.
    const page = scrollHost(document.getElementById('main-content')!);
    const list = scrollHost(document.querySelector('.library-shell-list') as HTMLElement);
    // 详情没开时整页在滚（面板是 `is-flow`，随内容长高）。
    page.scrollTop = 240;
    fireEvent.scroll(page);

    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    // 开详情换的是「谁在滚」：左栏自己成为滚动容器，整页不再滚。新容器不能从 0
    // 开始——用户报的就是「读到一半点开详情，页面自己跳回顶部」。
    expect(list.scrollTop).toBe(240);

    // 关掉详情（回首页）是同一条路的另一边：位置得写回整页那个容器。
    list.scrollTop = 500;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole('link', { name: 'to-home' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'detail:archive-0' })).not.toBeInTheDocument());
    await waitFor(() => expect(page.scrollTop).toBe(500));
  });

  it('keeps trying while the fresh scroller still clamps the offset', async () => {
    renderAppInWorkspace('/', makeAdapter());
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    const page = scrollHost(document.getElementById('main-content')!);
    const list = scrollHost(document.querySelector('.library-shell-list') as HTMLElement);
    page.scrollTop = 240;
    fireEvent.scroll(page);

    // 真机上的新容器不是「随时能滚」：换容器那一帧它还没长到 240 那么高，浏览器会把
    // 这一写**夹成 0**。这里把这件事做出来——前两次写进去都收不下，第三次才宽到装得下。
    // 一发式的写法会停在 0（那一发正好被夹掉），而打包带走位置的那一份也不能再被
    // 这个元素的 0 覆写。
    let stored = 0;
    let writes = 0;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => stored,
      set: (value: number) => {
        writes += 1;
        stored = Math.min(value, writes >= 3 ? 9999 : 0);
      },
    });

    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    await waitFor(() => expect(list.scrollTop).toBe(240));
    expect(writes).toBeGreaterThan(1);
  });

  it('starts every two-pane shell at the declared ratio instead of an even split', async () => {
    // `Panel` 自己的 `defaultSize` 在 react-resizable-panels v4 里不生效（4.12.3 实测：
    // 两个面板写 `defaultSize="58"`/`"42"`，渲染出来都是 `flex-grow: 50`），比例只能由
    // `Group` 的 `defaultLayout` 给——见 `src/lib/panelLayout.ts`。用户报的「首页的双页
    // 比例和别的页不一样」，根子就是没存过布局的页面全在五五开。
    const home = renderAppInWorkspace('/', makeAdapter());
    fireEvent.click(await screen.findByRole('link', { name: /Archive 0/ }));
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    expect([panelGrow('home-shell-list'), panelGrow('home-shell-detail')]).toEqual(['58', '42']);
    home.unmount();

    // 档案库、书架与首页是同一份声明，落下来也该是同一个比例。
    const cases = [
      { entry: '/library/archive-0', list: 'library-shell-list', detail: 'library-shell-detail' },
      { entry: '/history/archive-0', list: 'shelf-shell-list-history', detail: 'shelf-shell-detail-history' },
    ];
    for (const { entry, list, detail } of cases) {
      const view = renderAppInWorkspace(entry, makeAdapter());
      expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
      expect([panelGrow(list), panelGrow(detail)], entry).toEqual(['58', '42']);
      view.unmount();
    }
  });
});
