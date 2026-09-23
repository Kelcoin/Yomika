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

describe('sync settings', () => {
  it('shows configured WebDAV accounts and real status', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: [account] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderSync();

    // 同步区与其它设置同构：行报告当前状态，账户在行的悬浮菜单里。
    // 设置页按路由懒加载，全量并行跑时首个转换会超过默认 1s 等待。
    const row = await screen.findByRole('button', { name: '同步账户' }, { timeout: 10_000 });
    await user.click(row);
    const accountsMenu = await screen.findByRole('dialog', { name: '同步账户' });
    expect(await within(accountsMenu).findByText('Personal WebDAV')).toBeInTheDocument();
    expect(within(accountsMenu).getByText('https://dav.example.com/Yomika')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '同步状态' })).toHaveTextContent('已配置');
  });

  it('saves an account, collapses the form, and edits it without retyping the password', async () => {
    const user = userEvent.setup();
    // 保存后原生侧会写库并把它置为生效，界面紧跟一次 list：这里跟着模拟同一件事。
    let stored: Array<Record<string, unknown>> = [];
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers' || command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: stored };
      if (command === 'sync_account_credential') return { ok: true, value: 'secret-token' };
      if (command === 'save_sync_account') {
        const input = args?.input as { id: string; label: string; kind: string; baseUrl: string };
        const saved = { ...account, id: input.id, label: input.label, kind: input.kind, baseUrl: input.baseUrl, active: true };
        stored = [saved];
        return { ok: true, value: saved };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSync();

    await user.click(await screen.findByRole('button', { name: '同步账户' }, { timeout: 10_000 }));
    const setupMenu = screen.getByRole('dialog', { name: '同步账户' });
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
    expect(adapter).toHaveBeenCalledWith('save_sync_account', { input: {
      id: 'dav-f4feca5a', kind: 'webdav', label: 'Personal WebDAV', baseUrl: 'https://dav.example.com/Yomika', bucket: '', username: 'reader', credential: 'secret-token',
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
    expect(adapter).toHaveBeenCalledWith('save_sync_account', { input: {
      id: 'dav-f4feca5a', kind: 'webdav', label: 'Renamed WebDAV', baseUrl: 'https://dav.example.com/Yomika', bucket: '', username: 'reader', credential: 'secret-token',
    } });
    expect(screen.queryByText('secret-token')).not.toBeInTheDocument();
  });

  it('reopens the menu on the account row instead of the abandoned edit form', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: [account] };
      if (command === 'sync_account_credential') return { ok: true, value: 'secret-token' };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderSync();

    const row = await screen.findByRole('button', { name: '同步账户' }, { timeout: 10_000 });
    await user.click(row);
    const menu = await screen.findByRole('dialog', { name: '同步账户' });
    await user.click(within(menu).getByRole('button', { name: '编辑' }));
    await waitFor(() => expect(within(menu).getByLabelText('名称')).toHaveValue('Personal WebDAV'));
    expect(within(menu).getByLabelText('密码或 Token')).toHaveValue('secret-token');

    // 关掉菜单就是放弃这次编辑：再打开是账号行加三个动作，而不是上次没收起的表单，
    // 已回填的口令也不该留在折叠的表单里。
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '同步账户' })).toBeNull();
    await user.click(row);
    const reopened = await screen.findByRole('dialog', { name: '同步账户' });
    expect(within(reopened).getByLabelText('名称')).toHaveValue('');
    expect(within(reopened).getByLabelText('密码或 Token')).toHaveValue('');
    expect(within(reopened).getByLabelText('名称').closest('.sync-collapsible')).not.toHaveClass('is-open');
    expect(within(reopened).getByRole('button', { name: '立即同步' }).closest('.sync-collapsible')).toHaveClass('is-open');
  });

  it('saves the sync scope from its own row, not from the account form', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: [account] };
      if (command === 'save_sync_scope') {
        const scope = String(args?.syncScope ?? '');
        return { ok: true, value: { ...account, syncScope: scope } };
      }
      if (command === 'save_sync_account') return { ok: true, value: account };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSync();

    // 范围是独立一行：值直接说自己现在同步什么。
    const row = await screen.findByRole('button', { name: '同步范围' }, { timeout: 10_000 });
    expect(row).toHaveTextContent('阅读进度');
    await user.click(row);
    const menu = await screen.findByRole('dialog', { name: '同步范围' });

    // 行与「底栏项目」同一种控件：整行是复选框，勾一下就写回账户。
    const watchlist = within(menu).getByRole('checkbox', { name: '同步待看' });
    expect(watchlist).toHaveClass('settings-menu-check', 'is-checked');
    await user.click(watchlist);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_sync_scope', {
      accountId: 'personal',
      syncScope: '["progress","history","search_presets","dedup"]',
    }));
    // 应用设置是可勾的记录/设置类里后补的一项：勾上就写回去。
    const appSettings = within(menu).getByRole('checkbox', { name: '同步应用设置' });
    expect(appSettings).not.toHaveClass('is-checked');
    await user.click(appSettings);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_sync_scope', {
      accountId: 'personal',
      syncScope: '["progress","history","search_presets","dedup","app_settings"]',
    }));

    // 凭据在这里连行都没有：API Key、Cookie 与同步口令在系统凭据库，服务器地址与
    // 账户名在别的设备上也不成立（没有 Key 连不上、没有 Cookie 要重新登录）。它们
    // 只随「导入导出范围」与那份口令加密的文件走，所以这里能断言的只有「没有」——
    // 一行封着的凭据类都曾经让人以为「勾上就能同步」。
    expect(within(menu).queryByRole('checkbox', { name: '同步账户与服务器' })).toBeNull();
    expect(within(menu).queryByRole('checkbox', { name: '同步LRR 服务器' })).toBeNull();
    expect(within(menu).queryByRole('checkbox', { name: '同步E-H 账户' })).toBeNull();
    expect(within(menu).queryByRole('checkbox', { name: '同步凭据' })).toBeNull();
    // 留下的六个全是记录与设置：没有一个是封着的。
    expect(within(menu).getAllByRole('checkbox').filter((item) => item.hasAttribute('disabled'))).toEqual([]);
    expect(menu).toHaveTextContent('只在本机');

    // 账户表单里不再有范围：它只管账户本身。
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: '同步账户' }));
    const accountMenu = await screen.findByRole('dialog', { name: '同步账户' });
    expect(within(accountMenu).queryByRole('checkbox')).toBeNull();
    expect(within(accountMenu).queryByText('同步范围')).toBeNull();
  });

  it('keeps the two kinds in separate accounts and switches which one is active', async () => {
    const user = userEvent.setup();
    // 两份账户分开存：保存哪套哪套生效，另一套留着待命。
    let stored: Array<Record<string, unknown>> = [
      { ...account, kind: 'webdav', label: '坚果云', baseUrl: 'https://dav.jianguoyun.com/dav', username: 'me@example.com', active: true },
    ];
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: stored };
      if (command === 'sync_account_credential') return { ok: true, value: 'stored-secret' };
      if (command === 'save_sync_account') {
        const input = args?.input as Record<string, unknown>;
        const saved = {
          ...account, ...input,
          credentialRef: 'ref-a', syncScope: account.syncScope, status: 'ok',
          lastProbeAt: null, lastSyncAt: null, lastErrorCode: null, active: true,
        };
        stored = [saved, ...stored.filter((entry) => entry.kind !== input.kind).map((entry) => ({ ...entry, active: false }))];
        return { ok: true, value: saved };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSync();

    // 生效的是 WebDAV 那套。
    const row = await screen.findByRole('button', { name: '同步账户' }, { timeout: 10_000 });
    expect(row).toHaveTextContent('坚果云');
    await user.click(row);
    const menu = await screen.findByRole('dialog', { name: '同步账户' });
    await user.click(within(menu).getByRole('button', { name: '编辑' }));
    expect(within(menu).getByLabelText('WebDAV 地址')).toHaveValue('https://dav.jianguoyun.com/dav');

    // 切到对象存储：字段换成端点/桶/Access Key，而且**不留** WebDAV 那套的值。
    await user.click(within(menu).getByRole('button', { name: '对象存储' }));
    expect(within(menu).queryByLabelText('WebDAV 地址')).toBeNull();
    expect(within(menu).getByLabelText('端点')).toHaveValue('');
    expect(within(menu).getByLabelText('存储桶')).toHaveValue('');
    expect(within(menu).getByLabelText('Access Key ID')).toHaveValue('');
    expect(within(menu).getByLabelText('Secret Access Key')).toHaveValue('');
    // 另一套还在，只是待命——文案说清楚，免得以为被覆盖了。
    expect(within(menu).getByText(/WebDAV 账户「坚果云」已保存待命/)).toBeInTheDocument();

    await user.type(within(menu).getByLabelText('名称'), 'R2');
    await user.type(within(menu).getByLabelText('端点'), 'https://acct.r2.cloudflarestorage.com');
    await user.type(within(menu).getByLabelText('存储桶'), 'yomika');
    await user.type(within(menu).getByLabelText('Access Key ID'), 'ACCESSKEY');
    await user.type(within(menu).getByLabelText('Secret Access Key'), 'secret-key');
    await user.click(within(menu).getByRole('button', { name: '保存' }));
    expect(adapter).toHaveBeenCalledWith('save_sync_account', { input: expect.objectContaining({ kind: 's3', label: 'R2', bucket: 'yomika' }) });

    // 生效的换成对象存储那套，WebDAV 那套不再露面。
    expect(await screen.findByText('对象存储 账户已保存并启用')).toBeInTheDocument();
    const switched = await screen.findByRole('button', { name: '同步账户' });
    expect(switched).toHaveTextContent('R2');
    expect(switched).not.toHaveTextContent('坚果云');

    // 切回去：WebDAV 那套的值原样还在。
    await user.click(switched);
    const reopened = await screen.findByRole('dialog', { name: '同步账户' });
    await user.click(within(reopened).getByRole('button', { name: '编辑' }));
    await user.click(within(reopened).getByRole('button', { name: 'WebDAV' }));
    expect(within(reopened).getByLabelText('WebDAV 地址')).toHaveValue('https://dav.jianguoyun.com/dav');
    expect(within(reopened).getByText(/对象存储 账户「R2」已保存待命/)).toBeInTheDocument();
  });

  it('tests the form as typed, without saving it first', async () => {
    const user = userEvent.setup();
    const calls: Array<Record<string, unknown>> = [];
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: [] };
      if (command === 'test_sync_account') {
        calls.push(args?.input as Record<string, unknown>);
        return { ok: true, value: '连接正常：远端还没有同步文档，第一次同步会创建它' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSync();

    await user.click(await screen.findByRole('button', { name: '同步账户' }, { timeout: 10_000 }));
    const menu = await screen.findByRole('dialog', { name: '同步账户' });
    // 还没填完就点测试：命令被拒的提示走错误那条路。
    await user.click(within(menu).getByRole('button', { name: '测试' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('test_sync_account', expect.anything()));

    // 填好再测：送的是表单里当下的值，不需要先保存。
    await user.type(within(menu).getByLabelText('名称'), 'R2');
    await user.click(within(menu).getByRole('button', { name: '对象存储' }));
    await user.type(within(menu).getByLabelText('端点'), 'https://acct.r2.cloudflarestorage.com');
    await user.type(within(menu).getByLabelText('存储桶'), 'yomika');
    await user.type(within(menu).getByLabelText('Access Key ID'), 'ACCESSKEY');
    await user.type(within(menu).getByLabelText('Secret Access Key'), 'secret-key');
    await user.click(within(menu).getByRole('button', { name: '测试' }));

    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({
      kind: 's3',
      label: 'R2',
      baseUrl: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'yomika',
      username: 'ACCESSKEY',
      credential: 'secret-key',
    }));
    // 结论用 toast 报出来，账户并没有被保存。
    await vi.waitFor(() => {
      const toasts = [...document.querySelectorAll('.toast, [role="status"]')].map((el) => el.textContent ?? '');
      if (!toasts.some((text) => text.includes('连接正常'))) throw new Error(`no toast yet: ${JSON.stringify(toasts)}`);
    });
    expect(adapter).not.toHaveBeenCalledWith('save_sync_account', expect.anything());
  });

  it('runs a configured scope with the native device identity', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: [account] };
      if (command === 'sync_remote_scope') return { ok: true, value: 3 };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSync();

    await user.click(await screen.findByRole('button', { name: '同步账户' }));
    await user.click(await screen.findByRole('button', { name: '立即同步' }));

    expect(adapter).toHaveBeenCalledWith('sync_remote_scope', { accountId: 'personal', scopeId: 'scope-a' });
    expect(await screen.findByText('已同步 3 项变更（含从远端拉回的部分）')).toBeInTheDocument();
  });
});
