import { z } from 'zod';

/** 数据迁移（docs/30 重构后）：一份明文 JSON，装什么由导出弹层的勾选决定。
 *
 * 旧的两条路——「导入导出范围」偏好 + 口令加密的凭据文件——都移除了：防泄漏的
 * 防线是勾选凭据时的知情提醒，不是一把口令。`yomika-credentials`（旧口令格式）
 * 不再生成，也不再支持导入。
 */
export const DATA_EXPORT_KIND = 'yomika-export';
export const DATA_EXPORT_VERSION = 1;

/** 导出/导入弹层里的条目：`credential` 标记的是含敏感信息的那几类，勾选时界面
 * 必须提醒「切勿分享」。 */
export const DATA_EXPORT_ITEMS = [
  { id: 'records', label: '记录与设置', hint: '阅读进度、历史、待看、搜索预设、非重复标记与应用设置', credential: false },
  { id: 'lrr_servers', label: 'LANraragi 服务器', hint: '服务器条目与 API Key', credential: true },
  { id: 'eh_account', label: 'E-Hentai 账户', hint: '账户与登录 Cookie', credential: true },
  { id: 'sync_accounts', label: '同步账户', hint: 'WebDAV/S3 账户与口令', credential: true },
] as const;

export type DataExportItem = (typeof DATA_EXPORT_ITEMS)[number]['id'];

export function isCredentialItem(id: string): boolean {
  return DATA_EXPORT_ITEMS.some((item) => item.id === id && item.credential);
}

export function dataExportItemLabel(id: string): string {
  return DATA_EXPORT_ITEMS.find((item) => item.id === id)?.label ?? id;
}

/** 导出结果：那份文本、实际装进的条目，以及各类条目的条数。 */
export const DataExportReportSchema = z.object({
  text: z.string().min(1),
  items: z.array(z.string()),
  records: z.number().int().nonnegative(),
  servers: z.number().int().nonnegative(),
  ehAccounts: z.number().int().nonnegative(),
  syncAccounts: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type DataExportReport = z.infer<typeof DataExportReportSchema>;

/** 导入结果：勾选的各类各落地了多少条。 */
export const DataImportReportSchema = z.object({
  records: z.number().int().nonnegative(),
  servers: z.number().int().nonnegative(),
  ehAccounts: z.number().int().nonnegative(),
  syncAccounts: z.number().int().nonnegative(),
});
export type DataImportReport = z.infer<typeof DataImportReportSchema>;
