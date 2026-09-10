import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EhAccountPanel } from '../../src/components/EhAccountPanel';
import { ToastProvider } from '../../src/components/Toast';
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
    expect(within(items[0]!).getByText('正在检测 EXHENTAI 访问权限…')).toBeDefined();
    expect(within(items[0]!).getByText('正在更新资产…')).toBeDefined();
    expect(within(items[1]!).getByText('EX Account')).toBeDefined();
  });

  it('marks the active account', () => {
    render(<EhAccountPanel accounts={sampleAccounts} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.className).toContain('active');
    expect(items[1]!.className).not.toContain('active');
  });

  it('does not display verification labels in the account row', () => {
    render(<EhAccountPanel accounts={sampleAccounts} />);
    expect(screen.queryByText('已验证')).toBeNull();
    expect(screen.queryByText('未验证')).toBeNull();
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

  it('saves the account from a web sign-in, which is the only way past a challenge', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    const onBrowserLogin = vi.fn(async () => 'ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90');
    render(<EhAccountPanel accounts={[]} onSave={onSave} onBrowserLogin={onBrowserLogin} />);

    await user.click(screen.getByRole('tab', { name: /网页登录/ }));
    await user.click(screen.getByRole('button', { name: /打开登录页面/ }));

    expect(onBrowserLogin).toHaveBeenCalledTimes(1);
    // The cookies the window hands back go through the same save path as a pasted
    // one, so the site and the account id are still derived rather than asked for.
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      host: 'e-hentai.org',
      cookie: 'ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90',
    }));
  });

  it('offers no web sign-in when the caller cannot open a window', () => {
    render(<EhAccountPanel accounts={[]} onSave={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /网页登录/ })).toBeNull();
  });

  it('clears an earlier account-import error after a cookie saves successfully', async () => {
    const user = userEvent.setup();
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    render(<ToastProvider><EhAccountPanel accounts={[]} onSave={vi.fn(async () => undefined)} /></ToastProvider>);

    await user.click(screen.getByRole('tab', { name: 'Cookie 导入' }));
    const cookie = screen.getByLabelText('Cookie');
    await user.type(cookie, 'broken');
    await user.click(screen.getByRole('button', { name: '保存 Cookie' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('未能识别 Cookie');

    await user.clear(cookie);
    await user.type(cookie, `ipb_member_id=99; ipb_pass_hash=${hash}`);
    await user.click(screen.getByRole('button', { name: '保存 Cookie' }));
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('keeps the igneous refresh action available before ExHentai cookie exists', async () => {
    const user = userEvent.setup();
    const onReadCookie = vi.fn(async () => 'ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90');
    const onCheckHealth = vi.fn(async () => undefined);
    render(<EhAccountPanel accounts={sampleAccounts} onReadCookie={onReadCookie} onCheckHealth={onCheckHealth} />);
    const surface = screen.getByTestId('eh-account-surface-eh-a');
    fireEvent.touchStart(surface, { touches: [{ clientX: 240 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 120 }] });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 120 }] });
    await user.click(screen.getByRole('button', { name: '导出EH Main Cookie' }));
    expect((await screen.findAllByText('未获取')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: '刷新 igneous' }));
    expect(onCheckHealth).toHaveBeenCalledWith('eh-a');
  });

  it('shows every stored cookie in a popup with one copy-all action', async () => {
    const user = userEvent.setup();
    const cookie = 'ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; sl=dm_2; sk=abc123';
    render(<EhAccountPanel accounts={sampleAccounts} onReadCookie={vi.fn(async () => cookie)} />);
    const surface = screen.getByTestId('eh-account-surface-eh-a');
    fireEvent.touchStart(surface, { touches: [{ clientX: 240 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 120 }] });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 120 }] });
    await user.click(screen.getByRole('button', { name: '导出EH Main Cookie' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('sl')).toBeInTheDocument();
    expect(within(dialog).getByText('dm_2')).toBeInTheDocument();
    expect(within(dialog).getByText('sk')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '复制全部 Cookie' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /复制 ipb_member_id/ })).toBeNull();
  });

  it('lists the standard EH cookie fields even before a legacy account has refreshed them', async () => {
    const user = userEvent.setup();
    render(<EhAccountPanel accounts={sampleAccounts} onReadCookie={vi.fn(async () => 'ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90')} />);
    const surface = screen.getByTestId('eh-account-surface-eh-a');
    fireEvent.touchStart(surface, { touches: [{ clientX: 240 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 120 }] });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 120 }] });
    await user.click(screen.getByRole('button', { name: '导出EH Main Cookie' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('nw')).toBeInTheDocument();
    expect(within(dialog).getByText('datatags')).toBeInTheDocument();
    expect(within(dialog).getByText('ipb_session_id')).toBeInTheDocument();
    expect(within(dialog).getByText('hath_perks')).toBeInTheDocument();
  });
});
