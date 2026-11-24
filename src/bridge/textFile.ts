import { invokeCommand } from './invoke';
import type { CommandResult } from '../domain/result';
import { z } from 'zod';

/** 导出的文本与文件之间的那一跳。
 *
 * 桌面走 `std::fs`，Android 走原生：SAF 交回来的 `content://` URI 只有 ContentResolver
 * 读得动、写得动（系统的「新建文档」还会先把文件建好，零字节），所以这两个命令在原生侧
 * 各有一条 `mobile_host` 通道。 */

/** iOS 接收建议文件名，由原生导出面板选择位置；取消时返回 null。 */
export function saveTextToFile(path: string, contents: string): Promise<CommandResult<string | null>> {
  return invokeCommand('save_text_file', { path, contents }, z.string().min(1).nullable());
}

/** 读回一份文本文件。 */
export function readTextFromFile(path: string): Promise<CommandResult<string>> {
  return invokeCommand('read_text_file', { path }, z.string());
}
