import { z } from 'zod';
import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';
import { parseReadoshiNonDuplicateExport, type ReadoshiImportReport } from '../lib/readoShiDedupeImport';

const DedupCheckResultSchema = z.object({ hash: z.string(), size: z.number() });

const DedupFeatureRecordSchema = z.object({
  scopeId: z.string(),
  path: z.string(),
  exactHash: z.string(),
  dhash: z.string().nullable().optional(),
  algorithmVersion: z.string(),
  size: z.number(),
});

const DedupScanSessionSchema = z.object({
  sessionId: z.string().min(1), scopeId: z.string().min(1), algorithmVersion: z.string().min(1),
  status: z.enum(['running', 'cancelled', 'completed']), checkpoint: z.number().int().nonnegative(), archiveCount: z.number().int().nonnegative(),
});
const DedupArchiveSnapshotSchema = z.object({
  archiveId: z.string().min(1), path: z.string().min(1), title: z.string().nullable().optional(),
  pageCount: z.number().int().nonnegative().nullable().optional(), size: z.number().int().nonnegative().nullable().optional(), featureVersion: z.string().min(1),
});
const DedupPairSchema = z.object({
  leftArchiveId: z.string().min(1), rightArchiveId: z.string().min(1), source: z.string().min(1), diagnostics: z.unknown().nullable().optional(),
});
const DedupOutcomeSchema = z.object({ archiveId: z.string().min(1), deleted: z.boolean(), message: z.string().nullable().optional() });
const DedupLoadResultSchema = z.object({
  session: DedupScanSessionSchema, archives: z.array(DedupArchiveSnapshotSchema), pairs: z.array(DedupPairSchema),
  selectedArchiveIds: z.array(z.string().min(1)), outcomes: z.array(DedupOutcomeSchema),
});
export type DedupLoadResult = z.infer<typeof DedupLoadResultSchema>;
const DedupDeleteResultSchema = z.object({ rejectedArchiveIds: z.array(z.string().min(1)), outcomes: z.array(DedupOutcomeSchema) });
export type DedupStartScanInput = { sessionId: string; scopeId: string; algorithmVersion: string; archiveCount: number };
export type DedupScanInput = {
  sessionId: string;
  scopeId: string;
  algorithmVersion: string;
  startDate?: string | null;
  endDate?: string | null;
  chunkSize?: number | null;
};
export type DedupScanChunkInput = {
  sessionId: string;
  algorithmVersion: string;
  checkpoint: number;
  archives: z.infer<typeof DedupArchiveSnapshotSchema>[];
  pairs: DedupPairInput[];
  selectedArchiveIds: string[];
};
export const DedupScanProgressSchema = z.object({
  sessionId: z.string().min(1), scopeId: z.string().min(1),
  status: z.enum(['running', 'cancelled', 'completed']),
  stage: z.enum(['enumerating', 'covers', 'comparing', 'completed', 'cancelled']), processed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(), downloads: z.number().int().nonnegative(),
  missingCovers: z.number().int().nonnegative(), invalidCovers: z.number().int().nonnegative(),
  pairCount: z.number().int().nonnegative(), degraded: z.boolean(), checkpoint: z.number().int().nonnegative(),
  diagnostics: z.array(z.string()), pairs: z.array(DedupPairSchema),
});
export type DedupScanProgress = z.infer<typeof DedupScanProgressSchema>;
export type DedupPairInput = z.infer<typeof DedupPairSchema>;
const DedupNonDuplicateRecordSchema = z.object({
  pairKey: z.string().min(1),
  leftArchiveId: z.string().min(1),
  rightArchiveId: z.string().min(1),
  tombstoned: z.boolean(),
});
const DedupSessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  scopeId: z.string().min(1),
  status: z.enum(['running', 'cancelled', 'completed']),
  archiveCount: z.number().int().nonnegative(),
  pairCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** 已落库的扫描结果（保存/读取扫描结果用）：会话本身一直是持久的，这份摘要
 * 让工作区能把它们列出来重新载入。 */
export type DedupSessionSummary = z.infer<typeof DedupSessionSummarySchema>;
export type DedupNonDuplicateRecord = z.infer<typeof DedupNonDuplicateRecordSchema>;
export type DedupNonDuplicateInput = { scopeId: string; leftArchiveId: string; rightArchiveId: string };
export type DedupDeletionOutcomeInput = z.infer<typeof DedupOutcomeSchema>;

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
  async saveFeature(input: DedupSaveFeatureInput): Promise<CommandResult<void>> {
    const result = await invokeCommand('dedup_save_feature', { input }, z.null());
    return result.ok ? { ok: true, value: undefined } : result;
  }
  findExact(scopeId: string, exactHash: string): Promise<CommandResult<z.infer<typeof DedupFeatureRecordSchema>[]>> {
    return invokeCommand('dedup_find_exact', { scopeId, exactHash }, z.array(DedupFeatureRecordSchema));
  }
  startScan(input: DedupStartScanInput) { return invokeCommand('dedup_start_scan', { input }, DedupScanSessionSchema); }
  scanChunk(input: DedupScanChunkInput) { return invokeCommand('dedup_scan_chunk', { input }, DedupScanSessionSchema); }
  /** 待删选择：走独立命令，已完成的会话也能改（scan_chunk 只收运行中的会话）。 */
  saveSelection(sessionId: string, selectedArchiveIds: string[]) {
    return invokeCommand('dedup_save_selection', { sessionId, selectedArchiveIds }, VoidResponseSchema);
  }
  scan(input: DedupScanInput): Promise<CommandResult<DedupScanProgress>> { return invokeCommand('dedup_scan', { input }, DedupScanProgressSchema); }
  /** 扫描期间画进度条用；会话没在跑时后端回 null。 */
  scanProgress(sessionId: string): Promise<CommandResult<DedupScanProgress | null>> {
    return invokeCommand('dedup_scan_progress', { sessionId }, DedupScanProgressSchema.nullable());
  }
  listSessions(scopeId: string): Promise<CommandResult<DedupSessionSummary[]>> {
    return invokeCommand('dedup_list_sessions', { scopeId }, z.array(DedupSessionSummarySchema));
  }
  deleteSession(sessionId: string): Promise<CommandResult<void>> {
    return invokeCommand('dedup_delete_session', { sessionId }, VoidResponseSchema);
  }
  cancelScan(sessionId: string) { return invokeCommand('dedup_cancel_scan', { sessionId }, DedupScanSessionSchema); }
  resumeScan(sessionId: string) { return invokeCommand('dedup_resume_scan', { sessionId }, DedupScanSessionSchema); }
  loadResult(sessionId: string) { return invokeCommand('dedup_load_result', { sessionId }, DedupLoadResultSchema); }
  saveNonDuplicate(input: DedupNonDuplicateInput) { return invokeCommand('dedup_save_non_duplicate', { input }, VoidResponseSchema); }
  removeNonDuplicate(input: DedupNonDuplicateInput) { return invokeCommand('dedup_remove_non_duplicate', { input }, VoidResponseSchema); }
  importReadoshi(input: { scopeId: string; pairs: DedupPairInput[] }) { return invokeCommand('dedup_import_readoshi', { input }, VoidResponseSchema); }
  listNonDuplicates(scopeId: string): Promise<CommandResult<DedupNonDuplicateRecord[]>> {
    return invokeCommand('dedup_list_non_duplicates', { scopeId }, z.array(DedupNonDuplicateRecordSchema));
  }
  importReadoshiExport(scopeId: string, input: unknown): Promise<CommandResult<ReadoshiImportReport>> {
    let report: ReadoshiImportReport;
    try { report = parseReadoshiNonDuplicateExport(input, scopeId); }
    catch (error) {
      return Promise.resolve({ ok: false, error: { code: 'INVALID_RESPONSE', message: error instanceof Error ? error.message : '无效的 Readoshi 导入数据', retryable: false } });
    }
    return this.importReadoshi({ scopeId, pairs: report.pairs }).then((result) => result.ok ? { ok: true, value: report } : result as CommandResult<ReadoshiImportReport>);
  }
  deleteSelected(input: { sessionId: string; outcomes?: DedupDeletionOutcomeInput[] }, syncFavorite = false) {
    return invokeCommand('dedup_delete_selected', { input: { ...input, outcomes: input.outcomes ?? [] }, syncFavorite }, DedupDeleteResultSchema);
  }
}
