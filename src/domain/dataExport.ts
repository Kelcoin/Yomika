import { z } from 'zod';

/** 数据迁移（docs/30 重构后）：一份明文 JSON，装什么由导出弹层的勾选决定。
 *
 * 旧的两条路——「导入导出范围」偏好 + 口令加密的凭据文件——都移除了：防泄漏的
 * 防线是勾选凭据时的知情提醒，不是一把口令。`yomika-credentials`（旧口令格式）
 * 不再生成，也不再支持导入。
 */
export const DATA_EXPORT_KIND = 'yomika-export';
export const DATA_EXPORT_VERSION = 1;

export type DataExportItem = string;

/** 按类别显式迁移阅读记录与应用设置。 */
export const DATA_EXPORT_RECORD_ITEMS: readonly { id: DataExportItem; label: string }[] = [
  { id: 'progress', label: '阅读进度' },
  { id: 'history', label: '历史' },
  { id: 'watchlist', label: '待看' },
  { id: 'search_presets', label: '搜索预设' },
  { id: 'dedup', label: '非重复标记' },
  { id: 'app_settings', label: '应用设置' },
];

/** 含敏感信息的三类：勾选时界面必须提醒「切勿分享」。 */
export const DATA_EXPORT_CREDENTIAL_ITEMS: readonly { id: DataExportItem; label: string; credential: true }[] = [
  { id: 'lrr_servers', label: 'LANraragi 服务器', credential: true },
  { id: 'eh_account', label: 'E-Hentai 账户', credential: true },
];

export const DATA_EXPORT_ITEMS = [...DATA_EXPORT_RECORD_ITEMS, ...DATA_EXPORT_CREDENTIAL_ITEMS];

/** 默认勾选：记录与设置的六类。凭据要使用者自己勾上——默认带走口令是坏默认。 */
export const DEFAULT_DATA_EXPORT_ITEMS: readonly DataExportItem[] =
  DATA_EXPORT_RECORD_ITEMS.map((item) => item.id);

/** 旧文件把六类记录与设置合成过一条 `records`，导入端仍要认它、也要叫得出名字，
 * 但它不在可勾选清单里：现在导出永远写六类，让「勾了什么就是什么」成立。 */
const LEGACY_ITEM_LABELS: Record<string, string> = { records: '记录与设置' };

export function isCredentialItem(id: string): boolean {
  return DATA_EXPORT_CREDENTIAL_ITEMS.some((item) => item.id === id);
}

export function dataExportItemLabel(id: string): string {
  return DATA_EXPORT_ITEMS.find((item) => item.id === id)?.label ?? LEGACY_ITEM_LABELS[id] ?? id;
}

/** 导出结果：那份文本、实际装进的条目，以及各类条目的条数。 */
export const DataExportReportSchema = z.object({
  text: z.string().min(1),
  items: z.array(z.string()),
  records: z.number().int().nonnegative(),
  servers: z.number().int().nonnegative(),
  ehAccounts: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type DataExportReport = z.infer<typeof DataExportReportSchema>;

/** 导入结果：勾选的各类各落地了多少条，以及没能落地的类数（文件里没有内容，
 *  或本机读不出那份凭据——Rust 侧照实报，界面照实说）。 */
export const DataImportReportSchema = z.object({
  records: z.number().int().nonnegative(),
  servers: z.number().int().nonnegative(),
  ehAccounts: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type DataImportReport = z.infer<typeof DataImportReportSchema>;

/** 旧版按范围导出文件的导入结果。 */
export const ScopedImportReportSchema = z.object({
  applied: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  categories: z.array(z.string()),
});
export type ScopedImportReport = z.infer<typeof ScopedImportReportSchema>;
