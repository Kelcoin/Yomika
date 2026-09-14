import { fireEvent, render, screen, within } from '@testing-library/react';
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
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
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

  it('uses a single product label and provides global scroll-to-top', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
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

  it('exposes full desktop navigation and compact five-item navigation', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderAt();

    expect(screen.getByRole('link', { name: '跳到主内容' })).toHaveAttribute('href', '#main-content');
    await screen.findByRole('heading', { name: '添加你的 LANraragi' });
    const desktop = screen.getByRole('navigation', { name: '主导航' });
    expect(within(desktop).getByRole('link', { name: '下载' })).toBeInTheDocument();
    expect(within(desktop).queryByRole('link', { name: '同步' })).not.toBeInTheDocument();

    const compact = screen.getByRole('navigation', { name: '移动导航' });
    expect(within(compact).getAllByRole('link')).toHaveLength(5);
    expect(within(compact).queryByRole('link', { name: 'E-Hentai' })).not.toBeInTheDocument();
    expect(within(compact).queryByRole('link', { name: '下载' })).not.toBeInTheDocument();
    expect(within(compact).queryByRole('link', { name: '同步' })).not.toBeInTheDocument();
  });

  it('marks the current route and renders its workspace heading', () => {
    renderAt('/library');

    const desktop = screen.getByRole('navigation', { name: '主导航' });
    expect(within(desktop).getByRole('link', { name: '档案库', current: 'page' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '档案库' })).toBeInTheDocument();
  });

  it('offers server setup from the first-run home', () => {
    renderAt();

    expect(screen.getByRole('link', { name: '添加服务器' })).toHaveAttribute('href', '/settings');
  });

  it('shows repository-backed recent reading on home', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1 }] };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: '最近阅读档案', pageCount: 12, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'search_random_archives') return { ok: true, value: [] };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    // One rail only: the duplicate "最近阅读" list under it is gone.
    const rail = await screen.findByRole('region', { name: '继续阅读' });
    expect(within(rail).getByRole('link', { name: /最近阅读档案/ })).toHaveAttribute('href', '/library/a1');
    expect(within(rail).getByText('5/12 页')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '最近阅读' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '书架还是空的' })).not.toBeInTheDocument();
  });

  it('answers a right click on a home rail card', async () => {
    // The library list was the only surface wired to the menu, which read as the
    // app not having one at all: the rails, the recommendation rail and the
    // shelves all ignored the click.
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1 }] };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: '最近阅读档案', pageCount: 12, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'search_random_archives') return { ok: true, value: [] };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    const rail = await screen.findByRole('region', { name: '继续阅读' });
    fireEvent.contextMenu(within(rail).getByRole('link', { name: /最近阅读档案/ }), { clientX: 40, clientY: 60 });

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '阅读' })).toBeInTheDocument();
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
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
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
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
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
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
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
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
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
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });

    renderAt();

    expect(await screen.findByRole('heading', { name: '添加你的 LANraragi' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '档案库' })).not.toBeInTheDocument();
  });

  it('announces connection, sync, task, and cache status', () => {
    renderAt();

    expect(screen.getByRole('status', { name: '连接状态' })).toHaveTextContent('未连接');
    expect(screen.getByRole('status', { name: '同步状态' })).toHaveTextContent('未配置');
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
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    expect(await screen.findByRole('status', { name: '连接状态' })).toHaveTextContent('离线');
  });

  it('collapses desktop navigation to an icon rail', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
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

  it('collects the pages the compact bar cannot fit under 更多', async () => {
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

      await user.click(await screen.findByRole('button', { name: /更多/ }));
      const menu = screen.getByRole('menu', { name: '更多页面' });
      // 默认底栏＝首页/档案库/历史/收藏夹/设置(+钉住)，菜单只列缺的待看与下载；
      // 已在底栏里的页面不再重复出现。
      expect(within(menu).getByRole('menuitem', { name: /待看/ })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: /下载/ })).toBeInTheDocument();
      expect(within(menu).queryByRole('menuitem', { name: /历史/ })).not.toBeInTheDocument();
      await user.click(within(menu).getByRole('menuitem', { name: /待看/ }));
      expect(screen.queryByRole('menu', { name: '更多页面' })).not.toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });
});
