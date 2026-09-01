import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeSettingsRepository } from '../../src/repositories/nativeSettingsRepository';

afterEach(resetInvokeAdapterForTests);

const preferences = {
  theme: 'dark' as const,
  defaultLayout: 'double' as const,
  defaultDirection: 'rtl' as const,
  cacheMaxBytes: 4_294_967_296,
};

describe('native settings bridge', () => {
  it('loads the validated preference snapshot', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: preferences }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeSettingsRepository().load()).resolves.toEqual({ ok: true, value: preferences });
    expect(adapter).toHaveBeenCalledWith('load_preferences', {});
  });

  it('saves the whole preference snapshot', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: preferences }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeSettingsRepository().save(preferences)).resolves.toEqual({ ok: true, value: preferences });
    expect(adapter).toHaveBeenCalledWith('save_preferences', { input: preferences });
  });

  it('rejects invalid native preference values', async () => {
    setInvokeAdapterForTests(async () => ({
      ok: true,
      value: { ...preferences, theme: 'sepia', cacheMaxBytes: -1 },
    }));

    await expect(new NativeSettingsRepository().load()).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE', retryable: false },
    });
  });

  it('rejects cache quotas outside one through thirty-two GiB', async () => {
    const repository = new NativeSettingsRepository();
    await expect(repository.save({ ...preferences, cacheMaxBytes: 1_073_741_823 })).resolves.toMatchObject({ ok: false });
    await expect(repository.save({ ...preferences, cacheMaxBytes: 34_359_738_369 })).resolves.toMatchObject({ ok: false });
  });

  it('imports a validated legacy ordinary-preference result', async () => {
    const imported = { preferences, importedCount: 3 };
    const adapter = vi.fn(async () => ({ ok: true, value: imported }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeSettingsRepository().importLegacy('encoded-config')).resolves.toEqual({
      ok: true,
      value: imported,
    });
    expect(adapter).toHaveBeenCalledWith('import_legacy_preferences', { encoded: 'encoded-config' });
  });

  it('rejects an invalid legacy preference response', async () => {
    setInvokeAdapterForTests(async () => ({
      ok: true,
      value: { preferences, importedCount: 0 },
    }));

    await expect(new NativeSettingsRepository().importLegacy('encoded-config')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE', retryable: false },
    });
  });
});
