import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeSettingsRepository } from '../../src/repositories/nativeSettingsRepository';

afterEach(resetInvokeAdapterForTests);

const preferences = {
  theme: 'dark' as const,
  defaultLayout: 'double' as const,
  defaultDirection: 'rtl' as const,
  cacheMaxBytes: 4_294_967_296,
  prefetchPages: 2,
  allowProgressRegression: true,
  progressBarVisibility: 'history' as const,
  coverConcurrency: 4,
  startupRoute: 'home' as const,
  cardStyle: 'wide' as const,
  upscaleBackend: 'off' as const,
  upscaleModel: '',
  upscaleOutputScale: 2,
  upscaleAutoEnable: false,
  upscaleAutoTagMode: 'whitelist' as const,
  upscaleAutoThresholdBytes: 512_000,
  upscaleAutoWhitelist: 'category:doujinshi\ncategory:manga',
  upscaleAutoBlacklist: 'other:3d\ncategory:cosplay\ncategory:asian porn',
  downloadDirectory: '',
  ehFavoriteDeleteSync: false,
  confirmEhFavoriteDelete: true,
  continueReadingShowFinished: true,
  randomRoamShowFinished: true,
  ehMyTagsPriority: false,
  sfwMode: false,
  detailActions: ['read', 'readingList', 'favorites', 'download'] as Array<'read' | 'readingList' | 'favorites' | 'download' | 'edit' | 'delete'>,
  detailDateKind: 'published' as 'added' | 'published',
  customCss: '',
  floatingNav: false,
  bottomNavItems: ['home', 'library', 'history', 'watchlist', 'settings'] as Array<'home' | 'library' | 'history' | 'watchlist' | 'to-read' | 'downloads' | 'settings'>,
  autoSync: true,
  startWithWindows: false,
  closeToTray: false,
  tagTranslationEnabled: true,
  tagCountOrderEnabled: true,
  dlssnrEnabled: false,
  dlssnrPasses: '',
  computeCenterEnabled: false,
  computeCenterPort: 47_653,
  computeCenterToken: '',
  remoteComputeUrl: '',
  remoteComputeToken: '',
  remoteComputeOps: '',
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

  it('rejects an unusable preload distance or upscale backend', async () => {
    const adapter = vi.fn(async (_command: string, args?: Record<string, unknown>) => ({ ok: true, value: args?.input }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeSettingsRepository();
    // Ten pages of preload is allowed; eleven is not.
    await expect(repository.save({ ...preferences, prefetchPages: 10 })).resolves.toMatchObject({ ok: true });
    await expect(repository.save({ ...preferences, prefetchPages: 11 })).resolves.toMatchObject({ ok: false });
    await expect(repository.save({ ...preferences, coverConcurrency: 0 })).resolves.toMatchObject({ ok: false });
    await expect(repository.save({ ...preferences, upscaleBackend: 'gpu' as never })).resolves.toMatchObject({ ok: false });
    await expect(repository.save({ ...preferences, startupRoute: 'reader' as never })).resolves.toMatchObject({ ok: false });
  });

  it('fills in the startup page a native build predating it does not send', async () => {
    // Same contract as every other added field: a snapshot from an older build
    // must not fail validation and drop the user back to defaults wholesale.
    const { startupRoute: _added, ...older } = preferences;
    setInvokeAdapterForTests(async () => ({ ok: true, value: older }));

    await expect(new NativeSettingsRepository().load()).resolves.toEqual({
      ok: true,
      value: { ...older, startupRoute: 'home' },
    });
  });

  it('drops a stale accent colour instead of failing the whole snapshot', async () => {
    // The accent preference is gone — custom CSS covers it. A snapshot from an
    // older native build still carries the field, and rejecting it would leave
    // the app on defaults after an upgrade.
    const adapter = vi.fn(async () => ({ ok: true, value: { ...preferences, accentColor: '#1f6f8b' } }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeSettingsRepository().load()).resolves.toEqual({ ok: true, value: preferences });
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
