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
  prefetchPages: z.number().int().min(0).max(MAX_PREFETCH_PAGES).default(2),
  coverConcurrency: z.number().int().min(1).max(8).default(4),
  /** Which page opens at launch. Someone who lives in the library should not
   * have to step through the home page every time. */
  startupRoute: z.enum(['home', 'library']).default('home'),
  /** How archive cards are drawn. A preference, not view state: the shelves
   * follow the same choice, and as component state it reset to the default on
   * every navigation. */
  cardStyle: z.enum(['wide', 'thumbnail']).default('wide'),
  upscaleBackend: z.enum(['off', 'cpu', 'auto']).default('off'),
  upscaleModel: z.string().max(128).default(''),
  /** Installed de-censoring bundle to run on reader pages. Empty means off:
   * a bundle that is not chosen is the only sense in which it can be off. */
  decensorModel: z.string().max(128).default(''),
  downloadDirectory: z.string().max(4096).default(''),
  ehFavoriteDeleteSync: z.boolean().default(false),
  confirmEhFavoriteDelete: z.boolean().default(true),
  /** Whether the home continue-reading rail keeps records read past 95% of
   * their pages. Off hides them — there is nothing left to continue. */
  continueReadingShowFinished: z.boolean().default(true),
  /** Prioritise the E-Hentai account's own tag list ("My Tags") on archive
   * cards and detail pages, colouring those chips with the account's preset
   * colours. Needs a signed-in account and one mytags fetch. */
  ehMyTagsPriority: z.boolean().default(false),
  /** Free-form CSS appended after the design tokens. This is the whole
   * customisation surface — it replaced a standalone accent-colour preference,
   * which said less than one line of CSS here and had to be kept in step with
   * it. */
  customCss: z.string().max(20_000).default(''),
  /** Compact bottom navigation drawn as a floating capsule that hides on
   * scroll-down and returns on scroll-up. */
  floatingNav: z.boolean().default(false),
  /** Which entries the compact bottom bar shows, in the app's canonical order.
   * 档案库 and 设置 are pinned UI-side and re-pinned by the backend. */
  bottomNavItems: z
    .array(z.enum(['home', 'library', 'history', 'watchlist', 'to-read', 'downloads', 'settings']))
    .default(['home', 'library', 'history', 'watchlist', 'settings']),
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
  prefetchPages: 2,
  coverConcurrency: 4,
  startupRoute: 'home',
  cardStyle: 'wide',
  upscaleBackend: 'off',
  upscaleModel: '',
  decensorModel: '',
  downloadDirectory: '',
  ehFavoriteDeleteSync: false,
  confirmEhFavoriteDelete: true,
  continueReadingShowFinished: true,
  ehMyTagsPriority: false,
  customCss: '',
  floatingNav: false,
  bottomNavItems: ['home', 'library', 'history', 'watchlist', 'settings'],
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
