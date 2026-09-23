import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeSyncRepository } from '../../src/repositories/nativeSyncRepository';

afterEach(resetInvokeAdapterForTests);

describe('native sync repository bridge', () => {
  it('saves and lists sync accounts without returning credentials', async () => {
    const account = {
      id: 'account-a',
      kind: 'webdav',
      active: true,
      label: 'Personal WebDAV',
      bucket: '',
      baseUrl: 'https://dav.example.com/Yomika',
      username: 'reader',
      credentialRef: 'account-a',
      syncScope: '',
      status: 'unverified',
      lastProbeAt: null,
      lastSyncAt: null,
      lastErrorCode: null,
      createdAt: '2026-08-26 00:00:00',
      updatedAt: '2026-08-26 00:00:00',
    };
    const adapter = vi.fn(async (command: string) => command === 'save_sync_account'
      ? { ok: true, value: account }
      : { ok: true, value: [account] });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeSyncRepository();

    expect(await repository.saveAccount({
      id: 'account-a',
      kind: 'webdav',
      label: 'Personal WebDAV',
      baseUrl: 'https://dav.example.com/Yomika',
      bucket: '',
      username: 'reader',
      credential: 'secret-token',
    })).toEqual({ ok: true, value: account });
    expect(await repository.listAccounts()).toEqual({ ok: true, value: [account] });
    expect(adapter).toHaveBeenNthCalledWith(1, 'save_sync_account', {
      input: {
        id: 'account-a',
        kind: 'webdav',
        label: 'Personal WebDAV',
        baseUrl: 'https://dav.example.com/Yomika',
        bucket: '',
        username: 'reader',
        credential: 'secret-token',
      },
    });
    expect(adapter).toHaveBeenNthCalledWith(2, 'list_sync_accounts', {});
    expect(account).not.toHaveProperty('credential');
  });

  it('runs the whole sync in one native call', async () => {
    // 段、清单、加密、合并、认领日志都在原生侧完成：桥这边只有这一个入口。
    const adapter = vi.fn(async () => ({ ok: true, value: 2 }));
    setInvokeAdapterForTests(adapter);

    expect(await new NativeSyncRepository().syncRemoteScope('account-a', 'scope-a'))
      .toEqual({ ok: true, value: 2 });
    expect(adapter).toHaveBeenCalledWith('sync_remote_scope', {
      accountId: 'account-a', scopeId: 'scope-a',
    });
  });

  it('exposes only the account calls, the sync entry, the remote reset, and the scoped export', () => {
    const surface = Object.getOwnPropertyNames(NativeSyncRepository.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(surface).toEqual(['accountCredential', 'exportScopedData', 'importScopedData', 'listAccounts', 'resetRemote', 'saveAccount', 'saveScope', 'syncRemoteScope', 'testAccount']);
  });

  it('exports and imports the checked scope through the sync document commands', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'export_scoped_data') return { ok: true, value: { text: '{"kind":"yomika-scope-export"}', objects: 3, categories: ['history'] } };
      return { ok: true, value: { applied: 2, skipped: 1, categories: ['history'] } };
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeSyncRepository();

    expect(await repository.exportScopedData('["history"]'))
      .toEqual({ ok: true, value: { text: '{"kind":"yomika-scope-export"}', objects: 3, categories: ['history'] } });
    expect(adapter).toHaveBeenCalledWith('export_scoped_data', { categories: '["history"]' });

    expect(await repository.importScopedData('{"kind":"yomika-scope-export"}', '["history"]'))
      .toEqual({ ok: true, value: { applied: 2, skipped: 1, categories: ['history'] } });
    expect(adapter).toHaveBeenCalledWith('import_scoped_data', {
      payload: '{"kind":"yomika-scope-export"}', categories: '["history"]',
    });
  });

  it('resets the remote document through its own command', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: null }));
    setInvokeAdapterForTests(adapter);

    expect(await new NativeSyncRepository().resetRemote('account-a')).toEqual({ ok: true, value: undefined });
    expect(adapter).toHaveBeenCalledWith('reset_remote_state', { accountId: 'account-a' });
  });
});
