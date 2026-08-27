import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeInferenceRepository } from '../../src/repositories/nativeInferenceRepository';

afterEach(resetInvokeAdapterForTests);

describe('inference probe bridge', () => {
  it('returns backend capabilities with CPU fallback', async () => {
    const capabilities = { backends: ['cpu'], maxPixels: 64_000_000, hardwareAcceleration: false };
    const adapter = vi.fn(async () => ({ ok: true, value: capabilities }));
    setInvokeAdapterForTests(adapter);
    expect(await new NativeInferenceRepository().probe()).toEqual({ ok: true, value: capabilities });
    expect(adapter).toHaveBeenCalledWith('inference_probe', {});
  });
});
