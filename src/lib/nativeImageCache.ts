import type { ImageCacheIdentity } from '../domain/cache';
import { NativeCacheRepository } from '../repositories/nativeCacheRepository';
import { NativeInferenceRepository } from '../repositories/nativeInferenceRepository';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { detectImageMime } from './imageData';
import type { CachedImageData, ImageCacheRepository } from './unifiedImageCache';
import { UnifiedImageCache } from './unifiedImageCache';

export class NativeImageCacheAdapter implements ImageCacheRepository {
  constructor(
    private readonly cache = new NativeCacheRepository(),
    private readonly library = new NativeLibraryRepository(),
    private readonly inference = new NativeInferenceRepository(),
  ) {}

  async read(identity: ImageCacheIdentity): Promise<CachedImageData | null> {
    const result = await this.cache.readImage(identity);
    if (!result.ok) return null;
    return result.value;
  }

  async fetch(identity: ImageCacheIdentity, signal?: AbortSignal): Promise<CachedImageData> {
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
