import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeSyncRepository } from '../../src/repositories/nativeSyncRepository';

afterEach(resetInvokeAdapterForTests);

describe('native sync repository bridge', () => {
  it('creates a protected key and builds an encrypted pending segment', async () => {
    const segment = { sequenceStart: 2, sequenceEnd: 4, hash: 'a'.repeat(64), size: 3, ciphertext: [1, 2, 3] };
    const adapter = vi.fn(async (command: string) => command === 'create_sync_key'
      ? { ok: true, value: 'account-a' }
      : { ok: true, value: segment });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeSyncRepository();

    expect(await repository.createKey('account-a')).toEqual({ ok: true, value: 'account-a' });
    expect(await repository.buildSegment('account-a', 'scope-a')).toEqual({ ok: true, value: segment });
    expect(adapter).toHaveBeenNthCalledWith(1, 'create_sync_key', { accountId: 'account-a' });
    expect(adapter).toHaveBeenNthCalledWith(2, 'build_sync_segment', { accountId: 'account-a', scopeId: 'scope-a' });
  });

  it('encrypts and decrypts manifest through keyring-backed native commands', async () => {
    const manifest = { version: 1, epoch: 2, segments: [], deviceCursors: { 'device-a': 4 } };
    const adapter = vi.fn(async (command: string) => command === 'encrypt_sync_manifest'
      ? { ok: true, value: [1, 2, 3] }
      : { ok: true, value: manifest });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeSyncRepository();

    expect(await repository.encryptManifest('account-a', manifest)).toEqual({ ok: true, value: [1, 2, 3] });
    expect(await repository.decryptManifest('account-a', [1, 2, 3])).toEqual({ ok: true, value: manifest });
    expect(adapter).toHaveBeenNthCalledWith(1, 'encrypt_sync_manifest', { accountId: 'account-a', manifest });
    expect(adapter).toHaveBeenNthCalledWith(2, 'decrypt_sync_manifest', { accountId: 'account-a', ciphertext: [1, 2, 3] });
  });

  it('merges manifests through native deterministic rules', async () => {
    const local = { version: 1, epoch: 1, segments: [], deviceCursors: { a: 2 } };
    const remote = { version: 1, epoch: 2, segments: [], deviceCursors: { a: 1, b: 3 } };
    const merged = { version: 1, epoch: 2, segments: [], deviceCursors: { a: 2, b: 3 } };
    const adapter = vi.fn(async () => ({ ok: true, value: merged }));
    setInvokeAdapterForTests(adapter);

    expect(await new NativeSyncRepository().mergeManifests(local, remote)).toEqual({ ok: true, value: merged });
    expect(adapter).toHaveBeenCalledWith('merge_sync_manifests', { local, remote });
  });

  it('saves and lists WebDAV accounts without returning credentials', async () => {
    const account = {
      id: 'account-a',
      label: 'Personal WebDAV',
      baseUrl: 'https://dav.example.com/Yomika',
      username: 'reader',
      credentialRef: 'account-a',
      status: 'unverified',
      lastProbeAt: null,
      lastErrorCode: null,
      createdAt: '2026-08-26 00:00:00',
      updatedAt: '2026-08-26 00:00:00',
    };
    const adapter = vi.fn(async (command: string) => command === 'save_webdav_account'
      ? { ok: true, value: account }
      : { ok: true, value: [account] });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeSyncRepository();

    expect(await repository.saveAccount({
      id: 'account-a',
      label: 'Personal WebDAV',
      baseUrl: 'https://dav.example.com/Yomika',
      username: 'reader',
      credential: 'secret-token',
    })).toEqual({ ok: true, value: account });
    expect(await repository.listAccounts()).toEqual({ ok: true, value: [account] });
    expect(adapter).toHaveBeenNthCalledWith(1, 'save_webdav_account', {
      input: {
        id: 'account-a',
        label: 'Personal WebDAV',
        baseUrl: 'https://dav.example.com/Yomika',
        username: 'reader',
        credential: 'secret-token',
      },
    });
    expect(adapter).toHaveBeenNthCalledWith(2, 'list_webdav_accounts', {});
    expect(account).not.toHaveProperty('credential');
  });

  it('claims a bounded batch of pending journal records', async () => {
    const records = [{
      sequence: 3, scopeId: 'scope-a', objectId: 'scope-a/archive-a', objectType: 'reading_progress',
      operation: 'upsert', deviceId: 'device-a', logicalClock: 3, wallClock: '2026-08-26T00:00:00Z',
      payloadHash: 'a'.repeat(64), payloadJson: '{}', status: 'processing', attemptCount: 0, lastError: null,
    }];
    const adapter = vi.fn(async () => ({ ok: true, value: records }));
    setInvokeAdapterForTests(adapter);
    expect(await new NativeSyncRepository().claimJournal('scope-a', 10)).toEqual({ ok: true, value: records });
    expect(adapter).toHaveBeenCalledWith('claim_sync_journal', { scopeId: 'scope-a', limit: 10 });
  });

  it('runs the WebDAV sync orchestration command', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: 2 }));
    setInvokeAdapterForTests(adapter);
    expect(await new NativeSyncRepository().syncWebdavScope('account-a', 'scope-a', 'device-a'))
      .toEqual({ ok: true, value: 2 });
    expect(adapter).toHaveBeenCalledWith('sync_webdav_scope', {
      accountId: 'account-a', scopeId: 'scope-a', deviceId: 'device-a',
    });
  });
});
