import { invokeCommand } from '../bridge/invoke';
import {
  CredentialExportReportSchema,
  CredentialImportReportSchema,
  type CredentialExportReport,
  type CredentialImportReport,
} from '../domain/credentialWire';
import type { CommandResult } from '../domain/result';

/** 凭据的进出口：一个口令加密的文件。
 *
 * 与同步分开是有意的——同步不带凭据（见 docs/06 的范围表），而"换台机器"总要有个
 * 出口。口令只在这两条调用里存在：不进日志（redaction 认 `passphrase` 这个键名）、
 * 不落盘、不随任何请求上远端。
 *
 * `categories` 是「导入导出范围」里勾中的凭据类（JSON 数组）。没勾的类既不进文件，
 * 导入时也不会落地。 */
export class NativeCredentialRepository {
  /** `records` 是已经折好的记录与设置（`export_scoped_data` 的那份文本）：交进来就
   * 和凭据一起锁进同一份密文——范围里勾了记录又勾了凭据时，文件只有一份。 */
  exportAll(passphrase: string, categories: string, records?: string): Promise<CommandResult<CredentialExportReport>> {
    return invokeCommand('export_credentials', { passphrase, categories, records: records ?? null }, CredentialExportReportSchema);
  }

  /** `recordCategories` 是记录那一半的勾选：文件里装着记录且这里非空时，它们按同步的
   * 合并规则一起落地。 */
  importAll(payload: string, passphrase: string, categories: string, recordCategories: string): Promise<CommandResult<CredentialImportReport>> {
    return invokeCommand('import_credentials', { payload, passphrase, categories, recordCategories }, CredentialImportReportSchema);
  }
}
