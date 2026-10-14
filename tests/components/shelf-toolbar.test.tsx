import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { WorkspaceRoutes } from '../../src/app/routes';
import { PreferencesProvider } from '../../src/app/preferences';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

/** 收藏与待看的顶栏要和档案库同一套：分类筛选、排序方式、多选、显示模式，
 * 而且顺序就是档案库那个顺序（多选紧跟在排序方式右边）。 */
const archive = (index: number) => ({
  serverId: 'server-1',
  archiveId: `archive-${index}`,
  title: `Archive ${index}`,
  pageCount: 40,
  updatedAt: '2026-09-01T00:00:00.000Z',
});

const watchlist = [
  { scopeId: 'scope-1', archiveId: 'archive-0', addedAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z', deviceId: 'device-1', revision: 1, deleted: false },
  { scopeId: 'scope-1', archiveId: 'archive-1', addedAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z', deviceId: 'device-1', revision: 1, deleted: false },
];

// 分类 id 是 14 位（原生那边 schema 就是这个长度）。
const categories = [
  { id: 'category000001', name: 'Action', pinned: false, archives: ['archive-0'] },
  { id: 'category000002', name: 'Comedy', pinned: false, archives: ['archive-1'] },
];

function makeAdapter() {
  return vi.fn(async (command: string) => {
    if (command === 'list_servers') return { ok: true, value: [{ id: 'server-1', scopeId: 'scope-1', name: 'Home', baseUrl: 'https://example.com', enabled: true }] };
    if (command === 'list_watchlist') return { ok: true, value: [watchlist[0]] };
    if (command === 'list_reading_list') return { ok: true, value: watchlist };
    if (command === 'list_reading_history' || command === 'list_search_presets') return { ok: true, value: [] };
    // 收藏的成员与顺序来自远端分类；本地待看记录不决定收藏。
    if (command === 'read_favorites_category') return { ok: true, value: { id: 'favorites00001', archives: ['archive-1', 'archive-0'] } };
    if (command === 'list_archives_by_ids') return { ok: true, value: [archive(0), archive(1)] };
    if (command === 'verify_archives_exist') return { ok: true, value: [] };
    if (command === 'list_categories') return { ok: true, value: categories };
    if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
    if (command === 'list_tasks') return { ok: true, value: [] };
    return { ok: true, value: [] };
  });
}

function renderShelf(path: string, adapter: ReturnType<typeof makeAdapter>) {
  setInvokeAdapterForTests(adapter);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PreferencesProvider><ToastProvider>
        <WorkspaceRoutes />
      </ToastProvider></PreferencesProvider>
    </MemoryRouter>,
  );
}

/** 列表里卡片标题的顺序，用来验排序真的换了序。 */
function listTitles() {
  return within(screen.getByRole('list', { name: '档案' })).getAllByRole('listitem')
    .map((item) => item.textContent?.match(/Archive \d/)?.[0]);
}

afterEach(resetInvokeAdapterForTests);

describe('shelf toolbar', () => {
  it('gives 收藏 the library’s toolbar, with 多选 right after 排序方式', async () => {
    renderShelf('/watchlist', makeAdapter());
    const toolbar = await screen.findByRole('toolbar', { name: '档案库工具' });
    // 分类筛选要等分类读回来才画得出来（读完之前是一段骨架）。
    await screen.findByRole('combobox', { name: '分类筛选' });
    const labels = Array.from(toolbar.querySelectorAll('[aria-label]')).map((element) => element.getAttribute('aria-label') ?? '');
    expect(labels).toHaveLength(4);
    expect(labels[0]).toBe('分类筛选');
    expect(labels[1]).toBe('排序字段');
    expect(labels[2]).toBe('多选');
    expect(labels[3]).toMatch(/^显示模式：/);
  });

  it('filters by category and re-sorts by title', async () => {
    const adapter = makeAdapter();
    renderShelf('/watchlist', adapter);
    await screen.findByRole('combobox', { name: '分类筛选' });
    expect(adapter).toHaveBeenCalledWith('read_favorites_category', { serverId: 'server-1' });
    expect(adapter.mock.calls.some(([command]) => command === 'list_watchlist')).toBe(false);
    // 默认保留远端 Favorites 分类顺序：archive-1 在前。
    expect(listTitles()).toEqual(['Archive 1', 'Archive 0']);

    fireEvent.change(screen.getByRole('combobox', { name: '分类筛选' }), { target: { value: 'category000001' } });
    await waitFor(() => expect(listTitles()).toEqual(['Archive 0']));

    fireEvent.change(screen.getByRole('combobox', { name: '分类筛选' }), { target: { value: '' } });
    await waitFor(() => expect(listTitles()).toEqual(['Archive 1', 'Archive 0']));
    fireEvent.change(screen.getByRole('combobox', { name: '排序字段' }), { target: { value: 'title' } });
    await waitFor(() => expect(listTitles()).toEqual(['Archive 0', 'Archive 1']));
  });

  it('gives 待看 the same toolbar', async () => {
    renderShelf('/to-read', makeAdapter());
    expect(await screen.findByRole('toolbar', { name: '档案库工具' })).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: '分类筛选' })).toBeInTheDocument();
  });

  it('leaves 历史 without a toolbar: its order is the timeline itself', async () => {
    renderShelf('/history', makeAdapter());
    await screen.findByText('暂无历史');
    expect(screen.queryByRole('toolbar', { name: '档案库工具' })).not.toBeInTheDocument();
  });
});
