import { z } from 'zod';
import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

const CacheEvictionResultSchema = z.object({
  removedEntries: z.number().int().nonnegative(),
  removedFiles: z.number().int().nonnegative(),
  bytesFreed: z.number().int().nonnegative(),
  remainingBytes: z.number().int().nonnegative(),
  quotaSatisfied: z.boolean(),
  hasMore: z.boolean(),
});

export interface CacheEvictionInput { maxBytes: number; batchLimit: number; }
export type CacheEvictionResult = z.infer<typeof CacheEvictionResultSchema>;

export class NativeCacheRepository {
  evict(input: CacheEvictionInput): Promise<CommandResult<CacheEvictionResult>> {
    return invokeCommand('cache_evict', { input }, CacheEvictionResultSchema);
  }
}
