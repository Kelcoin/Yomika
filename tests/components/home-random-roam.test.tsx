import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetArchiveExistenceForTests } from '../../src/lib/archiveExistence';
import { invalidateRouteCache } from '../../src/lib/routeCache';

// 这一组测的是**随机漫游那一排什么时候重抽**。首页的数据源是本地索引与服务器，
// 而书架自己的写入（阅读进度每翻一页写一次、加收藏、删档案）都会广播
// `yomika:route-cache-invalidated`，首页因此重读一遍书架——随机漫游不该跟着重抽，
// 那正是用户报的「莫名其妙自动刷新」。抽签批次号写在标题里，屏幕上是哪一批一眼可断。

afterEach(() => {
  resetInvokeAdapterForTests();
  resetArchiveExistenceForTests();
  vi.clearAllMocks();
});

/** 抽到的档案。`draw` 是第几次抽签，`server` 是抽它的那台服务器——标题带上两者，
 * 于是「还是原来那一批」和「换了服务器重抽了」都能直接读出来。 */
const drawn = (server: string, draw: number, index: number) => ({
  serverId: server,
  archiveId: `archive-${draw}-${index}`,
  title: `Random ${draw}-${index}`,
  pageCount: 40,
  updatedAt: '2026-09-01T00:00:00.000Z',
});

function makeAdapter(state: { server: string; draws: number }) {
  return vi.fn(async (command: string) => {
    if (command === 'list_servers') {
      return {
        ok: true,
        value: [{ id: state.server, scopeId: `scope-${state.server}`, name: state.server, baseUrl: 'https://example.com', enabled: true }],
      };
    }
    if (command === 'list_reading_history') return { ok: true, value: [] };
    if (command === 'list_reading_list' || command === 'list_watchlist' || command === 'list_search_presets') return { ok: true, value: [] };
    if (command === 'list_archives_by_ids') return { ok: true, value: [] };
    if (command === 'verify_archives_exist') return { ok: true, value: [] };
    if (command === 'search_random_archives') {
      state.draws += 1;
      // `needed` 是 max(8, ceil(innerWidth / 150) + 2)——jsdom 里 1024 宽就是 9 条，
      // 一次 24 条够铺满，所以抽一次就停（画面上出现的批次也就可数）。
      return { ok: true, value: Array.from({ length: 24 }, (_, index) => drawn(state.server, state.draws, index)) };
    }
    if (command === 'load_preferences') {
      return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
    }
    if (command === 'cache_stats') return { ok: true, value: { bytes: 0, entries: 0 } };
    return { ok: true, value: [] };
  });
}

/** 首页每读一次书架就问一次历史；用它数「重读了几遍」，而不是数随机抽签。 */
const shelfReads = (adapter: ReturnType<typeof makeAdapter>) => adapter.mock.calls.filter(([command]) => command === 'list_reading_history').length;

describe('home random roam', () => {
  it.each(['remote', 'fallback'] as const)('ignores a late %s draw from the previous server', async (source) => {
    const state = { server: 'server-1', draws: 0 };
    const base = makeAdapter(state);
    let finishOld: ((value: unknown) => void) | undefined;
    const oldRows = Array.from({ length: 24 }, (_, index) => drawn('server-1', 1, index));
    setInvokeAdapterForTests(async (command, payload) => {
      const serverId = (payload as { input?: { serverId?: string } } | undefined)?.input?.serverId;
      if (serverId === 'server-1' && command === 'search_random_archives') {
        if (source === 'fallback') return { ok: true, value: [] };
        return new Promise((resolve) => { finishOld = resolve; });
      }
      if (serverId === 'server-1' && command === 'list_archives_page') {
        return new Promise((resolve) => { finishOld = resolve; });
      }
      return base(command);
    });
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await waitFor(() => expect(finishOld).toBeDefined());
    state.server = 'server-2';
    state.draws = 1;
    await act(async () => { invalidateRouteCache(); });
    const rail = await screen.findByRole('region', { name: '随机漫游' });
    expect(await within(rail).findByText('Random 2-0')).toBeInTheDocument();
    await act(async () => {
      finishOld!({ ok: true, value: source === 'remote' ? oldRows : { items: oldRows, total: oldRows.length, hasMore: false } });
    });
    expect(within(rail).getByText('Random 2-0')).toBeInTheDocument();
    expect(within(rail).queryByText('Random 1-0')).toBeNull();
  });

  it('keeps the set it already drew when a shelf write asks the home page to read again', async () => {
    const state = { server: 'server-1', draws: 0 };
    const adapter = makeAdapter(state);
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);

    const rail = await screen.findByRole('region', { name: '随机漫游' });
    expect(await within(rail).findByText('Random 1-0')).toBeInTheDocument();
    expect(state.draws).toBe(1);
    const reads = shelfReads(adapter);

    // 阅读进度在阅读时每翻一页写一次：save_reading_progress → invalidateShelves → `home:`。
    await act(async () => { invalidateRouteCache('home:'); });
    await waitFor(() => expect(shelfReads(adapter)).toBeGreaterThan(reads));

    expect(state.draws).toBe(1);
    expect(within(rail).getByText('Random 1-0')).toBeInTheDocument();
    expect(within(rail).queryByText('Random 2-0')).toBeNull();
  });

  it('draws again when the shelves move to another server', async () => {
    const state = { server: 'server-1', draws: 0 };
    const adapter = makeAdapter(state);
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);

    const rail = await screen.findByRole('region', { name: '随机漫游' });
    expect(await within(rail).findByText('Random 1-0')).toBeInTheDocument();

    // 启用服务器切换广播的是**全量**失效（`invalidateRouteCache()` 无前缀）：书架改读新
    // 启用的那台，随机漫游也必须跟着换，否则留在屏幕上的是上一台的档案。
    state.server = 'server-2';
    await act(async () => { invalidateRouteCache(); });

    await waitFor(() => expect(within(rail).getByText('Random 2-0')).toBeInTheDocument());
    expect(state.draws).toBe(2);
    expect(within(rail).queryByText('Random 1-0')).toBeNull();
  });
});
