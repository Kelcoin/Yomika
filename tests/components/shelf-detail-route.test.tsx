import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter } from 'react-router-dom';
import { WorkspaceRoutes } from '../../src/app/routes';
import { PreferencesProvider } from '../../src/app/preferences';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

/** 书架的两件事：卡片打开的详情留在书架上（不是档案库），历史的多选能清掉记录。 */
const archive = (index: number) => ({
  serverId: 'server-1',
  archiveId: `archive-${index}`,
  title: `Archive ${index}`,
  pageCount: 40,
  updatedAt: '2026-09-01T00:00:00.000Z',
});

const history = [0, 1].map((index) => ({
  scopeId: 'scope-1',
  archiveId: `archive-${index}`,
  // 30/40 页：读完（95% 以上）的那两条，多选才有「全选已读完」可用。
  pageIndex: 39,
  visitedAt: `2026-09-0${index + 1}T10:00:00.000Z`,
  deviceId: 'device-1',
  revision: 1,
}));

function makeAdapter(overrides: Record<string, (payload?: unknown) => unknown> = {}) {
  return vi.fn(async (command: string, payload?: unknown) => {
    if (overrides[command]) return overrides[command](payload);
    if (command === 'list_servers') return { ok: true, value: [{ id: 'server-1', scopeId: 'scope-1', name: 'Home', baseUrl: 'https://example.com', enabled: true }] };
    if (command === 'list_reading_history') return { ok: true, value: history };
    if (command === 'list_watchlist' || command === 'list_reading_list' || command === 'list_search_presets') return { ok: true, value: [] };
    if (command === 'list_archives_by_ids') return { ok: true, value: [archive(0), archive(1)] };
    if (command === 'verify_archives_exist') return { ok: true, value: [] };
    if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
    if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'archive-0', title: 'Archive 0', filename: 'a.zip', tags: '', extension: 'zip', progress: 0, pageCount: 40, lastReadTime: 0, size: 1 } };
    if (command === 'load_reading_progress') return { ok: true, value: [] };
    if (command === 'list_tasks') return { ok: true, value: [] };
    return { ok: true, value: [] };
  });
}

function renderApp(initialEntry: string, adapter: ReturnType<typeof makeAdapter>) {
  setInvokeAdapterForTests(adapter);
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PreferencesProvider><ToastProvider>
        <Link to="/history">to-history</Link>
        <Link to="/library">to-library</Link>
        <WorkspaceRoutes />
      </ToastProvider></PreferencesProvider>
    </MemoryRouter>,
  );
}

afterEach(resetInvokeAdapterForTests);

describe('shelf detail route', () => {
  it('opens the detail on the shelf itself, so the list on the left stays the shelf', async () => {
    const adapter = makeAdapter();
    renderApp('/history', adapter);
    const card = await screen.findByRole('button', { name: /Archive 0/ });
    fireEvent.click(card);
    // 详情开在 /history/… 上：左边那栏还是历史本身，不是档案库。
    const list = await screen.findByRole('list', { name: '档案' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '多选' })).toBeInTheDocument();
    await waitFor(() => expect(adapter.mock.calls.some(([command]) => command === 'load_archive_metadata')).toBe(true));
    // 历史里的那两条一个都不能少：卡片点击不是「跳去档案库」。
    expect(await screen.findByText('Archive 1')).toBeInTheDocument();
  });

  it('clears the selected history records from the shelf’s own multi-select', async () => {
    const adapter = makeAdapter({ delete_history_records: () => ({ ok: true, value: 2 }) });
    renderApp('/history', adapter);
    fireEvent.click(await screen.findByRole('button', { name: '多选' }));
    fireEvent.click(screen.getByRole('button', { name: '全选已读完' }));
    fireEvent.click(screen.getByRole('button', { name: '清理所选记录' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/将从历史里移除选中的 2 条记录/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /清理/ }));
    await waitFor(() => expect(adapter.mock.calls.some(([command]) => command === 'delete_history_records')).toBe(true));
    const call = adapter.mock.calls.find(([command]) => command === 'delete_history_records');
    expect(call?.[1]).toEqual({ scopeId: 'scope-1', archiveIds: expect.arrayContaining(['archive-0', 'archive-1']) });
    // 记录没了，历史就空了——清理的是记录，档案本体不受影响。
    await screen.findByText('暂无历史');
    expect(adapter.mock.calls.some(([command]) => command === 'delete_archive')).toBe(false);
  });
});
