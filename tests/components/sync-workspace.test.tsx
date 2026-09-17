import { render, screen, waitFor, within } from '@testing-library/react';
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
  syncScope: '["progress","history","watchlist","search_presets","dedup"]',
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

  it('saves an account, collapses the form, and edits it without retyping the password', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers' || command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      if (command === 'webdav_account_credential') return { ok: true, value: 'secret-token' };
      if (command === 'save_webdav_account') {
        const input = args?.input as { id: string; label: string };
        return { ok: true, value: { ...account, id: input.id, label: input.label } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSync();

    await user.click(await screen.findByRole('button', { name: 'WebDAV 账户' }, { timeout: 10_000 }));
    const setupMenu = screen.getByRole('dialog', { name: 'WebDAV 账户' });
    // 账户 ID 由名称自动派生，不再出现在表单里。
    expect(within(setupMenu).queryByLabelText('账户 ID')).toBeNull();
    await user.type(within(setupMenu).getByLabelText('名称'), 'Personal WebDAV');
    await user.type(within(setupMenu).getByLabelText('WebDAV 地址'), 'https://dav.example.com/Yomika');
    await user.type(within(setupMenu).getByLabelText('用户名'), 'reader');
    await user.type(within(setupMenu).getByLabelText('密码或 Token'), 'secret-token');
    await user.click(within(setupMenu).getByRole('button', { name: '保存' }));

    // 保存后账户出现在菜单里，表单收起——它以前一直摊在下面，加完也不收。
    // 收起是 .sync-collapsible 的 is-open 开关（内容留在 DOM 里做高度过渡）。
    expect(await within(setupMenu).findByText('Personal WebDAV')).toBeInTheDocument();
    expect(within(setupMenu).getByLabelText('名称').closest('.sync-collapsible')).not.toHaveClass('is-open');
    expect(adapter).toHaveBeenCalledWith('save_webdav_account', { input: {
      id: 'dav-f4feca5a', label: 'Personal WebDAV', baseUrl: 'https://dav.example.com/Yomika', username: 'reader', credential: 'secret-token',
      // 范围随账户一起保存；默认勾前五项。
      syncScope: '["progress","history","watchlist","search_presets","dedup"]',
    } });
    // 同步密钥不再由用户经手：保存账户就是全部准备。
    expect(adapter).not.toHaveBeenCalledWith('create_sync_key', expect.anything());

    // 「编辑」把表单带回来（is-open），字段预填，口令从凭据库读回来；留空保存＝不改。
    await user.click(within(setupMenu).getByRole('button', { name: '编辑' }));
    const label = await within(setupMenu).findByLabelText('名称');
    expect(label).toHaveValue('Personal WebDAV');
    expect(label.closest('.sync-collapsible')).toHaveClass('is-open');
    // 编辑时两个动作收起来。
    expect(within(setupMenu).getByRole('button', { name: '立即同步' }).closest('.sync-collapsible')).not.toHaveClass('is-open');
    // 焦点进入口令框时显示明文（type 由 password 切到 text）。
    const credential = within(setupMenu).getByLabelText('密码或 Token');
    await waitFor(() => expect(credential).toHaveValue('secret-token'));
    expect(credential).toHaveAttribute('type', 'password');
    await user.click(credential);
    expect(credential).toHaveAttribute('type', 'text');
    await user.clear(label);
    await user.type(label, 'Renamed WebDAV');
    await user.click(within(setupMenu).getByRole('button', { name: '保存' }));
    expect(adapter).toHaveBeenCalledWith('save_webdav_account', { input: {
      id: 'dav-f4feca5a', label: 'Renamed WebDAV', baseUrl: 'https://dav.example.com/Yomika', username: 'reader', credential: 'secret-token',
      syncScope: '["progress","history","watchlist","search_presets","dedup"]',
    } });
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
