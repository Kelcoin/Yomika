import { z } from 'zod';

import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import {
  WebdavAccountSchema,
  type SaveWebdavAccountInput,
  type WebdavAccount,
} from '../domain/syncWire';
import type { CommandResult } from '../domain/result';

/** 同步只剩三件事：账户、同步一次、重置远端。
 *
 * 段与清单那套（build_segment / encrypt_manifest / merge_manifests / 认领日志…）已经
 * 全部并进原生侧的同步引擎：远端现在是「一个账户一个文档」，本地日志也只由原生命令
 * 写入与消费，所以桥这边不再逐个暴露中间件。 */
export class NativeSyncRepository {
  saveAccount(input: SaveWebdavAccountInput): Promise<CommandResult<WebdavAccount>> {
    return invokeCommand('save_webdav_account', { input }, WebdavAccountSchema);
  }

  listAccounts(): Promise<CommandResult<WebdavAccount[]>> {
    return invokeCommand('list_webdav_accounts', {}, z.array(WebdavAccountSchema));
  }

  syncWebdavScope(accountId: string, scopeId: string): Promise<CommandResult<number>> {
    return invokeCommand('sync_webdav_scope', { accountId, scopeId }, z.number().int().nonnegative());
  }

  /** 「编辑」时回显已存的口令：凭据平时只在系统安全存储里，按需读一次。 */
  accountCredential(accountId: string): Promise<CommandResult<string>> {
    return invokeCommand('webdav_account_credential', { accountId }, z.string());
  }

  /** 删掉账户的远端文档；下次同步会按本地状态重新写一份。 */
  resetRemote(accountId: string): Promise<CommandResult<void>> {
    return invokeCommand('reset_webdav_state', { accountId }, VoidResponseSchema);
  }
}
