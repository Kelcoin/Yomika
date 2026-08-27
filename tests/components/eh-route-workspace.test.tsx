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
    await user.type(screen.getByPlaceholderText('搜索 E-Hentai...'), 'test query');
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
