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

/** 系统栏（状态栏 / 手势条）占掉的高度，CSS 像素。 */
export const SystemInsetsSchema = z.object({
  top: z.number(),
  bottom: z.number(),
});

export type SystemInsets = z.infer<typeof SystemInsetsSchema>;
