import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { ServerSetupDialog } from '../../src/components/ServerSetupDialog';
import { SyncAccountForm, useSyncSettings } from '../../src/components/SyncSettings';
import { SyncAccountSchema } from '../../src/domain/syncWire';
import { ok } from '../../src/domain/result';

afterEach(resetInvokeAdapterForTests);

const account = (id: string, kind: 'webdav' | 's3') => SyncAccountSchema.parse({
  id, kind, label: id, baseUrl: 'https://example.com', username: 'reader', credentialRef: id,
  syncScope: '[]', status: 'unverified', lastProbeAt: null, lastErrorCode: null, createdAt: 'now', updatedAt: 'now',
});

describe('asynchronous form drafts', () => {
  it('tests the mounted sync form and locks its draft until the request settles', async () => {
    const user = userEvent.setup();
    let finish!: (value: unknown) => void;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_sync_accounts' || command === 'list_servers') return ok([]);
      if (command === 'test_sync_account') return new Promise((resolve) => { finish = resolve; });
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    function Form() {
      const sync = useSyncSettings();
      return <SyncAccountForm sync={sync} />;
    }
    render(<Form />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'My NAS' } });
    fireEvent.change(screen.getByLabelText('WebDAV 地址'), { target: { value: 'https://dav.example.com' } });
    await user.click(screen.getByRole('button', { name: '测试' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('test_sync_account', expect.anything()));
    expect(screen.getByRole('button', { name: '对象存储' })).toBeDisabled();
    expect(screen.getByLabelText('名称')).toBeDisabled();
    await act(async () => { finish(ok('Connection succeeded')); });
    expect(screen.getByRole('button', { name: '对象存储' })).toBeEnabled();
  });

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

  it('does not put a delayed credential from a previous account into the current form', async () => {
    const dav = account('dav', 'webdav');
    const s3 = account('s3', 's3');
    let finishDav!: (value: unknown) => void;
    let finishS3!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_sync_accounts') return ok([dav, s3]);
      if (command === 'list_servers') return ok([]);
      if (command === 'sync_account_credential') return new Promise((resolve) => {
        if (args?.accountId === 'dav') finishDav = resolve;
        else finishS3 = resolve;
      });
      throw new Error(command);
    });
    const { result } = renderHook(() => useSyncSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.startEdit(dav));
    act(() => result.current.switchKind('s3'));
    await act(async () => { finishDav(ok('old-dav-secret')); });
    expect(result.current.credentialDraft).toBe('');
    await act(async () => { finishS3(ok('current-s3-secret')); });
    expect(result.current.credentialDraft).toBe('current-s3-secret');
  });

  it('does not refill a credential deliberately cleared while it was loading', async () => {
    const dav = account('dav', 'webdav');
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_sync_accounts') return ok([dav]);
      if (command === 'list_servers') return ok([]);
      return new Promise((resolve) => { finish = resolve; });
    });
    const { result } = renderHook(() => useSyncSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.startEdit(dav));
    act(() => result.current.setCredentialDraft(''));
    await act(async () => { finish(ok('stored-secret')); });
    expect(result.current.credentialDraft).toBe('');
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
