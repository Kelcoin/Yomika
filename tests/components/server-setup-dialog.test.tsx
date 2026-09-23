import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { ServerSetupDialog } from '../../src/components/ServerSetupDialog';
import { ok } from '../../src/domain/result';

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

  it('keeps an actionable error visible when persistence fails', async () => {
    const user = userEvent.setup();
    render(<ServerSetupDialog onSave={async () => ({ ok: false, error: { code: 'PLATFORM_UNAVAILABLE', message: '安全存储不可用', retryable: false } })} />);

    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    await user.type(screen.getByLabelText('名称'), 'Home');
    await user.type(screen.getByLabelText('服务器地址'), 'https://example.com');
    await user.type(screen.getByLabelText('API Key'), 'secret-value');
    await user.click(screen.getByRole('button', { name: '保存服务器' }));

    expect(screen.getByRole('alert')).toHaveTextContent('安全存储不可用');
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

  it('closes on a click outside, with no ✕ or 取消 in the way', async () => {
    const user = userEvent.setup();
    render(<ServerSetupDialog onSave={async ({ identity }) => ok(identity)} />);
    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    const dialog = await screen.findByRole('dialog');

    // 关闭只有一条路：点空白处（Esc 仍在）。右上角的 ✕ 与左下角的取消曾是另外两条，
    // 而它们一个在标题行里占一角、一个把动作行撑成两颗按钮——这个表单真正要做的事
    // 只有「保存服务器」一件。
    expect(within(dialog).queryByRole('button', { name: '关闭' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '取消' })).toBeNull();

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
});
