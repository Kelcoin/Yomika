import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { ServerSetupDialog } from '../../src/components/ServerSetupDialog';
import { ok } from '../../src/domain/result';

describe('server setup dialog', () => {
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
    await user.click(screen.getByRole('button', { name: '保存服务器' }));

    const pending = screen.getByRole('button', { name: '保存中…' });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute('aria-busy', 'true');

    resolveSave(ok({ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
