import { z } from 'zod';

import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import {
  ScopedExportReportSchema,
  ScopedImportReportSchema,
  SyncAccountSchema,
  type SaveSyncAccountInput,
  type ScopedExportReport,
  type ScopedImportReport,
  type SyncAccount,
} from '../domain/syncWire';
import type { CommandResult } from '../domain/result';

/** 同步只剩三件事：账户、同步一次、重置远端。账户可以是 WebDAV 目录或 S3
 * 兼容对象存储（Cloudflare R2、MinIO…），区别只在原生侧怎么读写那份文档。
 *
 * 段与清单那套（build_segment / encrypt_manifest / merge_manifests / 认领日志…）已经
 * 全部并进原生侧的同步引擎：远端现在是「一个账户一个文档」，本地日志也只由原生命令
 * 写入与消费，所以桥这边不再逐个暴露中间件。 */
export class NativeSyncRepository {
  saveAccount(input: SaveSyncAccountInput): Promise<CommandResult<SyncAccount>> {
    return invokeCommand('save_sync_account', { input }, SyncAccountSchema);
  }

  listAccounts(): Promise<CommandResult<SyncAccount[]>> {
    return invokeCommand('list_sync_accounts', {}, z.array(SyncAccountSchema));
  }

  /** 「测试」：拿表单里当前的字段连一次远端（只读），返回一句人话结论。 */
  testAccount(input: SaveSyncAccountInput): Promise<CommandResult<string>> {
    return invokeCommand('test_sync_account', { input }, z.string());
  }

  /** 「同步范围」设置行：勾选后立刻写回账户，不必再走账户表单。 */
  saveScope(accountId: string, syncScope: string): Promise<CommandResult<SyncAccount>> {
    return invokeCommand('save_sync_scope', { accountId, syncScope }, SyncAccountSchema);
  }

  syncRemoteScope(accountId: string, scopeId: string): Promise<CommandResult<number>> {
    return invokeCommand('sync_remote_scope', { accountId, scopeId }, z.number().int().nonnegative());
  }

  /** 「编辑」时回显已存的凭据（WebDAV 口令 / S3 Secret Key）：平时只在系统安全存储里，按需读一次。 */
  accountCredential(accountId: string): Promise<CommandResult<string>> {
    return invokeCommand('sync_account_credential', { accountId }, z.string());
  }

  /** 删掉账户的远端文档；下次同步会按本地状态重新写一份。 */
  resetRemote(accountId: string): Promise<CommandResult<void>> {
    return invokeCommand('reset_remote_state', { accountId }, VoidResponseSchema);
  }

  /** 按勾选的同步范围导出本地数据：原生侧把本地日志折成同步文档（每个对象的最新
   * 一版，含墓碑）再套一层信封，所以导入端跑的是同一条合并规则。 */
  exportScopedData(categories: string): Promise<CommandResult<ScopedExportReport>> {
    return invokeCommand('export_scoped_data', { categories }, ScopedExportReportSchema);
  }

  /** 导入那份导出文件：按同步的合并规则并进本地，并写日志让它能推给别的设备。 */
  importScopedData(payload: string, categories: string): Promise<CommandResult<ScopedImportReport>> {
    return invokeCommand('import_scoped_data', { payload, categories }, ScopedImportReportSchema);
  }
}
