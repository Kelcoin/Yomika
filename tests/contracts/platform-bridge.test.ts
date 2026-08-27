import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativePlatformRepository } from '../../src/repositories/nativePlatformRepository';

afterEach(resetInvokeAdapterForTests);

describe('native platform bridge', () => {
  it('returns platform capabilities through the native bridge', async () => {
    const caps = { platform: 'windows', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: true };
    const adapter = vi.fn(async () => ({ ok: true, value: caps }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativePlatformRepository();
    expect(await repository.getCapabilities()).toEqual({ ok: true, value: caps });
    expect(adapter).toHaveBeenCalledWith('platform_capabilities', {});
  });

  it('returns error when platform capabilities fail', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'UNKNOWN', message: 'Platform probe failed', retryable: true } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativePlatformRepository();
    expect(await repository.getCapabilities()).toEqual({ ok: false, error: { code: 'UNKNOWN', message: 'Platform probe failed', retryable: true } });
  });
});
