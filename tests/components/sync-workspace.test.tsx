import { render, screen } from '@testing-library/react';
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
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_webdav_accounts') return { ok: true, value: [account] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderSync();

    expect(await screen.findByRole('heading', { name: 'Personal WebDAV' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '同步尚未配置' })).not.toBeInTheDocument();
    expect(await screen.findByRole('status', { name: '同步状态' })).toHaveTextContent('已配置');
  });

  it('saves a WebDAV account and creates its local encryption key', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'save_webdav_account') return { ok: true, value: account };
      if (command === 'create_sync_key') return { ok: true, value: String(args?.accountId) };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSync();

    await user.type(await screen.findByLabelText('账户 ID'), 'personal');
    await user.type(screen.getByLabelText('名称'), 'Personal WebDAV');
    await user.type(screen.getByLabelText('WebDAV 地址'), 'https://dav.example.com/Yomika');
    await user.type(screen.getByLabelText('用户名'), 'reader');
    await user.type(screen.getByLabelText('密码或 Token'), 'secret-token');
    await user.click(screen.getByRole('button', { name: '保存同步账户' }));

    expect(await screen.findByRole('heading', { name: 'Personal WebDAV' })).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('save_webdav_account', { input: {
      id: 'personal', label: 'Personal WebDAV', baseUrl: 'https://dav.example.com/Yomika', username: 'reader', credential: 'secret-token',
    } });
    expect(adapter).toHaveBeenCalledWith('create_sync_key', { accountId: 'personal' });
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

    await user.click(await screen.findByRole('button', { name: '立即同步' }));

    expect(adapter).toHaveBeenCalledWith('sync_webdav_scope', { accountId: 'personal', scopeId: 'scope-a' });
    expect(await screen.findByText('已同步 3 项本地变更')).toBeInTheDocument();
  });
});
