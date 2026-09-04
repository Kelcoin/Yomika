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

  it('filters and sorts watchlist records by resolved archive title', async () => {
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

    const alpha = await screen.findByRole('button', { name: /Alpha archive/ });
    const beta = screen.getByRole('button', { name: /Beta archive/ });
    expect(alpha.compareDocumentPosition(beta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.type(screen.getByRole('searchbox', { name: '筛选待看' }), 'beta');
    expect(screen.queryByRole('button', { name: /Alpha archive/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta archive/ })).toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: '筛选待看' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '待看排序' }), 'recent');
    const recentFirst = screen.getByRole('button', { name: /Alpha archive/ });
    const recentSecond = screen.getByRole('button', { name: /Beta archive/ });
    expect(recentFirst.compareDocumentPosition(recentSecond) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('removes selected watchlist records locally and reports pending sync', async () => {
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

    await user.click(await screen.findByRole('checkbox', { name: '选择 Remove archive' }));
    await user.click(screen.getByRole('button', { name: '移除所选' }));

    expect(adapter).toHaveBeenCalledWith('set_watchlist', { scopeId: 'scope-a', archiveId: 'a', added: false });
    expect(screen.queryByRole('link', { name: /Remove archive/ })).not.toBeInTheDocument();
    expect(screen.getByText('已保存在本机，等待同步')).toBeInTheDocument();
  });

  it('keeps failed watchlist removals selected and explains the partial failure', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_watchlist') return { ok: true, value: [
        { scopeId: 'scope-a', archiveId: 'a', addedAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false },
        { scopeId: 'scope-a', archiveId: 'b', addedAt: '2026-08-27T00:00:00Z', updatedAt: '2026-08-27T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false },
      ] };
      if (command === 'list_archives_by_ids') return { ok: true, value: [
        { serverId: 'scope-a', archiveId: 'a', title: 'Alpha archive', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z' },
        { serverId: 'scope-a', archiveId: 'b', title: 'Beta archive', pageCount: 2, updatedAt: '2026-08-27T00:00:00Z' },
      ] };
      if (command === 'set_watchlist' && args?.archiveId === 'a') return { ok: true, value: { scopeId: 'scope-a', archiveId: 'a', addedAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-29T00:00:00Z', deviceId: 'device-a', deletedAt: '2026-08-29T00:00:00Z', revision: 2, deleted: true } };
      if (command === 'set_watchlist') return { ok: false, error: { code: 'UNKNOWN', message: '本地写入失败', retryable: true } };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/watchlist']}><App /></MemoryRouter>);

    await user.click(await screen.findByRole('checkbox', { name: '全选当前结果' }));
    await user.click(screen.getByRole('button', { name: '移除所选' }));

    expect(screen.queryByRole('button', { name: /Alpha archive/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta archive/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '选择 Beta archive' })).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('有 1 项未能移除：本地写入失败');
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
      if (command === 'list_archives') {
        return {
          ok: true,
          value: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Loaded Archive', pageCount: 12, updatedAt: '2026-08-26T00:00:00Z' }],
        };
      }
      if (command === 'list_categories' || command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'load_archive_thumbnail') return { ok: true, value: [255, 216, 255] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderLibrary();

    expect(await screen.findByRole('button', { name: /^Loaded Archive\b/ })).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('list_archives', { serverId: 'scope-a' });
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
      if (command === 'list_archives') {
        attempts += 1;
        return attempts === 1
          ? { ok: false, error: { code: 'UNKNOWN', message: '数据库读取失败', retryable: true } }
          : { ok: true, value: [{ serverId: 'scope-a', archiveId: 'recovered', title: 'Recovered', pageCount: 1, updatedAt: '2026-08-28T00:00:00Z' }] };
      }
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
      if (command === 'list_archives') {
        return {
          ok: true,
          value: [
            { serverId: 'scope-a', archiveId: 'a1', title: 'First', pageCount: 12, updatedAt: '2026-08-26T00:00:00Z' },
            { serverId: 'scope-a', archiveId: 'a2', title: 'Second', pageCount: 8, updatedAt: '2026-08-26T00:00:00Z' },
          ],
        };
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
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'first', title: 'First archive', pageCount: 3, updatedAt: '2026-08-28T00:00:00Z' }] };
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
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Delete me', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }] };
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
      if (command === 'list_archives_page') {
        return { ok: true, value: { items: [{ serverId: 'server-a', archiveId: 'a1', title: 'Categorize me', pageCount: 2, updatedAt: '2026-09-03T00:00:00Z' }], total: 1, hasMore: false } };
      }
      if (command === 'list_categories') return { ok: true, value: [
        { id: 'SET_1613080290', name: 'Static shelf', pinned: false, search: null, archives: [] },
        { id: 'SET_1613080291', name: 'Dynamic shelf', pinned: false, search: 'artist:someone$', archives: [] },
      ] };
      if (command === 'list_watchlist' || command === 'list_reading_history' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'probe_new_archives') return { ok: true, value: false };
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
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Original title', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }] };
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
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'cover-a', title: 'Covered', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }] };
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
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'server-a', archiveId: 'persistent-cover', title: 'Persistent cover', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }] };
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

  it('refreshes archives from remote server and replaces the local list', async () => {
    const user = userEvent.setup();
    let callCount = 0;
    // Models the native side: refresh writes the local index, and the list is
    // always read back through list_archives_page.
    let indexed = [{ serverId: 'scope-a', archiveId: 'a1', title: 'Old Archive', pageCount: 5, updatedAt: '2026-08-26T00:00:00Z' }];
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'list_archives_page') return { ok: true, value: { items: indexed, total: indexed.length, hasMore: false } };
      if (command === 'refresh_archives') {
        callCount += 1;
        indexed = [
          { serverId: 'scope-a', archiveId: 'a1', title: 'Updated Archive', pageCount: 10, updatedAt: '2026-08-27T00:00:00Z' },
          { serverId: 'scope-a', archiveId: 'a2', title: 'New Archive', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' },
        ];
        return { ok: true, value: indexed };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    // The first load syncs the remote index on its own, always with an explicit
    // sort key: LANraragi warns on every request that omits sortby.
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('refresh_archives', {
      input: { serverId: 'scope-a', params: { sortby: 'date_added', order: 'desc' } },
    }));
    expect(await screen.findByRole('button', { name: /^Updated Archive\b/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^New Archive\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Old Archive\b/ })).not.toBeInTheDocument();
    expect(callCount).toBe(1);

    await user.click(screen.getByRole('button', { name: '刷新档案库' }));

    await waitFor(() => expect(callCount).toBe(2));
  });

  it('keeps the old archive list when refresh fails', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'list_archives') {
        return {
          ok: true,
          value: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Stable Archive', pageCount: 5, updatedAt: '2026-08-26T00:00:00Z' }],
        };
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
      if (command === 'list_archives_page') {
        return { ok: true, value: { items: [{ serverId: 'server-a', archiveId: 'a1', title: 'Archive One', pageCount: 4, updatedAt: '2026-09-03T00:00:00Z' }], total: 1, hasMore: false } };
      }
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'list_watchlist' || command === 'list_reading_history' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'probe_new_archives') return { ok: true, value: false };
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
