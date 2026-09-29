import { z } from 'zod';

import { invokeBinaryCommand, invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

/** 一项能力：移动端据此显示「对面有什么、能不能用」。 */
export const ComputeCapabilitySchema = z.object({
  id: z.string(),
  label: z.string(),
  ready: z.boolean(),
  detail: z.string(),
});

export type ComputeCapability = z.output<typeof ComputeCapabilitySchema>;

export const ComputeCenterStatusSchema = z.object({
  running: z.boolean(),
  port: z.number().int(),
  /** 本机在局域网里的地址，照着念给移动端。 */
  addresses: z.array(z.string()),
  token: z.string(),
  capabilities: z.array(ComputeCapabilitySchema),
  /** 至少一项能力齐全——没有就不允许开。 */
  canStart: z.boolean(),
});

export type ComputeCenterStatus = z.output<typeof ComputeCenterStatusSchema>;

export const RemoteCapabilitiesSchema = z.object({
  service: z.string(),
  version: z.number().int(),
  name: z.string(),
  capabilities: z.array(ComputeCapabilitySchema),
});

export type RemoteCapabilities = z.output<typeof RemoteCapabilitiesSchema>;

/** 远端处理参数：发什么、用什么模型。 */
export const RemoteOpSchema = z
  .object({
    /** `upscale` / `decensor` / `dlssnr`。 */
    op: z.enum(['upscale', 'decensor', 'dlssnr']).default('upscale'),
    modelId: z.string().max(128).default(''),
    scale: z.number().int().min(1).max(4).default(2),
    /** DLSS5 的层参数，形状与本地那份一致。 */
    dlssnrPasses: z.array(z.record(z.string(), z.union([z.number(), z.boolean()]))).max(3).default([]),
  })
  .strip();

export type RemoteOp = z.output<typeof RemoteOpSchema>;

/** 远端处理的设置：只作用于远端那一次处理，不动两侧任何一方的本机设置。 */
export const RemoteOpsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** 从哪一版页面开始送：原图 / 已去码 / 已超分。 */
    source: z.enum(['reader-page', 'decensored', 'enhanced']).default('reader-page'),
    op: RemoteOpSchema.default({}),
  })
  .strip();

export type RemoteOps = z.output<typeof RemoteOpsSchema>;

export const DEFAULT_REMOTE_OPS: RemoteOps = {
  enabled: false,
  source: 'reader-page',
  op: { op: 'upscale', modelId: '', scale: 2, dlssnrPasses: [] },
};

/** 把偏好里那段 JSON 读成远端设置：坏数据回默认，不让设置页崩。 */
export function parseRemoteOps(encoded: string): RemoteOps {
  if (!encoded.trim()) return DEFAULT_REMOTE_OPS;
  try {
    const parsed = RemoteOpsSchema.safeParse(JSON.parse(encoded));
    return parsed.success ? parsed.data : DEFAULT_REMOTE_OPS;
  } catch {
    return DEFAULT_REMOTE_OPS;
  }
}

export function serializeRemoteOps(ops: RemoteOps): string {
  return JSON.stringify(RemoteOpsSchema.parse(ops));
}

export class NativeComputeCenterRepository {
  status(): Promise<CommandResult<ComputeCenterStatus>> {
    return invokeCommand('compute_center_status', {}, ComputeCenterStatusSchema);
  }

  /** 开关本机的算力中心，或换端口 / 换令牌。 */
  configure(input: {
    enabled: boolean;
    port?: number;
    rotateToken?: boolean;
  }): Promise<CommandResult<ComputeCenterStatus>> {
    return invokeCommand('compute_center_configure', input, ComputeCenterStatusSchema);
  }

  /** 连一次远端，拿它的能力清单。 */
  remoteCapabilities(url: string, token: string): Promise<CommandResult<RemoteCapabilities>> {
    return invokeCommand('remote_compute_capabilities', { url, token }, RemoteCapabilitiesSchema);
  }

  /** 把本机缓存里的一页发给远端处理，取回 PNG 字节。
   *
   * `source` 是起点那一版；它是本地某一步的产物时，产出它的模型 id 要一并给出
   * （与 DLSS5 那条路同一个规矩：起点按模型指纹存，算不出同一个 revision 就读不到）。 */
  remoteProcess(input: {
    url: string;
    token: string;
    params: {
      op: string;
      modelId?: string;
      scale?: number;
      dlssnr?: unknown;
    };
    scopeId: string;
    archiveId: string;
    pageIndex: number;
    source?: 'reader-page' | 'decensored' | 'enhanced';
    decensorModel?: string;
    upscaleModel?: string;
    taskId?: string;
  }): Promise<CommandResult<ArrayBuffer>> {
    return invokeBinaryCommand('remote_compute_process', { input });
  }
}
