import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setImageDecoderForTests } from '../../src/lib/decodeImage';
import { UnifiedImageCache, peekCachedImage, type CachedImageData, type ImageCacheRepository } from '../../src/lib/unifiedImageCache';
import {
  READER_UPSCALE_STAGE_ID,
  loadLocalRenditions,
  loadReaderComputedPage,
  type LocalRenditionOptions,
  type LocalRenditions,
  type ReaderComputedPageBridge,
  type ReaderComputedStageClaim,
  type ReaderPageEngine,
  type ReaderPageFailure,
} from '../../src/lib/readerComputedPage';
import type { ImageCacheIdentity } from '../../src/domain/cache';
import type { ReaderPagePayload } from '../../src/domain/compute';
import type {
  ComputeArtifactRecord,
  ComputeJobKey,
  ComputeJobSnapshot,
  ComputeJobState,
  ComputeSubmitted,
  ComputedImageLease,
} from '../../src/domain/compute';
import type { CommandResult as Result } from '../../src/domain/result';

const IDENTITY: ImageCacheIdentity = {
  scopeId: 'scope-a',
  archiveId: 'archive-a',
  pageIndex: 7,
  rendition: 'enhanced',
  modelId: 'realcugan-2x-conservative',
  source: 'reader-page',
};

const PAYLOAD: ReaderPagePayload = {
  scopeId: 'scope-a',
  archiveId: 'archive-a',
  pageIndex: 7,
  modelId: 'realcugan-2x-conservative',
  generation: 0,
  priority: 'foreground',
  deadlineMs: 0,
};

const KEY: ComputeJobKey = {
  inputId: 'scope-a:archive-a:7',
  settingsId: 'rev:v1:abc',
  sourceRevision: 'reader-page',
  backend: 'cpu',
  generation: 0,
};

function snapshot(state: ComputeJobState, sequence: number): ComputeJobSnapshot {
  return {
    jobId: 'job-1',
    key: KEY,
    priority: 'foreground',
    state,
    subscribers: 1,
    sequence,
    createdMs: 1,
    settledMs: null,
  };
}

function artifact(overrides: Partial<ComputeArtifactRecord> = {}): ComputeArtifactRecord {
  return {
    jobId: 'job-1',
    stageId: READER_UPSCALE_STAGE_ID,
    artifactId: 'artifact-1',
    stagingName: 'stage-upscale.bin',
    path: 'E:\\staging\\stage-upscale.bin',
    cacheRelative: 'cache/images/ab/ab.bin',
    byteLength: 4096,
    contentHash: 'blake3:aa',
    width: 48,
    height: 32,
    engineId: 'onnx',
    enginePrecision: 'Fp32',
    // 默认夹具是**没有引擎交代**的形态（老 worker，或事实驱动那条路）：宿主那两栏是 null，
    // 不等于「跑的就是 CPU」。要考回退的用例自己覆盖。
    enginePolicy: null,
    engineFallback: null,
    pipelineRevision: 'worker-v1:1',
    verified: true,
    ...overrides,
  };
}

function lease(artifactId: string): ComputedImageLease {
  return {
    leaseId: `lease-${artifactId}`,
    artifactId,
    jobId: 'job-1',
    url: `yomika-image://assets/${artifactId}`,
    mime: 'image/png',
    byteLength: 4096,
    width: 48,
    height: 32,
    // 故意与 `byteLength` 不同：预算那把尺子必须取编码后的长度（见下面那条断言）。
    estimatedDecodedBytes: 6144,
    pipelineRevision: 'worker-v1:1',
    expiresInMs: 60_000,
  };
}

interface FakeBridge extends ReaderComputedPageBridge {
  emit(event: ComputeJobSnapshot): void;
  listeners(): number;
}

function bridge(options: {
  artifacts?: ComputeArtifactRecord[];
  submit?: () => Promise<Result<ComputeSubmitted>>;
  onCall?: (name: string) => void;
} = {}): FakeBridge {
  const handlers = new Set<(event: ComputeJobSnapshot) => void>();
  return {
    onJobChanged: vi.fn((handler: (event: ComputeJobSnapshot) => void) => {
      handlers.add(handler);
      options.onCall?.('subscribe');
      return () => { handlers.delete(handler); };
    }),
    submitReaderPage: vi.fn(() => {
      options.onCall?.('submit');
      return options.submit
        ? options.submit()
        : Promise.resolve<Result<ComputeSubmitted>>({
          ok: true,
          value: {
            jobId: 'job-1',
            subscriptionId: 3,
            coalesced: false,
            snapshot: snapshot('queued', 0),
            evicted: null,
          },
        });
    }),
    cancel: vi.fn(async () => ({ ok: true as const, value: 'alreadyTerminal' as const })),
    jobArtifacts: vi.fn(async () => ({ ok: true as const, value: options.artifacts ?? [] })),
    acquireArtifact: vi.fn(async (_jobId: string, artifactId: string) => ({ ok: true as const, value: lease(artifactId) })),
    releaseArtifact: vi.fn(async () => ({ ok: true as const, value: undefined })),
    emit: (event) => { for (const handler of [...handlers]) handler(event); },
    listeners: () => handlers.size,
  };
}

/** 只读替身：这条路上缓存自己不去取图，`load` 那半边不该被碰到。 */
function readonlyCache(maxBytes = 1 << 20) {
  const repository: ImageCacheRepository = {
    read: vi.fn(async (): Promise<CachedImageData | null> => null),
    fetch: vi.fn(async () => ({ bytes: new Uint8Array([1]), mime: 'image/jpeg' })),
    store: vi.fn(async () => undefined),
  };
  const revoked: string[] = [];
  const cache = new UnifiedImageCache(repository, {
    createObjectURL: () => 'blob:test-adopted',
    revokeObjectURL: (url) => revoked.push(url),
    maxBytes,
  });
  return { cache, repository, revoked };
}

/** 一条阶段：默认就是阅读器那条超分链的唯一一阶段。 */
function claim(overrides: Partial<ReaderComputedStageClaim> = {}): ReaderComputedStageClaim {
  return { stageId: READER_UPSCALE_STAGE_ID, identity: IDENTITY, ...overrides };
}

function load(
  bridge: FakeBridge,
  cache: UnifiedImageCache,
  signal?: AbortSignal,
  stages: ReaderComputedStageClaim[] = [claim()],
) {
  return loadReaderComputedPage({
    repository: bridge,
    cache,
    stages,
    submit: (repository) => repository.submitReaderPage(PAYLOAD),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** 等一次宏任务：让 `submitReaderPage` 的应答落地。
 *
 * 事件只认**已经知道的那个 jobId**（订阅是全局的，不知道 jobId 之前来的一律不看），所以
 * 「提交应答之前就到达的事件」在这里是会被丢掉的——那种情况下改由应答自带的快照兜住
 * （`completed`/`running` 立刻去问产物，见「already done」那条）。测试要像宿主一样：
 * 先让应答落地，再发事件。 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

beforeEach(() => setImageDecoderForTests(async () => undefined));
afterEach(() => {
  setImageDecoderForTests(undefined);
  vi.restoreAllMocks();
});

describe('loadReaderComputedPage', () => {

  it('settles a host-cancelled job without waiting for a local AbortSignal', async () => {
    const repo = bridge();
    const { cache } = readonlyCache();
    const pending = load(repo, cache);
    let settled = false;
    void pending.then(() => { settled = true; });
    await flush();
    repo.emit(snapshot('cancelled', 2));
    await flush();
    expect(settled).toBe(true);
    expect(await pending).toBeUndefined();
    expect(repo.listeners()).toBe(0);
  });

  it('settles cancellation already present in the submission snapshot', async () => {
    const repo = bridge({ submit: async () => ({ ok: true, value: {
      jobId: 'job-1', subscriptionId: 3, coalesced: false,
      snapshot: snapshot('cancelled', 2), evicted: null,
    } }) });
    const { cache } = readonlyCache();
    const pending = load(repo, cache);
    let settled = false;
    void pending.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(true);
    expect(await pending).toBeUndefined();
    expect(repo.listeners()).toBe(0);
  });

  it('subscribes before it submits, then hands the artifact over as an ordinary handle', async () => {
    // 顺序是有用的：任务可能在 `submit` 的应答回来之前就已经跑完（宿主把这次提交并进了
    // 正在跑的那个，或者直接命中缓存）。先挂订阅再开口，才不会被自己的等待窗口挡掉。
    const order: string[] = [];
    const b = bridge({ artifacts: [artifact()], onCall: (name) => order.push(name) });
    const { cache, repository } = readonlyCache();

    const promise = load(b, cache);
    expect(order).toEqual(['subscribe', 'submit']);
    await flush();
    b.emit(snapshot('completed', 1));
    const handle = await promise;

    expect(b.acquireArtifact).toHaveBeenCalledWith('job-1', 'artifact-1');
    expect(handle?.url).toBe('yomika-image://assets/artifact-1');
    // 预算那把尺子是编码后的长度，不是解码位图（两者在替身里故意不同）。
    expect(handle?.bytes).toBe(4096);
    expect((handle as typeof handle & { estimatedDecodedBytes?: number })?.estimatedDecodedBytes).toBe(6144);
    expect(repository.fetch).not.toHaveBeenCalled();

    cache.release(handle!);
    expect(b.releaseArtifact).toHaveBeenCalledWith('lease-artifact-1');
  });

  it('takes only the verified upscale artifact that really has a landing spot', async () => {
    // 同一个 job 的产物列表里可能出现别的阶段、没核验过的、以及只有 staging 没有落点的
    // 登记。挑错一个就等于把别的中间结果当成这一页。
    //
    // 能用的那一张故意**放在中间**：三个诱饵一个比一个晚，各自只违反一个条件。这样
    // 少掉任何一个条件，「最后一个能用的」都会变成那个诱饵——判据是按「谁被挑走」钉的，
    // 不是按「挑了三张里的第几张」。
    const b = bridge({
      artifacts: [
        artifact({ stageId: 'other-stage', artifactId: 'other-1' }),
        artifact({ artifactId: 'upscale-1' }),
        artifact({ artifactId: 'unverified-1', verified: false }),
        artifact({ artifactId: 'staging-only-1', cacheRelative: null }),
        artifact({ stageId: 'other-stage', artifactId: 'other-2' }),
      ],
    });
    const { cache } = readonlyCache();

    const promise = load(b, cache);
    await flush();
    b.emit(snapshot('completed', 1));
    const handle = await promise;

    expect(b.acquireArtifact).toHaveBeenCalledTimes(1);
    expect(b.acquireArtifact).toHaveBeenCalledWith('job-1', 'upscale-1');
    expect(handle?.url).toBe('yomika-image://assets/upscale-1');
    cache.release(handle!);
  });

  it('picks the artifact up straight from an answer that says the job is already done', async () => {
    // 命中缓存的那种提交：应答回来时状态就是 completed，而且此后不会再有任何事件。
    // 只靠事件驱动的话这一页会一直停在等结果。
    const b = bridge({
      artifacts: [artifact()],
      submit: async () => ({
        ok: true,
        value: {
          jobId: 'job-1',
          subscriptionId: 3,
          coalesced: true,
          snapshot: snapshot('completed', 9),
          evicted: null,
        },
      }),
    });
    const { cache } = readonlyCache();

    const handle = await load(b, cache);

    expect(handle?.url).toBe('yomika-image://assets/artifact-1');
    cache.release(handle!);
  });

  it('asks for the artifacts as soon as the job is running, not only when it completes', async () => {
    // §9.1：一个阶段跑完就已经能出图了，等整条管线结束只会让用户多盯一秒旧图。
    const b = bridge({
      artifacts: [artifact()],
      submit: async () => ({
        ok: true,
        value: {
          jobId: 'job-1',
          subscriptionId: 3,
          coalesced: false,
          snapshot: snapshot({ running: { stage: READER_UPSCALE_STAGE_ID, index: 0 } }, 1),
          evicted: null,
        },
      }),
    });
    const { cache } = readonlyCache();

    const handle = await load(b, cache);

    expect(b.jobArtifacts).toHaveBeenCalledWith('job-1');
    expect(handle?.url).toBe('yomika-image://assets/artifact-1');
    cache.release(handle!);
  });

  it('gives nothing back when the host says the job failed', async () => {
    const b = bridge({
      submit: async () => ({
        ok: true,
        value: {
          jobId: 'job-1',
          subscriptionId: 3,
          coalesced: false,
          snapshot: { ...snapshot({ failed: { code: 'COMPUTE_WORKER_UNAVAILABLE' } }, 2), failureMessage: 'native allocation refused: output size' },
          evicted: null,
        },
      }),
    });
    const { cache } = readonlyCache();
    const notes: string[] = [];
    const failures: ReaderPageFailure[] = [];

    const handle = await loadReaderComputedPage({
      repository: b,
      cache,
      stages: [claim()],
      submit: (repository) => repository.submitReaderPage(PAYLOAD),
      onDiagnostic: (message, detail) => notes.push(`${message} ${detail?.message ?? ''}`),
      onFailure: failure => failures.push(failure),
    });

    expect(handle).toBeUndefined();
    expect(peekCachedImage(cache, IDENTITY)).toBeUndefined();
    expect(notes).toContain('阅读器算图：任务失败 native allocation refused: output size');
    expect(failures).toEqual([{ code: 'COMPUTE_WORKER_UNAVAILABLE', message: 'native allocation refused: output size' }]);
  });

  it('ignores events that belong to another page or to an older sequence', async () => {
    // 订阅是全局的：同一代里别的页也在报。拿别人的事件去问产物，只会把别人的图认领到这一页。
    const b = bridge({ artifacts: [artifact()] });
    const { cache } = readonlyCache();

    const promise = load(b, cache);
    await flush();
    // 别人的任务先跑完：订阅是全局的，但不许拿它的完成去问这一页的产物。
    b.emit({ ...snapshot('completed', 11), jobId: 'job-other' });
    b.emit(snapshot('queued', 9)); // 自己这个 job，序号更新，但状态还不是「出图了」
    b.emit(snapshot('completed', 3)); // 更旧的完成事件：不许当成新的
    expect(b.jobArtifacts).not.toHaveBeenCalled();

    b.emit(snapshot('completed', 12));
    const handle = await promise;

    expect(b.jobArtifacts).toHaveBeenCalledTimes(1);
    expect(handle?.url).toBe('yomika-image://assets/artifact-1');
    cache.release(handle!);
  });

  it('hands an artifact that will not decode straight back instead of showing a broken page', async () => {
    setImageDecoderForTests(async () => { throw new Error('这个 URL 解不开'); });
    const b = bridge({ artifacts: [artifact()] });
    const { cache } = readonlyCache();

    const promise = load(b, cache);
    await flush();
    b.emit(snapshot('completed', 1));
    const handle = await promise;

    expect(handle).toBeUndefined();
    expect(b.releaseArtifact).toHaveBeenCalledWith('lease-artifact-1');
    expect(peekCachedImage(cache, IDENTITY)).toBeUndefined();
  });

  it('does not adopt a lease the real image element cannot load', async () => {
    // 上面那条用的是测试用的 decoder 替身，它自己会 reject——所以它证明不了**生产**那条路：
    // 真的 `decodeImage` 把失败吞掉了（`decode().catch(() => undefined)`），URL 打不开时
    // 产品里就是「换上一张破图、日志一行都没有」（2026-10-13 真机现场）。这条换掉全局
    // `Image`（src 一设就报 onerror、`decode()` 也 reject）走真实现：把调用改回宽松版，
    // 它立刻转红（会认领、会显示成坏图）。
    setImageDecoderForTests(undefined);
    const original = (globalThis as { Image?: unknown }).Image;
    class BrokenImage {
      decoding = 'async';
      complete = false;
      naturalWidth = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_url: string) {
        queueMicrotask(() => this.onerror?.());
      }
      decode(): Promise<void> {
        return Promise.reject(new Error('解不开'));
      }
    }
    (globalThis as { Image?: unknown }).Image = BrokenImage;
    try {
      const b = bridge({ artifacts: [artifact()] });
      const { cache } = readonlyCache();

      const promise = load(b, cache);
      await flush();
      b.emit(snapshot('completed', 1));
      const handle = await promise;

      expect(handle).toBeUndefined();
      expect(b.releaseArtifact).toHaveBeenCalledWith('lease-artifact-1');
      expect(peekCachedImage(cache, IDENTITY)).toBeUndefined();
    } finally {
      (globalThis as { Image?: unknown }).Image = original;
    }
  });

  it('needs no job at all when the page is already in hand', async () => {
    const b = bridge();
    const { cache } = readonlyCache();
    const adopted = cache.adopt(IDENTITY, { url: 'yomika-image://assets/lease-1', bytes: 4096, release: vi.fn() });

    const handle = await load(b, cache);

    expect(handle?.url).toBe(adopted.url);
    expect(b.submitReaderPage).not.toHaveBeenCalled();
    cache.release(adopted);
    cache.release(handle!);
  });

  it('never asks the host for a page the reader already walked away from', async () => {
    const b = bridge();
    const { cache } = readonlyCache();
    const controller = new AbortController();
    controller.abort();

    const handle = await load(b, cache, controller.signal);

    expect(handle).toBeUndefined();
    expect(b.submitReaderPage).not.toHaveBeenCalled();
    expect(b.onJobChanged).not.toHaveBeenCalled();
  });

  it('cancels a job whose submit answer arrives after the reader left', async () => {
    // `abort` 那会儿还不知道 jobId，退不掉这份订阅；应答回来时补退——否则这一页会一直
    // 占着宿主的订阅名额（后台那件永远轮不到位置）。
    let answer!: (value: Result<ComputeSubmitted>) => void;
    const b = bridge({ submit: () => new Promise((resolve) => { answer = resolve; }) });
    const { cache } = readonlyCache();
    const controller = new AbortController();

    const promise = load(b, cache, controller.signal);
    await vi.waitFor(() => expect(b.submitReaderPage).toHaveBeenCalledTimes(1));
    controller.abort();
    answer({
      ok: true,
      value: {
        jobId: 'job-1',
        subscriptionId: 3,
        coalesced: false,
        snapshot: snapshot('queued', 0),
        evicted: null,
      },
    });

    await expect(promise).resolves.toBeUndefined();
    expect(b.cancel).toHaveBeenCalledWith('job-1', 3);
    expect(b.listeners()).toBe(0);
  });

  it('reports a submit that never got through without hanging on the event stream', async () => {
    const b = bridge({
      submit: async () => ({ ok: false, error: { code: 'COMPUTE_BAD_REQUEST', message: '这一页还没有落在缓存里', retryable: false } }),
    });
    const { cache } = readonlyCache();
    const notes: string[] = [];
    const failures: ReaderPageFailure[] = [];

    const handle = await loadReaderComputedPage({
      repository: b,
      cache,
      stages: [claim()],
      submit: (repository) => repository.submitReaderPage(PAYLOAD),
      onDiagnostic: (message) => notes.push(message),
      onFailure: (failure) => failures.push(failure),
    });

    expect(handle).toBeUndefined();
    expect(notes).toContain('阅读器算图：提交没成功');
    // 命令回包那条路有话说，所以它必须把话带上；事件那条路只有码（见下一条）。
    expect(failures).toEqual([{ code: 'COMPUTE_BAD_REQUEST', message: '这一页还没有落在缓存里' }]);
    expect(b.listeners()).toBe(0);
  });

  it('hands over the engine account of itself together with the artifact', async () => {
    // 「点的是显卡、跑的是 CPU」这句话只有产物上那两栏说得出来（7-b-ix）。交代必须与
    // 这一版上屏一起发生：没有产物就没有交代，界面也不该凭空说一句。
    const b = bridge({
      artifacts: [artifact({
        enginePolicy: 'auto',
        engineDeviceId: 'cpu',
        engineFallback: { requested: 'directml', used: 'cpu', reason: 'directml 在这台机器上不可用' },
      })],
    });
    const { cache } = readonlyCache();
    const seen: ReaderPageEngine[] = [];

    const promise = loadReaderComputedPage({
      repository: b,
      cache,
      stages: [claim({ onEngine: (engine) => seen.push(engine) })],
      submit: (repository) => repository.submitReaderPage(PAYLOAD),
    });
    await flush();
    b.emit(snapshot('completed', 1));
    const handle = await promise;

    expect(seen).toEqual([{
      policy: 'auto',
      deviceId: 'cpu',
      fallback: { requested: 'directml', used: 'cpu', reason: 'directml 在这台机器上不可用' },
    }]);
    cache.release(handle!);
  });

  it('reports an engine that said nothing as nothing, not as CPU', async () => {
    // 老 worker（或事实驱动那条路）的报告里没有这两栏。如实带出两个 `null`：界面按
    // 「宿主没交代」处理，而不是替宿主宣布「跑的就是 CPU」——那正是本轮要消灭的谎话。
    const b = bridge({ artifacts: [artifact()] });
    const { cache } = readonlyCache();
    const seen: ReaderPageEngine[] = [];

    const promise = loadReaderComputedPage({
      repository: b,
      cache,
      stages: [claim({ onEngine: (engine) => seen.push(engine) })],
      submit: (repository) => repository.submitReaderPage(PAYLOAD),
    });
    await flush();
    b.emit(snapshot('completed', 1));
    const handle = await promise;

    expect(seen).toEqual([{ policy: null, fallback: null }]);
    cache.release(handle!);
  });

  it('hands the failure code out when the job itself fails', async () => {
    // 事件里的失败只带码、不带话。界面要靠这个码把「点名要显卡却没给上」与普通降级分开
    // （`GPU_OUTPUT_INVALID`/`GPU_BACKEND_UNAVAILABLE` 是强制失败，措辞必须不同）。
    const b = bridge();
    const { cache } = readonlyCache();
    const failures: ReaderPageFailure[] = [];

    const promise = loadReaderComputedPage({
      repository: b,
      cache,
      stages: [claim()],
      submit: (repository) => repository.submitReaderPage(PAYLOAD),
      onFailure: (failure) => failures.push(failure),
    });
    await flush();
    b.emit(snapshot({ failed: { code: 'GPU_OUTPUT_INVALID' } }, 1));
    const handle = await promise;

    expect(handle).toBeUndefined();
    expect(failures).toEqual([{ code: 'GPU_OUTPUT_INVALID' }]);
    expect(b.listeners()).toBe(0);
  });

  it('picks the artifact for the stage the reader declared, and nothing else', async () => {
    // 阅读器这一版只声明一档（超分），列表里别的阶段（将来再多一档也走这条路）不该被认领。
    const b = bridge({
      artifacts: [
        artifact({ stageId: 'other-stage', artifactId: 'other-1' }),
        artifact({ stageId: READER_UPSCALE_STAGE_ID, artifactId: 'upscale-1' }),
      ],
      submit: () => success(),
    });
    const { cache } = readonlyCache();

    const handle = await load(b, cache);

    expect(b.acquireArtifact).toHaveBeenCalledTimes(1);
    expect(b.acquireArtifact).toHaveBeenCalledWith('job-1', 'upscale-1');
    expect(handle?.url).toBe('yomika-image://assets/upscale-1');
    cache.release(handle!);
  });
});

const UPSCALE_MODEL = 'realcugan-2x-conservative';

const ENHANCED_FROM_PAGE: ImageCacheIdentity = { ...IDENTITY, source: 'reader-page' };

function success(jobId = 'job-1', state: ComputeJobState = 'completed', sequence = 1): Promise<Result<ComputeSubmitted>> {
  return Promise.resolve({
    ok: true as const,
    value: { jobId, subscriptionId: 3, coalesced: false, snapshot: snapshot(state, sequence), evicted: null },
  });
}

function local(
  b: FakeBridge,
  cache: UnifiedImageCache,
  overrides: Partial<LocalRenditionOptions> = {},
): Promise<LocalRenditions> {
  return loadLocalRenditions({
    repository: b,
    cache,
    signal: new AbortController().signal,
    scopeId: 'scope-a',
    archiveId: 'archive-a',
    pageIndex: 7,
    generation: 0,
    priority: 'foreground',
    upscaleModel: UPSCALE_MODEL,
    enhancedFromPageIdentity: ENHANCED_FROM_PAGE,
    onEngine: () => undefined,
    onFailure: () => undefined,
    ...overrides,
  });
}

describe('loadLocalRenditions', () => {
  it('submits the upscale stage once and hands back the artifact it adopted', async () => {
    const b = bridge({
      artifacts: [artifact({ stageId: READER_UPSCALE_STAGE_ID, artifactId: 'upscale-1' })],
      submit: () => success(),
    });
    const { cache } = readonlyCache();
    const failures: string[] = [];

    const renditions = await local(b, cache, {
      onFailure: (stage, model, failure) => failures.push(`${stage}:${model}:${failure.code}`),
    });

    expect(vi.mocked(b.submitReaderPage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(b.submitReaderPage).mock.calls[0]![0]).toMatchObject({ modelId: UPSCALE_MODEL });
    expect(renditions.enhanced?.url).toBe('yomika-image://assets/upscale-1');
    expect(failures).toEqual([]);

    cache.release(renditions.enhanced!);
  });

  it('carries the chain diagnostics out so a page that fails silently can still be logged', async () => {
    // 2026-10-13 真机：超分「失败」时错误日志里一行都没有——这条链的 note（产物解不开、
    // 租借拿不到、摘不掉…）在 `loadLocalRenditions` 这一层被丢掉了，没人把它写进日志。
    // 这条把「话有没有传出来」钉住：把 `onDiagnostic` 那一行删掉，它立刻转红。
    setImageDecoderForTests(async () => {
      throw new Error('这个 URL 解不开');
    });
    const b = bridge({ artifacts: [artifact({ stageId: READER_UPSCALE_STAGE_ID })] });
    const { cache } = readonlyCache();
    const diagnostics: string[] = [];
    const failures: string[] = [];

    const promise = local(b, cache, {
      onDiagnostic: (message) => diagnostics.push(message),
      onFailure: (stage, model, failure) => failures.push(`${stage}:${model}:${failure.code}`),
    });
    await flush();
    b.emit(snapshot('completed', 1));
    const renditions = await promise;

    expect(renditions.enhanced).toBeUndefined();
    expect(failures).toEqual([`${READER_UPSCALE_STAGE_ID}:${UPSCALE_MODEL}:READER_ARTIFACT_UNDECODABLE`]);
    expect(diagnostics).toContain('阅读器算图：产物解不开');
  });
});
