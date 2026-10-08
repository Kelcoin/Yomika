import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setImageDecoderForTests } from '../../src/lib/decodeImage';
import { UnifiedImageCache, peekCachedImage, type CachedImageData, type ImageCacheRepository } from '../../src/lib/unifiedImageCache';
import {
  READER_DECENSOR_STAGE_ID,
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
  decensor?: () => Promise<Result<ComputeSubmitted>>;
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
    // 这道门默认答「不许走」；要走去码那条路的用例自己给 `decensor`。
    submitDecensorPage: vi.fn(async (): Promise<Result<ComputeSubmitted>> => (options.decensor
      ? options.decensor()
      : {
        ok: false as const,
        error: { code: 'COMPUTE_BAD_REQUEST' as const, message: '这条用例不走去码那道门', retryable: false },
      })),
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
        artifact({ stageId: 'decensor', artifactId: 'decensor-1' }),
        artifact({ artifactId: 'upscale-1' }),
        artifact({ artifactId: 'unverified-1', verified: false }),
        artifact({ artifactId: 'staging-only-1', cacheRelative: null }),
        artifact({ stageId: 'decensor', artifactId: 'decensor-2' }),
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
          snapshot: snapshot({ failed: { code: 'COMPUTE_WORKER_UNAVAILABLE' } }, 2),
          evicted: null,
        },
      }),
    });
    const { cache } = readonlyCache();
    const notes: string[] = [];

    const handle = await loadReaderComputedPage({
      repository: b,
      cache,
      stages: [claim()],
      submit: (repository) => repository.submitReaderPage(PAYLOAD),
      onDiagnostic: (message) => notes.push(message),
    });

    expect(handle).toBeUndefined();
    expect(peekCachedImage(cache, IDENTITY)).toBeUndefined();
    expect(notes).toContain('阅读器算图：任务失败');
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

  it('hands the first stage over as soon as it lands, then keeps waiting for the answer', async () => {
    // 一条链（去码 → 超分）的意义就在这里：第一步的产物一出来就先上屏，用户不必盯着原图
    // 等第二步跑完；而**返回值**只代表最后那一版（§9.1 ⑦：后面的阶段失败了，前面成功的
    // 那一版留着）。
    // 中间那一版的身份与答案那一版不同（`rendition: 'decensored'`）：两张图在同一张账上并存。
    const decensored: ImageCacheIdentity = { ...IDENTITY, rendition: 'decensored' };
    const b = bridge({
      artifacts: [
        artifact({ stageId: READER_DECENSOR_STAGE_ID, artifactId: 'decensor-1' }),
        artifact({ stageId: READER_UPSCALE_STAGE_ID, artifactId: 'upscale-1' }),
      ],
    });
    const { cache } = readonlyCache();
    const ready: string[] = [];

    const promise = loadReaderComputedPage({
      repository: b,
      cache,
      stages: [
        claim({ stageId: READER_DECENSOR_STAGE_ID, identity: decensored, onReady: (handle) => ready.push(handle.url) }),
        claim(),
      ],
      submit: (repository) => repository.submitReaderPage(PAYLOAD),
    });
    await flush();
    b.emit(snapshot({ running: { stage: READER_DECENSOR_STAGE_ID, index: 0 } }, 1));
    // 第一阶段先到：`pick` 按声明次序认领，所以这一轮只会拿起去码那一张。
    await vi.waitFor(() => expect(ready).toEqual(['yomika-image://assets/decensor-1']));

    b.emit(snapshot('completed', 2));
    const handle = await promise;

    expect(handle?.url).toBe('yomika-image://assets/upscale-1');
    // 认领次序就是声明次序：去码先上屏，答案后上屏。
    expect(vi.mocked(b.acquireArtifact).mock.calls.map((call) => call[1])).toEqual([
      'decensor-1',
      'upscale-1',
    ]);
    expect(peekCachedImage(cache, decensored)?.url).toBe('yomika-image://assets/decensor-1');
    cache.release(peekCachedImage(cache, decensored)!);
    cache.release(handle!);
  });

  it('does not claim an intermediate stage nobody asked to display', async () => {
    // 中间阶段没声明 `onReady` 就不认领：认领了没人还租借，等于拿宿主的 pin 去占缓存。
    const b = bridge({
      artifacts: [
        artifact({ stageId: READER_DECENSOR_STAGE_ID, artifactId: 'decensor-1' }),
        artifact({ stageId: READER_UPSCALE_STAGE_ID, artifactId: 'upscale-1' }),
      ],
    });
    const { cache } = readonlyCache();

    const handle = await loadReaderComputedPage({
      repository: b,
      cache,
      stages: [claim({ stageId: READER_DECENSOR_STAGE_ID }), claim()],
      submit: async () => ({
        ok: true,
        value: {
          jobId: 'job-1',
          subscriptionId: 3,
          coalesced: false,
          snapshot: snapshot('completed', 1),
          evicted: null,
        },
      }),
    });

    expect(handle?.url).toBe('yomika-image://assets/upscale-1');
    expect(b.acquireArtifact).toHaveBeenCalledTimes(1);
    expect(b.acquireArtifact).toHaveBeenCalledWith('job-1', 'upscale-1');
    cache.release(handle!);
  });
});

const DECENSOR_MODEL = 'aletheia-lens';
const UPSCALE_MODEL = 'realcugan-2x-conservative';

const DECENSORED_IDENTITY: ImageCacheIdentity = { ...IDENTITY, rendition: 'decensored', modelId: DECENSOR_MODEL };
const ENHANCED_FROM_DECENSORED: ImageCacheIdentity = { ...IDENTITY, source: 'decensored', decensorModelId: DECENSOR_MODEL };
const ENHANCED_FROM_PAGE: ImageCacheIdentity = { ...IDENTITY, source: 'reader-page' };

function success(jobId = 'job-1', state: ComputeJobState = 'completed', sequence = 1): Promise<Result<ComputeSubmitted>> {
  return Promise.resolve({
    ok: true as const,
    value: { jobId, subscriptionId: 3, coalesced: false, snapshot: snapshot(state, sequence), evicted: null },
  });
}

function refused(code: 'COMPUTE_MODEL_UNAVAILABLE' | 'COMPUTE_BAD_REQUEST'): Promise<Result<ComputeSubmitted>> {
  return Promise.resolve({
    ok: false as const,
    error: { code, message: '这一步在派发期就被拒了', retryable: false },
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
    decensorModel: DECENSOR_MODEL,
    upscaleModel: UPSCALE_MODEL,
    decensoredIdentity: DECENSORED_IDENTITY,
    enhancedFromDecensoredIdentity: ENHANCED_FROM_DECENSORED,
    enhancedFromPageIdentity: ENHANCED_FROM_PAGE,
    onDecensored: () => undefined,
    onEngine: () => undefined,
    onFailure: () => undefined,
    ...overrides,
  });
}

describe('loadLocalRenditions', () => {
  it('asks for both stages in one submission, and hands the first one up before the answer', async () => {
    // 一条链 = 一次提交（链的第二阶段只能吃第一阶段的产物，见 `loadLocalRenditions` 的 doc）。
    // 但「一次提交」与「用户先看到哪一版」是两件事：去码那一版一出来就先交出去。
    const b = bridge({
      artifacts: [
        artifact({ stageId: READER_DECENSOR_STAGE_ID, artifactId: 'decensor-1' }),
        artifact({ stageId: READER_UPSCALE_STAGE_ID, artifactId: 'upscale-1' }),
      ],
      decensor: () => success(),
    });
    const { cache } = readonlyCache();
    const ready: string[] = [];
    const failures: string[] = [];

    const renditions = await local(b, cache, {
      onDecensored: (handle) => ready.push(handle.url),
      onFailure: (stage, model, failure) => failures.push(`${stage}:${model}:${failure.code}`),
    });

    expect(vi.mocked(b.submitDecensorPage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(b.submitDecensorPage).mock.calls[0]![0]).toMatchObject({
      modelId: DECENSOR_MODEL,
      upscaleModelId: UPSCALE_MODEL,
    });
    // 第二条命令一次都不该被碰到：链是这一档唯一的路。
    expect(vi.mocked(b.submitReaderPage)).not.toHaveBeenCalled();
    expect(ready).toEqual(['yomika-image://assets/decensor-1']);
    // 中间那一版既走 `onDecensored` 上屏，**也**在返回值里：它是「去码这一步成了」的证据，
    // 调用方靠它才不会把链式成功误报成「去码没跑成」（返回值的 `enhanced` 才是终点那一版）。
    expect(renditions.censored?.url).toBe('yomika-image://assets/decensor-1');
    expect(renditions.enhanced?.url).toBe('yomika-image://assets/upscale-1');
    expect(failures).toEqual([]);

    cache.release(renditions.enhanced!);
    cache.release(renditions.censored!);
  });

  it('falls back to decensor-only when the named upscaler cannot run in the worker at all', async () => {
    // 整件被拒时不能就这么算了：被拒的是**整件**任务，连已经跑得动的去码一起拿不到，那比
    // 今天还差。所以退到只去码——保住已经能显示的那一版（§9.1 ⑦）。
    let attempt = 0;
    const b = bridge({
      artifacts: [artifact({ stageId: READER_DECENSOR_STAGE_ID, artifactId: 'decensor-1' })],
      decensor: () => {
        attempt += 1;
        return attempt === 1 ? refused('COMPUTE_MODEL_UNAVAILABLE') : success();
      },
    });
    const { cache } = readonlyCache();
    const failures: string[] = [];

    const renditions = await local(b, cache, {
      onFailure: (stage, model, failure) => failures.push(`${stage}:${model}:${failure.code}`),
    });

    expect(vi.mocked(b.submitDecensorPage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(b.submitDecensorPage).mock.calls[0]![0]).toMatchObject({ upscaleModelId: UPSCALE_MODEL });
    expect(vi.mocked(b.submitDecensorPage).mock.calls[1]![0].upscaleModelId).toBeUndefined();
    // 被拒过的模型不再排第二件任务：它进不了 worker，再试还是同一句话。
    expect(vi.mocked(b.submitReaderPage)).not.toHaveBeenCalled();
    expect(renditions.censored?.url).toBe('yomika-image://assets/decensor-1');
    expect(renditions.enhanced).toBeUndefined();
    // 账记在**超分**头上：只去码那一档随后跑成了，说明跑不了的就是点名的那个超分模型。
    expect(failures).toEqual([`upscale:${UPSCALE_MODEL}:COMPUTE_MODEL_UNAVAILABLE`]);

    cache.release(renditions.censored!);
  });

  it('blames the decensor when the chain was refused and the decensor-only retry failed too', async () => {
    // 「拿不到模型」是一句笼统的话：去码模型包没装好也会让整条链在派发期就被拒。两档都没落地
    // 时账得记在**第一阶段**头上——记在超分头上，用户会去查一个其实没问题的模型。
    const b = bridge({
      artifacts: [],
      decensor: () => refused('COMPUTE_MODEL_UNAVAILABLE'),
    });
    const { cache } = readonlyCache();
    const failures: string[] = [];

    const renditions = await local(b, cache, {
      onFailure: (stage, model, failure) => failures.push(`${stage}:${model}:${failure.code}`),
    });

    expect(vi.mocked(b.submitDecensorPage)).toHaveBeenCalledTimes(2);
    expect(renditions.censored).toBeUndefined();
    expect(renditions.enhanced).toBeUndefined();
    expect(failures).toEqual([`decensor:${DECENSOR_MODEL}:COMPUTE_MODEL_UNAVAILABLE`]);
  });

  it('does not retry a decensor that ran and failed, but still upscales from the original page', async () => {
    // 跑起来之后再失败是另一回事：那条路不再重试（重试由宿主/用户决定），但超分那一步与去码
    // 本来互不依赖——今天「去码没成也从原图放大」这条行为必须留着。
    const b = bridge({
      artifacts: [artifact({ stageId: READER_UPSCALE_STAGE_ID, artifactId: 'upscale-1' })],
      submit: () => success(),
      decensor: () => refused('COMPUTE_BAD_REQUEST'),
    });
    const { cache } = readonlyCache();

    const renditions = await local(b, cache);

    expect(vi.mocked(b.submitDecensorPage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(b.submitReaderPage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(b.submitReaderPage).mock.calls[0]![0]).toMatchObject({ modelId: UPSCALE_MODEL });
    expect(renditions.censored).toBeUndefined();
    expect(renditions.enhanced?.url).toBe('yomika-image://assets/upscale-1');

    cache.release(renditions.enhanced!);
  });

  it('upscales from the original page when the decensor step is not turned on', async () => {
    const b = bridge({
      artifacts: [artifact({ stageId: READER_UPSCALE_STAGE_ID, artifactId: 'upscale-1' })],
      submit: () => success(),
    });
    const { cache } = readonlyCache();

    const renditions = await local(b, cache, { decensorModel: undefined });

    expect(vi.mocked(b.submitDecensorPage)).not.toHaveBeenCalled();
    expect(vi.mocked(b.submitReaderPage)).toHaveBeenCalledTimes(1);
    expect(renditions.enhanced?.url).toBe('yomika-image://assets/upscale-1');

    cache.release(renditions.enhanced!);
  });
});
