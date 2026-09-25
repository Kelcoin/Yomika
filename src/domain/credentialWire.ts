import { z } from 'zod';

/** 凭据文件的信封标记。
 *
 * 同步刻意不带凭据（同步密钥由账户口令派生、API Key 与 Cookie 是这台设备的授权），
 * 换机器时走的就是这份口令加密的文件：导出与导入都在这条路上，与同步互不影响。
 * 导入时靠这个 `kind` 与同步文档（`yomika-scope-export`）分流。 */
export const CREDENTIAL_EXPORT_KIND = 'yomika-credentials';

/** 口令的最短长度：与原生侧一致（文件离开这台机器后，口令是它唯一的防线）。 */
export const MIN_PASSPHRASE_CHARS = 8;

/** 导出结果：那份密文文本，以及各类条目带上了多少条、有多少条读不到凭据而没带上。
 *
 * 文件里除了凭据还可能装着**记录与设置**（范围里同时勾了记录时，两半锁在同一份密文
 * 里）：`records` 是那一半的条数，0 表示这次只带了凭据。 */
export const CredentialExportReportSchema = z.object({
  text: z.string().min(1),
  servers: z.number().int().nonnegative(),
  ehAccounts: z.number().int().nonnegative(),
  syncAccounts: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export type CredentialExportReport = z.infer<typeof CredentialExportReportSchema>;

/** 导入结果：三类条目各写回了多少条，以及文件里那一半记录与设置落地了几条
 * （`recordsSkipped` 表示文件里有记录、但这次一个记录类都没勾）。 */
export const CredentialImportReportSchema = z.object({
  servers: z.number().int().nonnegative(),
  ehAccounts: z.number().int().nonnegative(),
  syncAccounts: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  recordsSkipped: z.boolean(),
});

export type CredentialImportReport = z.infer<typeof CredentialImportReportSchema>;
