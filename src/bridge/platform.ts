import { z } from 'zod';

import { ok, type CommandResult } from '../domain/result';
import {
  PlatformCapabilitiesSchema,
  SystemInsetsSchema,
  type PlatformCapabilities,
  type SystemInsets,
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

/** 系统栏（状态栏、手势条）占掉的高度。Android 上只有原生侧知道——WebView 只把刘海交给
 * `env(safe-area-inset-*)`，状态栏与手势条的高度从来不暴露给页面；其余平台是 0。 */
export async function getSystemInsets(): Promise<CommandResult<SystemInsets>> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return ok({ top: 0, bottom: 0 });
  return invokeCommand('system_insets', {}, SystemInsetsSchema);
}

/** 系统栏图标的明暗与窗口底色：跟着**应用主题**，不跟系统主题（Android 实现，其余平台
 * 空操作）。 */
export async function setSystemBarStyle(dark: boolean, background: string): Promise<CommandResult<void>> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return ok(undefined);
  return invokeCommand('set_system_bar_style', { dark, background }, VoidResponseSchema);
}

/** Reader immersion affects only the status bar; navigation gestures remain available. */
export async function setStatusBarVisible(visible: boolean): Promise<CommandResult<void>> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return ok(undefined);
  return invokeCommand('set_status_bar_visible', { visible }, VoidResponseSchema);
}

/** 在资源管理器里定位一个本机文件。仅 Windows 实现；别的平台返回失败，
 * 调用方应当按平台先藏掉入口。 */
export function revealInFileManager(path: string): Promise<CommandResult<void>> {
  return invokeCommand('reveal_in_file_manager', { path }, VoidResponseSchema);
}

export async function showSystemToast(text: string): Promise<boolean> {
  const result = await invokeCommand('show_system_toast', { text }, z.boolean());
  return result.ok && result.value;
}
