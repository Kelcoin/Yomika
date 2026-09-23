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
  exportAll(passphrase: string, categories: string): Promise<CommandResult<CredentialExportReport>> {
    return invokeCommand('export_credentials', { passphrase, categories }, CredentialExportReportSchema);
  }

  importAll(payload: string, passphrase: string, categories: string): Promise<CommandResult<CredentialImportReport>> {
    return invokeCommand('import_credentials', { payload, passphrase, categories }, CredentialImportReportSchema);
  }
}
