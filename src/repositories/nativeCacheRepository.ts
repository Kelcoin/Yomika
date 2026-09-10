import { z } from 'zod';
import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';
import type { ImageCacheIdentity } from '../domain/cache';

const CacheEvictionResultSchema = z.object({
  removedEntries: z.number().int().nonnegative(),
  removedFiles: z.number().int().nonnegative(),
  bytesFreed: z.number().int().nonnegative(),
  remainingBytes: z.number().int().nonnegative(),
  quotaSatisfied: z.boolean(),
  hasMore: z.boolean(),
});
const CacheBreakdownSchema = z.object({ bytes: z.number().int().nonnegative(), entries: z.number().int().nonnegative() });
const CacheStatsSchema = z.object({
  bytes: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  byRendition: z.object({
    cover: CacheBreakdownSchema,
    'page-thumbnail': CacheBreakdownSchema,
    'reader-page': CacheBreakdownSchema,
    enhanced: CacheBreakdownSchema.default({ bytes: 0, entries: 0 }),
    decensored: CacheBreakdownSchema.default({ bytes: 0, entries: 0 }),
    inference: CacheBreakdownSchema.default({ bytes: 0, entries: 0 }),
    other: CacheBreakdownSchema,
  }),
});
const CacheClearResultSchema = z.object({
  removedEntries: z.number().int().nonnegative(),
  removedFiles: z.number().int().nonnegative(),
  bytesFreed: z.number().int().nonnegative(),
  protectedBytes: z.number().int().nonnegative(),
});
const CacheInvalidateResultSchema = z.object({
  removedEntries: z.number().int().nonnegative(),
  removedFiles: z.number().int().nonnegative(),
  bytesFreed: z.number().int().nonnegative(),
});
const CachedImageSchema = z.object({
  bytes: z.array(z.number().int().min(0).max(255)),
  mime: z.string().min(1),
});

export interface NativeCachedImage { bytes: Uint8Array; mime: string; }

export interface CacheEvictionInput { maxBytes: number; batchLimit: number; }
export type CacheEvictionResult = z.infer<typeof CacheEvictionResultSchema>;
export type CacheStats = z.infer<typeof CacheStatsSchema>;
export type CacheClearResult = z.infer<typeof CacheClearResultSchema>;
export type CacheInvalidateResult = z.infer<typeof CacheInvalidateResultSchema>;

export class NativeCacheRepository {
  async readImage(identity: ImageCacheIdentity): Promise<CommandResult<NativeCachedImage | null>> {
    const result = await invokeCommand('cache_read_image', { identity }, CachedImageSchema.nullable());
    if (!result.ok) return result;
    if (!result.value) return { ok: true, value: null };
    return { ok: true, value: { bytes: new Uint8Array(result.value.bytes), mime: result.value.mime } };
  }
  async storeImage(identity: ImageCacheIdentity, image: NativeCachedImage): Promise<CommandResult<void>> {
    const result = await invokeCommand('cache_store_image', {
      input: { identity, mime: image.mime, bytes: Array.from(image.bytes) },
    }, z.null());
    return result.ok ? { ok: true, value: undefined } : result;
  }
  stats(): Promise<CommandResult<CacheStats>> {
    return invokeCommand('cache_stats', {}, CacheStatsSchema);
  }
  evict(input: CacheEvictionInput): Promise<CommandResult<CacheEvictionResult>> {
    return invokeCommand('cache_evict', { input }, CacheEvictionResultSchema);
  }
  clearImages(): Promise<CommandResult<CacheClearResult>> {
    return invokeCommand('cache_clear_images', {}, CacheClearResultSchema);
  }
  invalidateArchive(scopeId: string, archiveId: string): Promise<CommandResult<CacheInvalidateResult>> {
    return invokeCommand('cache_invalidate_archive', { scopeId, archiveId }, CacheInvalidateResultSchema);
  }
}
