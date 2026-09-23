import { z } from 'zod';

import { invokeCommand } from '../bridge/invoke';
import { DEFAULT_DATA_TRANSFER_SCOPE } from '../domain/dataTransferScope';
import type { CommandResult } from '../domain/result';

/** Keep in step with `MAX_PREFETCH_PAGES` in src-tauri/src/settings.rs. */
export const MAX_PREFETCH_PAGES = 10;

export const DETAIL_ACTIONS = ['read', 'readingList', 'favorites', 'download', 'edit', 'delete'] as const;
export const DEFAULT_DETAIL_ACTIONS: (typeof DETAIL_ACTIONS)[number][] = ['read', 'readingList', 'favorites', 'download'];

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
  /** Readoshi-style auto-enable: a session opens upscaled when the archive's
   * average page size (bytes/page) reaches the threshold. Needs a model; the
   * switch locks while upscale itself is off. */
  upscaleAutoEnable: z.boolean().default(false),
  /** The auto-enable threshold in bytes per page. Default 500 KB. */
  upscaleAutoThresholdBytes: z.number().int().min(64 * 1024).max(8 * 1024 * 1024).default(512_000),
  /** Installed de-censoring bundle to run on reader pages. Empty means off:
   * a bundle that is not chosen is the only sense in which it can be off. */
  decensorModel: z.string().max(128).default(''),
  downloadDirectory: z.string().max(4096).default(''),
  ehFavoriteDeleteSync: z.boolean().default(false),
  confirmEhFavoriteDelete: z.boolean().default(true),
  /** Whether the home continue-reading rail keeps records read past 95% of
   * their pages. Off hides them — there is nothing left to continue. */
  continueReadingShowFinished: z.boolean().default(true),
  /** Whether the home random-roam rail keeps finished archives. Off hides
   * them there too, and the rail keeps drawing until its width is full. */
  randomRoamShowFinished: z.boolean().default(true),
  /** Prioritise the E-Hentai account's own tag list ("My Tags") on archive
   * cards and detail pages, colouring those chips with the account's preset
   * colours. Needs a signed-in account and one mytags fetch. */
  ehMyTagsPriority: z.boolean().default(false),
  /** SFW 模式：所有封面模糊显示，悬停/点击才临时显示该封面，移开或失焦恢复。 */
  sfwMode: z.boolean().default(false),
  detailActions: z.array(z.enum(DETAIL_ACTIONS)).max(6).default(DEFAULT_DETAIL_ACTIONS),
  /** Which time the detail overview prints as its fourth fact: the archive's
   * own publish date (default) or the moment this library added it. */
  detailDateKind: z.enum(['added', 'published']).default('published'),
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
  /** 自动同步：启动、回到前台、写入之后、网络恢复与定时巡检各触发一次。
   * 关掉就只剩设置里的「立即同步」。 */
  autoSync: z.boolean().default(true),
  /** 导入导出范围：手动带走的文件里装哪几类（记录与设置，外加可勾的凭据）。
   * 与同步范围无关，默认只勾记录与设置。 */
  dataTransferScope: z.array(z.string().max(32)).max(12).default([...DEFAULT_DATA_TRANSFER_SCOPE]),
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
  upscaleAutoEnable: false,
  upscaleAutoThresholdBytes: 512_000,
  decensorModel: '',
  downloadDirectory: '',
  ehFavoriteDeleteSync: false,
  confirmEhFavoriteDelete: true,
  continueReadingShowFinished: true,
  randomRoamShowFinished: true,
  ehMyTagsPriority: false,
  sfwMode: false,
  detailActions: [...DEFAULT_DETAIL_ACTIONS],
  detailDateKind: 'published',
  customCss: '',
  floatingNav: false,
  bottomNavItems: ['home', 'library', 'history', 'watchlist', 'settings'],
  autoSync: true,
  dataTransferScope: [...DEFAULT_DATA_TRANSFER_SCOPE],
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
