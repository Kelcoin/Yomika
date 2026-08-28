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

  it('labels sync as externally unavailable instead of completed', async () => {
    render(<MemoryRouter initialEntries={['/sync']}><App /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: '同步尚未配置' })).toBeInTheDocument();
    expect(screen.getByText(/WebDAV/)).toBeInTheDocument();
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
