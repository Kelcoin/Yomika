import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import {
  COMPUTE_ERROR_CODES,
  ComputeSubmitPayloadSchema,
  DecensorPagePayloadSchema,
  ReaderPagePayloadSchema,
} from '../../src/domain/compute';
import { DomainErrorCodeSchema } from '../../src/domain/errors';
import {
  COMPUTE_JOB_CHANGED_EVENT,
  COMPUTE_LEASE_ERROR_CODES,
  isComputeErrorCode,
  NativeComputeRepository,
} from '../../src/repositories/nativeComputeRepository';
import { emitTauriEvent } from '../tauriEvents';

afterEach(resetInvokeAdapterForTests);

const snapshot = {
  jobId: 'job-7',
  key: {
    inputId: 'archive-a:12',
    settingsId: 'settings-1',
    sourceRevision: 'rev-1',
    backend: 'directml',
    generation: 3,
  },
  priority: 'foreground',
  // Rust 那个 enum 没有 `tag`：单位变体是字符串，带数据的变体是外部标签的对象。
  state: { running: { stage: 'upscale', index: 0 } },
  subscribers: 1,
  sequence: 41,
  createdMs: 1000,
  settledMs: null,
};

const artifact = {
  jobId: 'job-7',
  stageId: 'upscale',
  artifactId: 'artifact-1',
  stagingName: 'upscale.bin',
  path: 'E:\\data\\cache\\images\\ab\\abcdef.bin',
  cacheRelative: 'cache/images/ab/abcdef.bin',
  byteLength: 1_048_576,
  contentHash: 'ab'.repeat(32),
  width: 1536,
  height: 2048,
  engineId: 'realcugan',
  enginePrecision: 'fp32',
  // 老 worker 的形态：两栏都在，但什么都没交代。`null` 不是「跑的就是 CPU」。
  enginePolicy: null,
  engineFallback: null,
  pipelineRevision: 'rev:v1:deadbeef',
  verified: true,
};

describe('native compute bridge', () => {
  it('submits a job and hands back the counters the caller has to remember', async () => {
    const value = { jobId: 'job-7', subscriptionId: 5, coalesced: false, snapshot, evicted: null };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const payload = {
      inputId: 'archive-a:12',
      settingsId: 'settings-1',
      sourceRevision: 'rev-1',
      backend: 'directml',
      generation: 3,
      priority: 'foreground' as const,
      input: { inputId: 'archive-a:12', contentHash: 'cd'.repeat(32), byteLength: 4096 },
      pipeline: [{ stageId: 'upscale', modelSpecId: 'realcugan-2x', enginePolicy: 'gpu' as const }],
      outputGrantId: 'grant-1',
      deadlineMs: 60_000,
    };
    const result = await new NativeComputeRepository().submit(payload);

    expect(adapter).toHaveBeenCalledWith('compute_submit', { payload });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 订阅号与序号都要留着：取消要凭订阅号，事件排序要凭序号。丢掉任何一个，
    // 调用方就只能靠 jobId 猜，而 jobId 是会被复用的。
    expect(result.value).toEqual(value);
    expect(result.value.snapshot.sequence).toBe(41);
  });

  it('reports a queue-full submission as a retryable error instead of throwing', async () => {
    const adapter = vi.fn(async () => ({
      ok: false,
      error: { code: 'COMPUTE_QUEUE_FULL', message: '前台任务已经排满', retryable: true },
    }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().submit({} as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('COMPUTE_QUEUE_FULL');
    expect(result.error.retryable).toBe(true);
  });

  it('carries the compute error codes the host actually emits', async () => {
    // 宿主比前端新的时候，重计算那一路的码必须先在这张表里登记过。没登记过的码不是
    // 「原样透传」：桥接拿 `DomainErrorCodeSchema` 校验**整条**错误信封，整条会被判成
    // `INVALID_RESPONSE`，真正的理由（worker 起不来、GPU 拿不到）反而看不见。
    const adapter = vi.fn(async () => ({
      ok: false,
      error: { code: 'COMPUTE_WORKER_LOST', message: 'worker 掉线了', retryable: true },
    }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().retryWorker();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('COMPUTE_WORKER_LOST');
    expect(result.error.retryable).toBe(true);
    expect(isComputeErrorCode('COMPUTE_WORKER_LOST')).toBe(true);
    expect(isComputeErrorCode('COMPUTE_SOMETHING_NEW')).toBe(false);
  });

  it('flattens an error code that is not in the closed table, and that table has every compute code', async () => {
    // 这张表的代价与它的价值写在 `src/domain/errors.ts`：闭集换来的是调用方能穷举地
    // 处理错误码，代价是没登记过的码看不见原来的样子。所以下面这条不变量是硬要求——
    // 宿主会发的每一个 compute 码都必须在表里，否则「算不了」会变成「无效响应」。
    for (const code of COMPUTE_ERROR_CODES) {
      expect(DomainErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }

    const adapter = vi.fn(async () => ({
      ok: false,
      error: { code: 'COMPUTE_SOMETHING_NEW', message: '新的拒绝理由', retryable: false },
    }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().retryWorker();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_RESPONSE');
  });

  it('flags a response that does not match the schema as an invalid response', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { jobId: 7 } }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().jobGet('job-7');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_RESPONSE');
  });

  it('treats a job that fell out of the retention window as a null, not a failure', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: null }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeComputeRepository().jobGet('job-gone')).resolves.toEqual({ ok: true, value: null });
    expect(adapter).toHaveBeenCalledWith('compute_job_get', { jobId: 'job-gone' });
  });

  it('lists artifacts with the numbers the reader budgets with', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: [artifact, { ...artifact, artifactId: 'artifact-2', verified: false }] }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().jobArtifacts('job-7');

    expect(adapter).toHaveBeenCalledWith('compute_job_artifacts', { jobId: 'job-7' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.byteLength).toBe(1_048_576);
    expect(result.value[0]?.pipelineRevision).toBe('rev:v1:deadbeef');
    expect(result.value[1]?.verified).toBe(false);
  });

  /** 宿主对引擎的交代要**原样**到前端：界面要靠这两栏把「自动回退」和「强制失败」分开说
   * （docs/71:126）。同时钉住一件更要紧的事：前端不认识的运行库名不许被当成 CPU ——
   * `directml` 是一条**运行库**的名字，不是一条**政策**的名字，把两者搞混正是这轮要防的。 */
  it('keeps the engine account, and refuses a runtime name where a policy belongs', async () => {
    const account = {
      ...artifact,
      enginePolicy: 'auto' as const,
      engineFallback: { requested: 'directml', used: 'cpu', reason: 'directml 在这台机器上不可用' },
    };
    setInvokeAdapterForTests(vi.fn(async () => ({ ok: true, value: [account] })));

    const result = await new NativeComputeRepository().jobArtifacts('job-7');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.enginePolicy).toBe('auto');
    expect(result.value[0]?.engineFallback).toEqual({
      requested: 'directml',
      used: 'cpu',
      reason: 'directml 在这台机器上不可用',
    });

    setInvokeAdapterForTests(vi.fn(async () => ({ ok: true, value: [{ ...account, enginePolicy: 'directml' }] })));
    const refused = await new NativeComputeRepository().jobArtifacts('job-7');
    expect(refused.ok).toBe(false);
  });

  it('acquires a lease whose url is the only handle the renderer gets', async () => {
    const value = {
      leaseId: 'a'.repeat(32),
      artifactId: 'artifact-1',
      jobId: 'job-7',
      url: `yomika-image://asset/${'a'.repeat(32)}`,
      mime: 'image/png',
      byteLength: 1_048_576,
      width: 1536,
      height: 2048,
      estimatedDecodedBytes: 12_582_912,
      pipelineRevision: 'rev:v1:deadbeef',
      expiresInMs: 600_000,
    };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().acquireArtifact('job-7', 'artifact-1');

    expect(adapter).toHaveBeenCalledWith('compute_artifact_acquire', { jobId: 'job-7', artifactId: 'artifact-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe(`yomika-image://asset/${'a'.repeat(32)}`);
    // 1536 × 2048 × 4：预算是解码后的位图，不是压缩字节数。
    expect(result.value.estimatedDecodedBytes).toBe(12_582_912);
  });

  it('releases a lease as a plain void', async () => {
    // 释放的回包是 `CommandResult<()>`，Rust 序列化成 `null`：用 `z.undefined()`
    // 会把一次成功的释放判成 invalid response（桥接那边已经踩过这个坑）。
    const adapter = vi.fn(async () => ({ ok: true, value: null }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeComputeRepository().releaseArtifact('lease-9')).resolves.toEqual({ ok: true, value: undefined });
    expect(adapter).toHaveBeenCalledWith('compute_artifact_release', { leaseId: 'lease-9' });
  });

  it('answers a release of an unknown lease with the same void', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: null }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeComputeRepository().releaseArtifact('nobody')).resolves.toEqual({ ok: true, value: undefined });
  });

  it('cancels by subscription and reports how many consumers are left', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { droppedSubscription: { remaining: 1 } } }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().cancel('job-7', 5);

    expect(adapter).toHaveBeenCalledWith('compute_cancel', { jobId: 'job-7', subscriptionId: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ droppedSubscription: { remaining: 1 } });
  });

  it('reports a cancelled running job with the running flag, not a bare void', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { cancelRequested: { running: true } } }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().cancel('job-7', 0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ cancelRequested: { running: true } });
  });

  it('reports what dropping a generation actually dropped', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { queued: 2, running: 1 } }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().dropGeneration('archive-a:12', 2);

    expect(adapter).toHaveBeenCalledWith('compute_drop_generation', { inputId: 'archive-a:12', generation: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ queued: 2, running: 1 });
  });

  it('keeps the worker status discriminator so the UI can tell "stopped" from "broken"', async () => {
    const adapter = vi.fn(async () => ({
      ok: true,
      value: { kind: 'ready', epoch: 4, peerPid: 4242, limitsApplied: true, limitsNote: null },
    }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeComputeRepository().workerStatus();

    expect(adapter).toHaveBeenCalledWith('compute_worker_status', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: 'ready', epoch: 4, peerPid: 4242, limitsApplied: true, limitsNote: null });

    const broken = vi.fn(async () => ({ ok: true, value: { kind: 'broken', reason: '启动超时' } }));
    setInvokeAdapterForTests(broken);
    const second = await new NativeComputeRepository().workerStatus();
    expect(second.ok && second.value.kind === 'broken' && second.value.reason).toBe('启动超时');
  });

  it('delivers a job snapshot event only after it parses', async () => {
    const seen: unknown[] = [];
    const repository = new NativeComputeRepository();
    const detach = repository.onJobChanged((event) => seen.push(event));
    await Promise.resolve();

    emitTauriEvent(COMPUTE_JOB_CHANGED_EVENT, snapshot);
    emitTauriEvent(COMPUTE_JOB_CHANGED_EVENT, { jobId: 7, state: 'nonsense' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(snapshot);
    detach();
  });

  it('names the lease error codes the renderer refuses on', () => {
    expect(COMPUTE_LEASE_ERROR_CODES).toEqual([
      'COMPUTE_LEASE_UNKNOWN',
      'COMPUTE_LEASE_EXPIRED',
      'COMPUTE_LEASE_WRONG_WINDOW',
      'COMPUTE_ARTIFACT_INVALID',
      'COMPUTE_RESOURCE_LIMIT',
    ]);
  });

  it('takes either a byte declaration or a page identity, never both and never neither', () => {
    // 两种诚实的说法：字节已经在手上（连哈希一起给，宿主会核对），或者只知道
    // 「这是哪一页」（位置与哈希请宿主自己去查）。阅读器走后者——它手上没有这一页的
    // 字节，也不该为了提交把几十 MB 读一遍再算一次 blake3（docs/71 §9.3）。
    // 同一条规则宿主那边也有（`compute::commands::plan`）：前端先挡一次只为少一次往返，
    // 真正算数的是宿主。
    const base = {
      inputId: 'archive-a:12',
      settingsId: 'settings-1',
      sourceRevision: 'rev-1',
      backend: 'directml',
      generation: 3,
      priority: 'foreground' as const,
      pipeline: [{ stageId: 'upscale', modelSpecId: 'realcugan-2x', enginePolicy: 'gpu' as const }],
      outputGrantId: 'grant-1',
      deadlineMs: 60_000,
    };
    const declared = {
      ...base,
      input: { inputId: 'archive-a:12', contentHash: 'cd'.repeat(32), byteLength: 4096 },
    };
    const identity = {
      ...base,
      source: { scopeId: 'scope-a', archiveId: 'archive-a', pageIndex: 11 },
    };

    expect(ComputeSubmitPayloadSchema.safeParse(declared).success).toBe(true);
    expect(ComputeSubmitPayloadSchema.safeParse(identity).success).toBe(true);
    expect(
      ComputeSubmitPayloadSchema.safeParse({ ...identity, input: declared.input }).success,
    ).toBe(false);
    expect(ComputeSubmitPayloadSchema.safeParse(base).success).toBe(false);

    // 身份里塞不进路径或哈希：zod 把未知键**剥掉**（不是报错），所以硬塞也到不了宿主。
    const sneaky = ComputeSubmitPayloadSchema.parse({
      ...base,
      source: { scopeId: 'scope-a', archiveId: 'archive-a', pageIndex: 11, contentHash: 'cd'.repeat(32) },
    });
    expect(sneaky.source).toEqual({ scopeId: 'scope-a', archiveId: 'archive-a', pageIndex: 11 });
  });

  it('sends the reader page over its own command, because the host mints the job identity', async () => {
    const value = { jobId: 'job-9', subscriptionId: 1, coalesced: false, snapshot, evicted: null };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeComputeRepository();

    await repository.submitReaderPage({
      scopeId: 'scope-a',
      archiveId: 'archive-a',
      pageIndex: 11,
      modelId: 'realcugan-2x-conservative',
      generation: 7,
      priority: 'background',
      deadlineMs: 0,
    });

    expect(adapter).toHaveBeenCalledWith('compute_submit_reader_page', {
      payload: {
        scopeId: 'scope-a',
        archiveId: 'archive-a',
        pageIndex: 11,
        modelId: 'realcugan-2x-conservative',
        generation: 7,
        priority: 'background',
        deadlineMs: 0,
      },
    });
  });

  it('refuses a reader payload that carries fields only the host may decide', () => {
    // 身份（`settingsId`/`sourceRevision`/`backend`）与管线、授权号都由宿主铸。`.strict()`
    // 对应 Rust 那侧的 `deny_unknown_fields`：多一个键在那边是直接反序列化失败，前端先挡
    // 一次，报的是字段名而不是一句「invalid args」。
    const payload = {
      scopeId: 'scope-a',
      archiveId: 'archive-a',
      pageIndex: 11,
      modelId: 'realcugan-2x-conservative',
      generation: 7,
      priority: 'foreground' as const,
      deadlineMs: 0, // 0 = 用调度器的默认期限
    };

    expect(ReaderPagePayloadSchema.safeParse(payload).success).toBe(true);
    expect(ReaderPagePayloadSchema.safeParse({ ...payload, pageIndex: -1 }).success).toBe(false);
    expect(ReaderPagePayloadSchema.safeParse({ ...payload, scopeId: '' }).success).toBe(false);
    expect(ReaderPagePayloadSchema.safeParse({ ...payload, priority: 'urgent' }).success).toBe(false);

    const forged = ReaderPagePayloadSchema.safeParse({
      ...payload,
      settingsId: 'settings-1',
      sourceRevision: 'rev-1',
      backend: 'directml',
    });
    expect(forged.success).toBe(false);
    if (!forged.success) {
      expect(forged.error.issues.map((issue) => issue.message).join(' ')).toContain('settingsId');
    }
  });

  it('sends the decensor page over its own command, because the worker is the one that looks at the pixels', async () => {
    // 去码那道门与阅读器那道门形状相同（位置 + 模型 + 世代）：两边都只由宿主铸身份。区别在
    // **谁看像素**——去码这一页的框由 worker 检测（docs/94），宿主只把这一页、检测器和两份
    // 修补模型摆进输入根；所以它是一条自己的命令，不是阅读器那条的变体。
    const value = { jobId: 'job-de', subscriptionId: 2, coalesced: false, snapshot, evicted: null };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeComputeRepository();

    const result = await repository.submitDecensorPage({
      scopeId: 'scope-a',
      archiveId: 'archive-a',
      pageIndex: 11,
      modelId: 'aletheia-lens',
      generation: 4,
      priority: 'foreground',
      deadlineMs: 0,
    });

    expect(adapter).toHaveBeenCalledWith('compute_submit_decensor_page', {
      payload: {
        scopeId: 'scope-a',
        archiveId: 'archive-a',
        pageIndex: 11,
        modelId: 'aletheia-lens',
        generation: 4,
        priority: 'foreground',
        deadlineMs: 0,
      },
    });
    expect(result).toEqual({ ok: true, value });
  });

  it('asks for the upscale as the second stage of the very same job, because a chain only exists inside one task', async () => {
    // 链的第二阶段只能吃第一阶段的产物，而 compute 产物只有内容寻址的落点、没有按修订号登记
    // 的缓存行——出了这件任务，没人能按身份把它找回来。所以「补完接着放大」必须写在同一条
    // 请求里（docs/95），不是第二次提交：两次提交的结果是两个各自独立的 revision，第二个
    // 任务也没有资格去读第一个的产物。
    const value = { jobId: 'job-chain', subscriptionId: 5, coalesced: false, snapshot, evicted: null };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeComputeRepository();

    await repository.submitDecensorPage({
      scopeId: 'scope-a',
      archiveId: 'archive-a',
      pageIndex: 11,
      modelId: 'aletheia-lens',
      generation: 4,
      priority: 'foreground',
      deadlineMs: 0,
      upscaleModelId: 'realcugan-2x-conservative',
    });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledWith('compute_submit_decensor_page', {
      payload: {
        scopeId: 'scope-a',
        archiveId: 'archive-a',
        pageIndex: 11,
        modelId: 'aletheia-lens',
        generation: 4,
        priority: 'foreground',
        deadlineMs: 0,
        upscaleModelId: 'realcugan-2x-conservative',
      },
    });
  });

  it('does not accept "nothing to repair" as an answer any more, because the worker decides that', async () => {
    // 8-c 里这道门答过 `null`：宿主自己检测过这一页，一个要补的框都没有 ⇒ 原页就是答案。
    // 8-e 把检测搬进 worker 之后这条通道被撤了——宿主不再看像素，也就没有资格替 worker 说
    // 「不用补」；一个框都没有是 worker 的**成功结论**，它照样交出一件产物（原样编码的那一页，
    // 与源页逐点相同）。钉住这件事，是因为那条 `null` 一旦回来，调用方就会把「原页」和一个
    // 解码失败混成一件事：一个是正常显示，一个是错误提示。
    //
    // 断言写成 `INVALID_RESPONSE` 而不是 `rejects`：`invokeCommand` 从不抛（`src/bridge/invoke.ts:54-62`
    // 是 `safeParse` + `return err(...)`），所以一个 `null` 撞上非 nullable 的 schema 会变成一条
    // 可读的失败，而不是一个没人接的异常。
    const adapter = vi.fn(async () => ({ ok: true, value: null }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeComputeRepository();

    const result = await repository.submitDecensorPage({
      scopeId: 'scope-a',
      archiveId: 'archive-a',
      pageIndex: 11,
      modelId: 'aletheia-lens',
      generation: 4,
      priority: 'foreground',
      deadlineMs: 0,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_RESPONSE',
        message: 'Native command returned an invalid response',
        retryable: false,
      },
    });
  });

  it('refuses a decensor payload that carries fields only the host may decide', () => {
    const payload = {
      scopeId: 'scope-a',
      archiveId: 'archive-a',
      pageIndex: 11,
      modelId: 'aletheia-lens',
      generation: 4,
      priority: 'background' as const,
      deadlineMs: 0,
    };

    expect(DecensorPagePayloadSchema.safeParse(payload).success).toBe(true);
    expect(DecensorPagePayloadSchema.safeParse({ ...payload, pageIndex: -1 }).success).toBe(false);
    expect(DecensorPagePayloadSchema.safeParse({ ...payload, modelId: '' }).success).toBe(false);
    // 「接着放大」那一条要么指名一个模型、要么整句不写；写一个空串是第三种状态，不许存在。
    expect(DecensorPagePayloadSchema.safeParse({ ...payload, upscaleModelId: '' }).success).toBe(false);
    expect(DecensorPagePayloadSchema.safeParse({ ...payload, upscaleModelId: 'realcugan-2x' }).success).toBe(true);
    // 检测集与身份都不许由渲染进程塞：框由 worker 自己从像素里算（docs/94），宿主只管
    // 「这一页 + 哪三份模型」；身份（`settingsId`）也只有读得到模型包的宿主铸得出来。
    const forged = DecensorPagePayloadSchema.safeParse({
      ...payload,
      detections: [1, 2, 3],
      settingsId: 'settings-1',
    });
    expect(forged.success).toBe(false);
    if (!forged.success) {
      expect(forged.error.issues.map((issue) => issue.message).join(' ')).toContain('detections');
    }
  });
});
