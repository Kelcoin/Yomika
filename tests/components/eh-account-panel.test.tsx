import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EhAccountPanel } from '../../src/components/EhAccountPanel';
import { ToastProvider } from '../../src/components/Toast';
import type { EhAccount } from '../../src/domain/eh';

describe('EhAccountPanel', () => {
  const sampleAccounts: EhAccount[] = [
    { id: 'eh-a', label: 'EH Main', host: 'e-hentai.org', cookieRef: 'ref-a', isActive: true, status: 'verified', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    { id: 'eh-b', label: 'EX Account', host: 'exhentai.org', cookieRef: 'ref-b', isActive: false, status: 'unverified', createdAt: '2026-02-01', updatedAt: '2026-02-01' },
  ];

  it('renders a list of EH accounts with hosts and the generic fallback name', () => {
    render(<EhAccountPanel accounts={sampleAccounts} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // 未记录显示名时默认显示「E 站用户」。
    expect(within(items[0]!).getByText('E 站用户')).toBeDefined();
    expect(within(items[0]!).getByText('检测 EX 中…')).toBeDefined();
    expect(within(items[0]!).getByText('正在更新资产…')).toBeDefined();
    expect(within(items[1]!).getByText('E 站用户')).toBeDefined();
  });

  it('does not display verification labels in the account row', () => {
    render(<EhAccountPanel accounts={sampleAccounts} />);
    expect(screen.queryByText('已验证')).toBeNull();
    expect(screen.queryByText('未验证')).toBeNull();
  });

  it('calls onCheckHealth with account id when check button clicked', async () => {
    const onCheckHealth = vi.fn();
    const user = userEvent.setup();
    render(<EhAccountPanel accounts={sampleAccounts} onCheckHealth={onCheckHealth} />);
    const checkButtons = screen.getAllByRole('button', { name: '检查登录状态' });
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
    expect(screen.getByRole('status', { name: '正在读取账户' }).querySelector('.skeleton-line')).not.toBeNull();
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

  it('exports the account cookie to the clipboard as a header string', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const cookie = 'ipb_member_id=42; ipb_pass_hash=a1b2c3d4e5f60718293a4b5c6d7e8f90; sl=dm_2; sk=abc123';
    render(
      <ToastProvider>
        <EhAccountPanel accounts={sampleAccounts} onReadCookie={vi.fn(async () => cookie)} />
      </ToastProvider>,
    );
    // 导出没有弹窗：点击即把整段 Cookie 以 header string 格式放进剪贴板。
    const items = screen.getAllByRole('listitem');
    await user.click(within(items[0]!).getByRole('button', { name: '导出 Cookie' }));
    expect(await screen.findByText('Cookie 已复制到剪贴板')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(cookie);
  });

  it('reports a failed cookie export instead of copying nothing', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <EhAccountPanel accounts={sampleAccounts} onReadCookie={vi.fn(async () => undefined)} />
      </ToastProvider>,
    );
    const items = screen.getAllByRole('listitem');
    await user.click(within(items[0]!).getByRole('button', { name: '导出 Cookie' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('未能读取 Cookie');
  });

  it('turns the name inline-editable from the edit button and saves on Enter', async () => {
    const user = userEvent.setup();
    const onEditUsername = vi.fn(async () => undefined);
    render(
      <ToastProvider>
        <EhAccountPanel accounts={sampleAccounts} onEditUsername={onEditUsername} />
      </ToastProvider>,
    );
    const items = screen.getAllByRole('listitem');
    // 点铅笔 → 用户名原地变输入框；「E 站用户」回退不带进草稿（应为空）。
    await user.click(within(items[0]!).getByRole('button', { name: /编辑 / }));
    const input = await screen.findByRole('textbox', { name: '账户名' });
    expect(input).toHaveValue('');

    await user.type(input, 'Kelcoin');
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(onEditUsername).toHaveBeenCalledWith('eh-a', 'Kelcoin'));
    // 保存后退出编辑态。
    expect(screen.queryByRole('textbox', { name: '账户名' })).toBeNull();
  });

  it('cancels inline editing with Escape without saving', async () => {
    const user = userEvent.setup();
    const onEditUsername = vi.fn(async () => undefined);
    const named: EhAccount[] = [{ ...sampleAccounts[0]!, username: 'Kelcoin' }];
    render(
      <ToastProvider>
        <EhAccountPanel accounts={named} onEditUsername={onEditUsername} />
      </ToastProvider>,
    );
    const items = screen.getAllByRole('listitem');
    await user.click(within(items[0]!).getByRole('button', { name: /编辑 / }));
    const input = await screen.findByRole('textbox', { name: '账户名' });
    // 已记录的名字带入草稿。
    expect(input).toHaveValue('Kelcoin');
    await user.clear(input);
    await user.type(input, '被改了');
    await user.keyboard('{Escape}');
    expect(onEditUsername).not.toHaveBeenCalled();
  });

  it('keeps a pending rename from submitting twice or switching to another account', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onEditUsername = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<EhAccountPanel accounts={sampleAccounts} onEditUsername={onEditUsername} />);
    await user.click(screen.getAllByRole('button', { name: /编辑 .* 的账户名/ })[0]!);
    const input = screen.getByRole('textbox', { name: '账户名' });
    fireEvent.change(input, { target: { value: 'New name' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);
    });
    expect(onEditUsername).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /编辑 .* 的账户名/ })).toBeDisabled();
    await act(async () => { finish(); });
    expect(screen.queryByRole('textbox', { name: '账户名' })).toBeNull();
  });

  it('treats an unchanged or empty commit as a cancel', async () => {
    const user = userEvent.setup();
    const onEditUsername = vi.fn(async () => undefined);
    render(
      <ToastProvider>
        <EhAccountPanel accounts={sampleAccounts} onEditUsername={onEditUsername} />
      </ToastProvider>,
    );
    const items = screen.getAllByRole('listitem');
    await user.click(within(items[0]!).getByRole('button', { name: /编辑 / }));
    const input = await screen.findByRole('textbox', { name: '账户名' });
    // 空白提交：视为取消，不保存。
    await user.click(within(items[1]!).getByText('E 站用户'));
    await user.keyboard('{Enter}');
    expect(onEditUsername).not.toHaveBeenCalled();
  });
});
