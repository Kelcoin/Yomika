import type { ImageCacheIdentity } from '../domain/cache';
import { NativeCacheRepository } from '../repositories/nativeCacheRepository';
import { NativeComputeCenterRepository } from '../repositories/nativeComputeCenterRepository';
import { NativeDlssnrRepository, parseDlssnrPasses } from '../repositories/nativeDlssnrRepository';
import { NativeInferenceRepository } from '../repositories/nativeInferenceRepository';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSettingsRepository } from '../repositories/nativeSettingsRepository';
import { logError } from './errorLog';
import { detectImageMime } from './imageData';
import type { CachedImageData, ImageCacheRepository } from './unifiedImageCache';
import { UnifiedImageCache } from './unifiedImageCache';

/** 阅读器那几版渲染：它们的失败**没有别的出口**——阅读器把每一页的错误都咽掉
 * （失败只体现为「这一页没换」），所以不在这里记一笔，用户报「去码/超分没反应」
 * 时错误日志里就什么都没有。封面、缩略图不记：那些的原生失败本来就由桥接记录。 */
const READER_RENDITIONS: readonly string[] = ['reader-page', 'enhanced', 'decensored', 'dlssnr', 'remote'];

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
      || identity.rendition === 'decensored'
      || identity.rendition === 'dlssnr'
      || identity.rendition === 'remote'
    ) return null;
    const result = await this.cache.readImage(identity);
    if (!result.ok) return null;
    return result.value;
  }

  async fetch(identity: ImageCacheIdentity, signal?: AbortSignal): Promise<CachedImageData> {
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
    // `enhanced` 与 `decensored` 这两版**不从这里走**：它们现在整条都由 compute 那条链产出
    // （`loadLocalRenditions` 提交宿主任务、把产物认领进这张账），从这里再往外开一道
    // 「宿主在进程里跑模型」的旧门正是 8-g 要拆掉的东西。
    //
    // 这里点名拦一道不是因为不拦就危险（不拦会掉到下面那句 `Unsupported image request`），
    // 而是因为那句话什么也没说：真出了这种事（谁又按这两版来读图），日志里要写清楚这两版
    // 归谁管。
    if (identity.rendition === 'enhanced' || identity.rendition === 'decensored') {
      throw new Error(`${identity.rendition} is produced by compute, not by the image cache`);
    }
    if (identity.rendition === 'dlssnr') {
      // DLSSNR：起点由 `transform` 说明（本地去码/超分跑过就从它们的产物接着跑），
      // 层参数也在里面——它同时是缓存键的一部分，改参数就拿不到旧结果。起点是按
      // 「产出它的模型」存的，两个模型 id 一并送过去。
      const { source, passes } = parseDlssnrTransform(identity.transform);
      const processed = await this.dlssnr.applyPage({
        scopeId: identity.scopeId,
        archiveId: identity.archiveId,
        pageIndex: identity.pageIndex,
        source,
        ...(identity.decensorModelId ? { decensorModel: identity.decensorModelId } : {}),
        ...(identity.modelId ? { upscaleModel: identity.modelId } : {}),
        ...(identity.taskId ? { taskId: identity.taskId } : {}),
        ...(identity.priority ? { priority: identity.priority } : {}),
        settings: { passes: parseDlssnrPasses(passes) },
      });
      if (!processed.ok) throw new Error(processed.error.message);
      const bytes = new Uint8Array(processed.value);
      return { bytes, mime: detectImageMime(bytes) };
    }
    if (identity.rendition === 'remote') {
      // 远端算力：地址与令牌是「这台机器怎么找到对面」，不进缓存键（键里放凭据
      // 等于把它写进日志）；处理参数在 `transform` 里，键就跟着它走。
      const remote = parseRemoteOpsTransform(identity.transform);
      const loaded = await this.settings.load();
      if (!loaded.ok) throw new Error(loaded.error.message);
      const processed = await this.compute.remoteProcess({
        url: loaded.value.remoteComputeUrl,
        token: loaded.value.remoteComputeToken,
        // `op` 是 Rust 侧那个必填字段，拿串首顶上去；真正决定做哪几档的是 `chain`。
        // 模型、放大倍数、DLSSNR 层参数一律不发：对面按自己的设置跑。
        params: { op: remote.chain[0] ?? 'upscale', chain: remote.chain },
        scopeId: identity.scopeId,
        archiveId: identity.archiveId,
        pageIndex: identity.pageIndex,
        source: remote.source,
        ...(identity.decensorModelId ? { decensorModel: identity.decensorModelId } : {}),
        ...(identity.modelId ? { upscaleModel: identity.modelId } : {}),
        ...(identity.taskId ? { taskId: identity.taskId } : {}),
        // 远端有自己的队列（不占本机 GPU 那一件），档位管的是远端任务之间谁先走：
        // 当前页插到整本预扫前面。
        ...(identity.priority ? { priority: identity.priority } : {}),
      });
      if (!processed.ok) throw new Error(processed.error.message);
      const bytes = new Uint8Array(processed.value);
      return { bytes, mime: detectImageMime(bytes) };
    }
    const result = identity.rendition === 'cover'
      ? await this.library.loadArchiveThumbnail(identity.serverId, identity.archiveId)
      : identity.rendition === 'page-thumbnail'
        ? await this.library.loadArchivePageThumbnail(identity.serverId, identity.archiveId, identity.pageIndex + 1)
        : identity.rendition === 'reader-page' && identity.sourcePath
          ? await this.library.loadReaderPage(identity.serverId, identity.archiveId, identity.pageIndex, identity.sourcePath)
          : undefined;
    if (!result) throw new Error('Unsupported image request');
    if (!result.ok) throw new Error(result.error.message);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const bytes = new Uint8Array(result.value);
    return { bytes, mime: detectImageMime(bytes) };
  }

  store(_identity: ImageCacheIdentity, _data: CachedImageData): Promise<void> {
    return Promise.resolve();
  }
}

let sharedCache: UnifiedImageCache | undefined;

export function getNativeImageCache(): UnifiedImageCache {
  sharedCache ??= new UnifiedImageCache(new NativeImageCacheAdapter(), {
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
      source: parsed.source === 'enhanced' || parsed.source === 'decensored' ? parsed.source : 'reader-page',
      passes: typeof parsed.passes === 'string' ? parsed.passes : '',
    };
  } catch {
    return fallback;
  }
}

export type DlssnrSource = 'reader-page' | 'decensored' | 'enhanced';

/** `remote` 那一版的全部处理参数（同样进缓存键）。
 *
 *  `chain` 是这一页要做的**哪几档**（按顺序），由阅读器里开着的服务决定；**模型与参数不
 *  在这里**——那两样跟着对面那份设置走，本机只说「做什么」。所以同一台设备、同一起点、
 *  同一串服务算出来的版本就是同一份，缓存键里少的是所有会漂移的东西。 */
export function remoteTransform(input: {
  device: string;
  source: DlssnrSource;
  chain: readonly string[];
}): string {
  return JSON.stringify(input);
}

function parseRemoteOpsTransform(transform: string | undefined): {
  device: string;
  source: DlssnrSource;
  chain: string[];
} {
  const fallback = { device: '', source: 'reader-page' as DlssnrSource, chain: ['upscale'] };
  if (!transform) return fallback;
  try {
    const parsed = JSON.parse(transform) as { device?: unknown; source?: unknown; chain?: unknown };
    return {
      device: typeof parsed.device === 'string' ? parsed.device : '',
      source: parsed.source === 'enhanced' || parsed.source === 'decensored' ? parsed.source : 'reader-page',
      chain: Array.isArray(parsed.chain) ? parsed.chain.filter((step): step is string => typeof step === 'string') : fallback.chain,
    };
  } catch {
    return fallback;
  }
}
