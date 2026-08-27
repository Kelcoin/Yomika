import { z } from 'zod';

import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

export const PreferenceSnapshotSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  defaultLayout: z.enum(['auto', 'single', 'double', 'webtoon']),
  defaultDirection: z.enum(['ltr', 'rtl']),
  cacheMaxBytes: z.number().int().positive().safe(),
});

export type PreferenceSnapshot = z.infer<typeof PreferenceSnapshotSchema>;

export const LegacyPreferenceImportSchema = z.object({
  preferences: PreferenceSnapshotSchema,
  importedCount: z.number().int().positive().safe(),
});

export type LegacyPreferenceImport = z.infer<typeof LegacyPreferenceImportSchema>;

export const DEFAULT_PREFERENCES: PreferenceSnapshot = {
  theme: 'system',
  defaultLayout: 'auto',
  defaultDirection: 'ltr',
  cacheMaxBytes: 2_147_483_648,
};

export class NativeSettingsRepository {
  load(): Promise<CommandResult<PreferenceSnapshot>> {
    return invokeCommand('load_preferences', {}, PreferenceSnapshotSchema);
  }

  save(input: PreferenceSnapshot): Promise<CommandResult<PreferenceSnapshot>> {
    const parsed = PreferenceSnapshotSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.resolve({
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'Preference snapshot is invalid', retryable: false },
      });
    }
    return invokeCommand('save_preferences', { input: parsed.data }, PreferenceSnapshotSchema);
  }

  importLegacy(encoded: string): Promise<CommandResult<LegacyPreferenceImport>> {
    return invokeCommand('import_legacy_preferences', { encoded }, LegacyPreferenceImportSchema);
  }
}
