import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

const account = {
  id: 'personal',
  label: 'Personal WebDAV',
  baseUrl: 'https://dav.example.com/Yomika',
  username: 'reader',
  credentialRef: 'personal-secret',
  status: 'unverified',
  lastProbeAt: null,
  lastErrorCode: null,
  createdAt: '2026-08-28 00:00:00',
  updatedAt: '2026-08-28 00:00:00',
};

function renderSync() {
  return render(<MemoryRouter initialEntries={['/sync']}><App /></MemoryRouter>);
}

describe('sync workspace', () => {
  it('shows configured WebDAV accounts and real status', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_webdav_accounts') return { ok: true, value: [account] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderSync();

    // 同步区与其它设置同构：行报告当前状态，账户在行的悬浮菜单里。
    // 设置页按路由懒加载，全量并行跑时首个转换会超过默认 1s 等待。
    const row = await screen.findByRole('button', { name: 'WebDAV 账户' }, { timeout: 10_000 });
    await user.click(row);
    const accountsMenu = await screen.findByRole('dialog', { name: 'WebDAV 账户' });
    expect(await within(accountsMenu).findByText('Personal WebDAV')).toBeInTheDocument();
    expect(within(accountsMenu).getByText('https://dav.example.com/Yomika')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '同步状态' })).toHaveTextContent('已配置');
  });

  it('saves a WebDAV account and creates its local encryption key', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'save_webdav_account') return { ok: true, value: { ...account, id: (args?.input as { id: string }).id } };
      if (command === 'create_sync_key') return { ok: true, value: String(args?.accountId) };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSync();

    await user.click(await screen.findByRole('button', { name: 'WebDAV 账户' }));
    const setupMenu = screen.getByRole('dialog', { name: 'WebDAV 账户' });
    // 账户 ID 由名称自动派生，不再出现在表单里。
    expect(within(setupMenu).queryByLabelText('账户 ID')).toBeNull();
    await user.type(within(setupMenu).getByLabelText('名称'), 'Personal WebDAV');
    await user.type(within(setupMenu).getByLabelText('WebDAV 地址'), 'https://dav.example.com/Yomika');
    await user.type(within(setupMenu).getByLabelText('用户名'), 'reader');
    await user.type(within(setupMenu).getByLabelText('密码或 Token'), 'secret-token');
    await user.click(within(setupMenu).getByRole('button', { name: '保存同步账户' }));

    // 保存后账户出现在「WebDAV 账户」行的菜单里，行值也随之更新。
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Personal WebDAV')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'WebDAV 账户' }));
    const accountsMenu = await screen.findByRole('dialog', { name: 'WebDAV 账户' });
    expect(within(accountsMenu).getByText('Personal WebDAV')).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('save_webdav_account', { input: {
      id: 'dav-f4feca5a', label: 'Personal WebDAV', baseUrl: 'https://dav.example.com/Yomika', username: 'reader', credential: 'secret-token',
    } });
    expect(adapter).toHaveBeenCalledWith('create_sync_key', { accountId: 'dav-f4feca5a' });
    expect(screen.queryByText('secret-token')).not.toBeInTheDocument();
  });

  it('runs a configured scope with the native device identity', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_webdav_accounts') return { ok: true, value: [account] };
      if (command === 'sync_webdav_scope') return { ok: true, value: 3 };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSync();

    await user.click(await screen.findByRole('button', { name: 'WebDAV 账户' }));
    await user.click(await screen.findByRole('button', { name: '立即同步' }));

    expect(adapter).toHaveBeenCalledWith('sync_webdav_scope', { accountId: 'personal', scopeId: 'scope-a' });
    expect(await screen.findByText('已同步 3 项变更（含从远端拉回的部分）')).toBeInTheDocument();
  });
});
