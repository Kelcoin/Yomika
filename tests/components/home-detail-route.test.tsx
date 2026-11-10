import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
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
import { AppShell, navEntryActive } from '../../src/components/AppShell';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';

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

/** jsdom 里所有 `getBoundingClientRect` 都是 0；要测「按内容对齐」就得自己给一份布局。 */
function rect(top: number, height: number): DOMRect {
  return {
    top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}),
  } as DOMRect;
}

afterEach(resetInvokeAdapterForTests);

/** 某个面板当前的比例。react-resizable-panels 把「id → flexGrow」这份布局写在内联样式
 * 上，所以 DOM 里读得到真正生效的比例，而不是我们以为写了多少。（按 id 取而不是按
 * `[data-panel]` 的顺序取：书架那一页的列表里还嵌着档案库自己的一层单面板 Group。） */
function panelGrow(id: string): string | undefined {
  return document.getElementById(id)?.style.flexGrow;
}

describe('home detail route', () => {
  it('transfers the home position before paint without smooth-scrolling intermediate offsets', async () => {
    renderAppInWorkspace('/', makeAdapter());
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    const page = scrollHost(document.getElementById('main-content')!);
    const list = scrollHost(document.querySelector('.library-shell-list') as HTMLElement);
    list.style.scrollBehavior = 'smooth';
    page.scrollTop = 240;
    fireEvent.scroll(page);
    let offset = 0;
    const writes: string[] = [];
    Object.defineProperty(list, 'scrollTop', {
      configurable: true, get: () => offset,
      set: (value: number) => { writes.push(list.style.scrollBehavior); offset = value; },
    });
    fireEvent.click(card);
    expect(list.scrollTop).toBe(240);
    expect(writes).toEqual(['auto']);
    await waitFor(() => expect(list.style.scrollBehavior).toBe('smooth'));
  });
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
    // 这一写**夹成 0**。这里把这件事做出来——前 11 次写进去都收不下（左栏里的封面还在
    // 解码，内容高度就是没长起来），第十二次才宽到装得下。一发式的写法会停在 0；重试
    // 窗口只有一开始那几个帧（8 帧 ≈ 130ms）同样会停在 0，用户看到的是「跳到一个固定
    // 的位置」。
    let stored = 0;
    let writes = 0;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => stored,
      set: (value: number) => {
        writes += 1;
        stored = Math.min(value, writes >= 12 ? 9999 : 0);
      },
    });

    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    await waitFor(() => expect(list.scrollTop).toBe(240));
    expect(writes).toBeGreaterThan(1);
  });

  it('holds the position it was asked for even though its own writing comes back as a scroll event', async () => {
    renderAppInWorkspace('/', makeAdapter());
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    const page = scrollHost(document.getElementById('main-content')!);
    const list = scrollHost(document.querySelector('.library-shell-list') as HTMLElement);
    page.scrollTop = 240;
    fireEvent.scroll(page);

    // 真机上是两件事一起发生：新容器头几帧还装不下那么高（写进去被夹成 0），而且**每一次
    // 写都会换来一个 scroll 事件**——浏览器就是这么做的，它不区分「用户滚的」和「代码写的」。
    // 把这个回声当成「用户现在在这儿」，下一帧算出来的目标就变成它自己，循环立刻判定稳定、
    // 停在 0：用户看到的正是「只要不在顶部，打开详情就跳到某个固定的位置」。
    let stored = 0;
    let writes = 0;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => stored,
      set: (value: number) => {
        writes += 1;
        stored = Math.min(value, writes >= 3 ? 9999 : 0);
        fireEvent.scroll(list);
      },
    });

    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    await waitFor(() => expect(list.scrollTop).toBe(240));
    // 被夹掉的写不算数：循环必须一直试到新容器真的装得下为止（0、0、240 ⇒ 三次以上）。
    expect(writes).toBeGreaterThan(2);
  });

  it('holds the position when the page takes the scrolling back too', async () => {
    renderAppInWorkspace('/', makeAdapter());
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    const page = scrollHost(document.getElementById('main-content')!);
    const list = scrollHost(document.querySelector('.library-shell-list') as HTMLElement);
    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    list.scrollTop = 500;
    fireEvent.scroll(list);

    // 关闭是同一条路的另一边：位置要写回整页那个容器，而它同样会把写进去的值夹掉并回一个
    // scroll 事件（目标随之被改写成「当前位置」，500 就没了）。
    let stored = 0;
    let writes = 0;
    Object.defineProperty(page, 'scrollTop', {
      configurable: true,
      get: () => stored,
      set: (value: number) => {
        writes += 1;
        stored = Math.min(value, writes >= 3 ? 9999 : 0);
        fireEvent.scroll(page);
      },
    });

    fireEvent.click(screen.getByRole('link', { name: 'to-home' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'detail:archive-0' })).not.toBeInTheDocument());
    await waitFor(() => expect(page.scrollTop).toBe(500));
    expect(writes).toBeGreaterThan(2);
  });

  it('re-measures the rail at the moment of the click instead of trusting a stale anchor', async () => {
    renderAppInWorkspace('/', makeAdapter());
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    const page = scrollHost(document.getElementById('main-content')!);
    const list = scrollHost(document.querySelector('.library-shell-list') as HTMLElement);
    const rails = Array.from(document.querySelectorAll<HTMLElement>('.archive-rail'));
    expect(rails.length).toBeGreaterThan(0);

    let contentTop = 340;
    let active: HTMLElement = page;
    for (const rail of rails) {
      rail.getBoundingClientRect = () => rect(contentTop - active.scrollTop, 180);
    }
    page.scrollTop = 240;
    fireEvent.scroll(page); // 锚：这一排在滚动口顶端下方 100px

    // 用户没再滚过，但内容自己长高了 25px（封面解码完，把下面整排推下去）。上一次滚动
    // 记下的那份锚已经过期——照它换算要写 280，画面会平白往上跳 25px，正是用户说的
    // 「打开详情页时页面滚动一点点」。按下（换容器之前）重量一次，写的就是 255。
    contentTop = 365;
    fireEvent.pointerDown(card);
    contentTop = 380;
    active = list;
    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    await waitFor(() => expect(list.scrollTop).toBe(255));
  });

  it('follows the content when the narrower column pushes it down', async () => {
    renderAppInWorkspace('/', makeAdapter());
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    const page = scrollHost(document.getElementById('main-content')!);
    const list = scrollHost(document.querySelector('.library-shell-list') as HTMLElement);
    const rails = Array.from(document.querySelectorAll<HTMLElement>('.archive-rail'));
    expect(rails.length).toBeGreaterThan(0);

    // 真机上 `rect.top` 是跟着 `scrollTop` 一起动的（`rect.top = 内容里的位置 - scrollTop`），
    // 这里照这个模型伪造一份布局：jsdom 里所有 rect 都是 0，量不出高度的锚会被丢掉、退回
    // 数值路径，那就测不到这一条了。
    let contentTop = 340;
    let active: HTMLElement = page;
    for (const rail of rails) {
      rail.getBoundingClientRect = () => rect(contentTop - active.scrollTop, 180);
    }
    page.scrollTop = 240;
    fireEvent.scroll(page); // 记下锚：这一排轨道在滚动口顶端下方 100px

    // 详情一开，左栏变窄、横向滚动条出现，下面整排东西在内容坐标里下沉 15px。照搬数值
    // 240 落到新布局上就是「打开详情页时页面滚动一点点」（用户报的第 2 条）；按内容对齐
    // 要写的是 255——同一排轨道仍然在顶端下方 100px。
    contentTop = 355;
    active = list;
    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    await waitFor(() => expect(list.scrollTop).toBe(255));
  });

  it('measures the rail and its anchor in the same frame of reference', async () => {
    renderAppInWorkspace('/', makeAdapter());
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    const page = scrollHost(document.getElementById('main-content')!);
    const list = scrollHost(document.querySelector('.library-shell-list') as HTMLElement);
    const rails = Array.from(document.querySelectorAll<HTMLElement>('.archive-rail'));
    expect(rails.length).toBeGreaterThan(0);

    // 真机上滚动口自己也不在窗口顶端：它上面有标题栏、下面有状态栏，`.workspace` 里还有
    // 内边距。`getBoundingClientRect().top` 量到的是**视口**坐标，而锚记的是「离滚动口顶端
    // 多远」——两者相减时必须把滚动口自己那个 y 也减掉。少了这一步，滚动口的视口顶端坐标
    // 会被当成滚动量加进去（用户报的「滚动程度更大了，关闭也会触发」）。
    const scrollerTop = 100;
    page.getBoundingClientRect = () => rect(scrollerTop, 600);
    list.getBoundingClientRect = () => rect(scrollerTop, 600);
    // 三排轨道在内容里各差 380px，这样滚过第一排之后锚会落到下一排（真机上就是这样）。
    const railBase = rails.map((_, index) => 340 + index * 380);
    // 详情一开左栏变窄，内容整体下沉 15px（横向滚动条、标题换行都会做这件事）。
    let shift = 0;
    let active: HTMLElement = page;
    rails.forEach((rail, index) => {
      rail.getBoundingClientRect = () => rect(scrollerTop + (railBase[index] ?? 0) + shift - active.scrollTop, 180);
    });
    page.scrollTop = 240;
    fireEvent.scroll(page); // 锚：第一排在滚动口顶端下方 100px

    shift = 15;
    active = list;
    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    // 同一排仍然要在顶端下方 100px：内容里的位置 355 减 100 ⇒ 255。
    await waitFor(() => expect(list.scrollTop).toBe(255));

    // 关掉详情是同一件事的反面：位置要写回整页那个容器，而整页也在同一个 y 上。
    // （这份 fixture 里只有「继续阅读」这一排会渲染：待看与随机漫游都是空的。）
    list.scrollTop = 200;
    fireEvent.scroll(list);
    shift = 0;
    active = page;
    fireEvent.click(screen.getByRole('link', { name: 'to-home' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'detail:archive-0' })).not.toBeInTheDocument());
    // 200 减回去那 15px 的下沉 ⇒ 185；多了滚动口那 100px 就会写成 285。
    await waitFor(() => expect(page.scrollTop).toBe(185));
  });

  it('writes again when the fresh scroller drifts right after the first write', async () => {
    renderAppInWorkspace('/', makeAdapter());
    const card = await screen.findByRole('link', { name: /Archive 0/ });
    const page = scrollHost(document.getElementById('main-content')!);
    const list = scrollHost(document.querySelector('.library-shell-list') as HTMLElement);
    page.scrollTop = 240;
    fireEvent.scroll(page);

    // 换容器之后内容还会继续重排：写进去的 240 会被浏览器的滚动锚定挪走 2px，而这一挪
    // **比写入本身晚一拍**。收手太早（写成功一次就完）就会把这个漂移留在屏幕上，用户
    // 看到的就是「滚一点点」。
    let stored = 0;
    let writes = 0;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => stored,
      set: (value: number) => {
        writes += 1;
        stored = value;
        if (writes === 1) setTimeout(() => { stored += 2; }, 0);
      },
    });

    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'detail:archive-0' })).toBeInTheDocument();
    await waitFor(() => expect(writes).toBeGreaterThan(1));
    // 让那一挪真的落地，再看最终停在哪儿。
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    expect(list.scrollTop).toBe(240);
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

describe('侧栏那一条与详情挂在谁下面', () => {
  it('counts /home/:archiveId as the home entry, and nothing else as home', () => {
    // 纯规则：`to` 是点它去哪儿，额外前缀是它还代表哪几段路径。
    expect(navEntryActive('/', false, '/home/archive-0')).toBe(true);
    expect(navEntryActive('/', false, '/library/archive-0')).toBe(false);
    expect(navEntryActive('/library', false, '/home/archive-0')).toBe(false);
    // react-router 本来就认的那些（详情挂在自己前缀下）不受影响。
    expect(navEntryActive('/library', true, '/library/archive-0')).toBe(true);
  });

  it('keeps the home entry lit while the detail opened from the home page is up', async () => {
    // 用户报的：Windows 双页模式下从首页点开详情，左侧「首页」图标变成未选中。
    // `/` 那条带 `end`，只认根路径；首页的详情却是 `/home/:archiveId`。
    render(
      <MemoryRouter initialEntries={['/home/archive-0']}>
        <PreferencesProvider><ToastProvider>
          <AppShell><WorkspaceRoutes /></AppShell>
        </ToastProvider></PreferencesProvider>
      </MemoryRouter>,
    );
    const nav = await screen.findByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('link', { name: '首页' }).className).toContain('is-active');
    expect(within(nav).getByRole('link', { name: '档案库' }).className).not.toContain('is-active');
  });

  it('lights the shelf entry whose own detail is open, not the home entry', async () => {
    render(
      <MemoryRouter initialEntries={['/library/archive-0']}>
        <PreferencesProvider><ToastProvider>
          <AppShell><WorkspaceRoutes /></AppShell>
        </ToastProvider></PreferencesProvider>
      </MemoryRouter>,
    );
    const nav = await screen.findByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('link', { name: '档案库' }).className).toContain('is-active');
    expect(within(nav).getByRole('link', { name: '首页' }).className).not.toContain('is-active');
  });
});
