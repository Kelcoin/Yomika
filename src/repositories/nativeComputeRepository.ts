import { listen } from '@tauri-apps/api/event';
import { z } from 'zod';

import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import {
  COMPUTE_JOB_CHANGED_EVENT,
  ComputeArtifactRecordSchema,
  ComputeCancelOutcomeSchema,
  ComputeDroppedGenerationSchema,
  ComputeJobProgressSchema,
  ComputeJobSnapshotSchema,
  ComputePromoteOutcomeSchema,
  ComputeSubmittedSchema,
  ComputeWorkerStatusSchema,
  ComputedImageLeaseSchema,
  type ComputeArtifactRecord,
  type ComputeCancelOutcome,
  type ComputeDroppedGeneration,
  type ComputeJobProgress,
  type ComputeJobSnapshot,
  type ComputePromoteOutcome,
  type ComputeSubmitPayload,
  type ComputeSubmitted,
  type ComputeWorkerStatus,
  type ComputedImageLease,
  type DecensorPagePayload,
  type DecensorPageSubmitted,
  type ReaderPagePayload,
} from '../domain/compute';
import type { CommandResult } from '../domain/result';
import { logError } from '../lib/errorLog';

export {
  COMPUTE_JOB_CHANGED_EVENT,
  COMPUTE_LEASE_ERROR_CODES,
  isComputeErrorCode,
  type ComputeErrorCode,
} from '../domain/compute';

/** 任务快照的**可选**应答（超出保留窗口就是 `null`，不是失败）。 */
const OptionalJobSnapshotSchema = z.union([ComputeJobSnapshotSchema, z.null()]);
const OptionalProgressSchema = z.union([ComputeJobProgressSchema, z.null()]);

/** 重计算（宿主编排 + 独立 worker 进程）的桥。
 *
 * 关于「为什么有一半命令是 async 的」：宿主的提交、取消、租借都只做入队/记账，不等
 * 结果；真正几十秒的活在 worker 进程里。前端因此拿到的是 `jobId`，结果靠事件回来。
 *
 * 与 Rust 那侧对应：`src-tauri/src/compute/commands.rs`（命令名与参数名）、
 * `src-tauri/src/compute/mod.rs`（事件名）。
 */
export class NativeComputeRepository {
  /** 提交一个重任务。**不等结果**：回来的是身份（jobId + subscriptionId）与快照。
   *
   * `subscriptionId` 必须留着：取消要凭它，而 jobId 是会被复用的（同一份输入换了设置
   * 就是另一个 job）。
   *
   * 这里**不**做本地校验：谁有权限、输入在不在、管线合不合法，都是宿主的判断，它答的
   * `COMPUTE_BAD_REQUEST` 比前端猜出来的理由准确。 */
  async submit(payload: ComputeSubmitPayload): Promise<CommandResult<ComputeSubmitted>> {
    return invokeCommand('compute_submit', { payload }, ComputeSubmittedSchema);
  }

  /** 阅读器那一页：只说「哪一页」，身份由宿主铸（`compute::reader::plan_reader_page`）。
   *
   * 与 `submit` 的差别只在载荷：这里没有 `settingsId`/`sourceRevision`/`backend`/`pipeline`
   * ——那几样都要读宿主的模型包才算得出来（`settingsId` 就是缓存修订号）。渲染进程确实知道
   * 的只有三件事：位置、模型、世代。 */
  async submitReaderPage(payload: ReaderPagePayload): Promise<CommandResult<ComputeSubmitted>> {
    return invokeCommand('compute_submit_reader_page', { payload }, ComputeSubmittedSchema);
  }

  /** 去码那一页，补完可以接着放大（一条链，docs/95）。身份由宿主铸。
   *
   * 差别在**谁看像素**：这一页的检测由 worker 做（docs/94），宿主只负责把这一页、检测器和
   * 两份修补模型摆进输入根。所以答案不再可空——一个框都没有是 worker 的成功结论，它照样交
   * 出一件产物；「原页就是答案」这件事由产物自己说（它与源页逐点相同）。
   *
   * `upscaleModelId` 写上的话，放大是**同一件任务的第二阶段**：链的第二阶段吃第一阶段的
   * 产物，而那份产物只有内容寻址的落点、没有按修订号登记的缓存行，出了这件任务就没人能按
   * 身份把它找回来。 */
  async submitDecensorPage(payload: DecensorPagePayload): Promise<CommandResult<DecensorPageSubmitted>> {
    return invokeCommand('compute_submit_decensor_page', { payload }, ComputeSubmittedSchema);
  }

  /** 查一个任务现在是什么状态。断掉订阅之后也还能查：`null` = 超出保留窗口。 */
  async jobGet(jobId: string): Promise<CommandResult<ComputeJobSnapshot | null>> {
    return invokeCommand('compute_job_get', { jobId }, OptionalJobSnapshotSchema);
  }

  /** 现在挂着的任务（含后台的），用来在重新进入阅读器时对齐状态。 */
  async jobs(): Promise<CommandResult<ComputeJobSnapshot[]>> {
    return invokeCommand('compute_jobs', {}, z.array(ComputeJobSnapshotSchema));
  }

  /** worker 进程的状态。「没在跑」与「起不来了」必须分得开。 */
  async workerStatus(): Promise<CommandResult<ComputeWorkerStatus>> {
    return invokeCommand('compute_worker_status', {}, ComputeWorkerStatusSchema);
  }

  /** 某个任务已经核验过的产物。**`verified: false` 的一律不许用**。 */
  async jobArtifacts(jobId: string): Promise<CommandResult<ComputeArtifactRecord[]>> {
    return invokeCommand('compute_job_artifacts', { jobId }, z.array(ComputeArtifactRecordSchema));
  }

  async jobProgress(jobId: string): Promise<CommandResult<ComputeJobProgress | null>> {
    return invokeCommand('compute_job_progress', { jobId }, OptionalProgressSchema);
  }

  /** 取消自己的那份订阅。幂等：重复取消、取消一个已经结束的任务都不是错误。 */
  async cancel(jobId: string, subscriptionId: number): Promise<CommandResult<ComputeCancelOutcome>> {
    return invokeCommand('compute_cancel', { jobId, subscriptionId }, ComputeCancelOutcomeSchema);
  }

  /** 把后台任务提到前台（用户翻到了那一页）。 */
  async promote(jobId: string): Promise<CommandResult<ComputePromoteOutcome>> {
    return invokeCommand('compute_promote', { jobId }, ComputePromoteOutcomeSchema);
  }

  /** 丢掉某一代还没跑完的活（用户换了设置/快速翻页）。 */
  async dropGeneration(inputId: string, generation: number): Promise<CommandResult<ComputeDroppedGeneration>> {
    return invokeCommand('compute_drop_generation', { inputId, generation }, ComputeDroppedGenerationSchema);
  }

  /** 让宿主再试一次拉起 worker。 */
  async retryWorker(): Promise<CommandResult<void>> {
    return invokeCommand('compute_retry_worker', {}, VoidResponseSchema);
  }

  /** 拿一张图的租借：回包里 `url` 是渲染器唯一的把手（里面只有不透明租借号）。
   *
   * 租借同时会在宿主侧给这份内容上 pin，所以**必须**配对调用 `releaseArtifact`。 */
  async acquireArtifact(jobId: string, artifactId: string): Promise<CommandResult<ComputedImageLease>> {
    return invokeCommand('compute_artifact_acquire', { jobId, artifactId }, ComputedImageLeaseSchema);
  }

  /** 还掉一张租借（也会把宿主的 pin 还掉）。幂等。 */
  async releaseArtifact(leaseId: string): Promise<CommandResult<void>> {
    return invokeCommand('compute_artifact_release', { leaseId }, VoidResponseSchema);
  }

  /** 订阅任务状态事件。返回的是**同步**的退订函数：React 的清理函数不能是异步的。
   *
   * 看不懂的载荷只记日志、不抛：这条事件是广播，一个消费者认不出来不该影响别人。 */
  onJobChanged(handler: (event: ComputeJobSnapshot) => void): () => void {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<unknown>(COMPUTE_JOB_CHANGED_EVENT, (event) => {
      const parsed = ComputeJobSnapshotSchema.safeParse(event.payload);
      if (!parsed.success) {
        logError('compute/job-changed', '任务事件看不懂', {
          issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        });
        return;
      }
      handler(parsed.data);
    })
      .then((detach) => { if (active) unlisten = detach; else detach(); })
      .catch(() => { /* 不在壳里（测试/浏览器）就没有事件总线 */ });
    return () => { active = false; unlisten?.(); };
  }
}

let sharedRepository: NativeComputeRepository | undefined;

/** 进程里共用的那个桥。理由和 `getNativeImageCache` 相同：阅读器那条派生队列是命令式的
 * （每翻一页跑一件，句柄记在 ref 上），每件都新建一个 repository 只会让同一份事件订阅重复
 * 挂一遍，而订阅是按实例记的。 */
export function getNativeComputeRepository(): NativeComputeRepository {
  sharedRepository ??= new NativeComputeRepository();
  return sharedRepository;
}
