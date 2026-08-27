import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeCacheRepository } from '../../src/repositories/nativeCacheRepository';

afterEach(resetInvokeAdapterForTests);

describe('native cache bridge', () => {
  it('runs one bounded quota-eviction batch', async () => {
    const value = { removedEntries: 2, removedFiles: 1, bytesFreed: 6, remainingBytes: 14, quotaSatisfied: true, hasMore: false };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeCacheRepository().evict({ maxBytes: 14, batchLimit: 64 })).resolves.toEqual({ ok: true, value });
    expect(adapter).toHaveBeenCalledWith('cache_evict', { input: { maxBytes: 14, batchLimit: 64 } });
  });
});
