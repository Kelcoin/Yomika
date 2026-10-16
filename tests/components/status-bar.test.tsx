import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from '../../src/components/StatusBar';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(() => { resetInvokeAdapterForTests(); vi.useRealTimers(); });

const server = { id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test', enabled: true };
const failure = { ok: false, error: { code: 'LOCAL_DATABASE', message: 'busy', retryable: true } };

describe('status bar refresh', () => {
  it('does not overlap server or cache reads while focus and timer events arrive', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const adapter = vi.fn(async () => pending);
    setInvokeAdapterForTests(adapter);
    render(<StatusBar />);
    await act(async () => { fireEvent.focus(window); await vi.advanceTimersByTimeAsync(45_000); });
    expect(adapter.mock.calls.length).toBe(5);
    await act(async () => { finish(failure); });
    await act(async () => { fireEvent.focus(window); });
    expect(adapter.mock.calls.length).toBe(10);
  });

  it('clears the archive count when the configured server is removed', async () => {
    let configured = true;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: configured ? [server] : [] };
      if (command === 'check_server_status') return { ok: true, value: [] };
      if (command === 'list_archives_page') return { ok: true, value: { items: [], total: 42, hasMore: false } };
      return failure;
    });
    render(<StatusBar />);
    expect(await screen.findByText('42 项')).toBeInTheDocument();
    configured = false;
    await act(async () => { fireEvent.focus(window); });
    expect(screen.queryByLabelText('档案数量')).not.toBeInTheDocument();
  });

  it('reads the count for the enabled server instead of the first saved server', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ ...server, id: 'disabled', enabled: false }, server] };
      if (command === 'check_server_status') return { ok: true, value: [] };
      if (command === 'list_archives_page') return { ok: true, value: { items: [], total: 42, hasMore: false } };
      return failure;
    });
    setInvokeAdapterForTests(adapter);
    render(<StatusBar />);
    expect(await screen.findByText('42 项')).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('list_archives_page', { input: expect.objectContaining({ serverId: 's' }) });
  });
});
