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

/** 本体更新检查的结果（`app_release_latest`）。
 *
 * `latest` 已经去掉标签的 `v` 前缀，`pageUrl` 是「前往下载」要打开的地址：正常来自
 * release 负载里的 `html_url`，拿不到时原生侧退回仓库的 releases/latest 页。 */
export const AppReleaseSchema = z.object({
  current: z.string(),
  latest: z.string(),
  updateAvailable: z.boolean(),
  pageUrl: z.string(),
  publishedAt: z.string().nullish(),
});
export type AppRelease = z.infer<typeof AppReleaseSchema>;

/** 错误日志的「相关信息」要的两样：这份二进制是怎么编的，以及跑在哪个平台上。 */
export class NativeAppInfoRepository {
  buildInfo(): Promise<CommandResult<AppBuildInfo>> {
    return invokeCommand('app_build_info', {}, AppBuildInfoSchema);
  }

  /** 问一次 GitHub：有没有比这份二进制更新的正式发布。
   *
   * 离线、限流、GitHub 抽风都只是失败结果，调用方只在成功且 `updateAvailable`
   * 时才打扰用户，所以这里不重试、也不额外报错。 */
  appReleaseLatest(): Promise<CommandResult<AppRelease>> {
    return invokeCommand('app_release_latest', {}, AppReleaseSchema);
  }

  /** 平台名复用 `platform_capabilities`：它已经在每个平台上被问过很多次。 */
  async platformName(): Promise<CommandResult<string>> {
    const result = await invokeCommand('platform_capabilities', {}, PlatformCapabilitiesSchema);
    return result.ok ? { ok: true, value: result.value.platform } : result;
  }
}
