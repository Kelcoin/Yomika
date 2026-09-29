import type { ImageCacheIdentity } from '../domain/cache';
import { NativeCacheRepository } from '../repositories/nativeCacheRepository';
import { NativeComputeCenterRepository, parseRemoteOps } from '../repositories/nativeComputeCenterRepository';
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
    }
  }

  private async load(identity: ImageCacheIdentity, signal?: AbortSignal): Promise<CachedImageData> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!identity.serverId) throw new Error('Image request is missing a server ID');
    if (identity.rendition === 'enhanced') {
      // Upscaling reads the cached reader page, so the plain rendition has to be
      // loaded first; a miss here simply leaves the reader on the plain page.
      const upscaled = await this.inference.upscalePage({
        scopeId: identity.scopeId,
        archiveId: identity.archiveId,
        pageIndex: identity.pageIndex,
        ...(identity.modelId ? { modelId: identity.modelId } : {}),
        // Present when de-censoring is also on: the upscaler then reads the
        // de-censored page, so the regions are filled at the scale the models were
        // trained on and the finished page is what gets enlarged.
        ...(identity.decensorModelId ? { decensorModel: identity.decensorModelId } : {}),
      });
      if (!upscaled.ok) throw new Error(upscaled.error.message);
      const bytes = new Uint8Array(upscaled.value);
      return { bytes, mime: detectImageMime(bytes) };
    }
    if (identity.rendition === 'dlssnr') {
      // DLSS5：起点由 `transform` 说明（本地超分/去码跑过就从它们的产物接着跑），
      // 层参数也在里面——它同时是缓存键的一部分，改参数就拿不到旧结果。
      const { source, passes } = parseDlssnrTransform(identity.transform);
      const processed = await this.dlssnr.applyPage({
        scopeId: identity.scopeId,
        archiveId: identity.archiveId,
        pageIndex: identity.pageIndex,
        source,
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
      const ops = parseRemoteOps(loaded.value.remoteComputeOps);
      const processed = await this.compute.remoteProcess({
        url: loaded.value.remoteComputeUrl,
        token: loaded.value.remoteComputeToken,
        params: {
          op: remote.op,
          ...(remote.modelId ? { modelId: remote.modelId } : {}),
          ...(remote.scale ? { scale: remote.scale } : {}),
          ...(remote.op === 'dlssnr' && remote.passes.length > 0
            ? { dlssnr: { passes: parseDlssnrPasses(remote.passes) } }
            : {}),
        },
        scopeId: identity.scopeId,
        archiveId: identity.archiveId,
        pageIndex: identity.pageIndex,
        source: remote.source,
      });
      if (!processed.ok) throw new Error(processed.error.message);
      const bytes = new Uint8Array(processed.value);
      return { bytes, mime: detectImageMime(bytes) };
    }
    if (identity.rendition === 'decensored') {
      // Reads the cached reader page too, and needs a bundle: a missing one is an
      // error rather than a silent pass-through, since the reader would otherwise
      // show the censored page while the setting claims otherwise.
      const filled = await this.inference.decensorPage({
        scopeId: identity.scopeId,
        archiveId: identity.archiveId,
        pageIndex: identity.pageIndex,
        modelId: identity.modelId ?? '',
      });
      if (!filled.ok) throw new Error(filled.error.message);
      const bytes = new Uint8Array(filled.value);
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

/** `remote` 那一版的全部处理参数（同样进缓存键）。 */
export function remoteTransform(input: {
  source: DlssnrSource;
  op: string;
  modelId: string;
  scale: number;
  passes: string;
}): string {
  return JSON.stringify(input);
}

function parseRemoteOpsTransform(transform: string | undefined): {
  source: DlssnrSource;
  op: string;
  modelId: string;
  scale: number;
  passes: string;
} {
  const fallback = { source: 'reader-page' as DlssnrSource, op: 'upscale', modelId: '', scale: 2, passes: '' };
  if (!transform) return fallback;
  try {
    const parsed = JSON.parse(transform) as Partial<typeof fallback>;
    return {
      source: parsed.source === 'enhanced' || parsed.source === 'decensored' ? parsed.source : 'reader-page',
      op: typeof parsed.op === 'string' ? parsed.op : 'upscale',
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
      scale: typeof parsed.scale === 'number' ? parsed.scale : 2,
      passes: typeof parsed.passes === 'string' ? parsed.passes : '',
    };
  } catch {
    return fallback;
  }
}
