import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach } from 'vitest';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

function renderAt(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('application shell', () => {
  it('exposes full desktop navigation and compact five-item navigation', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderAt();

    expect(screen.getByRole('link', { name: '跳到主内容' })).toHaveAttribute('href', '#main-content');
    await screen.findByRole('heading', { name: '书架还是空的' });
    const desktop = screen.getByRole('navigation', { name: '主导航' });
    expect(within(desktop).getByRole('link', { name: '下载' })).toBeInTheDocument();
    expect(within(desktop).getByRole('link', { name: '同步' })).toBeInTheDocument();

    const compact = screen.getByRole('navigation', { name: '移动导航' });
    expect(within(compact).getAllByRole('link')).toHaveLength(5);
    expect(within(compact).queryByRole('link', { name: 'E-Hentai' })).not.toBeInTheDocument();
    expect(within(compact).queryByRole('link', { name: '下载' })).not.toBeInTheDocument();
    expect(within(compact).queryByRole('link', { name: '同步' })).not.toBeInTheDocument();
  });

  it('marks the current route and renders its workspace heading', () => {
    renderAt('/library');

    const desktop = screen.getByRole('navigation', { name: '主导航' });
    expect(within(desktop).getByRole('link', { name: '档案库', current: 'page' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '档案库' })).toBeInTheDocument();
  });

  it('offers server setup from the first-run home', () => {
    renderAt();

    expect(screen.getByRole('link', { name: '添加服务器' })).toHaveAttribute('href', '/settings');
  });

  it('shows repository-backed recent reading on home', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-28T00:00:00Z', deviceId: 'device-a', revision: 1 }] };
      if (command === 'list_archives') return { ok: true, value: [{ serverId: 'scope-a', archiveId: 'a1', title: '最近阅读档案', pageCount: 12, updatedAt: '2026-08-28T00:00:00Z' }] };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    expect(await screen.findByRole('link', { name: /最近阅读档案/ })).toHaveAttribute('href', '/reader/a1');
    expect(screen.getByText('第 5 页')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '书架还是空的' })).not.toBeInTheDocument();
  });

  it('announces connection, sync, task, and cache status', () => {
    renderAt();

    expect(screen.getByRole('status', { name: '连接状态' })).toHaveTextContent('未连接');
    expect(screen.getByRole('status', { name: '同步状态' })).toHaveTextContent('未配置');
    expect(screen.getByRole('status', { name: '任务状态' })).toHaveTextContent('0');
    expect(screen.getByRole('status', { name: '缓存状态' })).toHaveTextContent('0 B');
  });

  it('shows repository-backed server and task status', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [
        { id: 'one', kind: 'download', label: '下载', status: 'running', progress: 0.5, cancelable: true, retryable: true, createdAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z' },
        { id: 'two', kind: 'sync', label: '同步', status: 'queued', progress: 0, cancelable: true, retryable: true, createdAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z' },
      ] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderAt();

    expect(await screen.findByRole('status', { name: '连接状态' })).toHaveTextContent('Home');
    expect(screen.getByRole('status', { name: '任务状态' })).toHaveTextContent('2');
  });

  it('links tooltip icon controls to their workspaces', () => {
    renderAt();

    expect(screen.getByRole('link', { name: '搜索' })).toHaveAttribute('href', '/library');
    expect(screen.getByRole('link', { name: '任务中心' })).toHaveAttribute('href', '/downloads');
  });

  it('collapses desktop navigation to an icon rail', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderAt();

    await screen.findByRole('status', { name: '连接状态' });
    const collapse = screen.getByRole('button', { name: '折叠侧栏' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await user.click(collapse);

    expect(screen.getByRole('button', { name: '展开侧栏' })).toHaveAttribute('aria-expanded', 'false');
  });
});
