import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { ServerSetupDialog } from '../../src/components/ServerSetupDialog';
import { ok } from '../../src/domain/result';

afterEach(resetInvokeAdapterForTests);

describe('asynchronous form drafts', () => {
  it('does not overwrite a typed server key with a delayed saved key', async () => {
    const user = userEvent.setup();
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'read_server_api_key') return new Promise((resolve) => { finish = resolve; });
      throw new Error(command);
    });
    render(<ServerSetupDialog server={{ name: 'Home', baseUrl: 'https://example.com', scopeId: 'home', enabled: true }} onSave={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '编辑 Home' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'new-secret' } });
    await act(async () => { finish(ok('old-secret')); });
    expect(screen.getByLabelText('API Key')).toHaveValue('new-secret');
  });

  it('keeps a server save in its original dialog until it settles', async () => {
    const user = userEvent.setup();
    let finish!: (value: ReturnType<typeof ok<import('../../src/domain/server').ServerIdentity>>) => void;
    const onSave = vi.fn(() => new Promise<ReturnType<typeof ok<import('../../src/domain/server').ServerIdentity>>>((resolve) => { finish = resolve; }));
    render(<ServerSetupDialog onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    fireEvent.change(screen.getByLabelText('服务器地址'), { target: { value: 'https://example.com' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'typed-secret' } });
    await user.click(screen.getByRole('button', { name: '保存服务器' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeDisabled();
    await act(async () => { finish(ok({ name: '', baseUrl: 'https://example.com', scopeId: 's' })); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
