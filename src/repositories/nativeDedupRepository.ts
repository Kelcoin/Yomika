import { z } from 'zod';
import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import { ok, type CommandResult } from '../domain/result';
import { NativeLrrBridgeRepository } from './nativeLrrBridgeRepository';
const hostedBridge = new NativeLrrBridgeRepository();

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
  stage: z.enum(['enumerating', 'covers', 'waiting-covers', 'comparing', 'completed', 'cancelled']), processed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
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
  saved: z.boolean().optional().default(true),
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
  async startScan(input: DedupStartScanInput) {
    const refreshed = await this.refreshHostedMarks(input.scopeId);
    if (!refreshed.ok) return refreshed;
    return invokeCommand('dedup_start_scan', { input }, DedupScanSessionSchema);
  }
  scanChunk(input: DedupScanChunkInput) { return invokeCommand('dedup_scan_chunk', { input }, DedupScanSessionSchema); }
  /** 待删选择：走独立命令，已完成的会话也能改（scan_chunk 只收运行中的会话）。 */
  saveSelection(sessionId: string, selectedArchiveIds: string[]) {
    return invokeCommand('dedup_save_selection', { sessionId, selectedArchiveIds }, VoidResponseSchema);
  }
  async scan(input: DedupScanInput): Promise<CommandResult<DedupScanProgress>> {
    const refreshed = await this.refreshHostedMarks(input.scopeId);
    if (!refreshed.ok) return refreshed;
    return invokeCommand('dedup_scan', { input }, DedupScanProgressSchema);
  }
  /** 扫描期间画进度条用；会话没在跑时后端回 null。 */
  scanProgress(sessionId: string): Promise<CommandResult<DedupScanProgress | null>> {
    return invokeCommand('dedup_scan_progress', { sessionId }, DedupScanProgressSchema.nullable());
  }
  listSessions(scopeId: string, includeUnsaved = false): Promise<CommandResult<DedupSessionSummary[]>> {
    return invokeCommand('dedup_list_sessions', { scopeId, ...(includeUnsaved ? { includeUnsaved: true } : {}) }, z.array(DedupSessionSummarySchema));
  }
  saveSession(sessionId: string): Promise<CommandResult<void>> {
    return invokeCommand('dedup_save_session', { sessionId }, VoidResponseSchema);
  }
  deleteSession(sessionId: string): Promise<CommandResult<void>> {
    return invokeCommand('dedup_delete_session', { sessionId }, VoidResponseSchema);
  }
  cancelScan(sessionId: string) { return invokeCommand('dedup_cancel_scan', { sessionId }, DedupScanSessionSchema); }
  resumeScan(sessionId: string) { return invokeCommand('dedup_resume_scan', { sessionId }, DedupScanSessionSchema); }
  loadResult(sessionId: string, refreshIndex = false) { return invokeCommand('dedup_load_result', { sessionId, ...(refreshIndex ? { refreshIndex: true } : {}) }, DedupLoadResultSchema); }
  private async refreshHostedMarks(scopeId: string): Promise<CommandResult<void>> {
    const config = await hostedBridge.config(scopeId);
    if (!config.ok) return config;
    if (!config.value.enabled) return ok(undefined);
    const result = await hostedBridge.collectionList(scopeId, 'non_duplicates');
    return result.ok ? ok(undefined) : result;
  }
  async saveNonDuplicate(input: DedupNonDuplicateInput) {
    const result = await invokeCommand('dedup_save_non_duplicate', { input }, VoidResponseSchema);
    if (result.ok) await this.notifyHostedWrite(input.scopeId);
    return result;
  }
  /** Native writes queue per-record hosted operations atomically with the local mirror. */
  async saveNonDuplicates(entries: DedupNonDuplicateInput[]): Promise<CommandResult<boolean[]>> {
    const result = await invokeCommand('dedup_save_non_duplicates', { input: { entries } }, z.array(z.boolean()));
    if (result.ok) for (const scopeId of new Set(entries.filter((_, i) => result.value[i]).map(entry => entry.scopeId))) await this.notifyHostedWrite(scopeId);
    return result;
  }
  async removeNonDuplicate(input: DedupNonDuplicateInput) {
    const result = await invokeCommand('dedup_remove_non_duplicate', { input }, VoidResponseSchema);
    if (result.ok) await this.notifyHostedWrite(input.scopeId);
    return result;
  }
  private async notifyHostedWrite(scopeId: string) {
    const config = await hostedBridge.config(scopeId);
    if (config.ok && config.value.enabled) window.dispatchEvent(new CustomEvent('yomika:lrr-bridge-write', { detail: { scopeId, kind: 'non_duplicates' } }));
  }
  listCachedNonDuplicates(scopeId: string): Promise<CommandResult<DedupNonDuplicateRecord[]>> {
    return invokeCommand('dedup_list_non_duplicates', { scopeId }, z.array(DedupNonDuplicateRecordSchema));
  }
  async listNonDuplicates(scopeId: string): Promise<CommandResult<DedupNonDuplicateRecord[]>> {
    const refreshed = await this.refreshHostedMarks(scopeId);
    if (!refreshed.ok) return refreshed;
    return invokeCommand('dedup_list_non_duplicates', { scopeId }, z.array(DedupNonDuplicateRecordSchema));
  }
  async deleteSelected(input: { sessionId: string; outcomes?: DedupDeletionOutcomeInput[] }, syncFavorite = false, onProgress?: (progress: { processed: number; total: number }) => void) {
    let onProgressChannel;
    if ('__TAURI_INTERNALS__' in window) {
      const { Channel } = await import('@tauri-apps/api/core');
      onProgressChannel = new Channel<unknown>();
      onProgressChannel.onmessage = (value) => {
        const parsed = z.object({ processed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).safeParse(value);
        if (parsed.success) onProgress?.(parsed.data);
      };
    }
    return invokeCommand('dedup_delete_selected', { input: { ...input, outcomes: input.outcomes ?? [] }, syncFavorite, ...(onProgressChannel ? { onProgress: onProgressChannel } : {}) }, DedupDeleteResultSchema);
  }
}
