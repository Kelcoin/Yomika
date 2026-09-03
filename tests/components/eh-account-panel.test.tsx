import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EhAccountPanel } from '../../src/components/EhAccountPanel';
import type { EhAccount } from '../../src/domain/eh';

describe('EhAccountPanel', () => {
  const sampleAccounts: EhAccount[] = [
    { id: 'eh-a', label: 'EH Main', host: 'e-hentai.org', cookieRef: 'ref-a', isActive: true, status: 'verified', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    { id: 'eh-b', label: 'EX Account', host: 'exhentai.org', cookieRef: 'ref-b', isActive: false, status: 'unverified', createdAt: '2026-02-01', updatedAt: '2026-02-01' },
  ];

  it('renders a list of EH accounts with labels and hosts', () => {
    render(<EhAccountPanel accounts={sampleAccounts} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('EH Main')).toBeDefined();
    expect(within(items[0]!).getByText('e-hentai.org')).toBeDefined();
    expect(within(items[1]!).getByText('EX Account')).toBeDefined();
  });

  it('marks the active account', () => {
    render(<EhAccountPanel accounts={sampleAccounts} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.className).toContain('active');
    expect(items[1]!.className).not.toContain('active');
  });

  it('displays verification status for each account', () => {
    render(<EhAccountPanel accounts={sampleAccounts} />);
    expect(screen.getByText('已验证')).toBeDefined();
    expect(screen.getByText('未验证')).toBeDefined();
  });

  it('calls onSwitch with account id when switch button clicked', async () => {
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    render(<EhAccountPanel accounts={sampleAccounts} onSwitch={onSwitch} />);
    const switchButton = screen.getByRole('button', { name: /切换到EX Account/ });
    await user.click(switchButton);
    expect(onSwitch).toHaveBeenCalledWith('eh-b');
  });

  it('calls onCheckHealth with account id when check button clicked', async () => {
    const onCheckHealth = vi.fn();
    const user = userEvent.setup();
    render(<EhAccountPanel accounts={sampleAccounts} onCheckHealth={onCheckHealth} />);
    const checkButtons = screen.getAllByRole('button', { name: /检查/ });
    await user.click(checkButtons[0]!);
    expect(onCheckHealth).toHaveBeenCalledWith('eh-a');
  });

  it('renders nothing but the panel when there are no accounts and no way to add one', () => {
    render(<EhAccountPanel accounts={[]} />);
    // No nagging copy: the panel is simply empty until a login path is offered.
    expect(screen.getByLabelText('E-Hentai 账户')).toBeEmptyDOMElement();
  });

  it('shows loading state', () => {
    render(<EhAccountPanel accounts={[]} loading />);
    expect(screen.getByText('正在读取账户…')).toBeDefined();
  });
});
