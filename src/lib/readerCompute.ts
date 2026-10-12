import { useEffect, useRef, useState } from 'react';

import type {
  ComputeArtifactRecord,
  ComputeCancelOutcome,
  ComputeJobKey,
  ComputeJobSnapshot,
  ComputePriority,
  ComputeSubmitPayload,
  ComputeSubmitted,
  ComputedImageLease,
  PipelineStage,
  RunInput,
} from '../domain/compute';
import type { CommandResult } from '../domain/result';
import type { ComputedImageCache, ComputedImageHandle } from './computedImageCache';
import { decodeImage } from './decodeImage';

/** 一次重计算的请求：这一页的输入在哪儿、要跑哪些阶段、要多久算过期。 */
export interface ComputedPageRequest {
  key: ComputeJobKey;
  priority: ComputePriority;
  input: RunInput;
  pipeline: PipelineStage[];
  outputGrantId: string;
  deadlineMs: number;
}

/** 这一页要用到的桥的**最小**切面（`NativeComputeRepository` 自然是它的实现）。 */
export interface ComputedPageRepository {
  onJobChanged(handler: (event: ComputeJobSnapshot) => void): () => void;
  submit(payload: ComputeSubmitPayload): Promise<CommandResult<ComputeSubmitted>>;
  cancel(jobId: string, subscriptionId: number): Promise<CommandResult<ComputeCancelOutcome>>;
  jobArtifacts(jobId: string): Promise<CommandResult<ComputeArtifactRecord[]>>;
  acquireArtifact(jobId: string, artifactId: string): Promise<CommandResult<ComputedImageLease>>;
  releaseArtifact(leaseId: string): Promise<CommandResult<void>>;
}

export type ComputedPageStatus = 'idle' | 'queued' | 'running' | 'ready' | 'failed';

export interface ComputedPageState {
  status: ComputedPageStatus;
  /** 已经**解好**、可以换上去的那一版的 URL。解好之前这里是上一版（或没有）。 */
  url?: string;
  error?: { code: string; message: string };
}

export interface UseComputedPageOptions {
  repository: ComputedPageRepository;
  cache: ComputedImageCache;
  /** 这一页在阅读器里的身份：算出来的图按「它 + 内容哈希」共享，换页换 key。 */
  key: string;
  request: ComputedPageRequest | undefined;
  /** 留一行记录的地方（默认不记）。 */
  onDiagnostic?: (message: string, detail?: Record<string, unknown>) => void;
}

interface Tracking {
  inputId: string;
  generation: number;
  jobId: string | undefined;
  subscriptionId: number | undefined;
  /** 宿主那条事件流里的单调序号：旧事件不许盖掉新的。 */
  lastSequence: number;
  /** 这一代里已经拿过的产物（进度会重复报，不能重复租）。 */
  picked: Set<string>;
  cancelled: boolean;
}

/** 一轮请求的身份：内容没变就不重来（`request` 对象每次渲染都是新的，不能拿它当依赖）。 */
function requestIdentity(request: ComputedPageRequest): string {
  const { key } = request;
  return [
    key.inputId,
    key.settingsId,
    key.sourceRevision,
    key.backend,
    String(key.generation),
    request.outputGrantId,
    JSON.stringify(request.pipeline),
  ].join('|');
}

function toPayload(request: ComputedPageRequest): ComputeSubmitPayload {
  return {
    inputId: request.key.inputId,
    settingsId: request.key.settingsId,
    sourceRevision: request.key.sourceRevision,
    backend: request.key.backend,
    generation: request.key.generation,
    priority: request.priority,
    input: request.input,
    pipeline: request.pipeline,
    outputGrantId: request.outputGrantId,
    deadlineMs: request.deadlineMs,
  };
}

/** 一页重计算的完整生命周期：先订阅再提交 → 收到产物 → 解码 → 换图 → 还上一版。
 *
 * 几条不写在别处的规矩（§9.1）：
 * - **先订阅再提交**：命中缓存时终态可能在 `submit` 返回之前就到了，漏掉那条就永远停在
 *   「排队中」。
 * - **只用核验过的产物**：`verified: false` 或没有正式落点的一律不拿——worker 自报的字段
 *   不是证据。
 * - **解好才换**：`decodeImage` 成功之前不设 `url`，否则就是那道黑闪。
 * - 任何一步失败都留着**已经显示的那一版**，并如实报错（取消不算失败）。
 */
/** 「现在没位置」这一类：队列排满、内存/显存吃紧、worker 手上正有一件。
 *
 * 它们说的不是「哪里坏了」，而是「这一件现在挤不进去」，所以这一页**不进 `failed`**：
 * 原地安静地等一会儿再问一次。把它们当失败报出去，用户看到的是「处理失败（计算队列
 * 满了）」——什么都没坏，只是需要等；而一路抢着重问只会让队列更挤，那正是一份真实设备
 * 日志里同一条错误刷了 424 遍、占全日志 92% 的成因。
 *
 * 与 `src/domain/errors.ts` 的 `QUIET_ERROR_CODES` 守同一条边界：那边管「不写进错误日志」，
 * 这里管「不进失败态」。两处都要有，少一处就还剩一半噪声。 */
const BACKPRESSURE_COMPUTE_CODES: ReadonlySet<string> = new Set([
  'COMPUTE_QUEUE_FULL',
  'COMPUTE_UNAVAILABLE',
  'COMPUTE_WORKER_BUSY',
]);

/** 让位的等待：0.6s 起，翻倍到 10s 封顶。
 *
 * 为什么是指数而不是固定间隔：软阈值（`resource_policy::admission` 的 `ForegroundOnly`）
 * 要等手上那一件算完、内存落回去才松开，而那件事的时长本来就是几秒到几十秒。固定间隔
 * 重问等于拿一串必然被拒的提交去刷日志与调度器。 */
const BACKPRESSURE_RETRY_MS: readonly number[] = [600, 1_200, 2_400, 4_800, 10_000];

export function useComputedPage(options: UseComputedPageOptions): ComputedPageState {
  const { repository, cache, key, request, onDiagnostic } = options;
  const [state, setState] = useState<ComputedPageState>({ status: 'idle' });
  const shownRef = useRef<ComputedImageHandle | undefined>(undefined);

  // 回调与请求都只从 ref 取：把 `request` 放进依赖会让每次渲染都取消再重提一次。
  const requestRef = useRef(request);
  requestRef.current = request;
  const diagnosticRef = useRef(onDiagnostic);
  diagnosticRef.current = onDiagnostic;

  const identity = request === undefined ? undefined : requestIdentity(request);

  useEffect(() => {
    const current = requestRef.current;
    if (current === undefined || identity === undefined) {
      setState({ status: 'idle' });
      return undefined;
    }

    const tracking: Tracking = {
      inputId: current.key.inputId,
      generation: current.key.generation,
      jobId: undefined,
      subscriptionId: undefined,
      lastSequence: -1,
      picked: new Set<string>(),
      cancelled: false,
    };

    setState((previous) => ({ status: 'queued', ...(previous.url === undefined ? {} : { url: previous.url }) }));

    const fail = (code: string, message: string) => {
      diagnosticRef.current?.(`compute page ${key}: ${code}`, { message });
      setState((previous) => ({
        status: 'failed',
        error: { code, message },
        ...(previous.url === undefined ? {} : { url: previous.url }),
      }));
    };

    const swapTo = (handle: ComputedImageHandle) => {
      const previous = shownRef.current;
      shownRef.current = handle;
      setState({ status: 'ready', url: handle.url });
      // 新的一版已经在屏幕上，才把上一版的 pin 还掉。
      if (previous !== undefined && previous !== handle) cache.release(previous);
    };

    const pick = async () => {
      const jobId = tracking.jobId;
      if (jobId === undefined || tracking.cancelled) return;
      const artifacts = await repository.jobArtifacts(jobId);
      if (tracking.cancelled) return;
      if (!artifacts.ok) {
        diagnosticRef.current?.('compute page: 产物列表拿不到', { code: artifacts.error.code });
        return;
      }
      const usable = artifacts.value.filter((artifact) => artifact.verified && artifact.cacheRelative !== null);
      const newest = usable[usable.length - 1];
      if (newest === undefined || tracking.picked.has(newest.artifactId)) return;
      tracking.picked.add(newest.artifactId);

      const cacheKey = `${key}|${newest.contentHash}`;
      const shared = cache.retain(cacheKey);
      if (shared !== undefined) {
        swapTo(shared);
        return;
      }

      const acquired = await repository.acquireArtifact(jobId, newest.artifactId);
      if (tracking.cancelled) {
        if (acquired.ok) void repository.releaseArtifact(acquired.value.leaseId);
        return;
      }
      if (!acquired.ok) {
        fail(acquired.error.code, acquired.error.message);
        return;
      }

      const lease = acquired.value;
      try {
        await decodeImage(lease.url);
      } catch (error) {
        // 解不开就不换：已经显示的那一版留着（宁可旧，也不要黑闪或白图）。
        void repository.releaseArtifact(lease.leaseId);
        fail('COMPUTE_ARTIFACT_INVALID', `算出来的图解不开：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (tracking.cancelled) {
        void repository.releaseArtifact(lease.leaseId);
        return;
      }

      let handle: ComputedImageHandle;
      try {
        handle = cache.adopt(cacheKey, {
          kind: 'lease',
          leaseId: lease.leaseId,
          url: lease.url,
          estimatedDecodedBytes: lease.estimatedDecodedBytes,
        });
      } catch (error) {
        // 预算不够：这张租借还没被收下，得由这里还掉（缓存不代还）。
        void repository.releaseArtifact(lease.leaseId);
        fail('COMPUTE_RESOURCE_LIMIT', error instanceof Error ? error.message : String(error));
        return;
      }
      swapTo(handle);
    };

    const handleEvent = (event: ComputeJobSnapshot) => {
      if (tracking.cancelled) return;
      // 页面身份 + 世代：上一代的结果贴到新一代上就是把旧设置的图当新设置的结果。
      if (event.key.inputId !== tracking.inputId || event.key.generation !== tracking.generation) return;
      if (tracking.jobId !== undefined && event.jobId !== tracking.jobId) return;
      if (event.sequence <= tracking.lastSequence) return;
      tracking.lastSequence = event.sequence;
      if (tracking.jobId === undefined) tracking.jobId = event.jobId;

      const next = event.state;
      if (typeof next === 'object' && 'failed' in next) {
        fail(next.failed.code, '任务失败');
        return;
      }
      if (typeof next === 'string' && next === 'cancelled') return;
      if (next === 'completed') {
        void pick();
        return;
      }
      if (typeof next === 'object' && 'running' in next) {
        setState((previous) => ({ status: 'running', ...(previous.url === undefined ? {} : { url: previous.url }) }));
        void pick();
      }
    };

    const detach = repository.onJobChanged(handleEvent);

    let retryTimer: number | undefined;
    let deferrals = 0;

    /** 让位：这一件现在没位置。留着已经显示的那一版，回到 `queued`，过一会儿再问一次。 */
    const defer = () => {
      const wait = BACKPRESSURE_RETRY_MS[Math.min(deferrals, BACKPRESSURE_RETRY_MS.length - 1)]!;
      deferrals += 1;
      // 只记第一次：让位本身是正常状态，但「这一页等过」值得留一条线索——一条，不是每
      // 六百毫秒一条。
      if (deferrals === 1) {
        diagnosticRef.current?.(`compute page ${key}: 让位`, { message: '计算队列现在没有位置，等一会儿再问一次' });
      }
      setState((previous) => ({ status: 'queued', ...(previous.url === undefined ? {} : { url: previous.url }) }));
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        if (!tracking.cancelled) submit();
      }, wait);
    };

    const submit = () => {
      void repository.submit(toPayload(current)).then((result) => {
        if (tracking.cancelled) {
          if (result.ok) void repository.cancel(result.value.jobId, result.value.subscriptionId);
          return;
        }
        if (!result.ok) {
          // 队列满 / 内存吃紧 / worker 正忙：退让再问，不报故障。
          if (BACKPRESSURE_COMPUTE_CODES.has(result.error.code)) {
            defer();
            return;
          }
          fail(result.error.code, result.error.message);
          return;
        }
        tracking.jobId = result.value.jobId;
        tracking.subscriptionId = result.value.subscriptionId;
        const observed = tracking.lastSequence;
        tracking.lastSequence = Math.max(observed, result.value.snapshot.sequence);
        const settled = result.value.snapshot.state;
        if (typeof settled === 'object' && 'failed' in settled) fail(settled.failed.code, '任务失败');
        // 提交回来的时候任务可能已经在跑（宿主把这次提交并进了已经在跑的那个任务：重新进入阅读器
        // 就会这样），也可能已经完成（命中缓存）。两种都要立刻去问产物——更早阶段的产物可能已经
        // 发布了，等下一次阶段切换才显示，等于把「已经躺在磁盘上的图」白按住一个阶段。
        // 但要是事件流里已经先送来了更新的一条（序号更大），这份应答就是旧的，别拿它再走一遍。
        else if (
          observed <= result.value.snapshot.sequence &&
          (settled === 'completed' || (typeof settled === 'object' && 'running' in settled))
        ) {
          if (typeof settled === 'object') {
            setState((previous) => ({ status: 'running', ...(previous.url === undefined ? {} : { url: previous.url }) }));
          }
          void pick();
        }
      });
    };

    submit();

    return () => {
      tracking.cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      detach();
      const { jobId, subscriptionId } = tracking;
      if (jobId !== undefined && subscriptionId !== undefined) void repository.cancel(jobId, subscriptionId);
    };
  }, [cache, identity, key, repository]);

  // 卸载时把这一页手上那张还掉（换页/关闭阅读器都走这里）。
  useEffect(() => () => {
    const handle = shownRef.current;
    shownRef.current = undefined;
    if (handle !== undefined) cache.release(handle);
  }, [cache]);

  return state;
}
