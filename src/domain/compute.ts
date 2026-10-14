import { z } from 'zod';

/** 重计算（宿主编排 + worker）的线上契约（docs/71 §6.6）。
 *
 * 这些 schema 是前端能看到的**唯一**形状说明：宿主的命令回包、事件载荷都过这里。
 * 与 Rust 那侧一一对应的地方：
 * - `../../src-tauri/src/compute/commands.rs`（命令名与参数名）
 * - `../../src-tauri/src/compute/scheduler.rs`（`JobKey`/`JobState`/`JobSnapshot`/`Submitted`/各种 outcome）
 * - `../../src-tauri/src/compute/manager.rs`（`ArtifactRecord`/`JobProgress`/`WorkerStatus`）
 * - `../../src-tauri/crates/compute-protocol/src/messages.rs`（`PipelineStage`/`RunInput`/`EnginePolicy`）
 *
 * 枚举那几处没有 `tag`，所以带数据的变体是**外部标签**（`{ running: { … } }`），
 * 单位变体是字符串（`"completed"`）——`WorkerStatus` 是唯一带 `tag = "kind"` 的。
 */

/** 与 Rust 的 `EnginePolicy` 一致：`auto` 允许回退，`gpu` 拿不到就是失败。 */
export const EnginePolicySchema = z.enum(['auto', 'cpu', 'gpu']);
export type EnginePolicy = z.infer<typeof EnginePolicySchema>;

export const ComputePrioritySchema = z.enum(['foreground', 'background']);
export type ComputePriority = z.infer<typeof ComputePrioritySchema>;

/** 管线里的一个阶段。可选字段在 Rust 那侧带 `skip_serializing_if`，所以缺省就是缺省。
 *
 * 这里**没有** `model` / `minInputEdge` / `outputScale`，是有意的：那三条由宿主在派发前
 * 补（`compute::manager` 的 `prepare_run` 解析已安装模型摆进只读输入根、清单里的
 * `minInputEdge`，以及产品策略决定的「交出去多大」）。调用方不许指名模型文件、也不许自己
 * 定交出去的尺寸——zod 默认会剥掉未知键，所以就算有人硬塞也进不来。
 */
export const PipelineStageSchema = z.object({
  stageId: z.string().min(1),
  modelSpecId: z.string().min(1),
  enginePolicy: EnginePolicySchema,
  scale: z.number().int().positive().optional(),
  tile: z.number().int().positive().optional(),
  layers: z.number().int().positive().optional(),
  settingsId: z.string().optional(),
});
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

/** 输入文件在 staging 里的身份：worker 靠这三个值核对它读到的东西。 */
export const RunInputSchema = z.object({
  inputId: z.string().min(1),
  contentHash: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
});
export type RunInput = z.infer<typeof RunInputSchema>;

/**
 * 一页的**身份**，不是它的路径、也不是它的哈希。
 *
 * 渲染进程给不出后两样（那是宿主的账，§9.3 也不许每页在 JS 重算哈希），但它知道用户在
 * 看哪一页。宿主拿这四个字段去查一次缓存主键，把这一页还原成一份可核对的位置。
 */
export const SourcePageSchema = z.object({
  scopeId: z.string().min(1),
  archiveId: z.string().min(1),
  pageIndex: z.number().int().nonnegative(),
  /** 哪一版：目前只认 `reader-page`，缺省也是它。 */
  rendition: z.literal('reader-page').optional(),
});
export type SourcePage = z.infer<typeof SourcePageSchema>;

/**
 * 提交载荷。**没有** jobId/workerEpoch/budgets：那些由宿主派发时补。
 *
 * `input` 与 `source` 二选一，因为「输入是什么」有两种诚实的说法：字节已经在手上（连哈希
 * 一起给，宿主会核对），或者只知道「这是哪一页」（位置与哈希请宿主自己去查）。两边都给、
 * 两边都不给，宿主都会用 `COMPUTE_BAD_REQUEST` 挡回来——前端先挡一次是为了少一次往返，
 * 不是为了替宿主做判断（真正算数的是 `compute::commands::plan`）。
 */
export const ComputeSubmitPayloadSchema = z
  .object({
    inputId: z.string().min(1),
    settingsId: z.string().min(1),
    sourceRevision: z.string().min(1),
    backend: z.string().min(1),
    generation: z.number().int().nonnegative(),
    priority: ComputePrioritySchema,
    input: RunInputSchema.optional(),
    source: SourcePageSchema.optional(),
    pipeline: z.array(PipelineStageSchema).min(1),
    outputGrantId: z.string().min(1),
    deadlineMs: z.number().int().positive(),
  })
  .refine((payload) => (payload.input === undefined) !== (payload.source === undefined), {
    message: 'input 与 source 二选一：一份字节的声明，或者「这一页是谁」',
    path: ['input'],
  });
export type ComputeSubmitPayload = z.infer<typeof ComputeSubmitPayloadSchema>;

/**
 * 阅读器那一页的请求：只说「哪一页 + 哪个模型 + 哪一代」，**没有**身份。
 *
 * 任务身份（`inputId`/`settingsId`/`sourceRevision`/`backend`）里的 `settingsId` 就是缓存
 * 修订号，而修订号由宿主的模型包与「这一页是怎么来的」一起算出来——渲染进程手上没有这些
 * 输入，硬凑一个只会得到另一个 job。所以这道门由宿主自己铸身份
 * （`compute::reader::plan_reader_page`），前端只报它确实知道的三件事：位置、模型、世代。
 *
 * `.strict()` 对应宿主那侧的 `deny_unknown_fields`：多一个键在 Rust 里是直接反序列化失败，
 * 在前端先挡一次，报的是字段名而不是「invalid args」。
 */
export const ReaderPagePayloadSchema = z
  .object({
    scopeId: z.string().min(1),
    archiveId: z.string().min(1),
    pageIndex: z.number().int().nonnegative(),
    /** 超分模型的 id（设置页里看到的那个），不是路径、不是文件名。 */
    modelId: z.string().min(1),
    /** 阅读器世代（§9.1）：换设置就换代，旧一代整个作废。 */
    generation: z.number().int().nonnegative(),
    priority: ComputePrioritySchema,
    /** 0 = 用宿主调度器的默认期限（`DEFAULT_DEADLINE_MS`）。上限由宿主把关。 */
    deadlineMs: z.number().int().nonnegative(),
  })
  .strict();
export type ReaderPagePayload = z.infer<typeof ReaderPagePayloadSchema>;

/** 任务身份：同一身份的请求合并成一个 job（§8.1）。 */
export const ComputeJobKeySchema = z.object({
  inputId: z.string(),
  settingsId: z.string(),
  sourceRevision: z.string(),
  backend: z.string(),
  generation: z.number().int().nonnegative(),
});
export type ComputeJobKey = z.infer<typeof ComputeJobKeySchema>;

/** 任务状态。单位变体是字符串，带数据的变体是外部标签的对象。 */
export const ComputeJobStateSchema = z.union([
  z.enum(['queued', 'dispatched', 'accepted', 'cancelRequested', 'completed', 'cancelled']),
  z.object({ running: z.object({ stage: z.string(), index: z.number().int() }) }),
  z.object({ failed: z.object({ code: z.string() }) }),
]);
export type ComputeJobState = z.infer<typeof ComputeJobStateSchema>;

export const ComputeJobSnapshotSchema = z.object({
  jobId: z.string(),
  key: ComputeJobKeySchema,
  priority: ComputePrioritySchema,
  state: ComputeJobStateSchema,
  subscribers: z.number().int().nonnegative(),
  /** 单调序号：事件排序用，也是「谁更旧」的判据——旧事件不许盖掉新的。 */
  sequence: z.number().int().nonnegative(),
  createdMs: z.number().int().nonnegative(),
  settledMs: z.number().int().nonnegative().nullable(),
});
export type ComputeJobSnapshot = z.infer<typeof ComputeJobSnapshotSchema>;

export const ComputeSubmittedSchema = z.object({
  jobId: z.string(),
  subscriptionId: z.number().int().nonnegative(),
  coalesced: z.boolean(),
  snapshot: ComputeJobSnapshotSchema,
  evicted: z.string().nullable(),
});
export type ComputeSubmitted = z.infer<typeof ComputeSubmittedSchema>;

export const ComputeJobProgressSchema = z.object({
  stageId: z.string(),
  percent: z.number().min(0).max(100),
  updatedMs: z.number().int().nonnegative(),
});
export type ComputeJobProgress = z.infer<typeof ComputeJobProgressSchema>;

/** 产物记录。`cacheRelative` 为 `null` = 没有正式落点（只有 staging），拿不到 URL。 */
export const ComputeArtifactRecordSchema = z.object({
  jobId: z.string(),
  stageId: z.string(),
  artifactId: z.string(),
  stagingName: z.string(),
  path: z.string(),
  cacheRelative: z.string().nullable(),
  byteLength: z.number().int().nonnegative(),
  contentHash: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  engineId: z.string(),
  enginePrecision: z.string(),
  /** 这一阶段**被问的是哪条引擎政策**。`null` = 那次报告没交代（老 worker，或事实驱动
   * 的那条路），不是「跑的就是 CPU」——这两件事在界面上要分开说。 */
  enginePolicy: EnginePolicySchema.nullable(),
  /** 真回退时的交代（想要谁 / 用了谁 / 为什么）。`null` = 没有回退。
   *
   * 「自动回退」与「强制失败」是两件事，前端靠它和错误码分开呈现（docs/71:126：
   * 强制 GPU 不得静默变成 CPU，auto 可显式回退并展示原因）。 */
  engineFallback: z
    .object({
      requested: z.string(),
      used: z.string(),
      reason: z.string(),
    })
    .nullable(),
  pipelineRevision: z.string(),
  /** 宿主自己重算过哈希、对过长度。为 false 的产物一律不许拿。 */
  verified: z.boolean(),
});
export type ComputeArtifactRecord = z.infer<typeof ComputeArtifactRecordSchema>;

/** 一张图的租借。渲染器只拿到 `url`（里面只有不透明租借号）与预算用的尺寸。 */
export const ComputedImageLeaseSchema = z.object({
  leaseId: z.string(),
  artifactId: z.string(),
  jobId: z.string(),
  url: z.string(),
  mime: z.string(),
  byteLength: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  /** 解码后的位图预算（宽 × 高 × 4），不是压缩字节数。 */
  estimatedDecodedBytes: z.number().int().nonnegative(),
  pipelineRevision: z.string(),
  expiresInMs: z.number().int().nonnegative(),
});
export type ComputedImageLease = z.infer<typeof ComputedImageLeaseSchema>;

export const ComputeCancelOutcomeSchema = z.union([
  z.enum(['alreadyTerminal', 'unknown']),
  z.object({ droppedSubscription: z.object({ remaining: z.number().int().nonnegative() }) }),
  z.object({ cancelRequested: z.object({ running: z.boolean() }) }),
]);
export type ComputeCancelOutcome = z.infer<typeof ComputeCancelOutcomeSchema>;

export const ComputePromoteOutcomeSchema = z.enum([
  'promoted',
  'alreadyForeground',
  'alreadyTerminal',
  'unknown',
]);
export type ComputePromoteOutcome = z.infer<typeof ComputePromoteOutcomeSchema>;

export const ComputeDroppedGenerationSchema = z.object({
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
});
export type ComputeDroppedGeneration = z.infer<typeof ComputeDroppedGenerationSchema>;

/** worker 状态。`stopped`（没活干）与 `broken`（起不来了）必须分得开。 */
export const ComputeWorkerStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stopped') }),
  z.object({ kind: z.literal('starting'), epoch: z.number().int() }),
  z.object({
    kind: z.literal('ready'),
    epoch: z.number().int(),
    peerPid: z.number().int().nonnegative(),
    limitsApplied: z.boolean(),
    limitsNote: z.string().nullable(),
  }),
  z.object({ kind: z.literal('broken'), reason: z.string() }),
]);
export type ComputeWorkerStatus = z.infer<typeof ComputeWorkerStatusSchema>;

/** 任务状态变化事件的名字。Rust 侧同一个字符串在 `compute/mod.rs`。 */
export const COMPUTE_JOB_CHANGED_EVENT = 'compute-job-changed';

/** §6.6 点名的标准错误码 + 宿主实际会发出来的那几个。桥接只会照原样传递，
 * 但**必须**在这里登记：`DomainErrorCodeSchema` 是闭集，没登记的码会被整条判成
 * 「无效响应」，真正的理由（比如 GPU 拿不到）反而看不见。 */
export const COMPUTE_ERROR_CODES = [
  'COMPUTE_WORKER_UNAVAILABLE',
  'COMPUTE_PROTOCOL_MISMATCH',
  'COMPUTE_WORKER_LOST',
  'COMPUTE_WORKER_BUSY',
  'COMPUTE_QUEUE_FULL',
  'COMPUTE_RESOURCE_LIMIT',
  'COMPUTE_TIMEOUT',
  'GPU_OUTPUT_INVALID',
  'GPU_BACKEND_UNAVAILABLE',
  'COMPUTE_ARTIFACT_INVALID',
  'COMPUTE_ARTIFACT_REJECTED',
  'COMPUTE_INPUT_INVALID',
  /** 这一段要的模型在这台机器上拿不到：没下载、没装完，或者它压根不是 worker 能跑的
   * 那种模型（宿主内置的 shader 链走的是另一条路）。与「输入坏了」分开，因为处置不同：
   * 一个去装/换模型，另一个重新取一页。 */
  'COMPUTE_MODEL_UNAVAILABLE',
  'COMPUTE_CANCELLED',
  'COMPUTE_INTERNAL',
  'COMPUTE_BAD_REQUEST',
  'COMPUTE_UNAVAILABLE',
  'COMPUTE_LEASE_UNKNOWN',
  'COMPUTE_LEASE_EXPIRED',
  'COMPUTE_LEASE_WRONG_WINDOW',
] as const;

export type ComputeErrorCode = (typeof COMPUTE_ERROR_CODES)[number];

const COMPUTE_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(COMPUTE_ERROR_CODES);

export function isComputeErrorCode(code: string): code is ComputeErrorCode {
  return COMPUTE_ERROR_CODE_SET.has(code);
}

/** 渲染器会因为这几个码放弃一张已经到手的图（租借没了/不是这个窗口的）。 */
export const COMPUTE_LEASE_ERROR_CODES: readonly ComputeErrorCode[] = [
  'COMPUTE_LEASE_UNKNOWN',
  'COMPUTE_LEASE_EXPIRED',
  'COMPUTE_LEASE_WRONG_WINDOW',
  'COMPUTE_ARTIFACT_INVALID',
  'COMPUTE_RESOURCE_LIMIT',
];

/** 这一页没算成时，哪些失败**值得再问一次**。
 *
 * 分的是「现场问题」与「这一页/这台机器的问题」：进程没了、队列满了、算超时都是前者——
 * 宿主的看门狗会把 worker 拉回来（`compute_manager.rs` 里那条「杀了它还要能接着干」的
 * 集成测试就是这件事），换一次机会就可能过；模型没装、输入坏了、输出不合法、指名要显卡
 * 却是这台机器给不了，都是后者，再问一次还是同一个结果。
 *
 * 阅读器拿它决定「这一页到底算不算试过了」，见 `ReaderRoute` 里那一句：阵发失败不算试过，
 * 用户下次翻到这一页要再给一次机会，否则这一页在这次阅读里永远停在原图。 */
const RETRYABLE_COMPUTE_CODES: readonly ComputeErrorCode[] = [
  'COMPUTE_WORKER_UNAVAILABLE',
  'COMPUTE_WORKER_LOST',
  'COMPUTE_WORKER_BUSY',
  'COMPUTE_QUEUE_FULL',
  'COMPUTE_TIMEOUT',
  'COMPUTE_UNAVAILABLE',
  'COMPUTE_CANCELLED',
];

export const RETRYABLE_COMPUTE_ERROR_CODES: ReadonlySet<string> = new Set<string>(RETRYABLE_COMPUTE_CODES);
