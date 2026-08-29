import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
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
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: '历史档案标题', pageCount: 12, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/history']}><App /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: /历史档案标题/ })).toHaveAttribute('href', '/reader/a1');
    expect(screen.getByText('Home · 第 5 页')).toBeInTheDocument();
  });

  it('filters and sorts watchlist records by resolved archive title', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_watchlist') return { ok: true, value: [
        { scopeId: 'scope-a', archiveId: 'b', addedAt: '2026-08-27T00:00:00Z', updatedAt: '2026-08-27T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false },
        { scopeId: 'scope-a', archiveId: 'a', addedAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 2, deleted: false },
      ] };
      if (command === 'list_archives') return { ok: true, value: [
        { serverId: 'scope-a', archiveId: 'a', title: 'Alpha archive', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z' },
        { serverId: 'scope-a', archiveId: 'b', title: 'Beta archive', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' },
      ] };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MemoryRouter initialEntries={['/watchlist']}><App /></MemoryRouter>);

    const alpha = await screen.findByRole('link', { name: /Alpha archive/ });
    const beta = screen.getByRole('link', { name: /Beta archive/ });
    expect(alpha.compareDocumentPosition(beta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.type(screen.getByRole('searchbox', { name: '筛选待看' }), 'beta');
    expect(screen.queryByRole('link', { name: /Alpha archive/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Beta archive/ })).toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: '筛选待看' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '待看排序' }), 'recent');
    const recentFirst = screen.getByRole('link', { name: /Alpha archive/ });
    const recentSecond = screen.getByRole('link', { name: /Beta archive/ });
    expect(recentFirst.compareDocumentPosition(recentSecond) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('removes selected watchlist records locally and reports pending sync', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_watchlist') return { ok: true, value: [
        { scopeId: 'scope-a', archiveId: 'a', addedAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false },
      ] };
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a', title: 'Remove archive', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z' }] };
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
      if (command === 'list_archives') return { ok: true, value: [
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

    expect(screen.queryByRole('link', { name: /Alpha archive/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Beta archive/ })).toBeInTheDocument();
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

    expect(await screen.findByText('second.cbz')).toBeInTheDocument();
    expect(screen.getByText('Remote summary')).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('load_archive_metadata', { serverId: 'scope-a', archiveId: 'a2' });
  });

  it('loads the first archive detail without requiring a redundant row click', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'first', title: 'First archive', pageCount: 3, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'first', title: 'First archive', filename: 'first.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 3, lastReadTime: 0, size: 3 } };
      if (command === 'load_archive_thumbnail') return { ok: true, value: [255, 216, 255] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    expect(await screen.findByText('first.cbz')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '阅读 First archive' })).toHaveAttribute('href', '/reader/first');
    expect(adapter).toHaveBeenCalledWith('load_archive_metadata', { serverId: 'scope-a', archiveId: 'first' });
  });

  it('requires confirmation before deleting the selected archive', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Delete me', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }] };
      if (command === 'delete_archive') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

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

  it('loads categories and assigns the selected archive to one', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Categorize me', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'a1', title: 'Categorize me', filename: 'a.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 2, lastReadTime: 0, size: 1 } };
      if (command === 'list_categories') return { ok: true, value: [{ id: 'SET_1613080290', name: 'Favorites', pinned: false, search: null, archives: [] }] };
      if (command === 'add_archive_to_category') return { ok: true, value: { operation: 'add_to_category', success: 1 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    await user.click(await screen.findByRole('button', { name: /^Categorize me\b/ }));
    expect(await screen.findByRole('combobox', { name: '分类' })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: '分类' }), 'SET_1613080290');
    await user.click(screen.getByRole('button', { name: '加入分类' }));

    expect(adapter).toHaveBeenCalledWith('add_archive_to_category', { serverId: 'scope-a', categoryId: 'SET_1613080290', archiveId: 'a1' });
    expect(await screen.findByText('分类已更新')).toBeInTheDocument();
  });

  it('edits current archive metadata and refreshes the detail pane', async () => {
    const user = userEvent.setup();
    let metadataTitle = 'Original title';
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Original title', pageCount: 2, updatedAt: '2026-08-26T00:00:00Z' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'a1', title: metadataTitle, filename: 'a.cbz', tags: 'artist:old', extension: 'cbz', progress: 0, pageCount: 2, lastReadTime: 0, size: 1 } };
      if (command === 'update_archive_metadata') {
        metadataTitle = String((args?.metadata as { title?: string })?.title);
        return { ok: true, value: { operation: 'update_metadata', success: 1 } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

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

    expect(await screen.findByRole('img', { name: 'Covered 封面' })).toHaveAttribute('src', expect.stringContaining('data:application/octet-stream;base64,'));
  });

  it('refreshes archives from remote server and replaces the local list', async () => {
    const user = userEvent.setup();
    let callCount = 0;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_categories') return { ok: true, value: [] };
      if (command === 'list_archives') {
        return {
          ok: true,
          value: [{ serverId: 'scope-a', archiveId: 'a1', title: 'Old Archive', pageCount: 5, updatedAt: '2026-08-26T00:00:00Z' }],
        };
      }
      if (command === 'refresh_archives') {
        callCount += 1;
        return {
          ok: true,
          value: [
            { serverId: 'scope-a', archiveId: 'a1', title: 'Updated Archive', pageCount: 10, updatedAt: '2026-08-27T00:00:00Z' },
            { serverId: 'scope-a', archiveId: 'a2', title: 'New Archive', pageCount: 3, updatedAt: '2026-08-27T00:00:00Z' },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderLibrary();

    expect(await screen.findByRole('button', { name: /^Old Archive\b/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '刷新档案库' }));

    expect(adapter).toHaveBeenCalledWith('refresh_archives', { input: { serverId: 'scope-a', params: {} } });
    expect(callCount).toBe(1);
    expect(await screen.findByRole('button', { name: /^Updated Archive\b/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^New Archive\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Old Archive\b/ })).not.toBeInTheDocument();
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
});
