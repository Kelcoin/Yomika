import { ok, type CommandResult } from '../domain/result';
import {
  PlatformCapabilitiesSchema,
  type PlatformCapabilities,
} from '../domain/platform';
import { VoidResponseSchema, invokeCommand } from './invoke';

export async function getPlatformCapabilities(): Promise<CommandResult<PlatformCapabilities>> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return ok({
      platform: 'browser',
      native: false,
      secureStorage: false,
      fileSystem: false,
      backgroundTasks: false,
      nativeInference: false,
    });
  }

  return invokeCommand('platform_capabilities', {}, PlatformCapabilitiesSchema);
}

/** 在资源管理器里定位一个本机文件。仅 Windows 实现；别的平台返回失败，
 * 调用方应当按平台先藏掉入口。 */
export function revealInFileManager(path: string): Promise<CommandResult<void>> {
  return invokeCommand('reveal_in_file_manager', { path }, VoidResponseSchema);
}
