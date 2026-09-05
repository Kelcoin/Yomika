import { z } from 'zod';

import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

/** Keep in step with `MAX_PREFETCH_PAGES` in src-tauri/src/settings.rs. */
export const MAX_PREFETCH_PAGES = 10;

export const PreferenceSnapshotSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  defaultLayout: z.enum(['auto', 'single', 'double', 'webtoon']),
  defaultDirection: z.enum(['ltr', 'rtl']),
  cacheMaxBytes: z.number().int().min(1_073_741_824).max(34_359_738_368).refine((value) => value % 1_073_741_824 === 0),
  // Defaults keep an older native build (which does not send these yet) from
  // failing the whole snapshot.
  prefetchPages: z.number().int().min(0).max(MAX_PREFETCH_PAGES).default(1),
  coverConcurrency: z.number().int().min(1).max(8).default(4),
  /** Which page opens at launch. Someone who lives in the library should not
   * have to step through the home page every time. */
  startupRoute: z.enum(['home', 'library']).default('home'),
  upscaleBackend: z.enum(['off', 'cpu', 'auto']).default('off'),
  upscaleModel: z.string().max(128).default(''),
  /** Free-form CSS appended after the design tokens. This is the whole
   * customisation surface — it replaced a standalone accent-colour preference,
   * which said less than one line of CSS here and had to be kept in step with
   * it. */
  customCss: z.string().max(20_000).default(''),
}).strip();

export type PreferenceSnapshot = z.output<typeof PreferenceSnapshotSchema>;
/** The schema fills in defaults, so its input type is looser than its output.
 * Commands answer with the filled-in shape. */
const PreferenceSnapshotResponse = PreferenceSnapshotSchema as unknown as z.ZodType<PreferenceSnapshot>;

export const LegacyPreferenceImportSchema = z.object({
  preferences: PreferenceSnapshotSchema,
  importedCount: z.number().int().positive().safe(),
});

export type LegacyPreferenceImport = z.output<typeof LegacyPreferenceImportSchema>;
const LegacyPreferenceImportResponse = LegacyPreferenceImportSchema as unknown as z.ZodType<LegacyPreferenceImport>;

export const DEFAULT_PREFERENCES: PreferenceSnapshot = {
  theme: 'system',
  defaultLayout: 'auto',
  defaultDirection: 'ltr',
  cacheMaxBytes: 2_147_483_648,
  prefetchPages: 1,
  coverConcurrency: 4,
  startupRoute: 'home',
  upscaleBackend: 'off',
  upscaleModel: '',
  customCss: '',
};

export class NativeSettingsRepository {
  load(): Promise<CommandResult<PreferenceSnapshot>> {
    return invokeCommand('load_preferences', {}, PreferenceSnapshotResponse);
  }

  save(input: PreferenceSnapshot): Promise<CommandResult<PreferenceSnapshot>> {
    const parsed = PreferenceSnapshotSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.resolve({
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'Preference snapshot is invalid', retryable: false },
      });
    }
    return invokeCommand('save_preferences', { input: parsed.data }, PreferenceSnapshotResponse);
  }

  importLegacy(encoded: string): Promise<CommandResult<LegacyPreferenceImport>> {
    return invokeCommand('import_legacy_preferences', { encoded }, LegacyPreferenceImportResponse);
  }
}
