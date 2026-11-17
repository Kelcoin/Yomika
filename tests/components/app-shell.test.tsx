import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

const translationLifecycle = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('../../src/lib/tagTranslationService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/tagTranslationService')>(),
  startTagTranslationUpdates: translationLifecycle.start,
  stopTagTranslationUpdates: translationLifecycle.stop,
}));

import { COMPACT_WIDTH_QUERY } from '../../src/lib/useMediaQuery';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetArchiveExistenceForTests } from '../../src/lib/archiveExistence';

afterEach(() => {
  resetInvokeAdapterForTests();
  // Confirmed ids are remembered for the session, so one test must not answer
  // the next test's question.
  resetArchiveExistenceForTests();
  vi.clearAllMocks();
});

function renderAt(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('application shell', () => {
  it('runs tag translation updates only while the application is visible', () => {
    const view = renderAt();
    expect(translationLifecycle.start).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(translationLifecycle.stop).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(translationLifecycle.start).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(translationLifecycle.stop).toHaveBeenCalledTimes(2);
  });

  it('draws the app-drawn title bar on Windows only', async () => {
    // Windows 关了原生装饰，那条栏是应用自己画的；macOS 有自己的红绿灯，
    // iOS/Android 没有窗口按钮可点——只有 Windows 该出现这排按钮。
    const adapter = (platform: string) => vi.fn(async (command: string) => {
      if (command === 'app_security_status') return { ok: true, value: { supported: true, locked: false, passwordEnabled: false, biometricEnabled: false, lockOnBackground: false, hidePreview: false, biometricAvailable: false, previewProtectionAvailable: true, platformNote: '' } };
      if (command === 'app_security_ready') return { ok: true, value: null };
      if (command === 'list_servers' || command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'cache_stats') return { ok: true, value: { bytes: 0, entries: 0 } };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'platform_capabilities') return { ok: true, value: { platform, native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: true } };
      throw new Error(`Unexpected command: ${command}`);
    });

    // 平台探测只在原生运行时里问命令（浏览器里直接答 browser），所以这里造一个
    // 原生运行时标记，让这次探测真的走到适配器上。
    // invoke 是自绘标题栏自己的窗口 API 走的通道（它不问应用适配器）。
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async () => false } });
    try {
      setInvokeAdapterForTests(adapter('windows'));
      renderAt();
      expect(await screen.findByRole('button', { name: '最小化' })).toBeInTheDocument();
      // 跳过链接是给键盘用户的，桌面照旧保留。
      expect(screen.getByRole('link', { name: '跳到主内容' })).toBeInTheDocument();

      cleanup();
      setInvokeAdapterForTests(adapter('android'));
      renderAt();
      await waitFor(() => expect(screen.queryByRole('button', { name: '最小化' })).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument();
      // 触屏上它没有用处，而 WebKit 会把点按命中成 :focus-visible，让它常驻在
      // 状态栏那一角——平台上就不该渲染。
      expect(screen.queryByRole('link', { name: '跳到主内容' })).not.toBeInTheDocument();
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('uses a single product label and provides global scroll-to-top', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers' || command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'cache_stats') return { ok: true, value: { bytes: 0, entries: 0 } };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderAt();
    expect(screen.queryByText('YOMIKA')).not.toBeInTheDocument();
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    await userEvent.click(screen.getByRole('button', { name: '返回顶部' }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('exposes full desktop navigation and compact four-item navigation', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers' || command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderAt();

    expect(screen.getByRole('link', { name: '跳到主内容' })).toHaveAttribute('href', '#main-content');
    await screen.findByRole('heading', { name: '添加你的 LANraragi' });
    const desktop = screen.getByRole('navigation', { name: '主导航' });
    expect(within(desktop).getByRole('link', { name: '本地档案' })).toBeInTheDocument();
    expect(within(desktop).queryByRole('link', { name: '同步' })).not.toBeInTheDocument();

    const compact = screen.getByRole('navigation', { name: '移动导航' });
    expect(within(compact).getAllByRole('link')).toHaveLength(4);
    expect(within(compact).queryByRole('link', { name: /更多|设置/ })).not.toBeInTheDocument();
    expect(within(compact).queryByRole('link', { name: 'E-Hentai' })).not.toBeInTheDocument();
    expect(within(compact).queryByRole('link', { name: '本地档案' })).not.toBeInTheDocument();
    expect(within(compact).queryByRole('link', { name: '同步' })).not.toBeInTheDocument();
  });

  it('marks the current route and renders its workspace heading', () => {
    renderAt('/library');

    const desktop = screen.getByRole('navigation', { name: '主导航' });
    expect(within(desktop).getByRole('link', { name: '档案库', current: 'page' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '档案库' })).toBeInTheDocument();
  });

  it('offers server setup from the first-run home', async () => {
    // 提示要等服务器列表读完才出现：它若在 listServers 落地前渲染，冷启动会先
    // 闪一下「添加你的 LANraragi」再换成书架。
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers' || command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'cache_stats') return { ok: true, value: { bytes: 0, entries: 0 } };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderAt();
    // 列表还没回来时什么都不摆：先渲染提示再换书架就是冷启动的那一下闪烁。
    expect(screen.queryByRole('link', { name: '添加服务器' })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: '添加服务器' })).toHaveAttribute('href', '/settings');
  });

  it('shows repository-backed recent reading on home', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1 }] };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: '最近阅读档案', pageCount: 12, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'search_random_archives') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    // One rail only: the duplicate "最近阅读" list under it is gone.
    const rail = await screen.findByRole('region', { name: '继续阅读' });
    expect(within(rail).getByRole('link', { name: /最近阅读档案/ })).toHaveAttribute('href', '/home/a1?server=scope-a');
    expect(within(rail).getByText('5/12 页')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '最近阅读' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '书架还是空的' })).not.toBeInTheDocument();
  });

  it('fills the continue-reading rail from the same history the history page lists', async () => {
    // 首页那一排从前只取历史的前六条、再去掉已读完的：前六条里有一条已读完时，那一排只剩
    // 五张，而更早的未读完记录永远补不上来——和历史页面看到的不是同一份列表（用户报的
    // 「首页历史记录组件与历史记录页面内的记录不一致」）。
    const history = [
      { scopeId: 'scope-a', archiveId: 'done', pageIndex: 11, visitedAt: '2026-09-08T00:00:00Z', deviceId: 'device-a', revision: 1 },
      ...['b', 'c', 'd', 'e', 'f'].map((id, index) => ({
        scopeId: 'scope-a', archiveId: id, pageIndex: 1, visitedAt: `2026-09-0${7 - index}T00:00:00Z`, deviceId: 'device-a', revision: 1,
      })),
      { scopeId: 'scope-a', archiveId: 'g', pageIndex: 1, visitedAt: '2026-09-01T00:00:00Z', deviceId: 'device-a', revision: 1 },
    ];
    const archives = history.map((item) => ({
      serverId: 'scope-a', archiveId: item.archiveId, title: `档案${item.archiveId}`,
      pageCount: 12, updatedAt: '2026-09-01T00:00:00Z',
    }));
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: history };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_by_ids') {
        const ids = (args as { archiveIds?: string[] } | undefined)?.archiveIds ?? [];
        return { ok: true, value: archives.filter((item) => ids.includes(item.archiveId)) };
      }
      if (command === 'search_random_archives') return { ok: true, value: [] };
      if (command === 'verify_archives_exist') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      // 已读完的开关关掉 = 不显示已读完（「继续阅读显示已读完」那一行的默认是开）。
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, continueReadingShowFinished: false } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    const rail = await screen.findByRole('region', { name: '继续阅读' });
    const titles = within(rail).getAllByRole('link').map((link) => link.textContent);
    // 已读完的 done 被隐藏，后面六条补上来——包括窗口外面的 g。
    expect(titles).toHaveLength(6);
    expect(titles.some((title) => title?.includes('档案done'))).toBe(false);
    expect(within(rail).getByRole('link', { name: /档案g/ })).toBeInTheDocument();
  });

  it('lists every unfinished history record on the continue-reading rail', async () => {
    // 用户报的「历史记录里有很多没读完的，继续阅读里却只显示了六本」：那一排从前写死
    // 只取前六条（`CONTINUE_READING_RAIL`），历史页面却能滚出整条历史。同一份口径、同
    // 一份数据，不该有一边少。
    const history = Array.from({ length: 12 }, (_, index) => ({
      scopeId: 'scope-a', archiveId: `h${index}`, pageIndex: 1, visitedAt: `2026-09-${String(12 - index).padStart(2, '0')}T00:00:00Z`, deviceId: 'device-a', revision: 1,
    }));
    const archives = history.map((item) => ({
      serverId: 'scope-a', archiveId: item.archiveId, title: `档案${item.archiveId}`,
      pageCount: 12, updatedAt: '2026-09-01T00:00:00Z',
    }));
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: history };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_by_ids') {
        const ids = (args as { archiveIds?: string[] } | undefined)?.archiveIds ?? [];
        return { ok: true, value: archives.filter((item) => ids.includes(item.archiveId)) };
      }
      if (command === 'search_random_archives') return { ok: true, value: [] };
      if (command === 'verify_archives_exist') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    const rail = await screen.findByRole('region', { name: '继续阅读' });
    await waitFor(() => expect(within(rail).getAllByRole('link')).toHaveLength(12));
    // 最旧的那一条也在：只留前几条就会漏掉它。
    expect(within(rail).getByRole('link', { name: /档案h11/ })).toBeInTheDocument();
  });

  it('caps each home rail at twenty archives', async () => {
    // 用户要求首页两排各有上限（`HOME_RAIL_LIMIT = 20`）。历史页面与待看页面仍然列全量：
    // 上限是首页那一排的展示口，不是数据口径。这一排从前不截断、待看写死八条。
    const history = Array.from({ length: 24 }, (_, index) => ({
      scopeId: 'scope-a', archiveId: `h${index}`, pageIndex: 1, visitedAt: `2026-09-${String(24 - index).padStart(2, '0')}T00:00:00Z`, deviceId: 'device-a', revision: 1,
    }));
    const readingList = Array.from({ length: 24 }, (_, index) => ({
      scopeId: 'scope-a', archiveId: `w${index}`, addedAt: `2026-09-${String(24 - index).padStart(2, '0')}T00:00:00Z`, updatedAt: '2026-09-01T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false,
    }));
    const archives = [...history.map((item) => item.archiveId), ...readingList.map((item) => item.archiveId)]
      .map((archiveId) => ({ serverId: 'scope-a', archiveId, title: `档案${archiveId}`, pageCount: 12, updatedAt: '2026-09-01T00:00:00Z' }));
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: history };
      if (command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'list_reading_list') return { ok: true, value: readingList };
      if (command === 'list_archives_by_ids') {
        const ids = (args as { archiveIds?: string[] } | undefined)?.archiveIds ?? [];
        return { ok: true, value: archives.filter((item) => ids.includes(item.archiveId)) };
      }
      if (command === 'search_random_archives') return { ok: true, value: [] };
      if (command === 'verify_archives_exist') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    const continueRail = await screen.findByRole('region', { name: '继续阅读' });
    await waitFor(() => expect(within(continueRail).getAllByRole('link')).toHaveLength(20));
    // 第 21 条（最旧的几条）被上限挡在门外——那是上限的意思，不是「没读到」。
    expect(within(continueRail).getByRole('link', { name: /档案h19/ })).toBeInTheDocument();
    expect(within(continueRail).queryByRole('link', { name: /档案h20/ })).toBeNull();

    const toReadRail = await screen.findByRole('region', { name: '待看档案' });
    await waitFor(() => expect(within(toReadRail).getAllByRole('link')).toHaveLength(20));
  });

  it('answers a right click on a home rail card', async () => {
    // The library list was the only surface wired to the menu, which read as the
    // app not having one at all: the rails, the recommendation rail and the
    // shelves all ignored the click.
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1 }] };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: '最近阅读档案', pageCount: 12, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'search_random_archives') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    const rail = await screen.findByRole('region', { name: '继续阅读' });
    fireEvent.contextMenu(within(rail).getByRole('link', { name: /最近阅读档案/ }), { clientX: 40, clientY: 60 });

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '无痕阅读' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: '阅读' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '编辑元数据' })).toBeInTheDocument();
  });

  it('drops a shelf card the server no longer has instead of waiting for a click', async () => {
    // The local mirror only hears about a deletion when something asks the
    // server. Nothing refreshes it now that the library pages remotely, so an
    // archive deleted elsewhere stayed on the rails until the user clicked it and
    // was told it does not exist.
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') {
        return { ok: true, value: [
          { scopeId: 'scope-a', archiveId: 'gone', pageIndex: 1, visitedAt: '2026-08-29T00:00:00Z', deviceId: 'device-a', revision: 1 },
          { scopeId: 'scope-a', archiveId: 'kept', pageIndex: 2, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1 },
        ] };
      }
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_by_ids') {
        return { ok: true, value: [
          { serverId: 'scope-a', archiveId: 'gone', title: '已删除的档案', pageCount: 3, updatedAt: '2026-08-29T00:00:00Z' },
          { serverId: 'scope-a', archiveId: 'kept', title: '还在的档案', pageCount: 4, updatedAt: '2026-08-28T00:00:00Z' },
        ] };
      }
      if (command === 'verify_archives_exist') return { ok: true, value: ['gone'] };
      if (command === 'search_random_archives') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderAt();

    const rail = await screen.findByRole('region', { name: '继续阅读' });
    expect(within(rail).getByRole('link', { name: /还在的档案/ })).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('verify_archives_exist', { serverId: 'scope-a', archiveIds: ['gone', 'kept'] });
    await vi.waitFor(() => expect(screen.queryByRole('link', { name: /已删除的档案/ })).not.toBeInTheDocument());
  });

  it('shows the server load error instead of treating it as an empty setup', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: false, error: { code: 'PLATFORM_UNAVAILABLE', message: '本地存储不可用', retryable: true } };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    expect(await screen.findByRole('alert')).toHaveTextContent('本地存储不可用');
    expect(screen.queryByRole('heading', { name: '添加你的 LANraragi' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '书架还是空的' })).not.toBeInTheDocument();
  });

  it('retries a recoverable server load error from the home workspace', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') {
        attempts += 1;
        return attempts === 1
          ? { ok: false, error: { code: 'PLATFORM_UNAVAILABLE', message: '本地存储暂时不可用', retryable: true } }
          : { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      }
      if (command === 'list_reading_history') return { ok: true, value: [] };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [] };
      if (command === 'search_random_archives') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: '重试读取服务器' }));

    // A working server no longer gets a banner; an empty library shows the shelf
    // empty state instead.
    expect(await screen.findByRole('heading', { name: '书架还是空的' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens the page named by the startup preference, and only at launch', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, startupRoute: 'library' } };
      if (command === 'list_servers' || command === 'list_tasks') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });

    renderAt();

    // Awaited rather than asserted in place: the library route swaps its loading
    // heading for the workspace's own, so the first node found gets replaced.
    await screen.findByRole('heading', { name: '档案库' });
    // Going home afterwards is the user's own navigation and must stay there.
    await user.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '首页' }));
    await screen.findByRole('heading', { name: '添加你的 LANraragi' });
    expect(screen.queryByRole('heading', { name: '档案库' })).not.toBeInTheDocument();
  });

  it('stays on home when that is the startup preference', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, startupRoute: 'home' } };
      if (command === 'list_servers' || command === 'list_tasks') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });

    renderAt();

    expect(await screen.findByRole('heading', { name: '添加你的 LANraragi' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '档案库' })).not.toBeInTheDocument();
  });

  it('announces connection, task, and cache status', () => {
    renderAt();

    expect(screen.getByRole('status', { name: '连接状态' })).toHaveTextContent('未连接');
    expect(screen.getByRole('status', { name: '任务状态' })).toHaveTextContent('0');
    expect(screen.getByRole('status', { name: '缓存状态' })).toHaveTextContent('0 B');
  });

  it('shows repository-backed server and task status', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'check_server_status') return { ok: true, value: [{ serverId: 'scope-a', online: true, name: 'Home' }] };
      if (command === 'list_tasks') return { ok: true, value: [
        { id: 'one', kind: 'download', label: '下载', status: 'running', progress: 0.5, cancelable: true, retryable: true, createdAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z' },
        { id: 'two', kind: 'sync', label: '同步', status: 'queued', progress: 0, cancelable: true, retryable: true, createdAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z' },
      ] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    expect(await screen.findByRole('status', { name: '连接状态' })).toHaveTextContent('Home');
    expect(screen.getByRole('status', { name: '任务状态' })).toHaveTextContent('2');
  });

  it('shows a configured server as offline when its LANraragi health check fails', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://offline.example.com', scopeId: 'scope-a' }] };
      if (command === 'check_server_status') return { ok: true, value: [{ serverId: 'scope-a', online: false, name: 'Home', error: '无法连接' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    expect(await screen.findByRole('status', { name: '连接状态' })).toHaveTextContent('离线');
  });

  it('collapses desktop navigation to an icon rail', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers' || command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderAt();

    await screen.findByRole('status', { name: '连接状态' });
    const collapse = screen.getByRole('button', { name: '折叠侧栏' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await user.click(collapse);

    expect(screen.getByRole('button', { name: '展开侧栏' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('places secondary pages before fixed settings in the mobile home header', async () => {
    const user = userEvent.setup();
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === COMPACT_WIDTH_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      setInvokeAdapterForTests(async (command) => {
        if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
        if (command === 'list_servers') return { ok: true, value: [] };
        throw new Error(`Unexpected command: ${command}`);
      });
      renderAt('/');

      const topbar = await screen.findByRole('navigation', { name: '首页快捷导航' });
      const links = within(topbar).getAllByRole('link');
      expect(links.map(link => link.getAttribute('aria-label'))).toEqual(['待看', '本地档案', '设置']);
      expect(within(topbar).queryByRole('link', { name: '历史' })).not.toBeInTheDocument();
      expect(topbar.closest('header')?.parentElement).toHaveClass('has-home-topbar');
      expect(topbar.closest('.workspace')).toBeNull();
      expect(within(screen.getByRole('navigation', { name: '移动导航' })).queryByRole('link', { name: '更多' })).toBeNull();
      await user.click(within(topbar).getByRole('link', { name: '设置' }));
      expect(await screen.findByRole('complementary', { name: '设置分类' })).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: '首页快捷导航' })).toBeNull();
      fireEvent(window, new Event('yomika-mobile-back', { cancelable: true }));
      expect(await screen.findByRole('navigation', { name: '首页快捷导航' })).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('paints the compact bar already floating before preferences arrive', async () => {
    // 悬浮是偏好里的一行，偏好却是 IPC 回来的：首帧按默认值画，等偏好到了再换成悬浮的
    // ——开着悬浮的人每次启动都会先看到一下贴底栏。镜像（yomika.last-nav）在第一次渲染
    // 之前就读出来了，所以首帧就是最终形态。这里的 load_preferences 永不返回，量的就是
    // 「偏好还没到」的那一刻。
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === COMPACT_WIDTH_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      window.localStorage.setItem('yomika.last-nav', JSON.stringify({
        floatingNav: true,
        bottomNavItems: ['home', 'library', 'history', 'watchlist', 'settings'],
      }));
      setInvokeAdapterForTests(async (command) => {
        if (command === 'load_preferences') return new Promise(() => {});
        if (command === 'list_servers') return { ok: true, value: [] };
        throw new Error(`Unexpected command: ${command}`);
      });
      renderAt('/');

      const bar = await screen.findByRole('navigation', { name: '移动导航' });
      expect(bar).toHaveClass('is-floating');
      expect(document.querySelector('.app-shell')).toHaveClass('is-floating-nav');
    } finally {
      window.matchMedia = original;
    }
  });

  it('parks the compact bar out of the way only while it floats', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === COMPACT_WIDTH_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const mountWith = async (floatingNav: boolean) => {
        setInvokeAdapterForTests(async (command) => {
          if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, floatingNav } };
          if (command === 'list_servers') return { ok: true, value: [] };
          throw new Error(`Unexpected command: ${command}`);
        });
        renderAt('/');
        const bar = await screen.findByRole('navigation', { name: '移动导航' });
        const workspace = document.getElementById('main-content')!;
        const scrollTo = (top: number) => {
          workspace.scrollTop = top;
          fireEvent.scroll(workspace);
        };
        return { bar, scrollTo };
      };

      // 没开悬浮：底栏占一行、不盖内容，滚动不该把它收走。
      const docked = await mountWith(false);
      docked.scrollTo(200);
      docked.scrollTo(400);
      expect(docked.bar).not.toHaveClass('is-hidden');
      cleanup();

      // 开了悬浮：向下滚把它送出屏幕，向上滚再回来。
      const floating = await mountWith(true);
      const workspace = document.getElementById('main-content')!;
      Object.defineProperties(workspace, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 2000 },
      });
      floating.scrollTo(200);
      floating.scrollTo(400);
      expect(floating.bar).toHaveClass('is-hidden');
      expect(document.querySelector('.app-shell')).toHaveAttribute('data-compact-nav-hidden');
      // Hiding the nav removes its 80px tail clearance. Browser clamping at
      // the new maximum must not show it again and oscillate the layout.
      floating.scrollTo(1500);
      floating.scrollTo(1400);
      expect(floating.bar).toHaveClass('is-hidden');
      floating.scrollTo(120);
      expect(floating.bar).not.toHaveClass('is-hidden');
      expect(document.querySelector('.app-shell')).not.toHaveAttribute('data-compact-nav-hidden');
      cleanup();
    } finally {
      window.matchMedia = original;
    }
  });
});
