import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { BrowserRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

/** 详情页的「返回上一页」必须真的回到它自己那一页的列表，**而且不能被应用自己的
 *  历史改写骗到**：档案库的保留页面在「从别处回到档案库」时会用一条 `replace`
 *  把刚压进来的 `/library` 顶成 `/library/:id`，于是历史里那条列表条目消失，
 *  详情页再 `navigate(-1)` 弹出来的就是更早的那一页（最常见的就是首页）。
 *
 *  这里用生产用的 `BrowserRouter` 而不是测试里常见的 `MemoryRouter`：只有它才会
 *  往 `window.history` 里写 react-router 的 `{ idx }`，而返回逻辑正是在读它。 */

const server = { id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' };
const archive = { serverId: 'scope-a', archiveId: 'archive-a', title: 'Probe Archive', pageCount: 3, updatedAt: '2026-08-26T00:00:00Z' };
const metadata = { archiveId: 'archive-a', title: 'Probe Archive', filename: 'a.zip', tags: '', extension: 'zip', progress: 0, pageCount: 3, lastReadTime: 0, size: 10 };

afterEach(() => {
  resetInvokeAdapterForTests();
  window.localStorage.removeItem('yomika.route-cache.v1');
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

function answered() {
  return setInvokeAdapterForTests(async (command: string) => {
    if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, detailActions: ['read', 'readingList', 'favorites', 'download', 'edit'] } };
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'search_archives_page') return { ok: true, value: { items: [archive], total: 1, hasMore: false } };
    if (command === 'search_random_archives') return { ok: true, value: [archive] };
    if (command === 'read_favorites_category') return { ok: true, value: { id: 'fav', archives: ['archive-a'] } };
    if (command === 'list_archives_by_ids') return { ok: true, value: [archive] };
    if (command === 'load_archive_metadata') return { ok: true, value: metadata };
    if (command === 'cache_stats') return { ok: true, value: { bytes: 0, entries: 0 } };
    if (command.startsWith('list_')) return { ok: true, value: [] };
    return { ok: true, value: [] };
  });
}

function renderAt(path: string) {
  window.history.replaceState({ usr: null, key: 'default', idx: 0 }, '', path);
  return render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}

async function mainNav() {
  return within(await screen.findByRole('navigation', { name: '主导航' }));
}

async function clickDetailBack(to: string) {
  fireEvent.click(await screen.findByRole('button', { name: '返回上一页' }));
  await waitFor(() => expect(window.location.pathname).toBe(to));
}

describe('the detail page goes back to the page it belongs to', () => {
  it('lands on the library list, not the page the library was left from', async () => {
    answered();
    renderAt('/');
    const nav = await mainNav();

    // 首页 → 档案库 → 一份详情
    fireEvent.click(nav.getByRole('link', { name: '档案库' }));
    await waitFor(() => expect(window.location.pathname).toBe('/library'));
    fireEvent.click(await screen.findByRole('button', { name: /^Probe Archive\b/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/library/archive-a'));

    // 主导航打开列表，不恢复上次详情子路由。
    fireEvent.click(nav.getByRole('link', { name: '首页' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    fireEvent.click(nav.getByRole('link', { name: '档案库' }));
    await waitFor(() => expect(window.location.pathname).toBe('/library'));
    // 真的回到了列表：那一排卡片还在。
    expect(await screen.findByRole('button', { name: /^Probe Archive\b/ })).toBeInTheDocument();
  });

  it('comes back to the home rail, not the library, when the detail was opened from the home page', async () => {
    answered();
    renderAt('/');
    fireEvent.click(await screen.findByRole('link', { name: /^Probe Archive\b/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/home/archive-a'));

    await clickDetailBack('/');
  });

  it('falls back to the home page when the home detail has no history to go back to', async () => {
    answered();
    // 冷启动或深链：历史里只有这一格，返回按钮没有上一页可退，只能用兜底地址。
    renderAt('/home/archive-a');
    await screen.findByRole('button', { name: '返回上一页' });

    await clickDetailBack('/');
  });

  it('returns to the detail the metadata editor was opened from', async () => {
    answered();
    renderAt('/');
    fireEvent.click(await screen.findByRole('link', { name: /^Probe Archive\b/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/home/archive-a'));

    fireEvent.click(await screen.findByRole('button', { name: '编辑元数据' }));
    await waitFor(() => expect(window.location.pathname).toBe('/library/archive-a/edit'));

    // 编辑页的返回读的是详情页写进 state 的 returnTo：从首页那份详情进来的，
    // 就该回首页那份详情（而不是硬编码的档案库详情）。
    await clickDetailBack('/home/archive-a');
    await clickDetailBack('/');
    const nav = await mainNav();
    fireEvent.click(nav.getByRole('link', { name: '档案库' }));
    await waitFor(() => expect(window.location.pathname).toBe('/library'));
    expect(screen.queryByRole('heading', { name: '编辑元数据' })).not.toBeInTheDocument();
  });
});


it.each([['/library', '档案库'], ['/watchlist', '收藏夹']])('returns through the editor to its %s origin and list', async (origin, label) => {
  answered();
  renderAt('/');
  const nav = await mainNav();
  fireEvent.click(nav.getByRole('link', { name: label }));
  await waitFor(() => expect(window.location.pathname).toBe(origin));
  fireEvent.click(await screen.findByRole('button', { name: /^Probe Archive\b/ }));
  await waitFor(() => expect(window.location.pathname).toBe(`${origin}/archive-a`));
  fireEvent.click(await screen.findByRole('button', { name: '编辑元数据' }));
  await waitFor(() => expect(window.location.pathname).toBe('/library/archive-a/edit'));
  await clickDetailBack(`${origin}/archive-a`);
  await clickDetailBack(origin);
  fireEvent.click(nav.getByRole('link', { name: '档案库' }));
  await waitFor(() => expect(window.location.pathname).toBe('/library'));
  expect(screen.queryByRole('heading', { name: '编辑元数据' })).not.toBeInTheDocument();
});

it('falls back to the library list for a direct editor link with no history', async () => {
  answered();
  renderAt('/library/archive-a/edit');
  await screen.findByRole('heading', { name: '编辑元数据' });
  await clickDetailBack('/library');
  expect(await screen.findByRole('button', { name: /^Probe Archive\b/ })).toBeInTheDocument();
});
