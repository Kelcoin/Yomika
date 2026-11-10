import { z } from 'zod';
import { invokeCommand } from '../bridge/invoke';
import { err, ok, type CommandResult } from '../domain/result';
import type { ReadingProgress, ReadingHistoryRecord, WatchlistRecord } from '../domain/library';

const integer = z.number().int().nonnegative();
const ProgressSchema = z.object({
  pageIndex: integer, pageCount: integer, layout: z.enum(['paged', 'continuous']),
  direction: z.enum(['ltr', 'rtl']), coverAlone: z.boolean().nullable(), updatedAt: z.string().min(1),
}).strict();
export const LrrBridgeStateSchema = z.object({
  archiveId: z.string().min(1), version: integer, generation: integer,
  progress: ProgressSchema.nullable(), historyAt: z.string().nullable(), watchlistAt: z.string().nullable(),
}).strict();
export type LrrBridgeState = z.infer<typeof LrrBridgeStateSchema>;
export const LrrBridgeConfigSchema = z.object({
  enabled: z.boolean(), serverId: z.string().nullable().optional(), pending: integer, conflicts: integer,
}).strict();
export type LrrBridgeConfig = z.infer<typeof LrrBridgeConfigSchema>;
const envelope = { protocol: z.literal(1), serverId: z.string().min(1), epoch: z.string().min(1), version: integer };
const StatesSchema = z.object({ ...envelope, states: z.array(LrrBridgeStateSchema) });
const ListSchema = StatesSchema.extend({ total: integer });
const ApplySchema = z.object({ state: LrrBridgeStateSchema, queued: z.boolean(), conflict: z.boolean().optional() });
const WorkspaceSchema = z.object({ ...envelope,
  workspace: z.object({ key: z.string(), version: integer, value: z.unknown() }),
  errorCode: z.string().optional(),
});
export const BridgeCollectionRecordSchema = z.object({
  collection: z.enum(['search_presets', 'non_duplicates']), key: z.string().min(1), version: integer,
  value: z.unknown(), createdAt: z.string().nullable(), updatedAt: z.string().nullable(),
});
export type BridgeCollectionRecord = z.infer<typeof BridgeCollectionRecordSchema>;
export type BridgeCollection = BridgeCollectionRecord['collection'];
const configurations = new Map<string, Promise<CommandResult<LrrBridgeConfig>>>();
export const LRR_BRIDGE_CHANGED_EVENT = 'yomika:lrr-bridge-write';
function notifyBridge(scopeId: string, kind: string) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LRR_BRIDGE_CHANGED_EVENT, { detail: { scopeId, kind } }));
}
export async function getEnabledLrrBridgeScopes(): Promise<string[]> {
  const entries = await Promise.all([...configurations].map(async ([scopeId, request]) => {
    const result = await request;
    return result.ok && result.value.enabled ? scopeId : null;
  }));
  return entries.filter((scopeId): scopeId is string => scopeId !== null);
}
export function invalidateLrrBridgeConfig(scopeId?: string) {
  if (scopeId === undefined) configurations.clear();
  else configurations.delete(scopeId);
}

export function bridgeProgress(scopeId: string, state: LrrBridgeState): ReadingProgress | null {
  return state.progress ? { ...state.progress, scopeId, archiveId: state.archiveId, revision: Math.max(1, state.version) } : null;
}
export function bridgeWatchlist(scopeId: string, state: LrrBridgeState): WatchlistRecord {
  const at = state.watchlistAt ?? state.progress?.updatedAt ?? new Date().toISOString();
  return { scopeId, archiveId: state.archiveId, addedAt: at, updatedAt: at, deviceId: 'lrr-bridge',
    revision: Math.max(1, state.version), deleted: state.watchlistAt === null, deletedAt: state.watchlistAt === null ? at : null };
}
export function bridgeHistory(scopeId: string, state: LrrBridgeState): ReadingHistoryRecord {
  return { scopeId, archiveId: state.archiveId, pageIndex: state.progress?.pageIndex ?? 0,
    visitedAt: state.historyAt!, deviceId: 'lrr-bridge', revision: Math.max(1, state.version) };
}

/** Configuration reads are local IPC only; all mode changes invalidate this shared cache. */
export class NativeLrrBridgeRepository {
  async collectionList(scopeId: string, collection: BridgeCollection): Promise<CommandResult<BridgeCollectionRecord[]>> {
    const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'collection_list', input: { collection } }, z.object({ records: z.array(BridgeCollectionRecordSchema) }));
    return result.ok ? ok(result.value.records) : result;
  }
  async collectionApply(scopeId: string, collection: BridgeCollection, key: string, value: unknown): Promise<CommandResult<BridgeCollectionRecord>> {
    const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'collection_apply', input: { operation: { collection, key, value } } }, z.object({ queued: z.literal(true), record: BridgeCollectionRecordSchema }));
    if (!result.ok) return result;
    notifyBridge(scopeId, collection);
    return ok(result.value.record);
  }
  config(scopeId: string, refresh = false): Promise<CommandResult<LrrBridgeConfig>> {
    if (refresh) invalidateLrrBridgeConfig(scopeId);
    const cached = configurations.get(scopeId);
    if (cached) return cached;
    const request = invokeCommand('lrr_bridge_config', { scopeId }, LrrBridgeConfigSchema);
    configurations.set(scopeId, request);
    void request.then(result => { if (!result.ok && configurations.get(scopeId) === request) configurations.delete(scopeId); });
    return request;
  }
  async configure(scopeId: string, enabled: boolean): Promise<CommandResult<LrrBridgeConfig>> {
    const result = await invokeCommand('lrr_bridge_configure', { scopeId, enabled }, LrrBridgeConfigSchema);
    invalidateLrrBridgeConfig(scopeId);
    if (result.ok) configurations.set(scopeId, Promise.resolve(result));
    if (result.ok) notifyBridge(scopeId, 'config');
    return result;
  }
  detect(scopeId: string) {
    return invokeCommand('lrr_bridge_request', { scopeId, action: 'hello', input: {} }, z.object(envelope));
  }
  async flush(scopeId: string) {
    const result = await invokeCommand('lrr_bridge_flush', { scopeId }, LrrBridgeConfigSchema);
    if (result.ok) configurations.set(scopeId, Promise.resolve(result));
    return result;
  }
  async discardConflicts(scopeId: string) {
    const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'discard_conflicts', input: {} }, LrrBridgeConfigSchema);
    if (result.ok) {
      configurations.set(scopeId, Promise.resolve(result));
      notifyBridge(scopeId, 'discard_conflicts');
    }
    return result;
  }
  async abandonPending(scopeId: string) {
    const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'abandon_pending', input: {} }, LrrBridgeConfigSchema);
    if (result.ok) {
      configurations.set(scopeId, Promise.resolve(result));
      notifyBridge(scopeId, 'config');
    }
    return result;
  }
  /** Versioned small workspace blocks. Large results require a chunk manifest;
   * callers must not interpret this as an atomic multi-block document store. */
  async workspaceGet(scopeId: string, key: string) {
    const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'workspace_get', input: { key } }, WorkspaceSchema);
    return result.ok ? ok(result.value.workspace) : result;
  }
  async workspacePut(scopeId: string, key: string, expectedVersion: number, value: unknown, operationId: string = crypto.randomUUID()) {
    if (new TextEncoder().encode(JSON.stringify(value) ?? 'null').length > 1800)
      return err('INVALID_INPUT', '共享工作区单块内容过大，请拆分后提交。', false);
    const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'workspace_put', input: { key, expectedVersion, value, operationId } }, WorkspaceSchema);
    if (!result.ok) return result;
    return result.value.errorCode ? err('REMOTE_CONFLICT', '共享工作区已被其他设备修改，请重新读取。', false) : ok(result.value.workspace);
  }
  async states(scopeId: string, ids: string[]): Promise<CommandResult<LrrBridgeState[]>> {
    const states: LrrBridgeState[] = [];
    const unique = [...new Set(ids)];
    for (let offset = 0; offset < unique.length; offset += 32) {
      const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'states', input: { ids: unique.slice(offset, offset + 32) } }, StatesSchema);
      if (!result.ok) return result;
      states.push(...result.value.states);
    }
    return ok(states);
  }
  async list(scopeId: string, kind: 'watchlist' | 'history'): Promise<CommandResult<LrrBridgeState[]>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const states = new Map<string, LrrBridgeState>();
      let snapshot: string | undefined;
      for (let offset = 0; ;) {
        const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'list', input: { kind, offset, limit: 100 } }, ListSchema);
        if (!result.ok) { if (attempt === 0 && result.error.code === 'REMOTE_CONFLICT') break; return result; }
        const identity = JSON.stringify([result.value.serverId, result.value.epoch, result.value.version]);
        if (snapshot !== undefined && identity !== snapshot) break;
        snapshot = identity;
        result.value.states.forEach(state => states.set(state.archiveId, state));
        if (offset + result.value.states.length >= result.value.total) return ok([...states.values()]);
        if (result.value.states.length === 0) break;
        if (offset >= 1_000_000) return err('INVALID_RESPONSE', '托管列表分页无效', false);
        offset += result.value.states.length;
      }
    }
    return err('REMOTE_CONFLICT', '服务器阅读数据正在变化，请稍后刷新。', true);
  }
  async apply(scopeId: string, archiveId: string, kind: 'progress' | 'watchlist_add' | 'watchlist_remove' | 'history_delete' | 'progress_clear', progress?: Omit<ReadingProgress, 'scopeId' | 'archiveId' | 'revision'> & { allowProgressRegression?: boolean }): Promise<CommandResult<LrrBridgeState>> {
    const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'apply', input: {
      operation: { archiveId, kind, ...(progress ? { progress } : {}) },
    } }, ApplySchema);
    if (!result.ok) return result;
    if (result.value.conflict) return err('REMOTE_CONFLICT', '阅读数据发生冲突，操作未覆盖服务器数据。请刷新后重试。', false);
    notifyBridge(scopeId, kind);
    return ok(result.value.state);
  }
}
