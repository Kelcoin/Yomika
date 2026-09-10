import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter } from 'react-router-dom';
import { WorkspaceRoutes } from '../../src/app/routes';
import { PreferencesProvider } from '../../src/app/preferences';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';

afterEach(resetInvokeAdapterForTests);

describe('shelf snapshots', () => {
  it('restores separate shelves without reload and invalidates after reading-list mutation', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (['list_reading_history', 'list_watchlist', 'list_reading_list', 'list_archives_by_ids'].includes(command)) return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'set_reading_list') return { ok: true, value: { scopeId: 's', archiveId: 'a', addedAt: '2026-09-07', updatedAt: '2026-09-07', deviceId: 'device', deleted: false, revision: 1 } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/history']}><PreferencesProvider><ToastProvider>
      <Link to="/history">history-nav</Link><Link to="/to-read">to-read-nav</Link><WorkspaceRoutes />
    </ToastProvider></PreferencesProvider></MemoryRouter>);
    await screen.findByText('暂无历史');
    fireEvent.click(screen.getByText('to-read-nav'));
    await screen.findByText('暂无待看档案');
    fireEvent.click(screen.getByText('history-nav'));
    expect(screen.getByText('暂无历史')).toBeInTheDocument();
    expect(adapter.mock.calls.filter(([command]) => command === 'list_reading_history')).toHaveLength(1);
    const mutation = await new NativeLibraryRepository().setReadingList('s', 'a', true);
    expect(mutation.ok).toBe(true);
    fireEvent.click(screen.getByText('to-read-nav'));
    await waitFor(() => expect(adapter.mock.calls.filter(([command]) => command === 'list_reading_list')).toHaveLength(2));
  });
});
