import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setFilePickerForTests } from '../../src/bridge/filePicker';

afterEach(() => {
  resetInvokeAdapterForTests();
  resetFilePickerForTests();
});

const preferences = { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 };

function renderTools() {
  return render(<MemoryRouter initialEntries={['/settings?section=tools']}><App /></MemoryRouter>);
}

describe('settings tools upload', () => {
  it('selects an archive, creates a task, and uploads it', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: preferences };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'create_task') {
        return { ok: true, value: { id: 'task-1', kind: 'download', label: '上传 demo.cbz', status: 'queued', progress: 0, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' } };
      }
      if (command === 'upload_archive') return { ok: true, value: { operation: 'upload', success: 1, id: 'archive-1' } };
      if (command === 'list_archives' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'cache_stats') return { ok: true, value: { imageBytes: 0, imageEntries: 0, maxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    setFilePickerForTests(async () => 'C:/library/demo.cbz');

    renderTools();
    await user.click(await screen.findByRole('button', { name: '选择文件并上传' }));

    expect(adapter).toHaveBeenCalledWith('create_task', { task: { kind: 'download', label: '上传 demo.cbz' } });
    expect(adapter).toHaveBeenCalledWith('upload_archive', { serverId: 'scope-a', taskId: 'task-1', filePath: 'C:/library/demo.cbz' });
    expect(await screen.findByText(/已上传 demo\.cbz/)).toBeInTheDocument();
  });

  it('marks upload busy while the native upload is pending', async () => {
    const user = userEvent.setup();
    let resolveUpload!: (value: { ok: true; value: { operation: string; success: number; id: string } }) => void;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: preferences };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'create_task') return { ok: true, value: { id: 'task-1', kind: 'download', label: '上传 demo.cbz', status: 'queued', progress: 0, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' } };
      if (command === 'upload_archive') return new Promise((resolve) => { resolveUpload = resolve; });
      if (command === 'list_archives' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'cache_stats') return { ok: true, value: { imageBytes: 0, imageEntries: 0, maxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setFilePickerForTests(async () => 'C:/library/demo.cbz');

    renderTools();
    await user.click(await screen.findByRole('button', { name: '选择文件并上传' }));
    const pending = await screen.findByRole('button', { name: '上传中…' });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute('aria-busy', 'true');

    resolveUpload({ ok: true, value: { operation: 'upload', success: 1, id: 'archive-1' } });
    expect(await screen.findByText(/已上传 demo\.cbz/)).toBeInTheDocument();
  });

  it('marks upload busy while the file picker is open', async () => {
    const user = userEvent.setup();
    let resolvePicker!: (path: string | null) => void;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: preferences };
      if (command === 'list_archives' || command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'cache_stats') return { ok: true, value: { imageBytes: 0, imageEntries: 0, maxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setFilePickerForTests(() => new Promise<string | null>((resolve) => { resolvePicker = resolve; }));

    renderTools();
    const upload = await screen.findByRole('button', { name: '选择文件并上传' });
    await user.click(upload);

    expect(screen.getByRole('button', { name: '上传中…' })).toBeDisabled();
    resolvePicker(null);
    expect(await screen.findByRole('button', { name: '选择文件并上传' })).not.toBeDisabled();
  });

  it('keeps deduplication in the tools section without the Readoshi import', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: preferences };
      if (command === 'list_archives' || command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'cache_stats') return { ok: true, value: { imageBytes: 0, imageEntries: 0, maxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderTools();

    expect(await screen.findByRole('button', { name: /开始扫描/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '导入 Readoshi 不重复关系' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '查重工作区' })).not.toBeInTheDocument();
  });
});
