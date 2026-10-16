import { z } from 'zod';

import { invokeCommand } from '../bridge/invoke';
import { DataExportReportSchema, DataImportReportSchema, type DataExportReport, type DataImportReport } from '../domain/dataExport';
import type { CommandResult } from '../domain/result';

/** Keep in step with `MAX_PREFETCH_PAGES` in src-tauri/src/settings.rs. */
export const MAX_PREFETCH_PAGES = 10;

export const DETAIL_ACTIONS = ['read', 'readingList', 'favorites', 'download', 'edit', 'clearProgress', 'delete'] as const;
export const DEFAULT_DETAIL_ACTIONS: (typeof DETAIL_ACTIONS)[number][] = ['read', 'readingList', 'favorites', 'download'];

export const PreferenceSnapshotSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  defaultLayout: z.enum(['auto', 'single', 'double', 'webtoon']),
  defaultDirection: z.enum(['ltr', 'rtl']),
  allowProgressRegression: z.boolean().default(true),
  progressBarVisibility: z.enum(['none', 'history', 'all']).default('history'),
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
  upscaleAutoTagMode: z.enum(['whitelist', 'blacklist']).default('whitelist'),
  upscaleAutoWhitelist: z.string().max(2000).default('category:doujinshi\ncategory:manga'),
  upscaleAutoBlacklist: z.string().max(2000).default('other:3d\ncategory:cosplay\ncategory:asian porn'),
  /** The auto-enable threshold in bytes per page. Default 500 KB. */
  upscaleAutoThresholdBytes: z.number().int().min(64 * 1024).max(8 * 1024 * 1024).default(512_000),
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
  detailActions: z.array(z.enum(DETAIL_ACTIONS)).max(7).default(DEFAULT_DETAIL_ACTIONS),
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
  startWithWindows: z.boolean().default(false),
  closeToTray: z.boolean().default(false),
  tagTranslationEnabled: z.boolean().default(true),
  tagCountOrderEnabled: z.boolean().default(true),
  /** DLSSNR：阅读器里对这一页跑 1–5 层 NVIDIA 的神经渲染。 */
  dlssnrEnabled: z.boolean().default(false),
  /** 每层参数的 JSON 数组（形状见 dlssnr 的 PassSettings）。存字符串是为了让后端
   * 保持平台无关：非 Windows 的构建也能原样存住这份偏好。 */
  dlssnrPasses: z.string().max(4000).default(''),
  /** 本机作为算力中心：局域网里让移动端借这台机器的超分/DLSSNR。 */
  computeCenterEnabled: z.boolean().default(false),
  computeCenterPort: z.number().int().min(1024).max(65535).default(47653),
  /** 算力中心的令牌：要能显示给用户抄到移动端上，所以明文存在本机设置里。 */
  computeCenterToken: z.string().max(128).default(''),
  /** 远端算力：这一页发给哪台桌面端处理（空 = 不用远端）。 */
  remoteComputeUrl: z.string().max(256).default(''),
  remoteComputeToken: z.string().max(128).default(''),
  /** 远端处理用的参数（JSON 对象）。只作用于远端那一侧的处理，不改本机自己的
   * 超分/DLSSNR 设置，也不去改远端机器上的设置。 */
  remoteComputeOps: z.string().max(4000).default(''),
  /** 导入导出范围：手动带走的文件里装哪几类（记录与设置，外加可勾的凭据）。
   * 与同步范围无关，默认只勾记录与设置。 */
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
  allowProgressRegression: true,
  progressBarVisibility: 'history',
  cacheMaxBytes: 2_147_483_648,
  prefetchPages: 2,
  coverConcurrency: 4,
  startupRoute: 'home',
  cardStyle: 'wide',
  upscaleBackend: 'off',
  upscaleModel: '',
  upscaleAutoEnable: false,
  upscaleAutoTagMode: 'whitelist',
  upscaleAutoWhitelist: 'category:doujinshi\ncategory:manga',
  upscaleAutoBlacklist: 'other:3d\ncategory:cosplay\ncategory:asian porn',
  upscaleAutoThresholdBytes: 512_000,
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

  /** 数据迁移（docs/30）：按勾选的条目导出一份明文 JSON；凭据以明文进文件，
   * 勾选时的敏感信息提醒由界面负责。 */
  exportData(items: string[]): Promise<CommandResult<DataExportReport>> {
    return invokeCommand('export_data', { items }, DataExportReportSchema);
  }

  /** 导入：`items` 是用户在导入弹层里勾选的条目，文件里有但没勾的类如实跳过。 */
  importData(payload: string, items: string[]): Promise<CommandResult<DataImportReport>> {
    return invokeCommand('import_data', { payload, items }, DataImportReportSchema);
  }
}
