import type { ImageCacheIdentity } from '../domain/cache';
import { NativeCacheRepository } from '../repositories/nativeCacheRepository';
import { hasNativeReaderTiles } from './readerNativeTiles';
import { getNativeComputeRepository } from '../repositories/nativeComputeRepository';
import { NativeComputeCenterRepository } from '../repositories/nativeComputeCenterRepository';
import { NativeDlssnrRepository, parseDlssnrPasses } from '../repositories/nativeDlssnrRepository';
import { NativeInferenceRepository } from '../repositories/nativeInferenceRepository';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSettingsRepository } from '../repositories/nativeSettingsRepository';
import { logError } from './errorLog';
import { detectImageMime } from './imageData';
import type { CachedImageData, ImageCacheRepository, ImageHandle } from './unifiedImageCache';
import { UnifiedImageCache } from './unifiedImageCache';

/** 阅读器那几版渲染：它们的失败**没有别的出口**——阅读器把每一页的错误都咽掉
 * （失败只体现为「这一页没换」），所以不在这里记一笔，用户报「超分没反应」
 * 时错误日志里就什么都没有。封面、缩略图不记：那些的原生失败本来就由桥接记录。 */
const READER_RENDITIONS: readonly string[] = ['reader-page', 'enhanced', 'dlssnr', 'remote'];

/** 阅读器这几版里由**原生那一步**产出的那些（DLSSNR / 远端）没算出来时抛的就是它。
 *
 * 为什么要带着码抛：上层（`ReaderRoute` 的派生队列）拿这一页的失败去判「这是阵发问题
 * 还是定局」——`RETRYABLE_COMPUTE_ERROR_CODES` 里那几个（队列满、worker 忙/被杀、超时）
 * 只是「现在没位置」，不该把这一页记成「做过了」，否则用户翻回去也只有原图，这一趟阅读
 * 里再也拿不到结果（docs/71:645 第四句）。只抛一句话，那个码就在这里丢了，上层只能把
 * 每一次阵发失败都当成定局——那正是「开着 DLSSNR 却一直什么都没有」的样子。 */
export class RenditionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, readonly retryable = true) {
    super(message);
    this.name = 'RenditionError';
    this.code = code;
  }
}

/** 从抛出来的东西里取回那个码；不是这条来路的失败（解不开图、被掐掉…）返回 `undefined`。 */
export function renditionErrorCode(error: unknown): string | undefined {
  return error instanceof RenditionError ? error.code : undefined;
}

export class NativeImageCacheAdapter implements ImageCacheRepository {
  constructor(
    private readonly cache = new NativeCacheRepository(),
    private readonly library = new NativeLibraryRepository(),
    private readonly inference = new NativeInferenceRepository(),
    private readonly dlssnr = new NativeDlssnrRepository(),
    private readonly compute = new NativeComputeCenterRepository(),
    private readonly settings = new NativeSettingsRepository(),
  ) {}

  async read(identity: ImageCacheIdentity): Promise<CachedImageData | null> {
    // Enhanced pages are session results. Ignore old on-disk entries left by
    // earlier builds and run the selected pipeline for this reading session.
    // 派生版本都是**本次会话**的产物：磁盘上哪怕留着一份旧构建写下的同名文件也
    // 不认，免得显示一张与当前设置无关的图。
    if (
      identity.rendition === 'enhanced'
      || identity.rendition === 'dlssnr'
      || identity.rendition === 'remote'
    ) return null;
    const result = await this.cache.readImage(identity);
    if (!result.ok) return null;
    return result.value;
  }

  async fetch(identity: ImageCacheIdentity, signal?: AbortSignal): Promise<CachedImageData> {
    // Original downloads need native cancellation just like inference. Each
    // attempt has its own ID so a late cancel cannot stop a replacement request.
    if (identity.rendition === 'reader-page' && !identity.taskId) {
      identity = { ...identity, taskId: `reader-fetch:${crypto.randomUUID()}` };
    }
    // 取消要传到原生那侧：前端丢掉结果不等于它停手，而一页 4K 在 CPU 上要十几秒，
    // 全局又只允许一件重活——不叫停的话，用户真正要看的那一页排在旧任务后面。
    const cancelNative = () => {
      if (!identity.taskId) return;
      void this.inference.cancelPage(identity.taskId).catch(() => undefined);
    };
    if (signal) {
      if (signal.aborted) {
        cancelNative();
        throw new DOMException('Aborted', 'AbortError');
      }
      signal.addEventListener('abort', cancelNative, { once: true });
    }
    try {
      return await this.load(identity, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 取消不是失败：切页、退出阅读器都会走到这里。
      if (READER_RENDITIONS.includes(identity.rendition) && !/abort/i.test(message)) {
        logError(`image/${identity.rendition}`, message, {
          error,
          scopeId: identity.scopeId,
          archiveId: identity.archiveId,
          pageIndex: identity.pageIndex,
          ...(identity.modelId ? { modelId: identity.modelId } : {}),
        });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancelNative);
    }
  }

  private async load(identity: ImageCacheIdentity, signal?: AbortSignal): Promise<CachedImageData> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!identity.serverId) throw new Error('Image request is missing a server ID');
    // `enhanced` 这一版**不从这里走**：它现在整条都由 compute 那条链产出
    // （`loadLocalRenditions` 提交宿主任务、把产物认领进这张账），从这里再往外开一道
    // 「宿主在进程里跑模型」的旧门正是 8-g 要拆掉的东西。
    //
    // 这里点名拦一道不是因为不拦就危险（不拦会掉到下面那句 `Unsupported image request`），
    // 而是因为那句话什么也没说：真出了这种事（谁又按这一版来读图），日志里要写清楚这一版
    // 归谁管。
    if (identity.rendition === 'enhanced') {
      throw new Error(`${identity.rendition} is produced by compute, not by the image cache`);
    }
    if (identity.rendition === 'dlssnr') {
      // DLSSNR：起点由 `transform` 说明（本地超分跑过就从它的产物接着跑），
      // 层参数也在里面——它同时是缓存键的一部分，改参数就拿不到旧结果。起点是按
      // 「产出它的模型」存的，模型 id 一并送过去。
      const processed = await this.dlssnr.applyPage(dlssnrPageRequest(identity));
      if (!processed.ok) throw new RenditionError(processed.error.code, processed.error.message);
      const bytes = new Uint8Array(processed.value);
      return { bytes, mime: detectImageMime(bytes) };
    }
    if (identity.rendition === 'remote') {
      const processed = await this.compute.remoteProcess(await this.remoteRequest(identity));
      if (!processed.ok) throw new RenditionError(processed.error.code, processed.error.message);
      const bytes = new Uint8Array(processed.value);
      return { bytes, mime: detectImageMime(bytes) };
    }
    const result = identity.rendition === 'cover'
      ? await this.library.loadArchiveThumbnail(identity.serverId, identity.archiveId)
      : identity.rendition === 'page-thumbnail'
        ? await this.library.loadArchivePageThumbnail(identity.serverId, identity.archiveId, identity.pageIndex + 1)
        : identity.rendition === 'reader-page' && identity.sourcePath
          ? await this.library.loadReaderPage(identity.serverId, identity.archiveId, identity.pageIndex, identity.sourcePath, identity.taskId)
          : undefined;
    if (!result) throw new Error('Unsupported image request');
    if (!result.ok) throw new RenditionError(result.error.code, result.error.message, result.error.retryable);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const bytes = new Uint8Array(result.value);
    return { bytes, mime: detectImageMime(bytes) };
  }

  private async remoteRequest(identity: ImageCacheIdentity): Promise<Parameters<NativeComputeCenterRepository['remoteProcess']>[0]> {
    // 远端算力：地址与令牌是「这台机器怎么找到对面」，不进缓存键（键里放凭据
    // 等于把它写进日志）；处理参数在 `transform` 里，键就跟着它走。
    const remote = parseRemoteOpsTransform(identity.transform);
    const loaded = await this.settings.load();
    if (!loaded.ok) throw new RenditionError(loaded.error.code, loaded.error.message);
    return {
      url: loaded.value.remoteComputeUrl,
      token: loaded.value.remoteComputeToken,
      // `op` 是 Rust 侧那个必填字段，拿串首顶上去；真正决定做哪几档的是 `chain`。
      // 模型、放大倍数、DLSSNR 层参数一律不发：对面按自己的设置跑。
      params: { op: remote.chain[0] ?? 'upscale', chain: remote.chain },
      scopeId: identity.scopeId,
      archiveId: identity.archiveId,
      pageIndex: identity.pageIndex,
      source: remote.source,
      // 键里那一版身份也带过去：对面回包上会写明**这一次真正用的**是哪一版，两者不一样
      // 就说明处理计划的身份在我们眼皮底下变了，这一份产物不能按老版本存下来（R11）。
      ...(remote.revision ? { expectedRevision: remote.revision } : {}),
      ...(identity.modelId ? { upscaleModel: identity.modelId } : {}),
      ...(identity.outputScale !== undefined ? { upscaleOutputScale: identity.outputScale } : {}),
      ...(identity.taskId ? { taskId: identity.taskId } : {}),
      // 远端有自己的队列（不占本机 GPU 那一件），档位管的是远端任务之间谁先走：
      // 当前页插到整本预扫前面。
      ...(identity.priority ? { priority: identity.priority } : {}),
    };
  }

  async loadRemoteFile(cache: UnifiedImageCache, identity: ImageCacheIdentity, signal: AbortSignal): Promise<ImageHandle | undefined> {
    if (!hasNativeReaderTiles()) return undefined;
    const request = await this.remoteRequest(identity);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!request.expectedRevision) return undefined;
    const releaseArtifact = getNativeComputeRepository();
    const cancelNative = () => {
      if (request.taskId) void this.inference.cancelPage(request.taskId).catch(() => undefined);
    };
    signal.addEventListener('abort', cancelNative, { once: true });
    try {
      const result = await this.compute.remoteProcessFile(request, identity.readerSession);
      if (!result.ok) {
        if (result.error.code === 'COMPUTE_RESOURCE_LIMIT') return undefined;
        throw new RenditionError(result.error.code, result.error.message, result.error.retryable);
      }
      if (!result.value) return undefined;
      const { lease, contentHash } = result.value;
      const release = () => { void releaseArtifact.releaseArtifact(lease.leaseId).catch(() => undefined); };
      if (signal.aborted) {
        release();
        throw new DOMException('Aborted', 'AbortError');
      }
      return cache.adopt(identity, {
        url: lease.url, bytes: lease.byteLength, estimatedDecodedBytes: lease.estimatedDecodedBytes,
        leaseId: lease.leaseId, contentHash, release,
      });
    } finally {
      signal.removeEventListener('abort', cancelNative);
    }
  }

  async loadDlssnrFile(cache: UnifiedImageCache, identity: ImageCacheIdentity, signal: AbortSignal): Promise<ImageHandle | undefined> {
    const session = identity.readerSession;
    if (session === undefined || !hasNativeReaderTiles()) return undefined;
    const input = dlssnrPageRequest(identity);
    const cancel = () => {
      if (input.taskId) void this.inference.cancelPage(input.taskId).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await this.dlssnr.applyPageFile(input, session);
      if (!result.ok) throw new RenditionError(result.error.code, result.error.message, result.error.retryable);
      if (!result.value) return undefined;
      const { lease, contentHash } = result.value;
      const release = () => { void getNativeComputeRepository().releaseArtifact(lease.leaseId).catch(() => undefined); };
      if (signal.aborted) {
        release();
        throw new DOMException('Aborted', 'AbortError');
      }
      return cache.adopt(identity, {
        url: lease.url, bytes: lease.byteLength, estimatedDecodedBytes: lease.estimatedDecodedBytes,
        leaseId: lease.leaseId, contentHash, release,
      });
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  store(_identity: ImageCacheIdentity, _data: CachedImageData): Promise<void> {
    return Promise.resolve();
  }
}

function dlssnrPageRequest(identity: ImageCacheIdentity): Parameters<NativeDlssnrRepository['applyPage']>[0] {
  const { source, passes } = parseDlssnrTransform(identity.transform);
  return {
    scopeId: identity.scopeId,
    archiveId: identity.archiveId,
    pageIndex: identity.pageIndex,
    source,
    ...(identity.modelId ? { upscaleModel: identity.modelId } : {}),
    ...(identity.outputScale !== undefined ? { upscaleOutputScale: identity.outputScale } : {}),
    ...(identity.taskId ? { taskId: identity.taskId } : {}),
    ...(identity.priority ? { priority: identity.priority } : {}),
    settings: { passes: parseDlssnrPasses(passes) },
  };
}

const readerCacheAdapter = new NativeImageCacheAdapter();
let sharedCache: UnifiedImageCache | undefined;

export async function loadRemoteReaderPage(identity: ImageCacheIdentity, signal: AbortSignal): Promise<ImageHandle> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const cache = getNativeImageCache();
  return cache.peek(identity) ?? await readerCacheAdapter.loadRemoteFile(cache, identity, signal) ?? await cache.load(identity, { signal });
}

export async function loadDlssnrReaderPage(identity: ImageCacheIdentity, signal: AbortSignal): Promise<ImageHandle> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const cache = getNativeImageCache();
  return cache.peek(identity) ?? await readerCacheAdapter.loadDlssnrFile(cache, identity, signal) ?? await cache.load(identity, { signal });
}

export function getNativeImageCache(): UnifiedImageCache {
  sharedCache ??= new UnifiedImageCache(readerCacheAdapter, {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    maxBytes: 96 * 1024 * 1024,
    maxEntries: 256,
  });
  return sharedCache;
}

/** `dlssnr` 那一版的起点与层参数（也构成它的缓存键）。 */
export function dlssnrTransform(source: DlssnrSource, passes: string): string {
  return JSON.stringify({ source, passes });
}

function parseDlssnrTransform(transform: string | undefined): { source: DlssnrSource; passes: string } {
  const fallback = { source: 'reader-page' as DlssnrSource, passes: '' };
  if (!transform) return fallback;
  try {
    const parsed = JSON.parse(transform) as { source?: DlssnrSource; passes?: string };
    return {
      source: parsed.source === 'enhanced' ? parsed.source : 'reader-page',
      passes: typeof parsed.passes === 'string' ? parsed.passes : '',
    };
  } catch {
    return fallback;
  }
}

export type DlssnrSource = 'reader-page' | 'enhanced';

/** `remote` 那一版的全部处理参数（同样进缓存键）。
 *
 *  `chain` 是这一页要做的**哪几档**（按顺序），由阅读器里开着的服务决定；**模型与参数不
 *  在这里**——那两样跟着对面那份设置走，本机只说「做什么」。所以同一台设备、同一起点、
 *  同一串服务算出来的版本就是同一份，缓存键里少的是所有会漂移的东西。 */
export function remoteTransform(input: {
  device: string;
  source: DlssnrSource;
  chain: readonly string[];
  /** 服务端配置版本（能力清单给的那一版，与单次请求的计划版本分开）。
   *
   *  模型内容、归一化参数、执行政策、DLL 内容都算进这一版；链顺序由 chain 单独表示。对面换了模型权重
   *  或换了一层参数，同一台设备、同一起点、同一串服务就是**另一版**，键也就跟着变。
   *  它不是凭据（是哈希），所以进键不进日志。 */
  revision: string;
}): string {
  return JSON.stringify(input);
}

function parseRemoteOpsTransform(transform: string | undefined): {
  device: string;
  source: DlssnrSource;
  chain: string[];
  revision: string;
} {
  const fallback = { device: '', source: 'reader-page' as DlssnrSource, chain: ['upscale'], revision: '' };
  if (!transform) return fallback;
  try {
    const parsed = JSON.parse(transform) as { device?: unknown; source?: unknown; chain?: unknown; revision?: unknown };
    return {
      device: typeof parsed.device === 'string' ? parsed.device : '',
      source: parsed.source === 'enhanced' ? parsed.source : 'reader-page',
      chain: Array.isArray(parsed.chain) ? parsed.chain.filter((step): step is string => typeof step === 'string') : fallback.chain,
      revision: typeof parsed.revision === 'string' ? parsed.revision : '',
    };
  } catch {
    return fallback;
  }
}
