import { z } from 'zod';

import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

export const ErrorLogEntrySchema = z.object({
  /** ISO-8601，或 Rust 侧 panic 写的 `epoch:<毫秒>`。 */
  at: z.string(),
  level: z.string(),
  source: z.string(),
  message: z.string(),
  detail: z.string().nullable().optional(),
});
export type ErrorLogEntry = z.infer<typeof ErrorLogEntrySchema>;

/** 后端那份本次运行的错误日志：读取与导出。写入走 `src/lib/errorLog.ts`，
 * 它不经过这层（否则 bridge 记日志要绕回 bridge 自己）。 */
export class NativeErrorLogRepository {
  list(): Promise<CommandResult<ErrorLogEntry[]>> {
    return invokeCommand('error_log_read', {}, z.array(ErrorLogEntrySchema));
  }

  /** 内容由调用方给：导出的就是界面上那一份，原生侧只负责写到用户选的位置
   * （Android 上 `dialog.save` 给的是 SAF 的 `content://` URI，只有原生侧写得进去）。 */
  exportTo(path: string, contents: string): Promise<CommandResult<string>> {
    return invokeCommand('error_log_export', { path, contents }, z.string());
  }

  /** 清空本次与上次两轮的全部记录（含崩溃现场），返回删掉了几条。 */
  clear(): Promise<CommandResult<number>> {
    return invokeCommand('error_log_clear', {}, z.number().int().nonnegative());
  }
}
