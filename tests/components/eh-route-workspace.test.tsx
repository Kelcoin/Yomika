import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(() => {
  resetInvokeAdapterForTests();
  window.localStorage.clear();
});

const accounts = [
  { id: 'eh-a', label: 'EH Main', host: 'e-hentai.org', cookieRef: 'ref-a', isActive: true, status: 'verified', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  { id: 'eh-b', label: 'EH Backup', host: 'exhentai.org', cookieRef: 'ref-b', isActive: false, status: 'unverified', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
] as const;

function renderEhRoute() {
  return render(
    <MemoryRouter initialEntries={['/eh']}>
      <App />
    </MemoryRouter>,
  );
}

describe('EH route workspace', () => {
  it('ignores malformed cached health and completes the fresh account load', async () => {
    window.localStorage.setItem('yomika.eh.health.v1', JSON.stringify({
      'eh-a': { checkedAt: 1, username: 'Broken cache', assets: { gp: 42, credits: '', hath: '' } },
    }));
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [accounts[0]] };
      if (command === 'check_eh_login_health') return { ok: true, value: { loggedIn: true, username: 'Fresh name', assets: { gp: '42', credits: '', hath: '' }, exhentaiAccess: true } };
      return { ok: true, value: null };
    });
    renderEhRoute();
    expect(await screen.findByText('Fresh name')).toBeInTheDocument();
    expect(screen.getByText(/GP 42/)).toBeInTheDocument();
  });

  it.each(['rename', 'export'] as const)('discards a pending %s result after logout and reimport', async (operation) => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [accounts[0]] };
      if (command === 'check_eh_login_health') return { ok: false, error: { code: 'EH_NETWORK', message: 'offline', retryable: true } };
      if (command === 'set_eh_username_hint' || command === 'read_eh_account_cookie') return pending;
      if (command === 'save_eh_account') return { ok: true, value: { ...accounts[0], usernameHint: 'New session' } };
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderEhRoute();
    if (operation === 'rename') {
      await user.click(await screen.findByRole('button', { name: /编辑 .* 的账户名/ }));
      await user.type(screen.getByRole('textbox', { name: '账户名' }), 'Old draft{Enter}');
    } else await user.click(await screen.findByRole('button', { name: '导出 Cookie' }));
    await user.click(screen.getByRole('button', { name: '退出登录' }));
    await user.click(await screen.findByRole('tab', { name: 'Cookie 导入' }));
    await user.type(screen.getByLabelText('Cookie'), 'ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90');
    await user.click(screen.getByRole('button', { name: '保存 Cookie' }));
    await act(async () => finish({ ok: true, value: operation === 'rename' ? null : 'ipb_member_id=1; ipb_pass_hash=old' }));
    expect(await screen.findByText('New session')).toBeInTheDocument();
    expect(screen.queryByText('账户名已更新')).not.toBeInTheDocument();
    expect(adapter.mock.calls.map(([command]) => command)).not.toContain('write_clipboard_text');
  });

  it('does not apply an old login probe to the same account after logout and reimport', async () => {
    let finishHealth!: (value: unknown) => void;
    const health = new Promise((resolve) => { finishHealth = resolve; });
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [accounts[0]] };
      if (command === 'check_eh_login_health') return health;
      if (command === 'save_eh_account') return { ok: true, value: { ...accounts[0], usernameHint: 'New session' } };
      return { ok: true, value: null };
    });
    const user = userEvent.setup();
    renderEhRoute();
    await user.click(await screen.findByRole('button', { name: '退出登录' }));
    await user.click(await screen.findByRole('tab', { name: 'Cookie 导入' }));
    await user.type(screen.getByLabelText('Cookie'), 'ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90');
    await user.click(screen.getByRole('button', { name: '保存 Cookie' }));
    expect(await screen.findByText('New session')).toBeInTheDocument();
    await act(async () => finishHealth({ ok: true, value: { loggedIn: true, username: 'Old session', assets: { gp: '999', credits: '', hath: '' }, exhentaiAccess: false } }));
    expect(screen.queryByText(/GP 999/)).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('yomika.eh.health.v1') ?? '{}')).toEqual({});
  });

  it('shows an account read failure with retry instead of an empty login form', async () => {
    let reads = 0;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_eh_accounts') return ++reads === 1
        ? { ok: false, error: { code: 'LOCAL_DATABASE', message: '账户读取失败', retryable: true } }
        : { ok: true, value: [{ ...accounts[0], usernameHint: 'Saved account' }] };
      return { ok: true, value: null };
    });
    const user = userEvent.setup();
    renderEhRoute();
    expect(await screen.findByRole('alert')).toHaveTextContent('账户读取失败');
    expect(screen.queryByRole('button', { name: '登录 E-Hentai' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新读取账户' }));
    expect(await screen.findByText('Saved account')).toBeInTheDocument();
  });

  it('keeps a manually edited name when the startup health probe finishes later', async () => {
    let finishHealth!: (value: unknown) => void;
    const health = new Promise((resolve) => { finishHealth = resolve; });
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [accounts[0]] };
      if (command === 'check_eh_login_health') return health;
      if (command === 'set_eh_username_hint') return { ok: true, value: null };
      return { ok: true, value: null };
    });
    const user = userEvent.setup();
    renderEhRoute();
    await user.click(await screen.findByRole('button', { name: /编辑 .* 的账户名/ }));
    await user.type(screen.getByRole('textbox', { name: '账户名' }), 'My name{Enter}');
    expect(await screen.findByText('My name')).toBeInTheDocument();
    await act(async () => finishHealth({ ok: true, value: { loggedIn: true, username: 'Remote name', assets: { gp: '42', credits: '', hath: '' }, exhentaiAccess: true } }));
    expect(screen.getByText('My name')).toBeInTheDocument();
    expect(screen.getByText(/GP 42/)).toBeInTheDocument();
    expect(screen.queryByText('Remote name')).not.toBeInTheDocument();
  });

  it('preserves a saved display name instead of a cached or freshly probed name', async () => {
    window.localStorage.setItem('yomika.eh.health.v1', JSON.stringify({
      'eh-a': { checkedAt: Date.now(), username: 'Old cached name', assets: { gp: '', credits: '', hath: '' } },
    }));
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [{ ...accounts[0], usernameHint: 'My name' }] };
      if (command === 'check_eh_login_health') return { ok: true, value: { loggedIn: true, username: 'Remote name', assets: { gp: '42', credits: '', hath: '' }, exhentaiAccess: true } };
      return { ok: true, value: null };
    });
    renderEhRoute();
    expect(await screen.findByText(/GP 42/)).toBeInTheDocument();
    expect(screen.getByText('My name')).toBeInTheDocument();
    expect(screen.queryByText('Remote name')).not.toBeInTheDocument();
    expect(screen.queryByText('Old cached name')).not.toBeInTheDocument();
  });

  it('derives the account from a pasted cookie instead of asking for ids', async () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const saved = { id: 'eh-1234', label: 'E-Hentai 1234', host: 'exhentai.org', cookieRef: 'keyring://eh-1234', isActive: true, status: 'unverified', createdAt: '2026-08-28', updatedAt: '2026-08-28' };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'save_eh_account') return { ok: true, value: saved };
      if (command === 'fetch_eh_forum_username') return { ok: true, value: 'Forum Reader' };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderEhRoute();

    await user.click(await screen.findByRole('tab', { name: 'Cookie 导入' }));
    await user.type(screen.getByLabelText('Cookie'), `ipb_member_id=1234; ipb_pass_hash=${hash}; igneous=abcdef1234`);
    await user.click(screen.getByRole('button', { name: '保存 Cookie' }));

    // The site is derived from igneous, the id from the member id.
    expect(adapter).toHaveBeenCalledWith('save_eh_account', { input: {
      id: 'eh-1234', label: 'E-Hentai 账户', host: 'exhentai.org',
      cookie: `ipb_member_id=1234; ipb_pass_hash=${hash}; igneous=abcdef1234`,
    } });
    // A fresh row has no display name yet, so the forums profile lookup runs
    // right after the save and the card picks the name up in place.
    expect(adapter).toHaveBeenCalledWith('fetch_eh_forum_username', { accountId: 'eh-1234' });
    expect(await screen.findByText('Forum Reader')).toBeInTheDocument();
    expect(screen.queryByText(hash)).not.toBeInTheDocument();
    expect(screen.queryByText('已验证')).not.toBeInTheDocument();
    expect(screen.queryByText('未验证')).not.toBeInTheDocument();
    expect(adapter.mock.calls.map(([command]) => command)).not.toContain('check_eh_login_health');
  });

  it('opens the in-app sign-in sheet on mobile and picks the cookie up by polling', async () => {
    // Android 上应用自己的 webview 就是 activity 的内容视图：另开窗口会把它顶掉，顶层导航
    // 等于把应用整个换掉（两条都闪退）。所以登录页画在原生侧的另一层 WebView 上——应用原地
    // 不动，结果在这里轮询领回来。
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    let polls = 0;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'platform_capabilities') return { ok: true, value: { platform: 'android', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: false } };
      if (command === 'start_eh_in_app_login') return { ok: true, value: null };
      if (command === 'take_eh_in_app_login') {
        polls += 1;
        // 第一轮还没有会话（人还在登录页上），第二轮才有——轮询确实在轮。
        return { ok: true, value: polls > 1 ? `ipb_member_id=42; ipb_pass_hash=${hash}` : null };
      }
      if (command === 'cancel_eh_in_app_login') return { ok: true, value: null };
      if (command === 'save_eh_account') return { ok: true, value: { id: 'eh-42', label: 'E-Hentai 42', host: 'e-hentai.org', cookieRef: 'keyring://eh-42', isActive: true, status: 'verified', createdAt: '2026-09-23', updatedAt: '2026-09-23' } };
      if (command === 'fetch_eh_forum_username') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async () => null } });
    const user = userEvent.setup();
    try {
      renderEhRoute();

      // 三个登录方式都在；点「网页登录」给的是应用内那条路，不是另开窗口。
      await user.click(await screen.findByRole('tab', { name: /网页登录/ }));
      expect(screen.getByText(/在应用内的登录页完成登录/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /打开登录页面/ }));
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('start_eh_in_app_login', {}));
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_eh_account', {
        input: expect.objectContaining({ cookie: `ipb_member_id=42; ipb_pass_hash=${hash}` }),
      }), { timeout: 5_000 });
      expect(adapter.mock.calls.map(([command]) => command)).not.toContain('open_eh_login_window');
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('picks up the in-app sign-in result after the app comes back', async () => {
    // 顶层导航那条路（桌面、iOS）登录期间应用整页被登录页替换掉，回来时是重新加载：结果由
    // 原生侧存着，这里重载后领一次。Android 上是原生浮层，这条兜底也不会把结果丢在地上。
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'take_eh_in_app_login') return { ok: true, value: `ipb_member_id=42; ipb_pass_hash=${hash}` };
      if (command === 'save_eh_account') return { ok: true, value: { id: 'eh-42', label: 'E-Hentai 42', host: 'e-hentai.org', cookieRef: 'keyring://eh-42', isActive: true, status: 'verified', createdAt: '2026-09-23', updatedAt: '2026-09-23' } };
      if (command === 'fetch_eh_forum_username') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderEhRoute();

    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_eh_account', {
      input: expect.objectContaining({ cookie: `ipb_member_id=42; ipb_pass_hash=${hash}` }),
    }));
    // 领走即清：同一个结果不会再被保存第二次。
    expect(adapter.mock.calls.filter(([command]) => command === 'take_eh_in_app_login')).toHaveLength(1);
  });

  it('opens the sign-in window on the desktop and reads its cookie jar', async () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'platform_capabilities') return { ok: true, value: { platform: 'windows', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: false } };
      if (command === 'open_eh_login_window') return { ok: true, value: null };
      if (command === 'capture_eh_login_cookies') return { ok: true, value: `ipb_member_id=7; ipb_pass_hash=${hash}` };
      if (command === 'close_eh_login_window') return { ok: true, value: null };
      if (command === 'save_eh_account') return { ok: true, value: { id: 'eh-7', label: 'E-Hentai 7', host: 'e-hentai.org', cookieRef: 'keyring://eh-7', isActive: true, status: 'verified', createdAt: '2026-09-23', updatedAt: '2026-09-23' } };
      if (command === 'fetch_eh_forum_username') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async () => null } });
    const user = userEvent.setup();
    try {
      renderEhRoute();

      await user.click(await screen.findByRole('tab', { name: /网页登录/ }));
      await user.click(screen.getByRole('button', { name: /打开登录页面/ }));

      await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('open_eh_login_window', {}));
      // 窗口里的 Cookie 一到手就关掉窗口并保存，读的是那个窗口自己的 Cookie 罐。
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('capture_eh_login_cookies', {}), { timeout: 20_000 });
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('close_eh_login_window', {}), { timeout: 20_000 });
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_eh_account', {
        input: expect.objectContaining({ cookie: `ipb_member_id=7; ipb_pass_hash=${hash}` }),
      }), { timeout: 20_000 });
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  }, 30_000);

  it('signs in with a username and password and stores the returned cookie', async () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const saved = { id: 'eh-77', label: 'E-Hentai 77', host: 'e-hentai.org', cookieRef: 'keyring://eh-77', isActive: true, status: 'unverified', createdAt: '2026-08-28', updatedAt: '2026-08-28' };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'login_eh_account') return { ok: true, value: `ipb_member_id=77; ipb_pass_hash=${hash}` };
      if (command === 'save_eh_account') return { ok: true, value: saved };
      if (command === 'fetch_eh_forum_username') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderEhRoute();

    await user.type(await screen.findByLabelText('用户名'), 'reader');
    await user.type(screen.getByLabelText('密码'), 'secret-password');
    await user.click(screen.getByRole('button', { name: '登录 E-Hentai' }));

    expect(adapter).toHaveBeenCalledWith('login_eh_account', { username: 'reader', password: 'secret-password' });
    // 未记录显示名时默认显示为「E 站用户」。
    expect(await screen.findByText('E 站用户')).toBeInTheDocument();
    expect(screen.queryByText('secret-password')).not.toBeInTheDocument();
    expect(adapter.mock.calls.map(([command]) => command)).not.toContain('check_eh_login_health');
  });

  it('fills the name after a save without ever running a health probe', async () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const saved = { id: 'eh-88', label: 'E-Hentai 88', host: 'e-hentai.org', cookieRef: 'keyring://eh-88', isActive: true, status: 'unverified', createdAt: '2026-08-28', updatedAt: '2026-08-28' };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'save_eh_account') return { ok: true, value: saved };
      // A web login stashes its clearance during the capture polls, so the
      // lookup right after the save is a plain HTTP replay. When even that
      // cannot name the account it degrades to null — never a health probe.
      if (command === 'fetch_eh_forum_username') return { ok: true, value: 'Named Later' };
      if (command === 'check_eh_login_health') throw new Error('save must not run a health probe');
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderEhRoute();

    await user.click(await screen.findByRole('tab', { name: 'Cookie 导入' }));
    await user.type(screen.getByLabelText('Cookie'), `ipb_member_id=88; ipb_pass_hash=${hash}`);
    await user.click(screen.getByRole('button', { name: '保存 Cookie' }));

    expect(adapter).toHaveBeenCalledWith('fetch_eh_forum_username', { accountId: 'eh-88' });
    expect(await screen.findByText('Named Later')).toBeInTheDocument();
    expect(adapter.mock.calls.map(([command]) => command)).not.toContain('check_eh_login_health');
  });

  it('reports a rejected sign-in as rejected, not as an expired session', async () => {
    // A first sign-in cannot have an expired session and has no cookie to
    // reconfigure. The native side answers with the reason, and the sign-in form
    // shows it instead of running it through the generic code map.
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'login_eh_account') {
        return { ok: false, error: { code: 'EH_LOGIN_REJECTED', message: '用户名或密码不正确', retryable: false } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const user = userEvent.setup();
    renderEhRoute();

    await user.type(await screen.findByLabelText('用户名'), 'reader');
    await user.type(screen.getByLabelText('密码'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: '登录 E-Hentai' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码不正确');
    expect(screen.queryByText(/登录已失效/)).not.toBeInTheDocument();
    expect(screen.queryByText(/重新配置 Cookie/)).not.toBeInTheDocument();
  });

  it('updates the target account status after a successful health check', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: accounts };
      if (command === 'check_eh_login_health') return { ok: true, value: { loggedIn: true, username: 'Reader', assets: { gp: '12,345', credits: '6,789', hath: '42' }, exhentaiAccess: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderEhRoute();

    // 每个账户卡片底部都有自己的操作列表；第二张卡片属于 EH Backup。
    const backupCheck = (await screen.findAllByRole('button', { name: '检查登录状态' }))[1]!;
    await user.click(backupCheck);

    expect(adapter).toHaveBeenCalledWith('check_eh_login_health', { accountId: 'eh-b' });
    const backup = backupCheck.closest('li');
    expect(backup).not.toBeNull();
    expect(within(backup!).queryByText('已验证')).not.toBeInTheDocument();
    expect(within(backup!).getByText('Reader')).toBeInTheDocument();
    expect(within(backup!).getByText(/GP 12,345/)).toBeInTheDocument();
    expect(within(backup!).getByText(/EX 可访问/)).toBeInTheDocument();
  });

  it('does not retain a stale negative ExHentai result when the fresh probe is unknown', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [{ ...accounts[0], exhentaiAccess: false }] };
      if (command === 'check_eh_login_health') return { ok: true, value: { loggedIn: true, username: 'Reader', assets: { gp: '', credits: '', hath: '' }, exhentaiAccess: null } };
      return { ok: true, value: undefined };
    });

    renderEhRoute();

    expect(await screen.findByText('Reader')).toBeInTheDocument();
    expect(screen.getByText('检测 EX 中…')).toBeInTheDocument();
    expect(screen.queryByText('EX 不可访问')).toBeNull();
  });

  it('uses cached health when SQLite only has empty default values', async () => {
    window.localStorage.setItem('yomika.eh.health.v1', JSON.stringify({
      'eh-a': {
        checkedAt: Date.now(),
        username: 'Cached Reader',
        assets: { gp: '12,345', credits: '6,789', hath: '42' },
        exhentaiAccess: true,
      },
    }));
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_eh_accounts') {
        return {
          ok: true,
          value: [{ ...accounts[0], status: 'error', assets: { gp: '', credits: '', hath: '' }, exhentaiAccess: false }],
        };
      }
      if (command === 'check_eh_login_health') {
        return { ok: false, error: { code: 'EH_NETWORK', message: 'offline', retryable: true } };
      }
      return { ok: true, value: undefined };
    });

    renderEhRoute();

    expect(await screen.findByText('Cached Reader')).toBeInTheDocument();
    expect(screen.getByText(/GP 12,345/)).toBeInTheDocument();
    expect(screen.getByText(/EX 可访问/)).toBeInTheDocument();
  });
});
