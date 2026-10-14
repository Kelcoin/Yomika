import { z } from 'zod';
import { invokeBinaryCommand, invokeCommand } from '../bridge/invoke';
import { detectImageMime } from '../lib/imageData';
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
    dlssnr: CacheBreakdownSchema.default({ bytes: 0, entries: 0 }),
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
/** 读出来的图。字节的类型是 `Uint8Array<ArrayBuffer>`（不是 `ArrayBufferLike`）：它们
 * 直接来自 IPC 回包的 ArrayBuffer，`Blob` 只接受真的 ArrayBuffer，写宽了就得再拷一份。 */
export interface NativeCachedImage { bytes: Uint8Array<ArrayBuffer>; mime: string; }

export interface CacheEvictionInput { maxBytes: number; batchLimit: number; }
export type CacheEvictionResult = z.infer<typeof CacheEvictionResultSchema>;
export type CacheStats = z.infer<typeof CacheStatsSchema>;
export type CacheClearResult = z.infer<typeof CacheClearResultSchema>;
export type CacheInvalidateResult = z.infer<typeof CacheInvalidateResultSchema>;

export class NativeCacheRepository {
  /** 命中的图是**二进制体**，不是 JSON 信封。
   *
   * 一页 1.5MB 的 JPEG 走 JSON 就是上百万个数字，前端要用 zod 逐个校验，实测每次
   * 命中在主线程上留下一个 200–280ms 的 long task——阅读器一次开三页，那几秒里加载
   * 动画一顿一顿的（详情页封面、书架封面走的是同一条路，只是图小、看不出来）。
   * 空体就是没有这一条：图片不会是 0 字节，空缓存文件也算没命中，会去重新取。
   * mime 由字节自己认，同一条字节流不再多带一个字段。 */
  async readImage(identity: ImageCacheIdentity): Promise<CommandResult<NativeCachedImage | null>> {
    const result = await invokeBinaryCommand('cache_read_image', { identity });
    if (!result.ok) return result;
    const bytes = new Uint8Array(result.value);
    if (bytes.byteLength === 0) return { ok: true, value: null };
    return { ok: true, value: { bytes, mime: detectImageMime(bytes) } };
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
  /**
   * 清掉一次阅读会话的「成品」（超分 / DLSSNR 的产物）。
   *
   * 这些产物只在本次阅读会话里有意义：真机上 2.84 GiB 的 DLSSNR 产物把 4 GiB 的配额
   * 吃到 90%，LRU 只好去挤别人的封面。进出阅读器各清一次，别指望配额。
   *
   * **必须带上是哪一本**：两本阅读器可以同时挂在保留里（`MAX_RETAINED_READERS = 2`），
   * 不带范围就会把另一本的产物一起删掉；宿主也会拒收空范围。
   */
  purgeReaderRenditions(scopeId: string, archiveId: string): Promise<CommandResult<CacheInvalidateResult>> {
    return invokeCommand('cache_purge_reader_renditions', { scopeId, archiveId }, CacheInvalidateResultSchema);
  }
}
