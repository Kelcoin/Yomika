import type { ImageCacheIdentity } from '../domain/cache';
import type {
  ComputeArtifactRecord,
  ComputeCancelOutcome,
  ComputeJobSnapshot,
  ComputePriority,
  ComputeSubmitted,
  ComputedImageLease,
  ReaderPagePayload,
} from '../domain/compute';
import type { CommandResult } from '../domain/result';
import { decodeImageStrict } from './decodeImage';
import { peekCachedImage, type ImageHandle, type UnifiedImageCache } from './unifiedImageCache';

/** 阅读器那条超分阶段的 id（宿主 `src-tauri/src/compute/reader.rs` 的 `UPSCALE_STAGE_ID`）。
 *
 * 产物是按阶段登记的，拿错阶段的产物就等于把别的中间结果当成这一页。 */
export const READER_UPSCALE_STAGE_ID = 'upscale';

/** 宿主的 compute 那道门（`NativeComputeRepository` 自然是它的实现）。
 *
 * 这道门只要「哪一页 + 哪个模型」。 */
export interface ReaderComputedPageBridge {
  onJobChanged(handler: (event: ComputeJobSnapshot) => void): () => void;
  submitReaderPage(payload: ReaderPagePayload): Promise<CommandResult<ComputeSubmitted>>;
  cancel(jobId: string, subscriptionId: number): Promise<CommandResult<ComputeCancelOutcome>>;
  jobArtifacts(jobId: string): Promise<CommandResult<ComputeArtifactRecord[]>>;
  acquireArtifact(jobId: string, artifactId: string): Promise<CommandResult<ComputedImageLease>>;
  releaseArtifact(leaseId: string): Promise<CommandResult<void>>;
}

/** 产物报告里的引擎交代：被问的是哪条政策，以及真回退时的「想要谁 / 用了谁 / 为什么」。
 *
 * 它只从**真的认领下来的那张图**上读：没有产物就没有交代，界面也不该凭空说一句。 */
export interface ReaderPageEngine {
  policy: ComputeArtifactRecord['enginePolicy'];
  fallback: ComputeArtifactRecord['engineFallback'];
}

/** 这一页没算成的原因。`code` 是宿主/领域错误码（`GPU_OUTPUT_INVALID` 这类）。
 *
 * `message` 只有命令回包那条路有；任务事件里的失败只带码，所以它是可选的，界面不许假定
 * 一定有话说。 */
export interface ReaderPageFailure {
  code: string;
  message?: string;
}

/** 产物拿到了、但渲染器自己解不开。
 *
 * 宿主从来没有经手过这张图，所以这里不能编一个宿主的码去冒充：这个值只在本文件与界面
 * 之间用，含义是「图在这台机器上没能解出来」。 */
export const READER_ARTIFACT_UNDECODABLE = 'READER_ARTIFACT_UNDECODABLE';

/** 一次请求里的一条阶段：要哪个阶段的产物、认领进哪张账、拿到之后交给谁。
 *
 * 一条链就是这样一个数组。**数组最后一条是这次请求的答案**，前面几条是
 * 路上能先拿到的中间版本（拿到了就 `onReady` 交出去，先上屏，请求还没结束）。
 *
 * 不设「最后一条」这种布尔字段：次序本身就是声明，少一个能被写错的状态。 */
export interface ReaderComputedStageClaim {
  /** 宿主的阶段 id（`READER_UPSCALE_STAGE_ID`）。 */
  stageId: string;
  /** 这一阶段在阅读器里的身份：回来那个句柄按它记账、按它淘汰。 */
  identity: ImageCacheIdentity;
  /** 中间阶段的出口：拿到了、也认领了，交给调用方先显示。答案那一条不走这里。 */
  onReady?: (handle: ImageHandle) => void;
  /** 拿到产物、准备认领时把引擎交代交出去（一个阶段最多一次）。 */
  onEngine?: (engine: ReaderPageEngine) => void;
}

export interface LoadReaderComputedPageOptions {
  repository: ReaderComputedPageBridge;
  /** 认领进去的那张账：阅读器的派生缓存（`getNativeImageCache()`）。 */
  cache: UnifiedImageCache;
  /** 这条链上的阶段，按结果先后排。最后一条就是这次请求的答案。 */
  stages: ReaderComputedStageClaim[];
  /** 向宿主开口那一下：交给调用方挑走哪道门、带什么载荷。 */
  submit: (bridge: ReaderComputedPageBridge) => Promise<CommandResult<ComputeSubmitted>>;
  signal?: AbortSignal;
  /** 这一页没算成时的原因。给用户看的那条路（会弹提示），与 `onDiagnostic` 的日志不同。 */
  onFailure?: (failure: ReaderPageFailure) => void;
  onDiagnostic?: (message: string, detail?: Record<string, unknown>) => void;
}

/** 让宿主算这一页，算出来就把它认领进阅读器那张账；没弄成返回 `undefined`。
 *
 * 为什么是普通函数而不是 hook：`useComputedPage` 那种形状假定「一页一个组件」——挂载就是
 * 一次请求、卸载就是取消。阅读器的派生队列不是那样，它是一条命令式队列（`runDerivedQueue`）：
 * 一件接一件地 await，句柄存在 ref 里、按会话预算淘汰、翻页/关闭时统一释放。那一整套账
 * （`retainDerived` 的字节预算、`pickDerivedEvictionVictim`、`imageCache.release`）认的都是
 * `ImageHandle{key,url,bytes}`，所以这里给出一模一样形状的返回值，那些账一行都不用改。
 *
 * 几条与 hook 共有的规矩（§9.1）：
 * - **先订阅再提交**：命中缓存时终态可能在 `submit` 返回之前就到了，漏掉那一条就永远停在等结果。
 * - **只用核验过、且真有落点的产物**：`verified: false` 或 `cacheRelative === null` 的一律不拿。
 * - **解好才认领**：`decodeImage` 成功之前不把租借交出去，否则页面上会先出现一版解不开的图。
 * - 任何一步失败都返回 `undefined`，阅读器照旧显示手上的那一版（与以前 `.catch(() => undefined)`
 *   同义）。取消不是失败，但也同样什么都不给。
 *
 * 链上多出来的一条：**中间阶段先上屏**。中间阶段的产物一出来就 `onReady` 交出去，
 * 请求继续等最后那一条。这正是 §9.1 ⑦ 要的「后面的阶段失败了，前面成功的那一版留着」——
 * 返回值只代表答案那一版，但界面上已经有过一版能看的图。
 *
 * 租借的出口只有一个：`cache.adopt` 里那个 `release` 闭包。图被预算淘汰、翻页释放、阅读器
 * 卸载——都要经过 `UnifiedImageCache.forget`，由它把宿主的 pin 还掉。**认领之后这里不再自己
 * 还租借**：缓存接手了它，谁也不知道那一刻哪条路会先到（换页、淘汰、卸载），两条路都还就是
 * 重复释放。中间阶段交出去的句柄同理——`onReady` 拿到手的人负责按同一套账留住它。
 */
export async function loadReaderComputedPage(
  options: LoadReaderComputedPageOptions,
): Promise<ImageHandle | undefined> {
  const { repository, cache, stages, submit, onDiagnostic } = options;
  const { onFailure } = options;
  const signal = options.signal;

  const claims = stages;
  const answer = claims[claims.length - 1];
  if (answer === undefined) {
    // 没有阶段就没有答案：调用方写错了。宁可当场炸，也不要挂在那里等一个不会来的产物。
    throw new Error('一次算图请求至少要声明一条阶段');
  }
  if (signal?.aborted) return undefined;

  // 内存里已经有这一版（这一页被排过两次、或上一次刚认领过）：按命中处理，不再向宿主开口。
  // `peekCachedImage` 命中时会加一次引用，与 `load` 的命中路径一致——调用方拿到的句柄都要还。
  const existing = peekCachedImage(cache, answer.identity);
  if (existing !== undefined) {
    if (signal?.aborted) {
      cache.release(existing);
      return undefined;
    }
    return existing;
  }

  const note = (message: string, detail?: Record<string, unknown>) => onDiagnostic?.(message, detail);
  /** 失败只说一次：`finish` 之后不会再走到这里，但提交那条路与事件那条路可能撞上。 */
  const failed = (failure: ReaderPageFailure) => onFailure?.(failure);

  let done = false;
  let cancelled = false;
  let detach: (() => void) | undefined;
  let jobId: string | undefined;
  let subscriptionId: number | undefined;
  /** 宿主的单调事件序号：旧事件不许盖掉新的。 */
  let lastSequence = -1;
  /** 这一代里已经拿过的产物：进度会重复报，不能重复租。 */
  const picked = new Set<string>();

  let complete!: (handle: ImageHandle | undefined) => void;
  const settled = new Promise<ImageHandle | undefined>((resolve) => { complete = resolve; });
  const finish = (handle: ImageHandle | undefined) => {
    if (done) return;
    done = true;
    complete(handle);
  };

  const pick = async () => {
    const id = jobId;
    if (id === undefined || cancelled || done) return;
    const artifacts = await repository.jobArtifacts(id);
    if (cancelled || done) return;
    if (!artifacts.ok) {
      // 拿不到列表不是「算失败」：可能只是订阅刚挂上、还没登记。留着让下一次事件再问。
      note('阅读器算图：产物列表拿不到', { code: artifacts.error.code });
      return;
    }
    for (let index = 0; index < claims.length; index += 1) {
      if (cancelled || done) return;
      const claim = claims[index];
      if (claim === undefined) continue;
      const isAnswer = index === claims.length - 1;
      // 中间阶段没人接就不认领：认领了没人还租借，等于拿宿主的 pin 去占缓存。
      if (!isAnswer && claim.onReady === undefined) continue;

      const usable = artifacts.value.filter(
        (artifact) => artifact.verified && artifact.cacheRelative !== null && artifact.stageId === claim.stageId,
      );
      const newest = usable[usable.length - 1];
      if (newest === undefined || picked.has(newest.artifactId)) continue;
      picked.add(newest.artifactId);

      const acquired = await repository.acquireArtifact(id, newest.artifactId);
      if (cancelled || done) {
        if (acquired.ok) void repository.releaseArtifact(acquired.value.leaseId);
        return;
      }
      if (!acquired.ok) {
        note('阅读器算图：租借拿不到', { code: acquired.error.code, message: acquired.error.message });
        failed({ code: acquired.error.code, message: acquired.error.message });
        finish(undefined);
        return;
      }

      const lease = acquired.value;
      try {
        // 必须用**不吞失败**的那一版：取图地址打不开时（scheme 形状不对、租借过期、
        // 文件被清）要让下面的 catch 真的接住，页面留在手上那一版，而不是换上一张破图。
        await decodeImageStrict(lease.url);
      } catch (error) {
        // 解不开就不认领：已经显示的那一版留着（宁可旧，也不要黑闪或白图）。
        void repository.releaseArtifact(lease.leaseId);
        const message = error instanceof Error ? error.message : String(error);
        note('阅读器算图：产物解不开', { message });
        failed({ code: READER_ARTIFACT_UNDECODABLE, message });
        finish(undefined);
        return;
      }
      if (cancelled || done) {
        void repository.releaseArtifact(lease.leaseId);
        return;
      }

      // 图真到手了才交代引擎：宿主报告里那两栏（政策 + 回退）就在这份产物上。放在认领
      // **之前**，是为了让「这一版不是显卡算的」与「这一版上屏」同时发生——等认领之后再说，
      // 中间那些 await 就可能让它晚于翻页。
      claim.onEngine?.({ policy: newest.enginePolicy, fallback: newest.engineFallback });

      // Keep encoded length for disk/Blob quota and propagate decoded residency
      // separately: a tiny compressed page can still decode to hundreds of MiB.
      const handle = cache.adopt(claim.identity, {
        url: lease.url,
        bytes: lease.byteLength,
        estimatedDecodedBytes: lease.estimatedDecodedBytes,
        release: () => { void repository.releaseArtifact(lease.leaseId); },
      });

      if (isAnswer) {
        finish(handle);
        return;
      }
      // 中间阶段：交出去先上屏，这一条请求继续等答案那一版。
      claim.onReady?.(handle);
    }
  };

  const handleEvent = (event: ComputeJobSnapshot) => {
    if (cancelled || done) return;
    // 订阅是全局的（同一代别的页也在跑），所以只认自己那一个任务；jobId 拿到之前先不看。
    if (jobId === undefined || event.jobId !== jobId) return;
    if (event.sequence <= lastSequence) return;
    lastSequence = event.sequence;
    const state = event.state;
    if (typeof state === 'object' && 'failed' in state) {
      note('阅读器算图：任务失败', { code: state.failed.code });
      failed({ code: state.failed.code });
      finish(undefined);
      return;
    }
    // 自己取消的不算失败，也不算成功：什么都不给。
    if (state === 'cancelled') { finish(undefined); return; }
    if (state === 'completed' || (typeof state === 'object' && 'running' in state)) void pick();
  };

  const abort = () => {
    if (done) return;
    cancelled = true;
    detach?.();
    detach = undefined;
    // 任务已经建出来了就退掉这份订阅（幂等；取消一个已经结束的任务不是错误）。
    if (jobId !== undefined && subscriptionId !== undefined) void repository.cancel(jobId, subscriptionId);
    finish(undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });

  detach = repository.onJobChanged(handleEvent);

  const submitted = await submit(repository);
  if (submitted.ok) {
    jobId = submitted.value.jobId;
    subscriptionId = submitted.value.subscriptionId;
  }
  if (!submitted.ok) {
    if (!done && !cancelled) {
      note('阅读器算图：提交没成功', { code: submitted.error.code, message: submitted.error.message });
      failed({ code: submitted.error.code, message: submitted.error.message });
      finish(undefined);
    }
  } else if (cancelled || done) {
    // 取消赶在应答之前（`abort` 那会儿还不知道 jobId）：现在补退这份订阅。
    void repository.cancel(submitted.value.jobId, submitted.value.subscriptionId);
  } else {
    // 提交回来时任务可能已经在跑（宿主把这次提交并进了已经在跑的那个），也可能已经完成
    // （命中缓存）。两种都要立刻去问产物——更早阶段的产物可能已经发布了。
    const snapshot = submitted.value.snapshot;
    lastSequence = Math.max(lastSequence, snapshot.sequence);
    const state = snapshot.state;
    if (typeof state === 'object' && 'failed' in state) {
      note('阅读器算图：任务失败', { code: state.failed.code });
      failed({ code: state.failed.code });
      finish(undefined);
    } else if (state === 'cancelled') {
      finish(undefined);
    } else if (state === 'completed' || (typeof state === 'object' && 'running' in state)) {
      void pick();
    }
  }

  const handle = await settled;
  signal?.removeEventListener('abort', abort);
  detach?.();
  return handle;
}

/** 本地那一档（`job.engine === 'local'`）的编排：超分单阶段，起点是原图。
 *
 * 「一次提交」与「用户先看到哪一版」是两件事：产物一出来就先上屏（§9.1 ⑦），请求只等这一
 * 条。起点是原图还是别的产物由身份自己说（`enhancedFromPageIdentity` 的
 * `source: 'reader-page'`）。
 */
export interface LocalRenditionOptions {
  repository: ReaderComputedPageBridge;
  cache: UnifiedImageCache;
  signal: AbortSignal;
  scopeId: string;
  archiveId: string;
  pageIndex: number;
  generation: number;
  priority: ComputePriority;
  /** 超分模型 id；没开超分就是 `undefined`。 */
  upscaleModel: string | undefined;
  /** 终点那一版的身份，起点是原图（`rendition: 'enhanced'`, `source: 'reader-page'`）。 */
  enhancedFromPageIdentity: ImageCacheIdentity;
  /** 某一阶段的引擎交代（`policy` + 真回退时的「想要谁/用了谁/为什么」）。 */
  onEngine: (model: string, engine: ReaderPageEngine) => void;
  /** 输掉的那一阶段的失败。给用户看的那条路。
   *
   * 第一个参数是**哪一阶段**输的，不是「谁被点名了」：记错方向用户会去查错的模型。 */
  onFailure: (stage: 'upscale', model: string, failure: ReaderPageFailure) => void;
  /** 一路上的诊断（拿不到租借、产物解不开、产物列表拿不到…）。默认丢掉，调用方接住才能进日志：
   * 2026-10-13 的真机上「超分失效」时错误日志里什么都没有，就是因为这条线没人接。 */
  onDiagnostic?: (message: string, detail?: Record<string, unknown>) => void;
}

/** 本地这一档算出来的东西。没有就是没算成：页面照旧显示手上的那一版。 */
export interface LocalRenditions {
  enhanced?: ImageHandle;
}

export async function loadLocalRenditions(options: LocalRenditionOptions): Promise<LocalRenditions> {
  const { repository, cache, signal, scopeId, archiveId, pageIndex, generation, priority } = options;
  const { upscaleModel, onEngine, onFailure, onDiagnostic } = options;
  const base = { scopeId, archiveId, pageIndex, generation, priority, deadlineMs: 0 };
  if (upscaleModel === undefined) return {};

  /** 运行期真正的答案在这里攒：`enhanced` 是终点那一版。 */
  let enhanced: ImageHandle | undefined;
  /** 最后一次尝试的失败码。跑起来了再失败是另一回事，这里只收「没算成」。 */
  let failure: ReaderPageFailure | undefined;

  const handle = await loadReaderComputedPage({
    repository,
    cache,
    stages: [{
      stageId: READER_UPSCALE_STAGE_ID,
      identity: options.enhancedFromPageIdentity,
      onEngine: (engine) => onEngine(upscaleModel, engine),
    }],
    submit: (bridge) => bridge.submitReaderPage({ ...base, modelId: upscaleModel }),
    signal,
    // `exactOptionalPropertyTypes` 下不能把 `undefined` 显式塞进可选字段：要么给函数，
    // 要么这个键根本不在。少了这一条话就传不出去——那条链失败时日志里会一行都没有。
    ...(onDiagnostic ? { onDiagnostic } : {}),
    onFailure: (value) => { failure = value; },
  });
  if (handle !== undefined) enhanced = handle;

  if (failure !== undefined && enhanced === undefined) onFailure('upscale', upscaleModel, failure);

  return {
    ...(enhanced === undefined ? {} : { enhanced }),
  };
}

