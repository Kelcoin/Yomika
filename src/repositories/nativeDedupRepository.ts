import { z } from 'zod';
import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

const DedupCheckResultSchema = z.object({ hash: z.string(), size: z.number() });

const DedupFeatureRecordSchema = z.object({
  scopeId: z.string(),
  path: z.string(),
  exactHash: z.string(),
  dhash: z.string().nullable().optional(),
  algorithmVersion: z.string(),
  size: z.number(),
});

export interface DedupSaveFeatureInput {
  scopeId: string;
  path: string;
  exactHash: string;
  dhash?: string;
  algorithmVersion: string;
  size: number;
}

export class NativeDedupRepository {
  checkFile(path: string): Promise<CommandResult<{ hash: string; size: number }>> {
    return invokeCommand('dedup_check_file', { path }, DedupCheckResultSchema);
  }
  saveFeature(input: DedupSaveFeatureInput): Promise<CommandResult<void>> {
    return invokeCommand('dedup_save_feature', { input }, z.undefined());
  }
  findExact(scopeId: string, exactHash: string): Promise<CommandResult<z.infer<typeof DedupFeatureRecordSchema>[]>> {
    return invokeCommand('dedup_find_exact', { scopeId, exactHash }, z.array(DedupFeatureRecordSchema));
  }
}
