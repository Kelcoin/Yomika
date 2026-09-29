import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(() => {
  resetInvokeAdapterForTests();
  vi.restoreAllMocks();
});

const row = { serverId: 'scope-a', archiveId: 'archive-a', title: 'Cached archive', pageCount: 12, updatedAt: '2026-09-06T00:00:00Z' };
const offline = { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '服务器连不上', retryable: true } };

/** 服务器离线时点开一个档案的详情。
 *
 * 这条路曾经把**整个应用**变成一块纯色：详情页第一次渲染走完整骨架，metadata
 * 请求失败后的第二次渲染落到「读不到」那一支，而那一支后面还留着 `useTwoLineTitle`
 * ——挂钩数比上一次少，React 抛 #300（Rendered fewer hooks than expected），未捕获
 * 的错误把根节点一并卸载。这里的断言是「应用还在」：导航栏与自己画出来的错误都在。 */
it('keeps the app mounted when a detail page cannot reach the server', async () => {
  setInvokeAdapterForTests(async (command) => {
    if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
    if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
    if (command === 'search_archives_page') return { ok: true, value: { items: [row], total: 1, hasMore: false } };
    if (command === 'list_archives_by_ids') return { ok: true, value: [row] };
    if (command === 'cache_read_image') return offline;
    if (command.startsWith('list_')) return { ok: true, value: [] };
    return offline;
  });

  render(<MemoryRouter initialEntries={['/library']}><App /></MemoryRouter>);

  fireEvent.click(await screen.findByRole('button', { name: /^Cached archive/ }));

  // 详情页给出的是「读不到」那一片，而不是把应用带走。
  expect(await screen.findByRole('alert')).toHaveTextContent('服务器连不上');
  expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
  // 而且它还能退回去：左边的档案库一直在。
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  expect(await screen.findByRole('button', { name: /^Cached archive/ })).toBeInTheDocument();
});
