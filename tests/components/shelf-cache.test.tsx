import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter } from 'react-router-dom';
import { WorkspaceRoutes } from '../../src/app/routes';
import { PreferencesProvider } from '../../src/app/preferences';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';
import { readRouteCache, writeRouteCache } from '../../src/lib/routeCache';

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

  it('drops the home and shelf snapshots when history records are removed', async () => {
    // 用户报的那一条：历史里清掉（多选「全选已读完」→「清理所选记录」）或自动清理掉记录
    // 之后，首页「继续阅读」那一排还在显示它们。清理从前只排了一次同步（`notifyLocalWrite`），
    // 界面上的快照没人作废——首页那一份就一直停在旧数据上。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Home', baseUrl: 'https://example.com' }] };
      if (command === 'delete_history_records') return { ok: true, value: 2 };
      if (command === 'prune_history') return { ok: true, value: 3 };
      if (command === 'list_sync_accounts') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: `unused ${command}`, retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeLibraryRepository();

    writeRouteCache('home:shelves', { history: [] });
    writeRouteCache('state:history:default', { history: [] });
    expect(await repository.deleteHistoryRecords('s', ['a1', 'a2'])).toEqual({ ok: true, value: 2 });
    expect(readRouteCache('home:shelves')).toBeUndefined();
    expect(readRouteCache('state:history:default')).toBeUndefined();

    // 自动清理（启动后的巡检、设置里的「立即清理」）走的是同一条路。
    writeRouteCache('home:shelves', { history: [] });
    writeRouteCache('state:history:default', { history: [] });
    expect(await repository.pruneHistory()).toEqual({ ok: true, value: 3 });
    expect(readRouteCache('home:shelves')).toBeUndefined();
    expect(readRouteCache('state:history:default')).toBeUndefined();
  });

  it('leaves the snapshots alone when nothing was actually removed', async () => {
    // 六小时一次的巡检绝大多数时候一条也没清：那时不该作废快照，首页不会白重排一遍
    // （随机漫游也会跟着重抽）。
    setInvokeAdapterForTests(vi.fn(async (command: string) => {
      if (command === 'prune_history') return { ok: true, value: 0 };
      if (command === 'delete_history_records') return { ok: true, value: 0 };
      return { ok: false, error: { code: 'UNKNOWN', message: `unused ${command}`, retryable: false } };
    }));
    const repository = new NativeLibraryRepository();
    writeRouteCache('home:shelves', { history: [] });

    expect(await repository.pruneHistory()).toEqual({ ok: true, value: 0 });
    expect(await repository.deleteHistoryRecords('s', ['a1'])).toEqual({ ok: true, value: 0 });
    expect(readRouteCache('home:shelves')).toEqual({ history: [] });
  });
});
