import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { ServerSetupDialog } from '../../src/components/ServerSetupDialog';
import { ToastProvider } from '../../src/components/Toast';
import { ok } from '../../src/domain/result';

const homeServer = {
  name: 'Home',
  baseUrl: 'https://example.com',
  scopeId: 'scope_original',
  enabled: true,
};

describe('server setup dialog', () => {
  it('does not submit when the API key is empty', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async ({ identity }: Parameters<NonNullable<React.ComponentProps<typeof ServerSetupDialog>['onSave']>>[0]) => ok(identity));
    render(<ServerSetupDialog onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    await user.type(screen.getByLabelText('名称'), 'Home');
    await user.type(screen.getByLabelText('服务器地址'), 'https://example.com');
    await user.click(screen.getByRole('button', { name: '保存服务器' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText('API Key')).toBeInvalid();
  });

  it('validates and submits a normalized server without exposing the key', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async ({ identity }: Parameters<NonNullable<React.ComponentProps<typeof ServerSetupDialog>['onSave']>>[0]) => ok(identity));
    render(<ServerSetupDialog onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    await user.type(screen.getByLabelText('名称'), 'Home');
    await user.type(screen.getByLabelText('服务器地址'), 'HTTPS://Example.COM:443/lrr/');
    await user.type(screen.getByLabelText('API Key'), 'secret-value');
    await user.click(screen.getByRole('button', { name: '保存服务器' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ name: 'Home', baseUrl: 'https://example.com/lrr' }),
      apiKey: 'secret-value',
    }));
    expect(screen.queryByText('secret-value')).not.toBeInTheDocument();
  });

  it('reports a persistence failure as a toast and keeps the dialog open', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ServerSetupDialog onSave={async () => ({ ok: false, error: { code: 'PLATFORM_UNAVAILABLE', message: '安全存储不可用', retryable: false } })} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    await user.type(screen.getByLabelText('名称'), 'Home');
    await user.type(screen.getByLabelText('服务器地址'), 'https://example.com');
    await user.type(screen.getByLabelText('API Key'), 'secret-value');
    await user.click(screen.getByRole('button', { name: '保存服务器' }));

    // 报错只说一次，走 toast（portal 到 body，对话框盖不住它），表单里不再有常驻红字。
    expect(await screen.findByText('安全存储不可用')).toBeInTheDocument();
    expect(document.querySelector('.server-form .form-error')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('marks the save command busy while persistence is pending', async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: ReturnType<typeof ok<import('../../src/domain/server').ServerIdentity>>) => void;
    const onSave = vi.fn(() => new Promise<ReturnType<typeof ok<import('../../src/domain/server').ServerIdentity>>>((resolve) => { resolveSave = resolve; }));
    render(<ServerSetupDialog onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    await user.type(screen.getByLabelText('名称'), 'Home');
    await user.type(screen.getByLabelText('服务器地址'), 'https://example.com');
    await user.type(screen.getByLabelText('API Key'), 'secret-value');
    await user.click(screen.getByRole('button', { name: '保存服务器' }));

    const pending = screen.getByRole('button', { name: '保存中…' });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute('aria-busy', 'true');

    resolveSave(ok({ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes on a click outside, with no ✕ in the title row', async () => {
    const user = userEvent.setup();
    render(<ServerSetupDialog onSave={async ({ identity }) => ok(identity)} />);
    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    const dialog = await screen.findByRole('dialog');

    // 标题行里没有 ✕：动作行只留删除配置与保存服务器，关闭走点空白处与 Esc。
    expect(within(dialog).queryByRole('button', { name: '关闭' })).toBeNull();

    await user.click(document.querySelector('.dialog-overlay')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('editing a server keeps its original identity instead of deriving a new one', async () => {
    // The scope id keys every archive, progress and history row for the
    // server; re-deriving it from a renamed profile would orphan all of that
    // and pile a duplicate row into the server list.
    const user = userEvent.setup();
    const onSave = vi.fn(async ({ identity }: Parameters<NonNullable<React.ComponentProps<typeof ServerSetupDialog>['onSave']>>[0]) => ok(identity));
    render(<ServerSetupDialog onSave={onSave} server={{ name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope_original', enabled: true }} />);

    await user.click(screen.getByRole('button', { name: '编辑 Home' }));
    await user.clear(screen.getByLabelText('名称'));
    await user.type(screen.getByLabelText('名称'), 'Home NAS');
    await user.type(screen.getByLabelText('API Key'), 'secret-value');
    await user.click(screen.getByRole('button', { name: '保存服务器' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ name: 'Home NAS', scopeId: 'scope_original' }),
    }));
  });

  it('offers 删除配置 and 保存服务器 on the edit dialog, with no 取消 and no top description', async () => {
    const user = userEvent.setup();
    render(
      <ServerSetupDialog
        onSave={async ({ identity }) => ok(identity)}
        onDelete={async () => true}
        server={homeServer}
      />,
    );

    await user.click(screen.getByRole('button', { name: '编辑 Home' }));
    const dialog = await screen.findByRole('dialog');

    // 编辑态的两颗按钮等宽平分动作行。
    expect(dialog.querySelector('.dialog-actions')).toHaveClass('is-balanced');
    expect(within(dialog).getByRole('button', { name: '删除配置' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '保存服务器' })).toBeInTheDocument();
    // 动作行里不再有「取消」：关闭走点空白处、Esc 与返回手势。
    expect(within(dialog).queryByRole('button', { name: '取消' })).toBeNull();

    // 标题按规范：居中标题行，左侧 SVG 图标、右侧文字。
    const title = within(dialog).getByText('更新 LANraragi');
    expect(title).toHaveClass('dialog-title');
    expect(title.querySelector('svg')).not.toBeNull();

    // 顶部说明整段去掉。Radix 只在真的渲染了 Dialog.Description 时才给 Content
    // 挂 aria-describedby，所以这个属性缺席正是「那行小字没了」的结构证据。
    expect(dialog).not.toHaveAttribute('aria-describedby');
    expect(within(dialog).queryByText(/连接信息保存在此设备/)).toBeNull();
  });

  it('still closes on Escape now that the 取消 button is gone', async () => {
    const user = userEvent.setup();
    render(<ServerSetupDialog onSave={async ({ identity }) => ok(identity)} server={homeServer} />);

    await user.click(screen.getByRole('button', { name: '编辑 Home' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not offer 删除配置 on the add dialog', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => true);
    render(<ServerSetupDialog onSave={async ({ identity }) => ok(identity)} onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    const dialog = await screen.findByRole('dialog');

    // 还没有服务器可以被删：即使父层给了 onDelete，添加态也不显示删除配置。
    expect(within(dialog).queryByRole('button', { name: '删除配置' })).toBeNull();
    // 添加态与编辑态一样没有「取消」，只留保存服务器一颗。
    expect(within(dialog).queryByRole('button', { name: '取消' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: '保存服务器' })).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('confirms before deleting and closes the editor when the parent resolves true', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => true);
    render(
      <ServerSetupDialog
        onSave={async ({ identity }) => ok(identity)}
        onDelete={onDelete}
        server={homeServer}
      />,
    );

    await user.click(screen.getByRole('button', { name: '编辑 Home' }));
    await user.click(await screen.findByRole('button', { name: '删除配置' }));

    // 删除要先确认：点了删除配置只是打开确认框，还没有真的删。
    expect(await screen.findByText('删除「Home」的配置？')).toBeInTheDocument();
    // 档案馆藏与阅读记录留在本地，重新添加同一地址即可接回，确认文案要说清楚。
    expect(screen.getByText(/重新添加同一地址/)).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('更新 LANraragi')).not.toBeInTheDocument());
  });

  it('keeps the editor open when the parent reports the delete failed', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => false);
    render(
      <ServerSetupDialog
        onSave={async ({ identity }) => ok(identity)}
        onDelete={onDelete}
        server={homeServer}
      />,
    );

    await user.click(screen.getByRole('button', { name: '编辑 Home' }));
    await user.click(await screen.findByRole('button', { name: '删除配置' }));
    await user.click(await screen.findByRole('button', { name: '删除' }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    // 父层已经报过错；编辑器留着，用户可以改完再存或再删一次。
    expect(await screen.findByLabelText('名称')).toHaveValue('Home');
    expect(screen.queryByText('删除「Home」的配置？')).not.toBeInTheDocument();
  });

  it('puts the caret at the end of the name instead of selecting it whole', async () => {
    const user = userEvent.setup();
    render(<ServerSetupDialog onSave={async ({ identity }) => ok(identity)} server={homeServer} />);

    await user.click(screen.getByRole('button', { name: '编辑 Home' }));
    const name = (await screen.findByLabelText('名称')) as HTMLInputElement;

    // Radix 打开对话框时会聚焦第一个文本框并全选内容，编辑服务器时等于替用户选中了名字，
    // 一敲键盘就把名字整段替换掉。光标应该落在末尾。
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe('Home');
    expect(name.selectionStart).toBe(name.value.length);
    expect(name.selectionEnd).toBe(name.value.length);
  });
});
