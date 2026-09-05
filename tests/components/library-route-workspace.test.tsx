import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetLibrarySyncStateForTests } from '../../src/lib/librarySync';

afterEach(() => {
  resetInvokeAdapterForTests();
  resetLibrarySyncStateForTests();
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
  it('explains how to recover when history has no configured server', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/history']}><App /></MemoryRouter>);

    expect(await screen.findByText('尚未连接 LANraragi')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '添加服务器' })).toHaveAttribute('href', '/settings');
  });

  it('resolves history records to archive titles and server context', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1 }] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: '历史档案标题', pageCount: 12, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/history']}><App /></MemoryRouter>);

    // History reuses the library card, so the row is a button and the progress
    // renders in the shared card metadata slot.
    expect(await screen.findByRole('button', { name: /历史档案标题/ })).toBeInTheDocument();
    expect(screen.getByText('5/12 页')).toBeInTheDocument();
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
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
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
      if (command === 'list_watchlist') return { ok: true, value: [
        { scopeId: 'scope-a', archiveId: 'b', addedAt: '2026-08-27T00:00:00Z', updatedAt: '2026-08-27T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false },
        { scopeId: 'scope-a', archiveId: 'a', addedAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 2, deleted: false },
      ] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [
        { serverId: 'scope-a', archiveId: 'a', title: 'Alpha archive', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z' },
        { serverId: 'scope-a', archiveId: 'b', title: 'Beta archive', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' },
      ] };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
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
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_watchlist') return { ok: true, value: [
        { scopeId: 'scope-a', archiveId: 'a', addedAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false },
      ] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a', title: 'Remove archive', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'set_watchlist') return { ok: true, value: { scopeId: 'scope-a', archiveId: 'a', addedAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T01:00:00Z', deviceId: 'device-a', deletedAt: '2026-08-28T01:00:00Z', revision: 2, deleted: true } };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/watchlist']}><App /></MemoryRouter>);

    // The multi-select bar this replaces was the only control on the page, and a
    // right click already addresses one card.
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Remove archive/ }));
    await user.click(await screen.findByRole('menuitem', { name: /移出收藏夹/ }));

    expect(adapter).toHaveBeenCalledWith('set_watchlist', { scopeId: 'scope-a', archiveId: 'a', added: false });
    expect(screen.queryByRole('button', { name: /Remove archive/ })).not.toBeInTheDocument();
    expect(await screen.findByText('已保存在本机，等待同步')).toBeInTheDocument();
  });

  it('shows an actionable empty state when WebDAV is not configured', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/sync']}><App /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '同步尚未配置' })).toBeInTheDocument();
    expect(screen.getByText('添加 WebDAV 账户后，本地阅读进度、历史和待看变更会以密文增量同步。')).toBeInTheDocument();
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
      input: { serverId: 'scope-a', query: '', sortBy: 'added', order: 'desc', categoryId: null, start: 0 },
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

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库读取失败');
    expect(screen.queryByRole('heading', { name: '暂无档案库' })).not.toBeInTheDocument();
  });

  it('renders archive load failures in a dedicated alert region', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'LRR 不可用', retryable: true } };
    });

    renderLibrary();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('workspace-alert');
    expect(alert).toHaveTextContent('LRR 不可用');
  });

  it('turns missing server credentials into an actionable settings link', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      return { ok: false, error: { code: 'PLATFORM_UNAVAILABLE', message: 'No matching entry found in secure storage', retryable: false } };
    });

    renderLibrary();

    expect(await screen.findByText('服务器凭据不可用，请在设置中重新保存 API Key。')).toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: '阅读' })).toHaveAttribute('href', '/reader/first');
    expect(adapter).toHaveBeenCalledWith('load_archive_metadata', { serverId: 'scope-a', archiveId: 'first' });
  });

  it('requires confirmation before deleting the selected archive', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
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
    await user.click(screen.getByRole('button', { name: '删除档案' }));

    expect(screen.getByRole('dialog', { name: '确认删除' })).toBeInTheDocument();
    expect(adapter).not.toHaveBeenCalledWith('delete_archive', expect.anything());
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(adapter).toHaveBeenCalledWith('delete_archive', { serverId: 'scope-a', archiveId: 'a1' });
  });

  it('shows persisted tasks in the downloads workspace', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_tasks') {
        return {
          ok: true,
          value: [{ id: 'task-1', kind: 'download', label: '下载 demo.cbz', status: 'running', progress: 0.5, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:01:00Z' }],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/downloads']}><App /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '下载' })).toBeInTheDocument();
    expect(await screen.findByText('下载 demo.cbz')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: '编辑元数据' }));
    const titleInput = screen.getByRole('textbox', { name: '标题' });
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
      if (command === 'cache_read_image') return { ok: true, value: { bytes: [255, 216, 255, 224], mime: 'image/jpeg' } };
      if (command === 'load_archive_thumbnail') throw new Error('cover network should not be called');
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    const view = renderLibrary();

    await screen.findByRole('button', { name: /^Persistent cover\b/ });
    await waitFor(() => expect(view.container.querySelector('.archive-row-thumb img')).toHaveAttribute('src', expect.stringMatching(/^blob:/)));
    expect(adapter).not.toHaveBeenCalledWith('load_archive_thumbnail', expect.anything());
    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalled();
  });

  it('reads the list from the server and only rebuilds the offline index on demand', async () => {
    const user = userEvent.setup();
    let refreshCount = 0;
    // The server owns the list, so what it answers on the first page is what the
    // user sees — no full-library pull stands between them.
    let served = [{ serverId: 'scope-a', archiveId: 'a1', title: 'Newest Archive', pageCount: 5, updatedAt: '2026-08-26T00:00:00Z' }];
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') return { ok: true, value: { items: served, total: served.length, hasMore: false } };
      if (command === 'refresh_archives') {
        refreshCount += 1;
        served = [{ serverId: 'scope-a', archiveId: 'a2', title: 'Rebuilt Archive', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' }];
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
      input: { serverId: 'scope-a', query: '', sortBy: 'added', order: 'desc', categoryId: null, start: 0 },
    });

    await user.click(screen.getByRole('button', { name: '刷新档案库' }));

    await waitFor(() => expect(refreshCount).toBe(1));
    expect(adapter).toHaveBeenCalledWith('refresh_archives', {
      input: { serverId: 'scope-a', params: { sortby: 'date_added', order: 'desc' } },
    });
    expect(await screen.findByRole('button', { name: /^Rebuilt Archive\b/ })).toBeInTheDocument();
  });

  it('reuses a fresh list instead of refetching it on every visit', async () => {
    const user = userEvent.setup();
    let pageRequests = 0;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        pageRequests += 1;
        return servedPage([{ serverId: 'scope-a', archiveId: 'a1', title: 'Cached Archive', pageCount: 5, updatedAt: '2026-08-26T00:00:00Z' }]);
      }
      if (command === 'list_tasks') return { ok: true, value: [] };
      return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'not needed here', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    expect(await screen.findByRole('button', { name: /^Cached Archive\b/ })).toBeInTheDocument();
    expect(pageRequests).toBe(1);

    // Leaving and returning is a round trip to LANraragi now, not the local query
    // it used to be, so a snapshot this recent is served as-is.
    const sidebar = within(screen.getByRole('navigation', { name: '主导航' }));
    await user.click(sidebar.getByRole('link', { name: '下载' }));
    expect(await screen.findByRole('heading', { name: '下载' })).toBeInTheDocument();
    await user.click(sidebar.getByRole('link', { name: '档案库' }));

    expect(await screen.findByRole('button', { name: /^Cached Archive\b/ })).toBeInTheDocument();
    expect(pageRequests).toBe(1);
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

    // Leave and come back inside the freshness window, so the list is restored
    // from the snapshot rather than refetched.
    const sidebar = within(screen.getByRole('navigation', { name: '主导航' }));
    await user.click(sidebar.getByRole('link', { name: '下载' }));
    await screen.findByRole('heading', { name: '下载' });
    await user.click(sidebar.getByRole('link', { name: '档案库' }));
    await screen.findByRole('button', { name: /^One\b/ });
    expect(offsets).toEqual([0]);

    // The restored cursor has to be the server's (2), not the rendered length (1).
    fireEvent.scroll(screen.getByRole('list', { name: '档案' }), { target: { scrollTop: 10_000 } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Three\b/ })).toBeInTheDocument());
    expect(offsets).toEqual([0, 2]);
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
    expect(screen.queryByText('正在读取档案…')).not.toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: '存为预设' }));

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

  it('keeps the archive list when rebuilding the offline index fails', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        return { ok: true, value: { items: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Stable Archive', pageCount: 5, updatedAt: '2026-08-26T00:00:00Z' }], total: 1, hasMore: false } };
      }
      if (command === 'refresh_archives') {
        return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'Network error', retryable: true } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    expect(await screen.findByRole('button', { name: /^Stable Archive\b/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '刷新档案库' }));

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
