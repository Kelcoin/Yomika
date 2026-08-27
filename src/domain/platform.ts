import { z } from 'zod';

export const PlatformCapabilitiesSchema = z.object({
  platform: z.enum(['windows', 'macos', 'linux', 'android', 'ios', 'browser']),
  native: z.boolean(),
  secureStorage: z.boolean(),
  fileSystem: z.boolean(),
  backgroundTasks: z.boolean(),
  nativeInference: z.boolean(),
});

export type PlatformCapabilities = z.infer<typeof PlatformCapabilitiesSchema>;
