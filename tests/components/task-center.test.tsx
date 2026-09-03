import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(() => {
  resetInvokeAdapterForTests();
});

describe('task center', () => {
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

  });
