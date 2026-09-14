import { render, screen, within } from '@testing-library/react';
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
