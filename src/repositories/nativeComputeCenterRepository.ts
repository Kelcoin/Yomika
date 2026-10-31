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
  windowsServiceSupported: z.boolean().default(false),
  windowsServiceInstalled: z.boolean().default(false),
  port: z.number().int(),
  /** 本机在局域网里的地址，照着念给移动端。 */
  addresses: z.array(z.string()),
  token: z.string(),
  capabilities: z.array(ComputeCapabilitySchema),
  /** 保留的状态字段；允许先启动再安装模型。 */
  canStart: z.boolean(),
  /** `kind` 是配对时对面报上来的设备类型（`phone` / `tablet` / `desktop`）；这一版之前
   *  配的对没有这个字段，旧记录照样要能读——缺了就是「不知道」，界面画通用图标。 */
  pairedClients: z.array(z.object({ id: z.string(), name: z.string(), address: z.string(), kind: z.string().nullish() })).default([]),
});

export type ComputeCenterStatus = z.output<typeof ComputeCenterStatusSchema>;

/** 配对列表变了（另一台设备刚配对成功）：本机设置页收到就重拉，不必退出再进。
 *
 * 事件由本机 HTTP 服务的 `/v2/pair/confirm` 在配对成功后广播（Rust 侧同名常量
 * `PAIRING_CHANGED_EVENT`，见 `src-tauri/src/compute_center.rs`）——那次配对不是
 * 本机前端发起的，除了这条事件它没有任何别的办法知道列表变了。 */
export const COMPUTE_CENTER_PAIRING_CHANGED_EVENT = 'compute-center-pairing-changed';

/** 有人请求配对，本机要显示六位码：本机 HTTP 服务的 `/v2/pair/request` 广播这条事件
 *  （Rust 侧同名常量 `PAIRING_CODE_EVENT`，见 `src-tauri/src/compute_center.rs`）。
 *
 *  码只给人看，所以它不走命令的返回值：发起配对的是**另一台设备**，本机前端什么都没调用，
 *  除了这条广播没有别的来路。 */
export const COMPUTE_CENTER_PAIRING_CODE_EVENT = 'compute-center-pairing-code';

/** 配对码通告：`code` 是要在对面输入的六位数字，`name` / `address` 是那台设备的自称与 IP
 *  （给它一个「这是谁在请求」的交代），`expiresInSeconds` 供前端做倒计时。 */
export const PairingCodeNoticeSchema = z.object({
  code: z.string().min(1),
  name: z.string().default(''),
  address: z.string().default(''),
  expiresInSeconds: z.number().int().positive().default(90),
});

export type PairingCodeNotice = z.output<typeof PairingCodeNoticeSchema>;

export const RemoteCapabilitiesSchema = z.object({
  service: z.string(),
  version: z.number().int(),
  name: z.string(),
  capabilities: z.array(ComputeCapabilitySchema),
  models: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), scale: z.number().nullable() })).default([]),
  /** 对面那份**实际处理计划**的版本（模型内容 + 归一化参数 + 链顺序 + 那份 DLL 的内容）。
   *  老版本对面不发这一栏，所以缺省是空串——空的就不是一版身份，别拿它建键（docs/175 R11）。 */
  revision: z.string().default(''),
});

export type RemoteCapabilities = z.output<typeof RemoteCapabilitiesSchema>;

export const DiscoveredDeviceSchema = z.object({ address: z.string(), name: z.string(), port: z.number().int() });
export type DiscoveredDevice = z.output<typeof DiscoveredDeviceSchema>;
const PairRequestSchema = z.object({ requestId: z.string() });
const PairResultSchema = z.object({ token: z.string(), name: z.string() });

/** 远端能提供的那几档；`id` 与对面 `/v2/capabilities` 里 `Capability.id` 同一套。 */
export const REMOTE_SERVICE_IDS = ['upscale', 'dlssnr'] as const;

export type RemoteService = (typeof REMOTE_SERVICE_IDS)[number];

/** 对面这份清单里，某一档现在能不能用（没拿到清单就是不能用）。 */
export function remoteServiceReady(capabilities: RemoteCapabilities | undefined, service: RemoteService): boolean {
  return capabilities?.capabilities.some((item) => item.id === service && item.ready) === true;
}

/** 远端处理的设置：只剩「用不用」与「配过哪些设备」。
 *
 *  从前这里还存着一份「这一次处理怎么做」——哪一档、哪个模型、放大几倍、DLSSNR 走哪几层，
 *  现在整个删掉了。理由不只是「设置项太多」：对面 `/v2/process` 在客户端不传 `model_id`
 *  时取的是**它自己**的默认模型，不传 `dlssnr` 时取 `DlssnrSettings::default()`；本机再存
 *  一套，只会出现「这边显示按 4 倍跑，对面其实照自己的设置跑 2 倍」这种对不上的情况。
 *  处理方式固定跟随对面那份设置，本机只决定「用不用远端」和「这一页做哪几档」。
 *
 *  `.strip()`：旧数据里多出来的那几个键读进来直接丢掉，用户升上来不会因为多几个键就回默认。
 *
 *  `pairedDevices` 只留一台：这台机器是**它自己**的算力来源，配对确认时服务器那边整表替换，
 *  本地清单跟着收成一格。这里不写成 `.max(1)`——旧版本可能存着好几台，`.max(1)` 会让整份
 *  JSON 校验失败、`parseRemoteOps` 于是连 `enabled` 一起丢回默认；`.slice(-1)` 保留**最后
 *  配对**的那一台（前面的令牌在服务器侧早就失效了），旧数据照样读得进来、只是被收敛掉。 */
export const RemoteOpsSchema = z
  .object({
    enabled: z.boolean().default(false),
    pairedDevices: z.array(z.object({ address: z.string().max(256), name: z.string().max(80), token: z.string().max(128) })).max(8).transform((devices) => devices.slice(-1)).default([]),
  })
  .strip();

export type RemoteOps = z.output<typeof RemoteOpsSchema>;

export const DEFAULT_REMOTE_OPS: RemoteOps = {
  enabled: false,
  pairedDevices: [],
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
  discover(): Promise<CommandResult<DiscoveredDevice[]>> {
    return invokeCommand('compute_discover', {}, z.array(DiscoveredDeviceSchema));
  }

  /** 请求配对，顺带报上**这一台**是谁：`name` 是设备名、`kind` 是类型。
   *
   * 以前对面只能自己猜名字，而它猜的是后端 `host_name()`——Android 上没有
   * `COMPUTERNAME`/`HOSTNAME`，于是每台手机在对面列表里都叫「Yomika」。两个键都要
   * 发出去（Tauri 的 `Option<String>` 参数不允许缺键，缺了整条命令会被判「缺参数」），
   * 空值一律发 `null`，Rust 侧收到 `None` 再自己兜底。 */
  requestPair(url: string, name?: string, kind?: string): Promise<CommandResult<z.output<typeof PairRequestSchema>>> {
    return invokeCommand('compute_pair_request', { url, name: name ?? null, kind: kind ?? null }, PairRequestSchema);
  }

  confirmPair(url: string, requestId: string, code: string): Promise<CommandResult<z.output<typeof PairResultSchema>>> {
    return invokeCommand('compute_pair_confirm', { url, requestId, code }, PairResultSchema);
  }
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

  revokePairing(id: string): Promise<CommandResult<ComputeCenterStatus>> {
    return invokeCommand('compute_center_revoke_pairing', { id }, ComputeCenterStatusSchema);
  }

  configureWindowsService(enabled: boolean): Promise<CommandResult<ComputeCenterStatus>> {
    return invokeCommand('compute_windows_service_configure', { enabled }, ComputeCenterStatusSchema);
  }

  /** 连一次远端，拿它的能力清单。 */
  remoteCapabilities(url: string, token: string): Promise<CommandResult<RemoteCapabilities>> {
    return invokeCommand('remote_compute_capabilities', { url, token }, RemoteCapabilitiesSchema);
  }

  /** 把本机缓存里的一页发给远端处理，取回 PNG 字节。起点由阅读器自动选择。
   *
   *  `params.op` 仍要发（Rust 侧那个字段是必填），`params.chain` 才是这一页要做哪几档；
   *  两者不一致时以 `chain` 为准。**不发模型与参数**：对面按自己的设置跑。 */
  remoteProcess(input: {
    url: string;
    token: string;
    params: {
      op: string;
      chain?: readonly string[];
      modelId?: string;
      scale?: number;
      dlssnr?: unknown;
    };
    scopeId: string;
    archiveId: string;
    pageIndex: number;
    source?: 'reader-page' | 'enhanced';
    /** 建键时用的那一版（能力清单给的）。对面回包说它实际用的是另一版时报错，不落缓存。 */
    expectedRevision?: string;
    upscaleModel?: string;
    upscaleOutputScale?: number;
    taskId?: string;
    /** 远端有自己的队列（不占本机 GPU 那一件）：档位管的是远端任务之间谁先走。 */
    priority?: 'foreground' | 'background';
  }): Promise<CommandResult<ArrayBuffer>> {
    return invokeBinaryCommand('remote_compute_process', { input });
  }
}
