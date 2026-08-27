import { ok, type CommandResult } from '../domain/result';
import {
  PlatformCapabilitiesSchema,
  type PlatformCapabilities,
} from '../domain/platform';
import { invokeCommand } from './invoke';

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
