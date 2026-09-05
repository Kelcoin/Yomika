import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

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
      if (command === 'check_eh_login_health') return { ok: true, value: { loggedIn: true } };
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
      id: 'eh-1234', label: 'E-Hentai 1234', host: 'exhentai.org',
      cookie: `ipb_member_id=1234; ipb_pass_hash=${hash}; igneous=abcdef1234`,
    } });
    expect(await screen.findByText('E-Hentai 1234')).toBeInTheDocument();
    expect(screen.queryByText(hash)).not.toBeInTheDocument();
    // Saving verifies straight away, so the row does not sit at 未验证 leaving
    // the user to guess whether the credentials work.
    expect(await screen.findByText('已验证')).toBeInTheDocument();
  });

  it('signs in with a username and password and stores the returned cookie', async () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const saved = { id: 'eh-77', label: 'E-Hentai 77', host: 'e-hentai.org', cookieRef: 'keyring://eh-77', isActive: true, status: 'unverified', createdAt: '2026-08-28', updatedAt: '2026-08-28' };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'login_eh_account') return { ok: true, value: `ipb_member_id=77; ipb_pass_hash=${hash}` };
      if (command === 'save_eh_account') return { ok: true, value: saved };
      if (command === 'check_eh_login_health') return { ok: true, value: { loggedIn: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderEhRoute();

    await user.type(await screen.findByLabelText('用户名'), 'reader');
    await user.type(screen.getByLabelText('密码'), 'secret-password');
    await user.click(screen.getByRole('button', { name: '登录 E-Hentai' }));

    expect(adapter).toHaveBeenCalledWith('login_eh_account', { username: 'reader', password: 'secret-password' });
    expect(await screen.findByText('E-Hentai 77')).toBeInTheDocument();
    expect(screen.queryByText('secret-password')).not.toBeInTheDocument();
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

  it('scopes searches to the active account', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: accounts };
      if (command === 'search_eh_galleries') return { ok: true, value: { galleries: [] } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderEhRoute();

    await screen.findByText('EH Main');
    await user.type(screen.getByRole('searchbox', { name: '搜索 E-Hentai' }), 'test query');
    await user.keyboard('{Enter}');

    expect(adapter).toHaveBeenCalledWith('search_eh_galleries', {
      accountId: 'eh-a',
      query: 'test query',
      params: {},
    });
  });

  it('switches the active account in the visible account list', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: accounts };
      if (command === 'set_active_eh_account') return { ok: true, value: undefined };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderEhRoute();

    await user.click(await screen.findByRole('button', { name: '切换到EH Backup' }));

    expect(adapter).toHaveBeenCalledWith('set_active_eh_account', { accountId: 'eh-b' });
    const backup = screen.getByText('EH Backup').closest('li');
    expect(backup).not.toBeNull();
    expect(within(backup!).getByLabelText('当前活跃')).toBeInTheDocument();
  });

  it('updates the target account status after a successful health check', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: accounts };
      if (command === 'check_eh_login_health') return { ok: true, value: { loggedIn: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const user = userEvent.setup();
    renderEhRoute();

    await user.click(await screen.findByRole('button', { name: '检查EH Backup' }));

    expect(adapter).toHaveBeenCalledWith('check_eh_login_health', { accountId: 'eh-b' });
    const backup = screen.getByText('EH Backup').closest('li');
    expect(backup).not.toBeNull();
    expect(within(backup!).getByText('已验证')).toBeInTheDocument();
  });
});
