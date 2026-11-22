import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { setImageDecoderForTests } from '../../src/lib/decodeImage';
import { getNativeImageCache, RenditionError } from '../../src/lib/nativeImageCache';
import { serializeRemoteOps } from '../../src/repositories/nativeComputeCenterRepository';
import type { ImageHandle } from '../../src/lib/unifiedImageCache';

/** 这一页算出来的成品（会话预算按 `bytes` 算，`url` 就是上屏那一个）。 */
interface HostLease {
  url: string;
  bytes: number;
  estimatedDecodedBytes?: number;
}

/** 宿主那道门（`compute_submit_reader_page`）在这一组测试里的替身。
 *
 * 这里**不能** `vi.mock('src/lib/readerComputedPage')`：`tests/setup.ts:13-15` 在测试文件
 * 之前就把 `ReaderRoute` 预加载了，组件那时已经绑定了真的那个模块；测试文件里的 `vi.mock`
 * 只换得掉测试自己这一侧的引用（这一轮真踩过：门绑的还是真函数，`mock.calls` 永远是 0，
 * 而页面上的行为又确实发生了）。仓库里既有的那条路是 `setInvokeAdapterForTests`：命令名、
 * 参数名、应答形状与真实宿主一致（见 `src/repositories/nativeComputeRepository.ts`），
 * 阅读器那一侧跑的是真代码——比换掉整扇门更值得信。
 *
 * 门自己的协议（先订阅再提交、只认核验过的产物、取消、认领不重复还租借）由
 * `tests/lib/reader-computed-page.test.ts` 逐条钉住；这里要的是「阅读器会不会去叫它、
 * 叫了几次、什么时候把它退掉」。 */
/** 门只跑一档：本地这条链就是「原图 → 超分」，一件任务一个阶段，产物按阶段登记。 */
type HostStage = 'upscale';

let hostLease: (pageIndex: number, stage: HostStage) => Promise<HostLease> = async (pageIndex) => ({
  url: `blob:enhanced-${pageIndex}`,
  bytes: 1,
});
let hostSubmitFails = false;
let hostAcquireNeverLands = false;
/** jobId → 哪一页、这件任务有几个阶段：产物与租借那几条命令只带 jobId（+ 产物号）。 */
const hostJobs = new Map<string, { pageIndex: number; stages: HostStage[] }>();
/** 一份成品只问一次：门自己要问两次（列表 + 租借），用例给的成品是一份。按阶段分开记。 */
const hostLeases = new Map<string, Promise<HostLease>>();
let hostJobSequence = 0;
/** 门收到了哪些命令，按顺序。用例拿它数「算了几次」、验「租借还回去了没有」。 */
let hostCommands: string[] = [];
/** 宿主在这份产物上报的引擎交代（7-b-ix 的两栏）。默认「没交代」：老 worker 的形态。 */
let hostEnginePolicy: 'auto' | 'cpu' | 'gpu' | null = null;
let hostEngineDeviceId: string | undefined;
let hostEngineFallback: { requested: string; used: string; reason: string } | null = null;
/** 宿主让这次任务以这个码失败（`null` = 正常跑）。 */
let hostFailCode: string | null = null;
let hostCancelled = false;
/** 宿主让这个阶段**跑起来之后再失败**（租借那一步答失败）：全任务级的 `failCode` 分不出阶段。 */
let hostFailStage: HostStage | null = null;
let hostFailStageCode = 'COMPUTE_INTERNAL';

function leaseFor(jobId: string, pageIndex: number, stage: HostStage): Promise<HostLease> {
  const key = `${jobId}:${stage}`;
  let pending = hostLeases.get(key);
  if (pending === undefined) {
    pending = hostLease(pageIndex, stage);
    hostLeases.set(key, pending);
  }
  return pending;
}

function installHost(options: {
  lease?: (pageIndex: number, stage: HostStage) => Promise<HostLease>;
  submitFails?: boolean;
  acquireNeverLands?: boolean;
  /** 产物上写「被问的是哪条政策」以及真回退时想要谁 / 用了谁 / 为什么。 */
  enginePolicy?: 'auto' | 'cpu' | 'gpu' | null;
  engineDeviceId?: string;
  engineFallback?: { requested: string; used: string; reason: string } | null;
  /** 任务以这个码失败（`GPU_OUTPUT_INVALID` 这类强制失败的码也走这里）。 */
  failCode?: string;
  cancelled?: boolean;
  /** 只让这一个阶段失败（产物已经在列表里，租借那一步答失败）。 */
  failStage?: HostStage;
  failStageCode?: string;
} = {}): void {
  hostLease = options.lease ?? (async (pageIndex) => ({ url: `blob:enhanced-${pageIndex}`, bytes: 1 }));
  hostSubmitFails = options.submitFails ?? false;
  hostAcquireNeverLands = options.acquireNeverLands ?? false;
  hostEnginePolicy = options.enginePolicy ?? null;
  hostEngineDeviceId = options.engineDeviceId;
  hostEngineFallback = options.engineFallback ?? null;
  hostFailCode = options.failCode ?? null;
  hostCancelled = options.cancelled ?? false;
  hostFailStage = options.failStage ?? null;
  hostFailStageCode = options.failStageCode ?? 'COMPUTE_INTERNAL';
  hostCommands = [];
  hostJobs.clear();
  hostLeases.clear();
  hostJobSequence = 0;
}

/** 提交那道门共用的应答：建一个任务号、把它有几个阶段记下来、答「已经在跑」。
 *
 * 一律答「已经在跑」：宿主扫得动就会跑，而门不看状态就永远停在等结果——真的那道门也是提交
 * 回来立刻去问产物（合并进正在跑的、或直接命中缓存完成）。 */
function submitJob(args: Record<string, unknown> | undefined, stages: HostStage[]): unknown {
  if (hostSubmitFails) {
    return { ok: false, error: { code: 'COMPUTE_WORKER_UNAVAILABLE', message: 'worker 起不来', retryable: true } };
  }
  const payload = args?.payload as { pageIndex: number; generation: number; priority: 'foreground' | 'background' };
  hostJobSequence += 1;
  const jobId = `host-job-${payload.pageIndex}-${payload.generation}-${hostJobSequence}`;
  hostJobs.set(jobId, { pageIndex: payload.pageIndex, stages });
  return {
    ok: true,
    value: {
      jobId,
      subscriptionId: 1,
      coalesced: false,
      evicted: null,
      snapshot: {
        jobId,
        priority: payload.priority,
        // 任务以失败告终的那一条：门是在提交应答自带的快照上看见它的（事件可能永远不来）。
        state: hostCancelled ? 'cancelled' : hostFailCode === null
          ? { running: { stage: stages[stages.length - 1]!, index: 0 } }
          : { failed: { code: hostFailCode } },
        subscribers: 1,
        sequence: 1,
        createdMs: 0,
        settledMs: null,
        key: {
          inputId: `a:${payload.pageIndex}`,
          settingsId: 'test',
          sourceRevision: 'reader-page',
          backend: 'cpu',
          generation: payload.generation,
        },
      },
    },
  };
}

/** 门那条命令的应答；`null` = 不是它的命令，交给用例自己的适配器。 */
async function hostUpscaleAnswer(command: string, args?: Record<string, unknown>): Promise<unknown | null> {
  if (!command.startsWith('compute_')) return null;
  hostCommands.push(command);
  switch (command) {
    case 'compute_submit_reader_page':
      // 「原图 → 超分」那一道门：一件任务一个阶段。
      return submitJob(args, ['upscale']);
    case 'compute_job_artifacts': {
      const jobId = String(args?.jobId ?? '');
      const job = hostJobs.get(jobId);
      if (job === undefined) return { ok: true, value: [] };
      // 一件产物一个阶段。这里**不许** await 租借：第二阶段还没落地时，await 会把第一阶段
      // 那一条也一起卡在列表里——「先看上屏那一版、最终那一版晚点换」正是靠列表先回来。
      return {
        ok: true,
        value: job.stages.map((stage) => ({
          jobId,
          stageId: stage,
          artifactId: `artifact-${jobId}-${stage}`,
          stagingName: `${jobId}-${stage}.bin`,
          // 宿主的正式落点：`cacheRelative` 为 null 的产物一律不许拿，所以这里必须给一个。
          path: `/staging/${jobId}-${stage}.bin`,
          cacheRelative: `cache/images/aa/${jobId}-${stage}.bin`,
          byteLength: 1,
          contentHash: `hash-${stage}`,
          width: 8,
          height: 8,
          engineId: 'cpu',
          enginePrecision: 'Fp32',
          enginePolicy: hostEnginePolicy,
          ...(hostEngineDeviceId ? { engineDeviceId: hostEngineDeviceId } : {}),
          engineFallback: hostEngineFallback,
          pipelineRevision: 'test',
          verified: true,
        })),
      };
    }
    case 'compute_artifact_acquire': {
      const jobId = String(args?.jobId ?? '');
      const artifactId = String(args?.artifactId ?? '');
      const job = hostJobs.get(jobId);
      if (job === undefined) return { ok: false, error: { code: 'COMPUTE_NOT_FOUND', message: '没有这个任务', retryable: false } };
      const stage = job.stages.find((candidate) => artifactId.endsWith(`-${candidate}`));
      if (stage === undefined) return { ok: false, error: { code: 'COMPUTE_NOT_FOUND', message: '没有这件产物', retryable: false } };
      // 「在 CPU 上要跑十几秒」那一条：租借一直不回来，只看阅读器会不会把任务退掉。
      // 只卡最终那一版——第一阶段挡在这里的话，用例连「先看上屏那一版」都验不了。
      if (hostAcquireNeverLands && stage === 'upscale') return new Promise(() => undefined);
      // 一个阶段跑起来之后再失败：产物发布过、租借这一步才失败，与「派发期被拒」不是一回事。
      if (hostFailStage === stage) {
        return { ok: false, error: { code: hostFailStageCode, message: `${stage} 这一步算失败了`, retryable: false } };
      }
      const lease = await leaseFor(jobId, job.pageIndex, stage);
      return {
        ok: true,
        value: {
          leaseId: `lease-${jobId}-${stage}`,
          artifactId,
          jobId,
          url: lease.url,
          mime: 'image/png',
          byteLength: lease.bytes,
          width: 8,
          height: 8,
          estimatedDecodedBytes: lease.estimatedDecodedBytes ?? lease.bytes,
          pipelineRevision: 'test',
          expiresInMs: 60_000,
        },
      };
    }
    case 'compute_artifact_release':
      return { ok: true, value: null };
    case 'compute_cancel':
      return { ok: true, value: 'alreadyTerminal' };
    default:
      return null;
  }
}

/** 一本只有「原图 → 超分」这一条路的档案：原图那几版仍走老的 `cache.load`，超分走宿主那道门。
 *
 * `archiveId` 必须能让用例各用各的：派生那些版本按「档案 + 页 + 模型」记在**整个进程共用**
 * 的那个图片账上（会话级保留就是它的功能），两条例用同一个档案时，后一条会直接命中前一条
 * 留下的那一版，根本不去问宿主——用例之间的串味就是这么来的。 */
function enhancedReader(
  pageCount: number,
  lease: (pageIndex: number) => Promise<HostLease> = async (pageIndex) => ({ url: `blob:enhanced-${pageIndex}`, bytes: 1 }),
  /** 宿主这次怎么交代引擎、或者怎么失败（见 `installHost`），以及这本档案叫什么。 */
  host: { archiveId?: string; engineDeviceId?: string; enginePolicy?: 'auto' | 'cpu' | 'gpu' | null; engineFallback?: { requested: string; used: string; reason: string } | null; failCode?: string } = {},
) {
  const { archiveId = 'enhancement-test', ...hostOptions } = host;
  installHost({ ...hostOptions, lease });
  const cache = getNativeImageCache();
  vi.spyOn(cache, 'load').mockImplementation(async (identity) => (
    { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:plain-${identity.pageIndex}`, bytes: 1 }
  ));
  const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
  setInvokeAdapterForTests(async (command, args) => {
    const hostReply = await hostUpscaleAnswer(command, args);
    if (hostReply !== null) return hostReply;
    if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, upscaleBackend: 'cpu', upscaleModel: 'test' } };
    if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
    if (command === 'load_reader_manifest') return { ok: true, value: { archiveId, title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
    if (command === 'load_reading_progress') return { ok: true, value: null };
    return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
  });
  render(<MemoryRouter initialEntries={[`/reader/${archiveId}`]}><App /></MemoryRouter>);
  return release;
}

afterEach(() => {
  resetInvokeAdapterForTests();
  vi.restoreAllMocks();
});

describe('reader route', () => {
  it('does not label a displayed successful page as failed when speculative compute fails', async () => {
    enhancedReader(2, async page => {
      if (page === 0) hostFailCode = 'COMPUTE_RESOURCE_LIMIT';
      return { url: `blob:enhanced-${page}`, bytes: 1 };
    }, { archiveId: 'successful-visible-background-failed' });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    await waitFor(() => expect(hostJobs.size).toBeGreaterThan(1));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByText(/超分这一步没跑成/)).not.toBeInTheDocument();
  });

  it('shows the initial page without waiting for a slow neighbour prefetch', async () => {
    const cache = getNativeImageCache();
    const pending: Array<() => void> = [];
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    vi.spyOn(cache, 'load').mockImplementation((identity) => {
      const handle = { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:initial-${identity.pageIndex}`, bytes: 1 };
      if (identity.rendition === 'reader-page' && identity.pageIndex > 0) {
        return new Promise<ImageHandle>((resolve) => { pending.push(() => resolve(handle)); });
      }
      return Promise.resolve(handle);
    });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: {
        theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr',
        cacheMaxBytes: 2_147_483_648, prefetchPages: 1, upscaleBackend: 'off', upscaleModel: '', dlssnrEnabled: false,
      } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'slow-neighbour', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    const view = render(<MemoryRouter initialEntries={['/reader/slow-neighbour']}><App /></MemoryRouter>);
    try {
      expect(await screen.findByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:initial-0');
    } finally {
      view.unmount();
      for (const resolve of pending) resolve();
    }
  });

  it('clears this session\'s products on the way in and on the way out of the archive it belongs to', async () => {
    // 用户的口径：超分 / DLSSNR 的产物**只在这次阅读会话里有意义**，进出阅读模式各清
    // 一次。从前它们和封面、缩略图、原页躺在同一张表里，只受配额 + LRU 管——真机上
    // 2.84 GiB 的 DLSSNR 产物把 4 GiB 的配额吃到 90%，LRU 只好去挤别人的封面。
    //
    // 两件事都要钉住：①清理带的是**这一本**的坐标——两本阅读器可以同时挂在保留里
    // （`MAX_RETAINED_READERS = 2`），不带范围会把另一本还在读的产物一起删掉，宿主也会
    // 拒收空范围；②「离开」按 `pageActive` 判，不是按卸载——阅读器被 `RetainedPage` 收着
    // 时从不卸载，真机上「读完一本回书架」那一半因此从来没跑过。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => (
      { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:plain-${identity.pageIndex}`, bytes: 1 }
    ));
    const purges: unknown[] = [];
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'cache_purge_reader_renditions') {
        purges.push(args);
        return { ok: true, value: { removedEntries: 0, removedFiles: 0, bytesFreed: 0 } };
      }
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, upscaleBackend: 'off', upscaleModel: '', dlssnrEnabled: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'purge-products', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/purge-products']}><App /><ReaderNavigation /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    // 进来一次：上一趟留下的产物不该带进这一趟，而且带的是这一本的坐标。
    await waitFor(() => expect(purges[0]).toEqual({ scopeId: 's', archiveId: 'purge-products' }));
    // 离开再一次——离开是**换一本**（路由变了、`pageActive` 翻成 false），不是卸载。
    fireEvent.click(screen.getByRole('button', { name: '换一本' }));
    await waitFor(() => expect(purges.length).toBeGreaterThanOrEqual(2));
    expect(purges[1]).toEqual({ scopeId: 's', archiveId: 'purge-products' });
  });

  it('lets the first derived job out only after the entry purge has landed', async () => {
    // 清理与派生队列抢同一把 DB 锁。清理晚到一秒，这一秒里算出来的成品就会被它自己删掉
    // （可见页靠内存句柄还活着，当场看不到；切回来重新取页就是「图片消失」）。判据是顺序：
    // 第一件算图任务提交之前，进入时那次清理必须已经落地。
    installHost();
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => (
      { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 }
    ));
    const order: string[] = [];
    let releasePurge: (() => void) | undefined;
    setInvokeAdapterForTests(async (command, args) => {
      order.push(command);
      if (command === 'cache_purge_reader_renditions') {
        await new Promise<void>((resolve) => { releasePurge = resolve; });
        return { ok: true, value: { removedEntries: 0, removedFiles: 0, bytesFreed: 0 } };
      }
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, upscaleBackend: 'cpu', upscaleModel: 'test', dlssnrEnabled: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'gate', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/gate']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    // 清理还没落地：一件算图任务都不许出去。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(order).toContain('cache_purge_reader_renditions');
    expect(order).not.toContain('compute_submit_reader_page');
    releasePurge?.();
    await waitFor(() => expect(order).toContain('compute_submit_reader_page'));
    expect(order.indexOf('cache_purge_reader_renditions'))
      .toBeLessThan(order.indexOf('compute_submit_reader_page'));
  });

  it('starts DLSSNR only from its reader control and keeps the final rendition', async () => {
    const cache = getNativeImageCache();
    const processed = { key: 'dlssnr-0', url: 'blob:dlssnr-0', bytes: 1 };
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    installHost();
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? processed
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command, args) => {
      // 本地超分这一版由宿主那道门给（8-f 起本地那一档整体翻了进去）。这一条盯的是
      // DLSSNR：它自己那一版仍然走本地缓存，起点是超分那一版而不是原图。
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 2, upscaleBackend: 'cpu', upscaleModel: 'test', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    expect(load.mock.calls.some(([identity]) => identity.rendition === 'dlssnr')).toBe(false);
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', processed.url));
    expect(release).not.toHaveBeenCalledWith(processed);
    expect(load.mock.calls.some(([identity]) => identity.rendition === 'dlssnr' && JSON.parse(identity.transform ?? '{}').source === 'enhanced')).toBe(true);
    await waitFor(() => expect(load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex)).toEqual([0, 1, 2]));
  });

  it.each(['COMPUTE_QUEUE_FULL', 'COMPUTE_UNAVAILABLE'])('asks again for a DLSSNR page refused with %s instead of recording it as done', async (failureCode) => {
    // 用户报的问题：开着 DLSSNR，这一页却什么都没有。现场日志（925 条）里 424 条是
    // `COMPUTE_QUEUE_FULL: 计算队列满了：Pressure`——那是「现在没位置」，不是这一页算不出来。
    // 从前这条失败只换回一句提示、**不带码**（`nativeImageCache` 只抛 `error.message`），
    // 所以阅读器判不了「阵发还是定局」，把这一页记成了「做过了」：翻回去也不再问，
    // 这一趟阅读里它永远只有原图。判据就是「队列放行以后，这一页还得再问一次」。
    const cache = getNativeImageCache();
    const attempts: number[] = [];
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    let refuseDlssnr = true;
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition !== 'dlssnr') {
        return { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 };
      }
      attempts.push(identity.pageIndex);
      if (refuseDlssnr) throw new RenditionError(failureCode, '计算任务暂时被拒绝');
      return { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: 1 };
    });
    installHost();
    setInvokeAdapterForTests(async (command, args) => {
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, upscaleBackend: 'off', upscaleModel: '', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    // ① 让位期间这一页留在手上的那一版上，不是空白。
    await waitFor(() => expect(attempts).toContain(0));
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:reader-page-0');
    // A rejected worker must not immediately march through every background
    // page and report the same failure for the whole archive.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(attempts).toEqual([0]);

    // ② 队列放行、用户翻回来：这一页必须再问一次，并且这次真的换上了 DLSSNR 那一版。
    refuseDlssnr = false;
    const first = attempts.filter((pageIndex) => pageIndex === 0).length;
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await screen.findByRole('img', { name: '第 2 页' });
    fireEvent.keyDown(reader, { key: 'ArrowLeft' });
    await waitFor(() => expect(attempts.filter((pageIndex) => pageIndex === 0).length).toBeGreaterThan(first));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:dlssnr-0'));
  });

  it('runs the DLSS5 prerequisites through the compute chain', async () => {
    // 更高档（dlssnr / remote）的本地前置那一版从前走的是宿主进程里跑模型的老路
    // （`inference_upscale_page`）：出来的图不在 compute 账上，
    // 也没法按修订号找回来（8-c 被挡住的那条根因）。8-g① 在取产物那一步给 compute 产物挂上
    // 缓存行之后，本地这一步就只剩一条路——DLSS5 按身份把它的产物当**输入**读回来，
    // 宿主进程里那条旧命令一次都不该被叫到。
    const commands: string[] = [];
    const upscalePayloads: Array<{ modelId?: string }> = [];
    let dlssnrSource: string | undefined;
    installHost();
    setInvokeAdapterForTests(async (command: string, args) => {
      commands.push(command);
      if (command === 'compute_submit_reader_page') {
        upscalePayloads.push((args?.payload ?? {}) as { modelId?: string });
      }
      if (command === 'dlssnr_apply_page') {
        dlssnrSource = (args?.input as { source?: string } | undefined)?.source;
        return { ok: true, value: [0x89, 0x50, 0x4e, 0x47] };
      }
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'realcugan-2x', dlssnrEnabled: true } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    // 本地的超分是**一件任务**：点名的模型跟着这一次提交走，不另排一件。
    await waitFor(() => expect(upscalePayloads[0]?.modelId).toBe('realcugan-2x'));
    expect(commands.filter((command) => command === 'compute_submit_reader_page')).toHaveLength(1);
    // 宿主进程里那条旧命令一次都没被叫到。
    expect(commands).not.toContain('inference_upscale_page');
    // DLSS5 的输入就是本地算出来的那一版（超分那一版），不是原图。
    await waitFor(() => expect(dlssnrSource).toBe('enhanced'));
  });
  it('keeps screen-owned raw neighbours valid through background warming and later revisits', async () => {
    const cache = getNativeImageCache();
    const revoked = new Set<string>();
    const rawHandles = new Map<number, ImageHandle>();
    const release = vi.spyOn(cache, 'release').mockImplementation((handle) => { revoked.add(handle.url); });
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      const handle = { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 };
      if (identity.rendition === 'reader-page') rawHandles.set(identity.pageIndex!, handle);
      return handle;
    });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'raw-owner', title: 'Reader', pages: Array.from({ length: 6 }, (_, i) => `${i}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/raw-owner']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    await waitFor(() => expect(rawHandles.has(1)).toBe(true));
    const retainedNeighbour = rawHandles.get(1)!;
    fireEvent.click(reader);
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    // Waiting for the last background-only release proves the sweep has passed
    // the screen's retained neighbour, rather than asserting before its finally.
    await waitFor(() => expect(release.mock.calls.some(([handle]) => handle.key === 'reader-page-5')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '关闭 DLSSNR' }));
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('img', { name: '第 2 页' })).toHaveAttribute('src', retainedNeighbour.url));
    fireEvent.keyDown(reader, { key: 'ArrowLeft' });
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('img', { name: '第 2 页' })).toHaveAttribute('src', retainedNeighbour.url));
    expect(revoked.has(retainedNeighbour.url)).toBe(false);
    expect(release).not.toHaveBeenCalledWith(retainedNeighbour);
    expect(load.mock.calls.filter(([identity]) => identity.rendition === 'reader-page' && identity.pageIndex === 1)).toHaveLength(1);
    for (let step = 0; step < 4; step += 1) fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await waitFor(() => expect(release).toHaveBeenCalledWith(retainedNeighbour));
  });

  it('does not retain source page handles for background-only preprocessing', async () => {
    const cache = getNativeImageCache();
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => ({
      key: `${identity.rendition}-${identity.pageIndex}`,
      url: `blob:${identity.rendition}-${identity.pageIndex}`,
      bytes: 1,
    }));
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, upscaleBackend: 'off', upscaleModel: '', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'source-window', title: 'Reader', pages: Array.from({ length: 6 }, (_, i) => `${i}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    const view = render(<MemoryRouter initialEntries={['/reader/source-window']}><App /></MemoryRouter>);
    try {
      await screen.findByRole('img', { name: '第 1 页' });
      fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
      fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
      await waitFor(() => expect(load.mock.calls.some(([identity]) => identity.rendition === 'dlssnr')).toBe(true));
      // Page 1 is already held as the screen's next swipe slot even with zero
      // configured prefetch. Page 2 is background-only and must be released.
      await waitFor(() => expect(release.mock.calls.map(([handle]) => handle.key)).toContain('reader-page-2'));
      expect(release.mock.calls.map(([handle]) => handle.key)).not.toContain('reader-page-0');
      expect(release.mock.calls.map(([handle]) => handle.key)).not.toContain('reader-page-1');
    } finally {
      view.unmount();
    }
  });

  it('preprocesses the whole archive, not just the pages in the viewport', async () => {
    // 用户报的问题：开着 DLSSNR，只有视口里那几页会被处理，后面的页要翻到才现算。
    // 队列原来每次可见页变化都把自己筛回「可见页 + 预取窗口」，所以整本档案里其余
    // 的页永远不会被排上。可见页那一档后面现在接着一条后台队列，这一条盯的就是它。
    const cache = getNativeImageCache();
    const pageCount = 12;
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: 1 }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'sweep', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/sweep']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:dlssnr-0'));

    // 只翻过一页，可见页那一档碰得到的只有第 1、2 页；剩下的十页只有后台预处理会做。
    const dlssnrPages = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex);
    await waitFor(() => {
      expect(new Set(dlssnrPages())).toEqual(new Set(Array.from({ length: pageCount }, (_, index) => index)));
    }, { timeout: 10_000 });
    // 可见的那一页排在后台那些页前面——预处理不该让正在读的这页等。
    expect(dlssnrPages()[0]).toBe(0);
    // Preprocessing reads every source, but must not pin all raw pages for the
    // entire session: only pages claimed by the screen belong to its window.
    await waitFor(() => {
      const released = release.mock.calls.map(([handle]) => handle.key);
      expect(released).toEqual(expect.arrayContaining(
        Array.from({ length: pageCount - 2 }, (_, index) => `reader-page-${index + 2}`),
      ));
      expect(released).not.toContain('reader-page-0');
      expect(released).not.toContain('reader-page-1');
    });
  });
  it('keeps the pages the reader is about to reach when the session budget overflows', async () => {
    // 用户报的问题：DLSSNR 明明预扫过了，翻到那一页却还要现算。会话预算 64MB、一页
    // 成品 3–6MB，装得下十来页；预扫是从当前页往后由近到远灌进来的，所以「最早算出来
    // 的那一页」正好是马上要翻到的那一页——按插入顺序淘汰，等于每翻一页都先把下一批
    // 要读的丢掉。这一条盯的是淘汰顺序：丢远的，留近的。
    const cache = getNativeImageCache();
    const pageCount = 24;
    const bytes = 6 * 1024 * 1024;
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'budget', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/budget']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const dlssnrPages = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex);
    await waitFor(() => {
      expect(new Set(dlssnrPages())).toEqual(new Set(Array.from({ length: pageCount }, (_, index) => index)));
    }, { timeout: 10_000 });

    const dropped = release.mock.calls
      .map(([handle]) => Number(handle.key.replace('dlssnr-', '')))
      .filter((index) => Number.isInteger(index));
    // 预扫把整本都做完了，但只留得住离第 1 页最近的那十来页：丢掉的必须是远端那些，
    // 第 1 页往后紧挨着的几页一页都不能丢（丢了就意味着翻过去要现算）。
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((index) => index >= 10)).toBe(true);
  });

  it('promotes a page the reader just turned to instead of leaving it in the prefetch tier', async () => {
    // 用户报的问题：翻页之后队列好像不跟着更新。已经在队列里、但还挂着 `neighbour`
    // 档的那一件，翻到它时不会被升成 `visible`，于是 worker 拿到的优先级是 background
    // ——正在看的那一页排在刚翻过去的那一页后面。这一条盯的就是那个换档。
    const cache = getNativeImageCache();
    const pageCount = 8;
    const processed: Array<{ pageIndex: number; priority?: 'foreground' | 'background' | undefined }> = [];
    let releaseFirst: (() => void) | undefined;
    const firstPageGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition !== 'dlssnr') {
        return { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 };
      }
      processed.push({ pageIndex: identity.pageIndex, priority: identity.priority });
      // 第 1 页那一件挂住，队列里才会攒着预取窗口排进来的第 2、3 页。
      if (identity.pageIndex === 0) await firstPageGate;
      return { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: 1 };
    });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 2, dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'promote', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/promote']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    await waitFor(() => expect(processed.some((entry) => entry.pageIndex === 0)).toBe(true));

    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await screen.findByRole('img', { name: '第 2 页' });
    await act(async () => {});
    await act(async () => { releaseFirst?.(); });

    await waitFor(() => {
      const second = processed.find((entry) => entry.pageIndex === 1);
      expect(second?.priority).toBe('foreground');
    }, { timeout: 5_000 });
    // 只是路过预取窗口、用户没翻过去的那一页仍然是后台的事。
    //
    // 这一条必须**等**它出现再断言档位：预取那一件要等前一页让出队列才排进去，而第 1 页
    // 刚在上面被放行——直接读 `processed` 会早读几毫秒（实测两次读之间差 3ms），看起来像
    // 「这一页没被排进去」。等的只是「它出现」，档位仍然必须是 background：等成 foreground
    // 照样红。
    await waitFor(() => {
      expect(processed.find((entry) => entry.pageIndex === 2)?.priority).toBe('background');
    }, { timeout: 5_000 });
  });

  it('keeps the pages right after the reader when one derived page takes a third of the budget', async () => {
    // 现场：这台机器的 DLSSNR 三档设置下一张成品 21–27MB（用户库里 133 页 2.9GB），
    // 而会话预算是按「一页 3–6MB」定的 64MB——只装得下两页。预扫从当前页往后由近到远
    // 灌进来，可「下一页」永远落在预算之外、刚算完就被挤掉，用户翻过去还是要现读一遍，
    // 看起来就是整本预处理没生效。这一条盯的是「可见页往后至少留住几页」那个下限。
    const cache = getNativeImageCache();
    const pageCount = 24;
    const bytes = 24 * 1024 * 1024;
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'resident', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/resident']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const dlssnrPages = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex);
    await waitFor(() => {
      expect(new Set(dlssnrPages())).toEqual(new Set(Array.from({ length: pageCount }, (_, index) => index)));
    }, { timeout: 10_000 });

    const dropped = release.mock.calls
      .map(([handle]) => Number(handle.key.replace('dlssnr-', '')))
      .filter((index) => Number.isInteger(index));
    // 第 1 页往后紧挨着的四页一页都不能丢：翻过去时它们就是「已经预处理过」的那几页。
    expect(dropped.filter((index) => index <= 4)).toEqual([]);
  });

  it('retries a page whose source could not be read instead of writing it off', async () => {
    // 源页读失败（LRR 掉线 / 超时）时不能把「尝试过」记在那一页头上：记上以后整本预扫
    // 剩下的部分和用户真的翻到它时都会跳过它，于是这一页在这次阅读里永远是原图。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    let failOnce = true;
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition === 'reader-page' && identity.pageIndex === 2 && failOnce) {
        failOnce = false;
        throw new Error('LANraragi dropped the page');
      }
      return identity.rendition === 'dlssnr'
        ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: 1 }
        : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 };
    });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'lost-source', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/lost-source']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const sourceCalls = () => load.mock.calls.filter(([identity]) => identity.rendition === 'reader-page' && identity.pageIndex === 2).length;
    const dlssnrPages = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex);
    // 预扫轮到第 3 页，源页读失败一次。
    await waitFor(() => expect(sourceCalls()).toBeGreaterThanOrEqual(1));
    // 用户翻到第 2 页：第 3 页进了预取窗口，这时候要再试一次。
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'ArrowRight' });
    await screen.findByRole('img', { name: '第 2 页' });
    await waitFor(() => expect(dlssnrPages()).toContain(2), { timeout: 2_000 });
  });

  it('does not auto-enable upscaling when the pages already average above the threshold', async () => {
    // 用户报的 ⑨：平均体积**高于**阈值，超分还是自己开起来了。阈值是「糊得值不值得
    // 超分」那条线（默认 500KB/页）：这条档案一页 4MB，标签规则再匹配也不该自动开。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => (
      { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 }
    ));
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, upscaleBackend: 'cpu', upscaleModel: 'realcugan-2x-denoise3x', upscaleAutoEnable: true, upscaleAutoTagMode: 'whitelist', upscaleAutoWhitelist: 'category:manga', dlssnrEnabled: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'fat-pages', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'fat-pages', title: 'Reader', filename: 'fat.zip', tags: 'category:manga', summary: null, extension: 'zip', progress: 0, pageCount: 3, lastReadTime: 0, size: 12 * 1024 * 1024 } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/reader/fat-pages']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));

    const upscaleRuns = () => adapter.mock.calls.filter(([command]) => command === 'compute_submit_reader_page').length;
    // 标签规则是匹配的（category:manga 在白名单里），所以只可能是体积那一半在挡。
    await waitFor(() => expect(adapter.mock.calls.some(([command]) => command === 'load_archive_metadata')).toBe(true));
    await act(async () => {});
    await act(async () => {});
    expect(upscaleRuns()).toBe(0);
    // 原图那一页确实读进来了，所以「没算超分」不是因为它压根没打开。
    expect(load.mock.calls.some(([identity]) => identity.rendition === 'reader-page')).toBe(true);
    expect(screen.getByRole('button', { name: '开启超分' })).toBeInTheDocument();
  });

  it('auto-enables upscaling when the pages average below the threshold and the tags match', async () => {
    // 上一条的反面：阈值以下 + 白名单命中还是要自动开——修方向不是把自动开启关掉。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => (
      { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:plain-${identity.pageIndex}`, bytes: 1 }
    ));
    installHost();
    setInvokeAdapterForTests(async (command, args) => {
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, upscaleBackend: 'cpu', upscaleModel: 'realcugan-2x-denoise3x', upscaleAutoEnable: true, upscaleAutoTagMode: 'whitelist', upscaleAutoWhitelist: 'category:manga', dlssnrEnabled: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'thin-pages', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'thin-pages', title: 'Reader', filename: 'thin.zip', tags: 'category:manga', summary: null, extension: 'zip', progress: 0, pageCount: 3, lastReadTime: 0, size: 300 * 1024 } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/thin-pages']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));

    await waitFor(() => expect(hostCommands).toContain('compute_submit_reader_page'));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(await screen.findByRole('button', { name: '关闭超分' })).toBeInTheDocument();
  });

  it('pauses hidden-document preprocessing and resumes without releasing the displayed page', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    let finishFirst!: (lease: HostLease) => void;
    const enhance = vi.fn((pageIndex: number) => pageIndex === 0
      ? new Promise<HostLease>((resolve) => { finishFirst = resolve; })
      : Promise.resolve({ url: `blob:enhanced-${pageIndex}`, bytes: 1 }));
    const release = enhancedReader(2, enhance);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(enhance).not.toHaveBeenCalled();

    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(enhance).toHaveBeenCalledTimes(1));
    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { finishFirst({ url: 'blob:enhanced-0', bytes: 1 }); });
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(enhance).toHaveBeenCalledTimes(1);
    expect(release.mock.calls.some(([handle]) => handle.url === 'blob:enhanced-0')).toBe(false);

    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(enhance).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0');
  });

  it('marks the page in the viewport as foreground and the rest of the sweep as background', async () => {
    // 用户要的「超分、DLSSNR 都无条件优先处理当前页」在前端这一侧就是这一个
    // 字段：队列按档位给每件活打上前台/后台，原生那侧据此插队并掐掉正在跑的后台。
    const cache = getNativeImageCache();
    const pageCount = 6;
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: 1 }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:plain-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'priority', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/priority']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const derived = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr');
    const pagesWith = (priority: string) => derived()
      .filter(([identity]) => identity.priority === priority)
      .map(([identity]) => identity.pageIndex);
    await waitFor(() => {
      expect(new Set(pagesWith('background'))).toEqual(new Set(Array.from({ length: pageCount - 1 }, (_, index) => index + 1)));
    }, { timeout: 10_000 });
    expect(new Set(pagesWith('foreground'))).toEqual(new Set([0]));
  });

  it('discards enhancement completed after its switch is disabled', async () => {
    let complete!: (lease: HostLease) => void;
    const enhance = vi.fn(() => new Promise<HostLease>((resolve) => { complete = resolve; }));
    enhancedReader(1, enhance);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(enhance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(enhance).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '关闭超分' }));
    // 关掉之后才落地的那一版：页面上不能换掉手里的原图，任务也得让宿主停下来（不然那份
    // 内容还占着 worker 与全局唯一的那件重活）。它在阅读器这一侧看不见，所以查宿主收到的命令。
    await act(async () => complete({ url: 'blob:enhanced-0', bytes: 1 }));
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:plain-0');
    await waitFor(() => expect(hostCommands).toContain('compute_cancel'));
    // 再开一次：这一页要重新向宿主开口（上一次那件已经被退掉了），换了版本才上屏。
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(enhance).toHaveBeenCalledTimes(2));
    await act(async () => complete({ url: 'blob:enhanced-0', bytes: 1 }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
  });

  it('keeps derived images for the whole session, so going back does not re-run inference', async () => {
    const enhance = vi.fn(async (index: number) => ({ url: `blob:enhanced-${index}`, bytes: 1 }));
    const release = enhancedReader(14, enhance);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    const runsForPageOne = () => enhance.mock.calls.filter(([index]) => index === 0).length;

    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    for (let index = 1; index <= 10; index += 1) {
      fireEvent.keyDown(reader, { key: 'ArrowRight' });
      await screen.findByRole('img', { name: `第 ${index + 1} 页` });
    }
    // Ten pages later the result is still held. It used to be released as its page
    // left the window, and since the attempt had already been spent, going back
    // showed the *plain* page for the rest of the sitting.
    expect(release.mock.calls.map(([handle]) => handle.url)).not.toContain('blob:enhanced-0');

    for (let index = 0; index < 10; index += 1) {
      fireEvent.keyDown(reader, { key: 'ArrowLeft' });
      await screen.findByRole('img', { name: `第 ${10 - index} 页` });
    }
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(runsForPageOne()).toBe(1);
  });

  it('drops the derived results the reader is least likely to need once the session is holding too much', async () => {
    // The hold is bounded: the shared image cache only evicts what nobody
    // references, so an unbounded hold would pin every upscaled page in memory.
    // 一页 40MB 时预算 = 「可见页 + 4 页」× 一页的实测体积 = 200MB，正好五页；多出来
    // 的一律按离当前页最远先丢——远处的页重算一遍便宜，丢近的那几页才是翻页现算。
    const enhancedIndexes: number[] = [];
    const release = enhancedReader(12, async (index) => {
      enhancedIndexes.push(index);
      return { url: `blob:enhanced-${index}`, bytes: 40 * 1024 * 1024 };
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    // 预取窗口是 0，所以第 2 页往后的每一页都只有预扫会碰——等它整本做完。
    await waitFor(() => expect(enhancedIndexes).toContain(11), { timeout: 10_000 });

    const droppedKeys = release.mock.calls.map(([handle]) => handle.url);
    expect(droppedKeys).toContain('blob:enhanced-11');
    // 紧挨着正在读的这一页的那几页一页都不能丢。
    expect(droppedKeys).not.toContain('blob:enhanced-1');
    expect(droppedKeys).not.toContain('blob:enhanced-2');

    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const releasesBeforeTurning = release.mock.calls.length;
    for (let index = 1; index <= 5; index += 1) {
      fireEvent.keyDown(reader, { key: 'ArrowRight' });
      await screen.findByRole('img', { name: `第 ${index + 1} 页` });
    }
    await waitFor(() => expect(screen.getByRole('img', { name: '第 6 页' })).toHaveAttribute('src', 'blob:enhanced-5'));
    // The page just enhanced is never the one dropped for room: 刚补算出来的正是正在读的
    // 这一页，腾地方腾的是身后最远的那一页。
    const droppedWhileReadingPageSix = release.mock.calls.slice(releasesBeforeTurning).map(([handle]) => handle.url);
    expect(droppedWhileReadingPageSix).toContain('blob:enhanced-0');
    expect(droppedWhileReadingPageSix).not.toContain('blob:enhanced-5');
  });

  it('loads native manifest and page bytes, then persists progress on navigation', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const progressScopes: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      calls.push(command);
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') {
        return { ok: true, value: [{ id: 'server-native', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-real' }] };
      }
      if (command === 'load_reader_manifest') {
        return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['00.jpg', '01.jpg'] } };
      }
      if (command === 'load_reader_page') return { ok: true, value: [1, 2, 3] };
      if (command === 'load_reading_progress') {
        progressScopes.push(String(args?.scopeId));
        return { ok: true, value: null };
      }
      if (command === 'save_reading_progress') {
        progressScopes.push(String((args?.progress as { scopeId?: string } | undefined)?.scopeId));
        return {
          ok: true,
          value: { scopeId: 'scope-real', archiveId: 'a1', pageIndex: 1, pageCount: 2, layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 1 },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageDown' });
    expect(await screen.findByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    // The overview panel's facts (metadata + cover) load in the background, so
    // their exact interleaving is not fixed; what matters is which commands run
    // and that progress is written after the page turn. The app shell's startup
    // update check runs here too: it asks once for the release and the model
    // catalog, and a failure (offline, or a test adapter that does not know the
    // command) just goes quiet.
    //
    // `compute_worker_status` 也是外壳的：计算进程那一条状态（§12.3）挂在 App 上，
    // 所以任何一页都会看到它问一次——它在这里出现不代表阅读器自己要用计算。
    // `fetch_tag_counts` 同理：补全排序开关默认开着，外壳启动时就让原生侧去看一眼
    // 频次表的版本（docs/30 那份表从前是前端自己 fetch GitHub，测试里看不见）。
    expect(new Set(calls)).toEqual(new Set([
      'list_servers', 'load_preferences', 'load_reader_manifest', 'load_archive_metadata',
      'load_reading_progress', 'load_archive_thumbnail', 'cache_read_image', 'load_reader_page',
      'save_reading_progress',
      'app_release_latest', 'inference_list_models', 'model_release_list_upscalers',
      'compute_worker_status', 'fetch_tag_counts',
      // 进阅读器就把上一趟留下的成品清一次（超分 / DLSSNR 的产物，见
      // `purgeReaderProducts`）：它们只在这次会话里有意义，不该跟着配额与 LRU 走。
      'cache_purge_reader_renditions',
    ]));
    expect(calls.filter((command) => command === 'load_reader_page')).toHaveLength(2);
    expect(calls.at(-1)).toBe('save_reading_progress');
    expect(progressScopes).toEqual(['scope-real', 'scope-real', 'scope-real']);
  });

  it('uses and releases persistent reader pages without requesting LANraragi', async () => {
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'server-cache', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-reader-cache' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'cached-reader', title: 'Cached reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'load_reader_page') throw new Error('reader network should not be called');
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    const view = render(<MemoryRouter initialEntries={['/reader/cached-reader']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(adapter).not.toHaveBeenCalledWith('load_reader_page', expect.anything());
    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalled();
  });

  it('waits for missing progress to hydrate from server metadata before opening or writing page one', async () => {
    let finishMetadata!: (value: unknown) => void;
    let hydrated = false;
    const metadataRequest = new Promise(resolve => { finishMetadata = resolve; });
    const loadedPaths: string[] = [];
    const adapter = vi.fn(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'server-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'server-progress', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg', '3.jpg', '4.jpg'] } };
      if (command === 'load_archive_metadata') return metadataRequest;
      if (command === 'load_reading_progress') return { ok: true, value: hydrated ? { scopeId: 'scope-a', archiveId: 'server-progress', pageIndex: 3, pageCount: 5, layout: 'paged', direction: 'ltr', updatedAt: '2026-11-05T00:00:00Z', revision: 1 } : null };
      if (command === 'load_reader_page') { loadedPaths.push(String(args?.path)); return { ok: true, value: [1] }; }
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/reader/server-progress']}><App /></MemoryRouter>);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('load_reading_progress', { scopeId: 'scope-a', archiveId: 'server-progress' }));
    expect(loadedPaths).toEqual([]);
    expect(adapter.mock.calls.some(([command]) => command === 'save_reading_progress')).toBe(false);
    hydrated = true;
    finishMetadata({ ok: true, value: { archiveId: 'server-progress', title: 'Reader', filename: 'a.zip', tags: '', summary: null, extension: 'zip', progress: 4, pageCount: 5, lastReadTime: 0, size: 100 } });
    expect(await screen.findByRole('img', { name: '第 4 页' })).toBeInTheDocument();
    expect(loadedPaths[0]).toBe('3.jpg');
  });

  it('loads the restored page, one slot either side, and then ahead of it', async () => {
    const loadedPaths: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg', '3.jpg', '4.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: { scopeId: 'scope-a', archiveId: 'a1', pageIndex: 3, pageCount: 5, layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 1 } };
      if (command === 'load_reader_page') {
        loadedPaths.push(String(args?.path));
        return { ok: true, value: [1] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 4 页' })).toBeInTheDocument();
    expect(loadedPaths[0]).toBe('3.jpg');
    // The prefetch budget still runs forward — reading does — but the slots
    // either side are rendered for the swipe now, so both have to exist: a drag
    // used to pull the page off an empty background. That is one slot back, not a
    // window behind. This viewport is wide enough for a spread, so the restored
    // page shares its slot with page 5 and the slot in front of it is the pair 2–3.
    expect(new Set(loadedPaths)).toEqual(new Set(['1.jpg', '2.jpg', '3.jpg', '4.jpg']));
  });

  it('opens the restored page even when a neighbour prefetch fails', async () => {
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'load_reader_page') {
        return String(args?.path) === '1.jpg'
          ? { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '页面暂时不可用', retryable: true } }
          : { ok: true, value: [1] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.queryByText('阅读页面加载失败')).not.toBeInTheDocument();
  });

  it('opens the first page through the regular image path if opening a native file fails transiently', async () => {
    vi.stubGlobal('YomikaTiles', { postMessage: vi.fn() });
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'native-open-retry', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'reader_open_page_file') return { ok: false, error: { code: 'NETWORK', message: 'Temporary source failure', retryable: true } };
      if (command === 'load_reader_page') return { ok: true, value: [1, 2, 3] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    try {
      render(<MemoryRouter initialEntries={['/reader/native-open-retry']}><App /></MemoryRouter>);
      expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
      expect(adapter.mock.calls.filter(([command]) => command === 'reader_open_page_file')).toHaveLength(1);
      expect(adapter.mock.calls.filter(([command]) => command === 'load_reader_page')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers a way out and a retry when the reader cannot load', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') {
        attempts += 1;
        return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '服务器暂时不可用', retryable: true } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    // Scoped to the canvas: the same message also reaches the shared toast, which
    // carries its own alert role, so an unscoped query races the toast mounting.
    // 整屏画布上只说「加载失败」这一件事实：宿主原话（传输层那一句自带服务器地址、
    // 端口与请求路径）留给 toast 与 error.log——用户报的就是画布上那一片技术细节。
    const canvas = await screen.findByRole('main');
    expect(await within(canvas).findByRole('alert')).toHaveTextContent('加载失败');
    expect(canvas.textContent ?? '').not.toContain('服务器暂时不可用');
    // The route is shell-free, so it has to offer its own exit; the message also
    // has to reach the shared toast. 顶栏本身默认隐藏（用户报的 ③），所以先按同一套
    // 手势把它唤出来，再问它给不给退路。
    expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument();
    fireEvent.click(canvas, { clientY: 40 });
    expect(await screen.findByRole('button', { name: '返回上一页' })).toBeInTheDocument();
    // 现场不丢：原话照旧到达共享 toast（还有 error.log，那一条由宿主那边钉）。
    expect(await screen.findByText('服务器暂时不可用')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试加载' }));
    await waitFor(() => expect(attempts).toBe(2));
  });

  // 用户报的：失败页原来把宿主原话整句贴出来。传输层的原话自带服务器地址
  // （`连不上 http://192.168.1.20:3000/api/archives/a1/files：连接被拒绝`），
  // 整屏画布上只说「加载失败」——地址留给 toast 与 error.log。
  it('never paints the transport error on the failure canvas, address and all', async () => {
    const detail = '连不上 http://192.168.1.20:3000/api/archives/a1/files：连接被拒绝';
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'http://192.168.1.20:3000', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: detail, retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    const canvas = await screen.findByRole('main');
    expect(await within(canvas).findByRole('alert')).toHaveTextContent('加载失败');
    const painted = canvas.textContent ?? '';
    // 连主机名与协议头都不能出现：只贴一句「加载失败」，地址连片段都不留在画布上。
    expect(painted).not.toContain('192.168.1.20');
    expect(painted).not.toContain('http://');
    expect(await screen.findByText(detail)).toBeInTheDocument();
  });

  // 用户报的：阅读模式是整屏的，自绘标题栏被它盖住，于是那一屏里没有任何地方能
  // 拖动窗口——加载慢或卡住时尤其难堪（那是用户唯一看得见的栏）。现在加载/失败态
  // 这条栏与阅读态那条共用同一套原生拖动。
  it('drags the native window from the bar it shows while the reader is loading', async () => {
    const invoke = vi.fn(() => Promise.resolve(false));
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
    try {
      setInvokeAdapterForTests(async (command: string) => {
        if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
        if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
        // Never resolves: the reader stays in its loading state.
        if (command === 'load_reader_manifest') return new Promise(() => undefined);
        throw new Error(`Unexpected command: ${command}`);
      });

      render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

      const canvas = await screen.findByRole('main');
      expect(await screen.findByRole('status', { name: '正在加载页面' })).toBeInTheDocument();
      fireEvent.click(canvas, { clientY: 40 });
      const back = await screen.findByRole('button', { name: '返回上一页' });
      const bar = back.closest('header') as HTMLElement;
      expect(bar).not.toBeNull();

      // 栏上没长控件的地方按下＝开始原生拖动（和外壳标题栏同一处手势）。
      fireEvent.mouseDown(bar.querySelector('strong') as HTMLElement, { button: 0, detail: 1 });
      expect(invoke).toHaveBeenCalledWith('plugin:window|start_dragging', { label: 'main' });

      // 落在栏上的按钮不吃这一下：按返回不该顺手把窗口拖走。
      invoke.mockClear();
      fireEvent.mouseDown(back, { button: 0, detail: 1 });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('shows the drawn loading indicator rather than a bare line or an empty state', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      // Never resolves: the reader stays in its loading state.
      if (command === 'load_reader_manifest') return new Promise(() => undefined);
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    // One indicator with an accessible name, not "正在加载页面…" as body text.
    expect(await screen.findByRole('status', { name: '正在加载页面' })).toBeInTheDocument();
    expect(screen.queryByText('正在加载页面…')).not.toBeInTheDocument();
    // 用户报的 ⑥：加载态原来只是一个转圈，阅读器的顶栏要等第一页到达才唤得出来，
    // 加载慢或卡住时就没有退路。现在加载态自带和失败态同一条顶栏，但它和加载完成
    // 之后的顶栏一样是默认隐藏的（用户报的 ③），所以先唤出来。
    const canvas = screen.getByRole('main');
    expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument();
    fireEvent.click(canvas, { clientY: 40 });
    const back = await screen.findByRole('button', { name: '返回上一页' });
    expect(back.closest('header')).not.toBeNull();
    expect(canvas.firstElementChild).toBe(back.closest('header'));
  });

  // 用户报的 ③：加载态的顶栏原来是常显的，而加载完成后那两条栏会自己藏起来——同一
  // 屏幕上前后两种行为，进阅读模式的第一眼就顶着一个常驻的栏。现在两条路径共用同一套
  // 判定：默认隐藏、指针进顶部感应带或点击附近出现、再点一下收起。
  it('keeps the loading bar hidden until the pointer or a tap in the top band calls for it', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      // Never resolves: the reader stays in its loading state.
      if (command === 'load_reader_manifest') return new Promise(() => undefined);
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    const canvas = await screen.findByRole('main');
    expect(await screen.findByRole('status', { name: '正在加载页面' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument();

    // 指针移进顶部感应带——不是点击：和阅读态那条 hover 判定同一套。
    fireEvent.mouseMove(canvas, { buttons: 0, clientY: 110 });
    expect(await screen.findByRole('button', { name: '返回上一页' })).toBeInTheDocument();

    // 移回画面中间，按同一条出场动画隐去。
    fireEvent.mouseMove(canvas, { buttons: 0, clientY: window.innerHeight / 2 });
    await waitFor(() => expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument());

    // 点击顶部附近也能唤出，再点一下收起。
    fireEvent.click(canvas, { clientY: 110 });
    expect(await screen.findByRole('button', { name: '返回上一页' })).toBeInTheDocument();
    fireEvent.click(canvas, { clientY: 110 });
    await waitFor(() => expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument());
  });

  // 加载态唤出来的栏和阅读态那两条栏用的是同一条计时（4.5s 无人理就自己走），否则
  // 「加载中」会变成一种要手动关掉的停留状态。这里用**真实**计时器跑一次：fake timers
  // 下 RTL 的 waitFor 会卡住，而这条断言本身就是「过一会儿会不会自己走」，等真实的
  // 4.5s + 0.26s 出场更可信。
  it('lets the summoned loading bar go away on its own', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return new Promise(() => undefined);
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    const canvas = await screen.findByRole('main');
    fireEvent.click(canvas, { clientY: 110 });
    expect(await screen.findByRole('button', { name: '返回上一页' })).toBeInTheDocument();

    await waitFor(
      () => expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument(),
      { timeout: 6_000 },
    );
  }, 10_000);

  it('applies the default layout and direction, and lets the archive override the layout', async () => {
    const preferences = { theme: 'system', defaultLayout: 'double', defaultDirection: 'rtl', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'off', upscaleModel: '', customCss: '' };
    let stored: unknown = null;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: preferences };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: stored };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'save_reading_progress') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });

    // Both settings were read, shown and saved but consumed by nothing: the
    // reader always started on auto/ltr, so choosing either did nothing at all.
    // No long waits any more: the reader takes a changed layout from its props, so
    // the preferences arriving late no longer has to be noticed by an unmount —
    // which is what made this the flakiest test in the file, and what the reader's
    // new auto-hiding chrome turned into a certain failure.
    const view = render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(await screen.findByRole('button', { name: '阅读布局：双页，点击切换' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '从右到左' })).toBeInTheDocument();
    view.unmount();

    // The archive's own record is the more specific answer for the LAYOUT, so it
    // wins: 'paged' cannot say whether it meant single or double, so only
    // continuous overrides. (The direction is the settings' call — see the next
    // test; an archive that once stored one used to pin it forever.)
    stored = { scopeId: 'scope-a', archiveId: 'a1', pageIndex: 0, pageCount: 3, layout: 'continuous', direction: 'ltr', updatedAt: '2026-09-05T00:00:00Z', revision: 1 };
    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('region', { name: '连续阅读' })).toBeInTheDocument();
  });

  it('takes the reading direction from the setting, not from the archive that stored its own', async () => {
    // 改设置对读过的档案不再无效：方向归设置管。以前是 `stored?.direction ??
    // defaultDirection`，档案里那份比设置更「具体」，于是一次都没改过设置的档案
    // 会把方向钉死，换一本档案又是另一个方向——用户看到的就是
    //「翻页方向设置有时不生效，甚至不同档案进入阅读模式后方向不一致」。
    const preferences = { theme: 'system', defaultLayout: 'auto', defaultDirection: 'rtl', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'off', upscaleModel: '', customCss: '' };
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: preferences };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      // 这本档案上次是按「从左到右」读的：一份比设置更旧的记录。
      if (command === 'load_reading_progress') return { ok: true, value: { scopeId: 'scope-a', archiveId: 'a1', pageIndex: 0, pageCount: 3, layout: 'paged', direction: 'ltr', updatedAt: '2026-09-05T00:00:00Z', revision: 1 } };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'save_reading_progress') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(await screen.findByRole('button', { name: '从右到左' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '从左到右' })).not.toBeInTheDocument();
  });

  it('opens page 1 when the URL explicitly asks for page=0, even with saved progress', async () => {
    // A missing page param restores the saved progress; a PRESENT `page=0` is
    // an explicit request for the first page (the detail page's thumbnail
    // grid), and it used to be mistaken for "no page requested".
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg', '3.jpg', '4.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: { scopeId: 'scope-a', archiveId: 'a1', pageIndex: 3, pageCount: 5, layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 1 } };
      if (command === 'load_reader_page') return { ok: true, value: [1] };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1?page=0']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

  it('reads against the server the linking card carried, not the first one', async () => {
    // Two configured servers with the same archive id: without `?server=` the
    // reader always opened server 1's copy and wrote progress there too.
    const requestedServers: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [
        { id: 'server-a', name: 'First', baseUrl: 'https://first.example.com', scopeId: 'scope-first' },
        { id: 'server-b', name: 'Second', baseUrl: 'https://second.example.com', scopeId: 'scope-second' },
      ] };
      if (command === 'load_reader_manifest') {
        requestedServers.push(String(args?.serverId));
        return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      }
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'load_reader_page') return { ok: true, value: [1] };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1?server=server-b']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(requestedServers).toEqual(['server-b']);
  });

  it('serves the upscaled page when a model is selected, and falls back when it fails', async () => {
    const commands: string[] = [];
    let model = 'realesr-general-x4v3';
    installHost({ lease: async (index) => ({ url: `blob:enhanced-${index}`, bytes: 1 }) });
    setInvokeAdapterForTests(async (command, args) => {
      commands.push(command);
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: model } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    const view = render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(commands).not.toContain('compute_submit_reader_page');
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(commands).toContain('compute_submit_reader_page'));
    view.unmount();

    // A failing upscale must leave the plain page on screen.
    hostSubmitFails = true;
    commands.length = 0;
    const failed = render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(commands).not.toContain('compute_submit_reader_page');
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(commands).toContain('compute_submit_reader_page'));
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    failed.unmount();

    // A backend with no model would run the nearest-neighbour fallback, which
    // returns the same pixels at four times the size. Not worth a round trip.
    hostSubmitFails = false;
    model = '';
    commands.length = 0;
    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(commands).not.toContain('compute_submit_reader_page');
  });

  it('quietly displays successful hardware output without a late hardware toast', async () => {
    enhancedReader(1, async (index) => ({ url: `blob:enhanced-${index}`, bytes: 1 }), {
      archiveId: 'quiet-vulkan-output', enginePolicy: 'auto', engineDeviceId: 'vulkan:Adreno (TM) 750',
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(screen.queryByText(/超分正在使用/)).not.toBeInTheDocument();
  });

  it('says out loud when the page was not computed by the runtime it asked for', async () => {
    // 「点的是显卡、跑的是 CPU」以前只有「成功」这一个结果，界面什么都不说（docs/71:126
    // 要求 auto 显式回退并展示原因）。交代来自产物上的那两栏，而且只说一次——同一台机器上
    // 每翻一页都是同一条原因（去重的键里带的是原因，不是页码）。
    enhancedReader(2, async (index) => ({ url: `blob:enhanced-${index}`, bytes: 1 }), {
      archiveId: 'engine-notice-test',
      enginePolicy: 'auto',
      engineFallback: { requested: 'directml', used: 'cpu', reason: 'directml 在这台机器上不可用' },
    });

    await screen.findByRole('img', { name: '第 1 页' });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(await screen.findByText(/没有用 directml 算/)).toBeInTheDocument();
    expect(screen.getByText(/实际用的是 cpu/)).toBeInTheDocument();

    // 第二页走的是另一份产物（另一个 jobId），但交代是同一件事实：不该再弹一遍。
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await screen.findByRole('img', { name: '第 2 页' });
    await waitFor(() => expect(screen.getByRole('img', { name: '第 2 页' })).toHaveAttribute('src', 'blob:enhanced-1'));
    expect(screen.getAllByText(/没有用 directml 算/)).toHaveLength(1);
  });

  it('tells a forced-GPU failure apart from a step that just did not run', async () => {
    // 点名要显卡却失败了，绝不能听起来像「只是慢了一档」：`Gpu` 是承诺（docs/71 §5.1/§12.1），
    // 拿不到显卡、或这个模型在这条运行库上实测不通过就是失败，决不许悄悄用 CPU 顶上。
    // 宿主这次让任务以 `GPU_OUTPUT_INVALID` 结束（提交应答里的快照就带着它）。
    enhancedReader(1, async (index) => ({ url: `blob:enhanced-${index}`, bytes: 1 }), {
      archiveId: 'forced-gpu-test',
      failCode: 'GPU_OUTPUT_INVALID',
    });

    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    expect(await screen.findByText(/点名要显卡这一步没跑成：GPU_OUTPUT_INVALID/)).toBeInTheDocument();
    // 普通那句讲的是另一件事（它是每一档失败共用的那句话），这里不该出现：说成「没跑成」
    // 会让人以为只是降级，而事实上是「你要的那条路给不了」。
    expect(screen.queryByText(/超分这一步没跑成/)).not.toBeInTheDocument();
    expect(hostCommands).toContain('compute_submit_reader_page');
    // 页面上留下的仍是原图那一版：失败不许变成黑图。
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:plain-0');
  });

  it('keeps reading while the worker is dead, and asks again once it is back', async () => {
    // docs/71:645 第四句的界面那一半：worker 被杀不等于阅读器坏了。失败是在**提交应答自带的
    // 快照**上看见的（`COMPUTE_WORKER_LOST`，事件可能永远不来），所以这一页必须立刻退回可用
    // 的那一版并说一次，翻页照走；等宿主把 worker 拉回来（它自己会重启，见
    // `compute_manager.rs` 那条 IT），翻回这一页要**再问一次**并换上新版——一次进程死亡不许
    // 把这一页在这一整次阅读里写死。
    enhancedReader(2, async (index) => ({ url: `blob:enhanced-${index}`, bytes: 1 }), {
      archiveId: 'worker-died-test',
      failCode: 'COMPUTE_WORKER_LOST',
    });

    await screen.findByRole('img', { name: '第 1 页' });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    // ① 页面上留下的是原图那一版，而且用户被告知这一步没跑成：失败不许变成空白。
    expect(await screen.findByText(/超分这一步没跑成/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:plain-0');

    // ② 界面还能用：翻页照走，第二页照样读得出来。
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    expect(await screen.findByRole('img', { name: '第 2 页' })).toHaveAttribute('src', 'blob:plain-1');

    // ③ worker 回来了（`hostFailCode = null` 之后提交能成）——翻回第一页要重新提交。
    hostFailCode = null;
    const submits = hostCommands.filter((command) => command === 'compute_submit_reader_page').length;
    fireEvent.keyDown(reader, { key: 'ArrowLeft' });
    await screen.findByRole('img', { name: '第 1 页' });
    // 先量「有没有再问一次」：这一页失败之后要是被记成「试过了」，翻回去不重问，它就永远
    // 停在原图——那不是「可用的一版」，是这一次阅读里再也拿不到结果。
    await waitFor(() => expect(
      hostCommands.filter((command) => command === 'compute_submit_reader_page').length,
    ).toBeGreaterThan(submits));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
  });

  it('does not ask again for a page the host says can never run', async () => {
    // 上一条的边界：只有**阵发性**的失败才配再问一次。点名要显卡、模型没装这类是这一页
    // （或这台机器）的定局，再问一次还是同一个结果——真那么做的话，用户每翻回来一次就
    // 重撞一次，日志里刷满同一条。
    enhancedReader(2, async (index) => ({ url: `blob:enhanced-${index}`, bytes: 1 }), {
      archiveId: 'permanent-failure-test',
      failCode: 'GPU_OUTPUT_INVALID',
    });

    await screen.findByRole('img', { name: '第 1 页' });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    expect(await screen.findByText(/点名要显卡这一步没跑成/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:plain-0');

    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    expect(await screen.findByRole('img', { name: '第 2 页' })).toHaveAttribute('src', 'blob:plain-1');

    const submits = hostCommands.filter((command) => command === 'compute_submit_reader_page').length;
    fireEvent.keyDown(reader, { key: 'ArrowLeft' });
    await screen.findByRole('img', { name: '第 1 页' });
    // 等一拍：真要是又问了，这一拍足够它把命令发出去。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hostCommands.filter((command) => command === 'compute_submit_reader_page')).toHaveLength(submits);
  });

  it('runs the upscale stage for the page on screen', async () => {
    // 本地这一档（超分）在 8-f 起也整体搬进了 worker：阅读器提交的是一件 compute 任务，
    // 不再让宿主在进程里跑模型（那是 `inference_upscale_page`，被删掉的那条路）。
    const commands: string[] = [];
    installHost();
    setInvokeAdapterForTests(async (command: string, args) => {
      commands.push(command);
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'test' } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(commands).not.toContain('compute_submit_reader_page');
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(commands).toContain('compute_submit_reader_page'));
    // 跑完那一版真的上了屏（不是「提交过了就算」）。
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(commands.filter((command) => command === 'compute_submit_reader_page')).toHaveLength(1);
    expect(commands).not.toContain('inference_upscale_page');
  });

  it('says the page is being upscaled while the model runs', async () => {
    // 一页在 CPU 上要好几秒；这段时间页面上压着一枚「超分处理中」的胶囊，
    // 让等待有交代——不然按下「超分」看上去就是没反应。
    let releaseUpscale: (() => void) | undefined;
    installHost();
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'compute_submit_reader_page') {
        // 提交这一下压在手里：这正是「原生还在算」的那几秒。
        return new Promise((resolve) => { releaseUpscale = () => resolve(submitJob(args, ['upscale'])); });
      }
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'test' } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.queryByText('超分处理中…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    await waitFor(() => expect(screen.getByText('超分处理中…')).toBeInTheDocument());
    await act(async () => { releaseUpscale?.(); });
    await waitFor(() => expect(screen.queryByText('超分处理中…')).not.toBeInTheDocument());
  });

  it('keeps the local upscaled page when the DLSS5 step fails', async () => {
    // DLSS5 开着（设置里检测通过），但这一步在运行期失败（片段换了、驱动不对）。
    // 这一步失败不能把**本地那一版也丢掉**：页面上该留着的仍然是超分那一版。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition === 'dlssnr') throw new Error('DLSS5 跑不通');
      return {
        key: `${identity.rendition}-${identity.pageIndex}`,
        url: `blob:${identity.rendition}-${identity.pageIndex}`,
        bytes: 1,
      };
    });
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const commands: string[] = [];
    installHost();
    setInvokeAdapterForTests(async (command: string, args) => {
      commands.push(command);
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'test', dlssnrEnabled: true } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      // 这台机器看着能跑（偏好里开着，检测也通过）：阅读器据此排队，失败发生在
      // 真正跑那一步的时候。
      if (command === 'dlssnr_status') {
        return {
          ok: true,
          value: {
            dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 165_840_496,
            gpu: { name: 'NVIDIA GeForce RTX 4070', recommendedVariant: 'community' },
            gpuName: 'NVIDIA GeForce RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版',
            coreAvailable: true, installable: true, available: true,
            probe: { supported: true, width: 96, height: 96, elapsedMs: 1200, difference: 12.5, error: null },
            probeValid: true, error: null,
          },
        };
      }
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:reader-page-0');
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    const image = screen.getByRole('img', { name: '第 1 页' });
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(image).toHaveAttribute('src', 'blob:reader-page-0');
  });

  it('auto-disables DLSS5 when this machine cannot actually run it', async () => {
    // 偏好里那个开关是**持久化**的：另一台机器上打开过、或者 DLL 换过，本机这一刻
    // 跑不起来。阅读器不能照旧排队（每次都是一次原生失败），而该关掉并说清楚。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => ({
      key: `${identity.rendition}-${identity.pageIndex}`,
      url: `blob:${identity.rendition}-${identity.pageIndex}`,
      bytes: 1,
    }));
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const saved: Array<Partial<{ dlssnrEnabled: boolean }>> = [];
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      commands.push(command);
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'off', upscaleModel: '', dlssnrEnabled: true } };
      }
      if (command === 'save_preferences') {
        const input = (args?.input ?? {}) as Partial<{ dlssnrEnabled: boolean }>;
        saved.push(input);
        return { ok: true, value: input };
      }
      if (command === 'dlssnr_status') {
        return {
          ok: true,
          value: {
            dllPresent: false, variant: null, variantLabel: null, dllBytes: null, gpu: null,
            gpuName: '', recommendedVariant: null, recommendedLabel: null, coreAvailable: false,
            installable: false, available: false, probe: null, probeValid: false,
            error: '没有找到 NVIDIA 显卡',
          },
        };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [1, 2, 3] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });

    // 说清楚为什么，并且把偏好写回 false（不然每次进阅读器都要重问一遍）。
    expect(await screen.findByText(/DLSSNR 不可用：没有找到 NVIDIA 显卡/)).toBeInTheDocument();
    await waitFor(() => expect(saved).toContainEqual(expect.objectContaining({ dlssnrEnabled: false })));
    // 也没有任何一步真的去跑它。
    expect(commands).not.toContain('dlssnr_apply_page');
  });

  it('keeps the plain page on screen until the enlarged one lands', async () => {
    // 超分那一版要算几秒：这段时间页面上压着的必须是原图。换版那一刻也不能先把旧图
    // 放掉——放掉到 0 引用会把 blob URL 撤销，页面上那一张就成了坏图。
    const cache = getNativeImageCache();
    let releaseUpscale: ((lease: HostLease) => void) | undefined;
    installHost({
      lease: async (_pageIndex) => {
        // 压在手里：用例自己决定最终那一版什么时候落地。
        return new Promise<HostLease>((resolve) => { releaseUpscale = resolve; });
      },
    });
    const adopt = vi.spyOn(cache, 'adopt');
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      // 算出来的那一版必须走宿主那道门：本地缓存这条路只剩原图。真去问它就要一个错——
      // 不然「走了旧路」也会得到同一张图，这条用例就成了白测。
      if (identity.rendition !== 'reader-page') throw new Error(`这一版不该再走本地缓存：${identity.rendition}`);
      return { key: `reader-page-${identity.pageIndex}`, url: `blob:reader-page-${identity.pageIndex}`, bytes: 1 };
    });
    setInvokeAdapterForTests(async (command: string, args) => {
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'real-esrgan', dlssnrEnabled: false } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    const image = screen.getByRole('img', { name: '第 1 页' });
    // 还没算完：这时候页面上压着的必须是原图（不是黑图，也不是空白）。
    await waitFor(() => expect(releaseUpscale).toBeDefined());
    expect(image).toHaveAttribute('src', 'blob:reader-page-0');
    await act(async () => { releaseUpscale?.({ url: 'blob:enhanced-0', bytes: 1 }); });
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(image).toHaveAttribute('src', 'blob:reader-page-0');
    const adopted = adopt.mock.results[0]!.value as ImageHandle;
    // 算出来的那一版起点是原图，不是别的阶段留下的产物。
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ rendition: 'enhanced', source: 'reader-page' }),
      expect.anything(),
    );
    // 它这会儿就在屏上：不许放掉——放掉到 0 引用会把 blob URL 撤销，页面上那一张
    // 就成了坏图。真正放掉它要等到离开这一次显示（见另一条「hands back the derived
    // renditions it holds once the reader stops being displayed」）。
    expect(release).not.toHaveBeenCalledWith(adopted);
  });

  it('reports the failure and keeps the plain page when the local upscale fails', async () => {
    // 本地那一档**跑起来之后再失败**（产物发过了、租借那一步答失败）——与「派发期整件被拒」
    // 不是一回事：页面上不能是黑图，用户也该被告知哪一档没跑成。
    const cache = getNativeImageCache();
    installHost({ failStage: 'upscale' });
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition !== 'reader-page') throw new Error(`这一版不该再走本地缓存：${identity.rendition}`);
      return { key: `reader-page-${identity.pageIndex}`, url: `blob:reader-page-${identity.pageIndex}`, bytes: 1 };
    });
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    setInvokeAdapterForTests(async (command, args) => {
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'real-esrgan', dlssnrEnabled: false } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    const image = screen.getByRole('img', { name: '第 1 页' });
    // 失败也说了出来（先等这句话，提交与租借都是异步的，抢在前面看命令列表会看到半截）。
    expect(await screen.findByText(/超分这一步没跑成/)).toBeInTheDocument();
    // 起点就是原图：这一步走的是宿主那道门。载荷里没有「起点」这一项——宿主按 `rendition`
    // 自己决定——所以这里能验的就是门确实被叫了。
    expect(hostCommands).toContain('compute_submit_reader_page');
    // 算不出来就退回原图：这一页必须还是能读的。
    expect(image).toHaveAttribute('src', 'blob:reader-page-0');
  });

  it('cancels the native task when the reader stops wanting it', async () => {
    // 前端丢掉结果不等于原生停手：一页 4K 在 CPU 上要十几秒，而全局只允许一件重活。
    // 离开阅读器 / 关掉开关时，那个任务号要发回宿主让它停下来（`compute_cancel`）。
    const calls: Array<{ command: string; args?: Record<string, unknown> | undefined }> = [];
    installHost({ acquireNeverLands: true });
    setInvokeAdapterForTests(async (command: string, args) => {
      calls.push({ command, args });
      const hostReply = await hostUpscaleAnswer(command, args);
      if (hostReply !== null) return hostReply;
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'real-esrgan' } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [1, 2, 3] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    const view = render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    // 超分这一步一直不回来（在 CPU 上就是这样），租借也就一直拿不到。
    const submitted = await waitFor(() => {
      const call = calls.find((entry) => entry.command === 'compute_submit_reader_page');
      expect(call).toBeDefined();
      return call!;
    });
    expect((submitted.args?.payload as { pageIndex?: number } | undefined)?.pageIndex).toBe(0);

    view.unmount();
    await waitFor(() => expect(calls.filter((entry) => entry.command === 'compute_cancel')).toContainEqual(
      expect.objectContaining({ args: expect.objectContaining({ jobId: expect.stringMatching(/^host-job-0-/), subscriptionId: 1 }) }),
    ));
  });

  it('hands back the derived renditions it holds once the reader stops being displayed', async () => {
    // 用户报的问题：读一本档案内存能到 8G，退出去过一段时间仍有 4G 回不来。派生
    // 渲染是最大的一份——这台机器 DLSSNR 一页成品 21–27MB（用户库里 133 页 2.9GB）。
    // 阅读器被切到后台时它一页都不显示，这些句柄就该当场放掉，而不是留给「也许还会
    // 切回来」；切回来时 ReaderScreen 会重新报可见页，按需再算一遍。
    const cache = getNativeImageCache();
    const pageCount = 6;
    const pageBytes = 24 * 1024 * 1024;
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    // 抓「排空之后过一会儿再交回 DLSSNR 工作区」那个定时器：宽限期是 30 秒，等真的
    // 30 秒过完不现实，所以在这里手动触发它一次（见 `scheduleWorkspaceRelease`）。
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const armedIdleRelease = () => setTimeoutSpy.mock.calls.filter(([, delay], index) => delay === 30_000
      && !clearTimeoutSpy.mock.calls.some(([id]) => id === setTimeoutSpy.mock.results[index]?.value)).at(-1);
    const commands: string[] = [];
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: pageBytes }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command, args) => {
      commands.push(command);
      if (command === 'trim_process_memory') return { ok: true, value: null };
      if (command === 'dlssnr_release_workspaces' || command === 'inference_release_sessions') return { ok: true, value: 0 };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: String(args?.archiveId ?? 'left'), title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: 'Lecram 版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: 'Lecram 版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/left']}><ReaderNavigation /><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const derivedLoads = () => load.mock.calls.filter(([identity]) => identity.archiveId === 'left' && identity.rendition === 'dlssnr');
    // 等这一本整本预扫完，之后 release 里出现的就只可能是这次离开造成的。
    await waitFor(() => {
      expect(new Set(derivedLoads().map(([identity]) => identity.pageIndex))).toEqual(new Set(Array.from({ length: pageCount }, (_, index) => index)));
    }, { timeout: 10_000 });
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:dlssnr-0'));

    release.mockClear();
    // 还有另一半内存不归句柄管：DLSSNR 缓存的工作区是**提交**内存（实测一页
    // 2731×4096 跑五层，进程从 45MB 涨到 9.5GB，`docs/69`），它跟进程同寿、上限两份。
    // 队列排空就说明没人再要下一张了，这时排一个 30 秒的宽限定时器（翻页是阵发的，
    // 立刻交回会让连翻的每一页都重建一次 feature）。
    await waitFor(() => expect(armedIdleRelease()).toBeDefined());
    expect(commands).not.toContain('dlssnr_release_workspaces');
    (armedIdleRelease()?.[0] as () => void)();
    await waitFor(() => expect(commands).toContain('dlssnr_release_workspaces'));
    expect(commands).toContain('inference_release_sessions');

    const loadsBeforeSettings = derivedLoads().length;
    fireEvent.click(screen.getByRole('link', { name: '阅读设置' }));
    const returnToReader = await screen.findByRole('button', { name: '返回阅读模式' });
    expect(release.mock.calls.map(([handle]) => handle.key)).not.toContain('dlssnr-0');
    fireEvent.click(returnToReader);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:dlssnr-0');
    expect(derivedLoads()).toHaveLength(loadsBeforeSettings);

    // 切到另一本：刚才那本还留着（App 的保留上限是 2），只是不再显示。
    fireEvent.click(screen.getByRole('button', { name: '换一本' }));
    const releasedKeys = () => release.mock.calls.map(([handle]) => handle.key);
    // 连屏幕上那一页的成品也要放：隐藏着的阅读器没有「不能闪」这回事。
    await waitFor(() => expect(releasedKeys()).toContain('dlssnr-0'));
    expect(releasedKeys().filter((key) => key.startsWith('dlssnr-'))).toEqual(expect.arrayContaining(['dlssnr-1', 'dlssnr-2']));

    // 句柄放掉只是一半：Rust 那边 free 了，Windows 不一定马上把页从进程工作集里收
    // 回去（实测退出后仍有 4GB 落不下来）。离开这一本的那一刻要叫一次工作集清理。
    await waitFor(() => expect(commands).toContain('trim_process_memory'));

    // Re-enter with processing disabled; an explicit new toggle may reuse the queue.
    const beforeReturn = derivedLoads().length;
    fireEvent.click(screen.getByRole('button', { name: '切回刚才那本' }));
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启 DLSSNR' }));
    await waitFor(() => expect(derivedLoads().length).toBeGreaterThan(beforeReturn), { timeout: 10_000 });
  });

  it('a run whose signal was already aborted cannot latch the failure screen onto pages that arrived', async () => {
    // 现场来自真窗口（`debug_outputs/task9f/reader-trace.json`）：StrictMode 下这个 effect 跑两遍，
    // 第一遍在信号被 abort 之后才拿到 manifest——代码里「我是不是最新那一遍」判的是
    // `contextRef.current`，而它是**新那一遍取回 manifest 时**才换的，所以旧那一遍在这段空隙里
    // 仍然算数：它把 contextRef 抢回去，随后必然 abort 的取页全都落空，于是写下
    // 「阅读页面加载失败」；新那一遍把页面都取回来了，却没人清掉那个错误，屏幕停在失败态。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    vi.spyOn(cache, 'load').mockImplementation(async (identity, options) => {
      // 真缓存第一句就是这个：带着已经 abort 的信号来的消费者一个字节也拿不到。
      if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:plain-${identity.pageIndex}`, bytes: 1 };
    });
    let serversCalls = 0;
    let manifests = 0;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, upscaleBackend: 'off', upscaleModel: '' } };
      if (command === 'list_servers') {
        // 两遍都会走到这里（它前面没有 await 之后的 staleness 判断），所以它是「effect 跑了两遍」
        // 的证人；`load_reader_manifest` 不行——修好之后旧那一遍根本走不到那一步。
        serversCalls += 1;
        return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      }
      if (command === 'load_reader_manifest') {
        manifests += 1;
        // 只让**第二遍**晚一步回来：旧那一遍这时仍是 `contextRef` 的主人，它的失败因此落得下来；
        // 真窗口里两遍的先后正是这样（旧那遍先跑完取页、新那遍的 manifest 后到）。
        if (manifests === 2) await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true, value: { archiveId: 'stale-run', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      }
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/reader/stale-run']}><App /></MemoryRouter>
      </StrictMode>,
    );
    // 这条用例问的是「两遍都在跑」这件事本身：StrictMode 不双跑，底下就什么都没测到。
    await waitFor(() => expect(serversCalls).toBe(2));
    // 旧那一遍的失败在新那一遍的 manifest 之前落下；两边都落定之后再看屏幕上是哪一支。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(screen.queryAllByText('阅读页面加载失败')).toHaveLength(0);
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeTruthy();
  });

  /** 远端那台机器在这次用例里的应答：三档能力各自 `ready` 与否由用例说了算。 */
  function remoteReader(options: {
    ready: { upscale: boolean; dlssnr: boolean };
    process?: (args: Record<string, unknown> | undefined) => unknown;
    /** 前几次问能力清单先答不上（对面刚起、网络抖一下）：默认 0。 */
    probeFailures?: number;
    localModel?: string;
    pageCount?: number;
    processFile?: () => unknown;
    rawPage?: (pageIndex: number) => unknown;
    prefetchPages?: number;
    startPage?: number;
  }): { calls: Array<[string, Record<string, unknown> | undefined]> } {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    let probes = 0;
    setInvokeAdapterForTests(async (command, args) => {
      calls.push([command, args as Record<string, unknown> | undefined]);
      if (command === 'load_preferences') {
        return {
          ok: true,
          value: {
            theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648,
            prefetchPages: options.prefetchPages ?? 0, coverConcurrency: 4,
            // 本机一个模型都没有：这三枚按钮能亮，只可能是因为对面报了可用。
            upscaleBackend: options.localModel ? 'cpu' : 'off', upscaleModel: options.localModel ?? '',
            remoteComputeUrl: '192.168.1.9:47653',
            remoteComputeToken: 'remote-token',
            remoteComputeOps: serializeRemoteOps({
              enabled: true,
              pairedDevices: [{ address: '192.168.1.9:47653', name: 'DESKTOP-PC', token: 'remote-token' }],
            }),
          },
        };
      }
      if (command === 'remote_compute_capabilities') {
        probes += 1;
        if (probes <= (options.probeFailures ?? 0)) {
          return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '对面没答上', retryable: true } };
        }
        return {
          ok: true,
          value: {
            service: 'yomika-compute-center',
            version: 2,
            name: 'DESKTOP-PC',
            revision: `settings-${probes}`,
            models: [],
            capabilities: (['upscale', 'dlssnr'] as const).map((id) => ({
              id,
              label: { upscale: '超分', dlssnr: 'DLSS5' }[id],
              ready: options.ready[id],
              detail: options.ready[id] ? '' : '对面没装',
            })),
          },
        };
      }
      const host = await hostUpscaleAnswer(command, args as Record<string, unknown> | undefined);
      if (host !== null) return host;
      if (command === 'remote_compute_process_file' && options.processFile) return options.processFile();
      if (command === 'reader_prepare_native_slot') return { ok: true, value: true };
      if (command === 'compute_artifact_release') return { ok: true, value: null };
      if (command === 'remote_compute_process') {
        return options.process ? options.process(args) : [0x89, 0x50, 0x4e, 0x47];
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'remote-reader', title: 'Reader', pages: Array.from({ length: options.pageCount ?? 1 }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: options.startPage === undefined ? null : { scopeId: 's', archiveId: 'remote-reader', pageIndex: options.startPage, pageCount: options.pageCount, layout: 'paged', direction: 'ltr', revision: 1, updatedAt: new Date().toISOString() } };
      if (command === 'load_reader_page') return options.rawPage ? options.rawPage(Number(args?.pageIndex)) : { ok: true, value: [1, 2, 3] };
      if (command === 'save_preferences') return { ok: true, value: (args?.input ?? {}) };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/remote-reader']}><App /></MemoryRouter>);
    return { calls };
  }

  it('reacquires and presents a remote result after native preparation fails in the same session', async () => {
    const events: { op: string; id: number }[] = [];
    vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => events.push(JSON.parse(message)) });
    let leases = 0;
    // A bad lease must fail in both renderers before it can be reacquired.
    setImageDecoderForTests(async (url) => {
      if (url.endsWith('remote-recovery-1')) throw new Error('Invalid image lease');
    });
    try {
      const { calls } = remoteReader({ ready: { upscale: true, dlssnr: true }, processFile: () => {
        const leaseId = `remote-recovery-${++leases}`;
        return { ok: true, value: { contentHash: 'e'.repeat(64), lease: {
          leaseId, artifactId: 'image', jobId: 'reader-remote', url: `yomika-image://assets/${leaseId}`,
          mime: 'image/png', width: 100, height: 200, byteLength: 500, estimatedDecodedBytes: 80_000,
          pipelineRevision: 'remote-version', expiresInMs: 60_000,
        } } };
      } });
      const page = await screen.findByRole('img', { name: '第 1 页' });
      fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
      fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
      const preparedSlots = () => calls.filter(([name]) => name === 'reader_prepare_native_slot').map(([, args]) => Number(args?.slot));
      const status = (slot: number, width: number, height: number) => window.dispatchEvent(
        new CustomEvent('yomika-reader-tile-status', { detail: { slot, width, height } }),
      );
      await waitFor(() => expect(preparedSlots()).toHaveLength(1));
      act(() => { status(preparedSlots()[0]!, 0, 0); });
      await waitFor(() => expect(preparedSlots()).toHaveLength(2));
      expect(screen.getByRole('img', { name: '第 1 页' })).toBe(page);
      expect(leases).toBe(2);
      expect(calls).toContainEqual(['compute_artifact_release', { leaseId: 'remote-recovery-1' }]);
      const replacement = preparedSlots()[1]!;
      act(() => { status(replacement, 100, 200); });
      await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ op: 'present', id: replacement })));
      act(() => { window.dispatchEvent(new CustomEvent('yomika-reader-tile-presented', { detail: { slot: replacement } })); });
      expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('data-native-reader-visible', 'true');
    } finally {
      setImageDecoderForTests(undefined);
      vi.unstubAllGlobals();
    }
  });

  it('sends one original page for the full remote chain without running the local model', async () => {
    installHost();
    const { calls } = remoteReader({ ready: { upscale: true, dlssnr: true }, localModel: 'local-model' });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await screen.findByRole('button', { name: '开启超分' });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
      fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    });
    await waitFor(() => expect(calls.filter(([name]) => name === 'remote_compute_process')).toHaveLength(1));
    const request = calls.find(([name]) => name === 'remote_compute_process')?.[1]?.input as { source: string; params: { chain: string[] } };
    expect(request.source).toBe('reader-page');
    expect(request.params.chain).toEqual(['upscale', 'dlssnr']);
    expect(calls.some(([name]) => name === 'compute_submit_reader_page')).toBe(false);
    expect(calls.some(([name]) => name === 'dlssnr_apply_page')).toBe(false);
  });

  it('continues the complete remote chain on adjacent pages without a page turn', async () => {
    installHost();
    const { calls } = remoteReader({ ready: { upscale: true, dlssnr: true }, pageCount: 5 });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await screen.findByRole('button', { name: '开启超分' });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
      fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    });
    await waitFor(() => {
      const requests = calls.filter(([name]) => name === 'remote_compute_process').map(([, args]) => args?.input as { pageIndex: number; params: { chain: string[] } });
      expect(new Set(requests.map(request => request.pageIndex))).toEqual(new Set([0, 1, 2, 3, 4]));
      expect(requests.every(request => request.params.chain.join(',') === 'upscale,dlssnr')).toBe(true);
    });
  });

  it('preprocesses the next DLSSNR page before older pages behind the viewport', async () => {
    installHost();
    const { calls } = remoteReader({ ready: { upscale: false, dlssnr: true }, pageCount: 7, startPage: 2, prefetchPages: 4 });
    await screen.findByRole('img', { name: '第 3 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启 DLSSNR' }));
    await waitFor(() => {
      const pages = calls.filter(([name]) => name === 'remote_compute_process').map(([, args]) => (args?.input as { pageIndex: number }).pageIndex);
      expect(pages.slice(0, 5)).toEqual([2, 3, 1, 4, 0]);
    });
  });

  it('processes ready prefetched pages while another original is still loading, then automatically processes that original once', async () => {
    installHost();
    let finish!: (value: unknown) => void;
    const slowOriginal = new Promise(resolve => { finish = resolve; });
    const { calls } = remoteReader({ ready: { upscale: true, dlssnr: true }, pageCount: 3, prefetchPages: 2,
      rawPage: pageIndex => pageIndex === 1 ? slowOriginal : { ok: true, value: [1, 2, 3] },
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await screen.findByRole('button', { name: '开启超分' });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
      fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    });
    const processed = () => calls.filter(([name]) => name === 'remote_compute_process')
      .map(([, args]) => args?.input as { pageIndex: number; params: { chain: string[] } });
    try {
      await waitFor(() => expect(processed().some(request => request.pageIndex === 2)).toBe(true));
      expect(processed().some(request => request.pageIndex === 1)).toBe(false);
      await act(async () => { finish({ ok: true, value: [1, 2, 3] }); });
      await waitFor(() => expect(processed().filter(request => request.pageIndex === 1)).toHaveLength(1));
      expect(processed().every(request => request.params.chain.join(',') === 'upscale,dlssnr')).toBe(true);
      expect(calls.filter(([name, args]) => name === 'load_reader_page' && args?.pageIndex === 1)).toHaveLength(1);
    } finally {
      await act(async () => { finish({ ok: true, value: [1, 2, 3] }); });
    }
  });

  it('resumes remote preprocessing after a temporary source-page failure without navigation', async () => {
    installHost();
    let failed = false;
    const { calls } = remoteReader({ ready: { upscale: true, dlssnr: true }, pageCount: 5, rawPage: pageIndex => {
      if (pageIndex === 3 && !failed) {
        failed = true;
        return { ok: false, error: { code: 'NETWORK', message: 'temporary source failure', retryable: true } };
      }
      return { ok: true, value: [1, 2, 3] };
    } });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await screen.findByRole('button', { name: '开启超分' });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
      fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    });
    await waitFor(() => {
      expect(failed).toBe(true);
      expect(calls.some(([name, args]) => name === 'remote_compute_process' && (args?.input as { pageIndex: number }).pageIndex === 3)).toBe(true);
    }, { timeout: 2500 });
  });

  it('bounds failed source retries and lets later remote pages run during backoff', async () => {
    installHost();
    let failures = 0;
    let laterPageStartedBeforeRetry = false;
    const { calls } = remoteReader({ ready: { upscale: true, dlssnr: false }, pageCount: 5,
      rawPage: pageIndex => {
        if (pageIndex === 3) {
          failures += 1;
          return { ok: false, error: { code: 'NETWORK', message: 'source offline', retryable: true } };
        }
        return { ok: true, value: [1, 2, 3] };
      },
      process: args => {
        if ((args?.input as { pageIndex: number }).pageIndex === 4) laterPageStartedBeforeRetry = failures === 1;
        return [0x89, 0x50, 0x4e, 0x47];
      },
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(failures).toBe(3), { timeout: 3000 });
    expect(laterPageStartedBeforeRetry).toBe(true);
    expect(calls.filter(([name]) => name === 'remote_compute_process')).toHaveLength(4);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect(failures).toBe(3);
  });

  it('reprobes changed remote settings and retries with the newly advertised revision', async () => {
    installHost();
    let processed = 0;
    const { calls } = remoteReader({
      ready: { upscale: true, dlssnr: false }, localModel: 'local-model',
      process: () => ++processed === 1
        ? { ok: false, error: { code: 'REMOTE_PLAN_CHANGED', message: 'settings changed', retryable: true } }
        : [0x89, 0x50, 0x4e, 0x47],
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(calls.filter(([name]) => name === 'remote_compute_capabilities').length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(calls.filter(([name]) => name === 'remote_compute_process').length).toBeGreaterThanOrEqual(2));
    await waitFor(() => {
      const last = calls.filter(([name]) => name === 'remote_compute_process').at(-1)?.[1]?.input as { expectedRevision: string };
      expect(last.expectedRevision).toBe('settings-2');
    });
    expect(calls.some(([name]) => name === 'compute_submit_reader_page')).toBe(false);
  });

  it('runs the local model only after the remote request fails', async () => {
    installHost();
    let rejectRemote!: (error: Error) => void;
    const { calls } = remoteReader({
      ready: { upscale: true, dlssnr: false }, localModel: 'local-model',
      process: () => new Promise((_resolve, reject) => { rejectRemote = reject; }),
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(rejectRemote).toBeTypeOf('function'));
    expect(calls.some(([name]) => name === 'compute_submit_reader_page')).toBe(false);
    await act(async () => { rejectRemote(new Error('remote unavailable')); });
    await waitFor(() => expect(calls.filter(([name]) => name === 'compute_submit_reader_page')).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
  });

  it('uses foreground priority for local fallback when a prefetched page becomes visible', async () => {
    installHost();
    let rejectPrefetch!: (value: unknown) => void;
    const pending = new Promise(resolve => { rejectPrefetch = resolve; });
    const { calls } = remoteReader({
      ready: { upscale: true, dlssnr: false }, localModel: 'local-model', pageCount: 2, prefetchPages: 1,
      process: args => (args?.input as { pageIndex: number }).pageIndex === 1 ? pending : [0x89, 0x50, 0x4e, 0x47],
    });
    const reader = await screen.findByRole('main', { name: '漫画阅读器' });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(reader);
    fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(calls).toContainEqual(['remote_compute_process', expect.objectContaining({
      input: expect.objectContaining({ pageIndex: 1, priority: 'background' }),
    })]));
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await screen.findByRole('img', { name: '第 2 页' });
    await act(async () => { rejectPrefetch({ ok: false, error: {
      code: 'COMPUTE_UNAVAILABLE', message: 'remote worker is over budget', retryable: true,
    } }); });
    await waitFor(() => expect(calls).toContainEqual(['compute_submit_reader_page', expect.objectContaining({
      payload: expect.objectContaining({ pageIndex: 1, priority: 'foreground' }),
    })]));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 2 页' })).toHaveAttribute('src', 'blob:enhanced-1'));
  });

  it('keeps the original visible and retries after both workers reject the page for pressure', async () => {
    installHost({ failCode: 'COMPUTE_UNAVAILABLE' });
    let remoteAttempts = 0;
    const { calls } = remoteReader({ ready: { upscale: true, dlssnr: false }, localModel: 'local-model',
      process: () => {
        remoteAttempts += 1;
        return { ok: false, error: { code: 'COMPUTE_UNAVAILABLE', message: 'worker pressure', retryable: true } };
      },
    });
    const image = await screen.findByRole('img', { name: '第 1 页' });
    const original = image.getAttribute('src');
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    const toggle = await screen.findByRole('button', { name: '开启超分' });
    vi.useFakeTimers();
    try {
      fireEvent.click(toggle);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(calls.filter(([name]) => name === 'compute_submit_reader_page')).toHaveLength(1);
      expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', original);
      installHost();
      await act(async () => { await vi.advanceTimersByTimeAsync(31_500); });
      expect(remoteAttempts).toBeGreaterThanOrEqual(2);
      expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back locally after a remote transport failure without retrying forever', async () => {
    installHost();
    let requests = 0;
    const { calls } = remoteReader({
      ready: { upscale: true, dlssnr: false }, localModel: 'local-model',
      process: () => ++requests === 1
        ? { ok: false, error: { code: 'NETWORK', message: 'temporary connection loss', retryable: true } }
        : [0x89, 0x50, 0x4e, 0x47],
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(calls.some(([name]) => name === 'compute_submit_reader_page')).toBe(true));
    expect(requests).toBe(1);
  });

  it('keeps the offline circuit open for adjacent pages and processes them locally', async () => {
    installHost();
    const requested: number[] = [];
    const { calls } = remoteReader({
      ready: { upscale: true, dlssnr: false }, localModel: 'local-model', pageCount: 2,
      process: (args) => {
        const index = (args?.input as { pageIndex: number }).pageIndex;
        requested.push(index);
        return index === 0
          ? { ok: false, error: { code: 'NETWORK', message: 'temporary failure', retryable: true } }
          : [0x89, 0x50, 0x4e, 0x47];
      },
    });
    await screen.findByRole('img', { name: '第 1 页' });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(requested).toEqual([0]));
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await waitFor(() => expect(calls.filter(([name]) => name === 'compute_submit_reader_page').length).toBeGreaterThanOrEqual(2));
    expect(requested).toEqual([0]);
  });

  it('updates remote-only controls after disconnection while preserving local upscale', async () => {
    installHost();
    const { calls } = remoteReader({
      ready: { upscale: true, dlssnr: true }, localModel: 'local-model',
      process: () => ({ ok: false, error: { code: 'NETWORK', message: 'offline', retryable: true } }),
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(await screen.findByRole('button', { name: '开启 DLSSNR' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(calls.some(([name]) => name === 'compute_submit_reader_page')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: '开启 DLSSNR' })).toBeNull());
    expect(screen.getByRole('button', { name: '关闭超分' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(calls.filter(([name]) => name === 'remote_compute_process')).toHaveLength(1);
  });

  it('removes remote upscale availability when disconnected without a local model', async () => {
    installHost();
    const { calls } = remoteReader({
      ready: { upscale: true, dlssnr: false },
      process: () => ({ ok: false, error: { code: 'NETWORK', message: 'offline', retryable: true } }),
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(calls.some(([name]) => name === 'remote_compute_process')).toBe(true));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '开启超分' })).toBeNull();
      expect(screen.queryByRole('button', { name: '关闭超分' })).toBeNull();
    });
  });

  it('restores remote controls after the offline cooldown probe succeeds', async () => {
    installHost();
    const { calls } = remoteReader({
      ready: { upscale: true, dlssnr: true }, localModel: 'local-model',
      process: () => ({ ok: false, error: { code: 'NETWORK', message: 'offline', retryable: true } }),
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(screen.queryByRole('button', { name: '开启 DLSSNR' })).toBeNull();
      expect(calls.filter(([name]) => name === 'remote_compute_capabilities')).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
      expect(calls.filter(([name]) => name === 'remote_compute_capabilities')).toHaveLength(1);
      // Turn processing off so this checks recovery, not another transport failure.
      fireEvent.click(screen.getByRole('button', { name: '关闭超分' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(calls.filter(([name]) => name === 'remote_compute_capabilities')).toHaveLength(2);
      fireEvent.mouseMove(screen.getByRole('main', { name: '漫画阅读器' }), { clientY: 700 });
      expect(screen.getByRole('button', { name: '开启 DLSSNR' })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('offers local upscale when the remote machine cannot provide it', async () => {
    installHost();
    const { calls } = remoteReader({ ready: { upscale: false, dlssnr: false }, localModel: 'local-model' });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(calls.filter(([name]) => name === 'compute_submit_reader_page')).toHaveLength(1));
    expect(calls.some(([name]) => name === 'remote_compute_process')).toBe(false);
  });

  it('stops retrying repeatedly cancelled local jobs and explains the failure', async () => {
    installHost({ cancelled: true });
    remoteReader({ ready: { upscale: false, dlssnr: false }, localModel: 'local-model' });
    await screen.findByRole('img', { name: '第 1 页' });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
      for (let index = 0; index < 2; index += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      }
      expect(hostCommands.filter((name) => name === 'compute_submit_reader_page')).toHaveLength(3);
      expect(screen.getByText(/本地超分任务多次中断/)).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(screen.getByRole('img', { name: '第 1 页' })).not.toHaveAttribute('src', 'blob:enhanced-0');
      expect(screen.queryByText(/处理中/)).not.toBeInTheDocument();
      fireEvent.mouseMove(reader, { clientY: 30 });
      // Reopening chrome must not silently restart an exhausted task.
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(hostCommands.filter((name) => name === 'compute_submit_reader_page')).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });

  it('takes the reader controls from the list the remote machine reports', async () => {
    // 第 17 项：连上远端之后，阅读器那两枚开关「能不能按」由**对面**那份清单决定。
    // 从前它们看的是本机装没装模型，于是手机连上桌面端之后两枚全是灰的。
    const { calls } = remoteReader({ ready: { upscale: true, dlssnr: false } });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));

    expect(await screen.findByRole('button', { name: '开启超分' })).toBeInTheDocument();
    // 对面没装的这一档不出现（本机也没装模型，两边都不给）。
    expect(screen.queryByRole('button', { name: '开启 DLSSNR' })).toBeNull();

    // 而且「连上远端」本身不等于「开始处理」：一档都没开的时候，一页都不许交给对面。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls.some(([command]) => command === 'remote_compute_capabilities')).toBe(true);
    expect(calls.some(([command]) => command === 'remote_compute_process')).toBe(false);
    // 也不去问本机那份 DLL 状态（走远端时它说的不是这一件事，手机上必然失败）。
    expect(calls.some(([command]) => command === 'dlssnr_status')).toBe(false);
  });

  it('rides out a capability probe that failed once instead of greying the switches', async () => {
    // 「设备连上之后频繁断开又重连」：一次探测失败（对面刚起、网络抖一下）就被当成断开，
    // 两枚开关全打回灰、用户刚打开的那一档还会被自动关掉。所以失败要重试，且**不**先把
    // 上一次的答案抹掉。
    const { calls } = remoteReader({ ready: { upscale: true, dlssnr: true }, probeFailures: 1 });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));

    expect(await screen.findByRole('button', { name: '开启超分' })).toBeInTheDocument();
    // 第一遍答不上、第二遍答上了：这就是「重试」这件事本身。
    expect(calls.filter(([command]) => command === 'remote_compute_capabilities')).toHaveLength(2);
  });

  it('hands the remote machine only the services that are on, in the order they must run', async () => {
    // 第 17 项：一次处理做哪几档，由阅读器里开着的开关决定；顺序固定「超分 → DLSSNR」，
    // 模型/倍数/层参数一概不发（对面按自己的设置跑）。
    const { calls } = remoteReader({ ready: { upscale: true, dlssnr: true } });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await screen.findByRole('button', { name: '开启超分' });

    const chains = () => calls
      .filter(([command]) => command === 'remote_compute_process')
      .map(([, args]) => (args?.input as { params: { chain: string[] } }).params.chain);

    // 一档都没开：一页都不许交给对面。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(chains()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(chains().length).toBeGreaterThan(0));
    // 只开了一档就只做这一档——不是「远端一律跑全套」。
    expect(chains()).toEqual(chains().map(() => ['upscale']));

    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    await waitFor(() => expect(chains()).toContainEqual(['upscale', 'dlssnr']));

    // 每一串都是这两档按同一个顺序取出的子序列——倒过来等于把超分这一步白扔，
    // 重复一档则是白跑一遍。
    const order = ['upscale', 'dlssnr'];
    for (const chain of chains()) {
      expect(chain.length).toBeGreaterThan(0);
      expect(chain).toEqual(order.filter((service) => chain.includes(service)));
    }
  });
});

/** 只用来把阅读器切到后台再切回来：`pageActive` 由 App 的 RetainedPage 决定，
 * 而它只跟着路由走。 */
function ReaderNavigation() {
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate('/reader/other')}>换一本</button>
    <button onClick={() => navigate('/reader/left')}>切回刚才那本</button>
  </>;
}
