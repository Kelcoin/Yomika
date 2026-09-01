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

describe('task center upload', () => {
  it('selects an archive, creates a task, uploads it, and refreshes tasks', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'create_task') {
        return { ok: true, value: { id: 'task-1', kind: 'download', label: '上传 demo.cbz', status: 'queued', progress: 0, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' } };
      }
      if (command === 'upload_archive') return { ok: true, value: { operation: 'upload', success: 1, id: 'archive-1' } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    setFilePickerForTests(async () => 'C:/library/demo.cbz');

    render(<MemoryRouter initialEntries={['/downloads']}><App /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '上传档案' }));

    expect(adapter).toHaveBeenCalledWith('create_task', { task: { kind: 'download', label: '上传 demo.cbz' } });
    expect(adapter).toHaveBeenCalledWith('upload_archive', { serverId: 'scope-a', taskId: 'task-1', filePath: 'C:/library/demo.cbz' });
    expect(await screen.findByText('上传完成')).toBeInTheDocument();
  });

  it('exposes only valid persistent task recovery controls', async () => {
    const user = userEvent.setup();
    const base = { kind: 'download', progress: 0.5, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' };
    const adapter = vi.fn(async (command: string, args) => {
      if (command === 'list_tasks') return { ok: true, value: [
        { ...base, id: 'failed', label: '失败任务', status: 'failed', error: 'offline' },
        { ...base, id: 'running', label: '运行任务', status: 'running' },
      ] };
      if (command === 'retry_task') return { ok: true, value: { ...base, id: String(args?.id), label: '失败任务', status: 'queued' } };
      if (command === 'update_task') return { ok: true, value: { ...base, id: String(args?.id), label: '运行任务', status: String((args?.update as { status?: string })?.status) } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    render(<MemoryRouter initialEntries={['/downloads']}><App /></MemoryRouter>);
    expect(await screen.findByText('失败')).toHaveClass('status-chip', 'status-chip-danger');
    expect(screen.getByText('进行中')).toHaveClass('status-chip', 'status-chip-active');
    await user.click(await screen.findByRole('button', { name: '重试失败任务' }));
    await user.click(screen.getByRole('button', { name: '暂停运行任务' }));

    expect(adapter).toHaveBeenCalledWith('retry_task', { id: 'failed' });
    expect(adapter).toHaveBeenCalledWith('update_task', { id: 'running', update: { status: 'paused' } });
    expect(screen.getByRole('button', { name: '恢复运行任务' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试运行任务' })).not.toBeInTheDocument();
  });

  it('marks upload busy while the native upload is pending', async () => {
    const user = userEvent.setup();
    let resolveUpload!: (value: { ok: true; value: { operation: string; success: number; id: string } }) => void;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'create_task') return { ok: true, value: { id: 'task-1', kind: 'download', label: '上传 demo.cbz', status: 'queued', progress: 0, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' } };
      if (command === 'upload_archive') return new Promise((resolve) => { resolveUpload = resolve; });
      throw new Error(`Unexpected command: ${command}`);
    });
    setFilePickerForTests(async () => 'C:/library/demo.cbz');
    render(<MemoryRouter initialEntries={['/downloads']}><App /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: '上传档案' }));
    const pending = await screen.findByRole('button', { name: '上传中…' });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute('aria-busy', 'true');

    resolveUpload({ ok: true, value: { operation: 'upload', success: 1, id: 'archive-1' } });
    expect(await screen.findByText('上传完成')).toBeInTheDocument();
  });

  it('locks task actions while a native task update is pending', async () => {
    const user = userEvent.setup();
    let resolveUpdate!: (value: unknown) => void;
    const adapter = vi.fn(async (command: string, args) => {
      if (command === 'list_tasks') return { ok: true, value: [{ kind: 'download', id: 'running', label: '运行任务', status: 'running', progress: 0.5, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' }] };
      if (command === 'update_task') return new Promise((resolve) => { resolveUpdate = () => resolve({ ok: true, value: { kind: 'download', id: String(args?.id), label: '运行任务', status: 'paused', progress: 0.5, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' } }); });
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    render(<MemoryRouter initialEntries={['/downloads']}><App /></MemoryRouter>);
    const pause = await screen.findByRole('button', { name: '暂停运行任务' });
    await user.click(pause);

    expect(pause).toBeDisabled();
    expect(pause).toHaveAttribute('aria-busy', 'true');
    expect(adapter.mock.calls.filter(([command]) => command === 'update_task')).toHaveLength(1);

    resolveUpdate(undefined);
    expect(await screen.findByRole('button', { name: '恢复运行任务' })).toBeInTheDocument();
  });

  it('marks upload busy while the file picker is open', async () => {
    const user = userEvent.setup();
    let resolvePicker!: (path: string | null) => void;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setFilePickerForTests(() => new Promise<string | null>((resolve) => { resolvePicker = resolve; }));

    render(<MemoryRouter initialEntries={['/downloads']}><App /></MemoryRouter>);
    const upload = await screen.findByRole('button', { name: '上传档案' });
    await user.click(upload);

    expect(screen.getByRole('button', { name: '上传中…' })).toBeDisabled();
    resolvePicker(null);
    expect(await screen.findByRole('button', { name: '上传档案' })).not.toBeDisabled();
  });
});
