import { z } from 'zod';

import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';
import { PlatformCapabilitiesSchema } from '../domain/platform';

/** 出问题时最先要问的几件事。`buildTime` 是 unix 秒的字符串（Rust 侧不格式化时间），
 * `commit`/`buildTime` 在拿不到时是空串——界面按缺项处理。 */
export const AppBuildInfoSchema = z.object({
  version: z.string(),
  buildTime: z.string().default(''),
  commit: z.string().default(''),
  profile: z.string().default(''),
  identifier: z.string().default(''),
  platform: z.string(),
  os: z.string(),
  arch: z.string(),
});
export type AppBuildInfo = z.infer<typeof AppBuildInfoSchema>;

/** 错误日志的「相关信息」要的两样：这份二进制是怎么编的，以及跑在哪个平台上。 */
export class NativeAppInfoRepository {
  buildInfo(): Promise<CommandResult<AppBuildInfo>> {
    return invokeCommand('app_build_info', {}, AppBuildInfoSchema);
  }

  /** 平台名复用 `platform_capabilities`：它已经在每个平台上被问过很多次。 */
  async platformName(): Promise<CommandResult<string>> {
    const result = await invokeCommand('platform_capabilities', {}, PlatformCapabilitiesSchema);
    return result.ok ? { ok: true, value: result.value.platform } : result;
  }
}
