import { z } from 'zod';
import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';
import { PlatformCapabilitiesSchema, type PlatformCapabilities } from '../domain/platform';

export class NativePlatformRepository {
  getCapabilities(): Promise<CommandResult<PlatformCapabilities>> {
    return invokeCommand('platform_capabilities', {}, PlatformCapabilitiesSchema);
  }
}
