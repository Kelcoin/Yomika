import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeDedupRepository } from '../../src/repositories/nativeDedupRepository';

afterEach(resetInvokeAdapterForTests);

describe('native dedup bridge', () => {
  it('checks file hash through the native bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { hash: 'ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f', size: 1234 } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    const result = await repository.checkFile('/path/to/file.zip');
    expect(result).toEqual({ ok: true, value: { hash: 'ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f', size: 1234 } });
    expect(adapter).toHaveBeenCalledWith('dedup_check_file', { path: '/path/to/file.zip' });
  });

  it('returns error when checkFile fails', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'File not found', retryable: true } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    expect(await repository.checkFile('/missing')).toEqual({ ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'File not found', retryable: true } });
  });

  it('saves dedup feature through the native bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: undefined }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    const input = { scopeId: 'scope-a', path: '/path/to/file.zip', exactHash: 'a'.repeat(64), dhash: 'ff'.repeat(8), algorithmVersion: '1', size: 1024 };
    expect(await repository.saveFeature(input)).toEqual({ ok: true, value: undefined });
    expect(adapter).toHaveBeenCalledWith('dedup_save_feature', { input });
  });

  it('returns error when saveFeature fails', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'INVALID_RESPONSE', message: 'Invalid dedup feature', retryable: false } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    expect(await repository.saveFeature({ scopeId: '', path: '', exactHash: '', algorithmVersion: '1', size: 0 })).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE', message: 'Invalid dedup feature', retryable: false } });
  });

  it('finds exact hash matches through the native bridge', async () => {
    const records = [{ scopeId: 'scope-a', path: '/a.zip', exactHash: 'a'.repeat(64), dhash: null, algorithmVersion: '1', size: 100 }];
    const adapter = vi.fn(async () => ({ ok: true, value: records }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    expect(await repository.findExact('scope-a', 'a'.repeat(64))).toEqual({ ok: true, value: records });
    expect(adapter).toHaveBeenCalledWith('dedup_find_exact', { scopeId: 'scope-a', exactHash: 'a'.repeat(64) });
  });

  it('returns empty array when findExact has no matches', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: [] }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    expect(await repository.findExact('scope-a', 'f'.repeat(64))).toEqual({ ok: true, value: [] });
  });
});
