import { z } from 'zod';
import { invalidateRouteCache, readRouteCache, writeRouteCache } from '../lib/routeCache';
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
  historyPageIndex: integer.optional(), historyRemovedAt: z.string().optional(),
}).strict();
export type LrrBridgeState = z.infer<typeof LrrBridgeStateSchema>;
export const LrrBridgeConfigSchema = z.object({
  enabled: z.boolean(), serverId: z.string().nullable().optional(), pending: integer, conflicts: integer,
}).strict();
export type LrrBridgeConfig = z.infer<typeof LrrBridgeConfigSchema>;
const envelope = { protocol: z.literal(1), serverId: z.string().min(1), epoch: z.string().min(1), version: integer };
const StatesSchema = z.object({ ...envelope, states: z.array(LrrBridgeStateSchema) });
const ListSchema = StatesSchema.extend({ total: integer, historyDelta: z.boolean().optional(), offline: z.boolean().optional(), pendingStates: z.array(LrrBridgeStateSchema).optional() });
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
type HistorySnapshot = Pick<z.infer<typeof ListSchema>, 'serverId' | 'epoch' | 'version'> & { states: LrrBridgeState[] };
const HISTORY_SNAPSHOT_PREFIX = 'bridge-history:v1:';
const historySnapshotKey = (scopeId: string) => `${HISTORY_SNAPSHOT_PREFIX}${encodeURIComponent(scopeId)}:`;
function saveHistorySnapshot(scopeId: string, snapshot: HistorySnapshot) {
  writeRouteCache(historySnapshotKey(scopeId), snapshot, { persist: true });
}
const pendingHistory = new Map<string, Promise<CommandResult<LrrBridgeState[]>>>();
function mergeHistory(target: Map<string, LrrBridgeState>, changes: LrrBridgeState[]) {
  for (const state of changes) {
    if (state.historyAt === null) target.delete(state.archiveId);
    else target.set(state.archiveId, state);
  }
}
function sortedHistory(states: Map<string, LrrBridgeState>): LrrBridgeState[] {
  return [...states.values()].sort((a, b) => (b.historyAt ?? '').localeCompare(a.historyAt ?? ''));
}
function staleHistoryRequest(): CommandResult<LrrBridgeState[]> {
  return err('REMOTE_CONFLICT', '历史同步配置已变更，请重新读取。', true);
}
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
  if (scopeId === undefined) {
    configurations.clear();
    invalidateRouteCache(HISTORY_SNAPSHOT_PREFIX);
    pendingHistory.clear();
  } else {
    configurations.delete(scopeId);
    invalidateRouteCache(historySnapshotKey(scopeId));
    pendingHistory.delete(scopeId);
  }
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
  return { scopeId, archiveId: state.archiveId, pageIndex: state.historyPageIndex ?? state.progress?.pageIndex ?? 0,
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
  /** 插件托管的全部记录：导出设置页要的是「服务器上现在有什么」，不是本机镜像。 */
  async exportAll(scopeId: string): Promise<CommandResult<LrrBridgeState[]>> {
    const states = new Map<string, LrrBridgeState>();
    for (let offset = 0; ;) {
      const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'export', input: { offset, limit: 100 } }, ListSchema);
      if (!result.ok) return result;
      for (const state of result.value.states) states.set(state.archiveId, state);
      offset += result.value.states.length;
      if (offset >= result.value.total || result.value.states.length === 0) break;
      if (offset >= 1_000_000) return err('INVALID_RESPONSE', '托管列表分页无效', false);
    }
    return ok([...states.values()]);
  }
  /** 旧导出的历史写进插件：服务端只收比现有记录更新的条目，重复导入因此是幂等的。 */
  async importHistory(scopeId: string, entries: readonly { archiveId: string; pageIndex: number; visitedAt: string }[]): Promise<CommandResult<number>> {
    let imported = 0;
    for (let offset = 0; offset < entries.length; offset += 50) {
      const result = await invokeCommand('lrr_bridge_request', {
        scopeId, action: 'import_history', input: { entries: entries.slice(offset, offset + 50) },
      }, z.object({ imported: integer }));
      if (!result.ok) return result;
      imported += result.value.imported;
    }
    if (imported) notifyBridge(scopeId, 'history');
    return ok(imported);
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
  pluginStatus(scopeId: string) {
    return invokeCommand('lrr_bridge_request', { scopeId, action: 'plugin_status', input: {} }, z.object({
      available: z.boolean(), version: z.string().min(1).nullish().transform(value => value ?? undefined),
    }));
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
  list(scopeId: string, kind: 'watchlist' | 'history'): Promise<CommandResult<LrrBridgeState[]>> {
    if (kind !== 'history') return this.readList(scopeId, kind);
    const pending = pendingHistory.get(scopeId);
    if (pending) return pending;
    const isCurrent = () => pendingHistory.get(scopeId) === request;
    const request: Promise<CommandResult<LrrBridgeState[]>> = this.readHistory(scopeId, isCurrent).finally(() => {
      if (pendingHistory.get(scopeId) === request) pendingHistory.delete(scopeId);
    });
    pendingHistory.set(scopeId, request);
    return request;
  }

  private async readHistory(scopeId: string, isCurrent: () => boolean): Promise<CommandResult<LrrBridgeState[]>> {
    const previous = readRouteCache<HistorySnapshot>(historySnapshotKey(scopeId), Infinity);
    if (previous) delta: for (let attempt = 0; attempt < 2; attempt++) {
      let states: Map<string, LrrBridgeState> | undefined;
      let stamp: number | undefined;
      for (let offset = 0; offset < 1_000_000;) {
        const result = await invokeCommand('lrr_bridge_request', {
          scopeId, action: 'history_changes', input: { since: previous.version, offset, limit: 100 },
        }, ListSchema.nullable());
        if (!isCurrent()) return staleHistoryRequest();
        if (!result.ok || !result.value) break delta;
        const page = result.value;
        if (page.serverId !== previous.serverId || page.epoch !== previous.epoch || page.version < previous.version) break delta;
        if (page.offline) {
          if (!page.pendingStates?.length) return ok(previous.states);
          const view = new Map(previous.states.map(state => [state.archiveId, state]));
          mergeHistory(view, page.pendingStates);
          return ok(sortedHistory(view));
        }
        // A server write during pagination invalidates the offsets, but the
        // last complete cursor can still serve as the base for a new delta.
        if (stamp !== undefined && stamp !== page.version) continue delta;
        stamp = page.version;
        if (page.states.length) {
          states ??= new Map(previous.states.map(state => [state.archiveId, state]));
          mergeHistory(states, page.states);
        }
        offset += page.states.length;
        if (offset >= page.total) {
          const authoritative = states ? sortedHistory(states) : previous.states;
          if (page.version !== previous.version) {
            saveHistorySnapshot(scopeId, { serverId: page.serverId, epoch: page.epoch, version: page.version, states: authoritative });
          }
          if (!page.pendingStates?.length) return ok(authoritative);
          const view = states ?? new Map(authoritative.map(state => [state.archiveId, state]));
          mergeHistory(view, page.pendingStates);
          return ok(sortedHistory(view));
        }
        if (!page.states.length) break delta;
      }
    }
    return this.readList(scopeId, 'history', isCurrent);
  }

  private async readList(scopeId: string, kind: 'watchlist' | 'history', isCurrent?: () => boolean): Promise<CommandResult<LrrBridgeState[]>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const states = new Map<string, LrrBridgeState>();
      let snapshot: string | undefined;
      let canCacheHistory = kind === 'history';
      for (let offset = 0; ;) {
        const result = await invokeCommand('lrr_bridge_request', { scopeId, action: 'list', input: { kind, offset, limit: 100 } }, ListSchema);
        if (isCurrent && !isCurrent()) return staleHistoryRequest();
        if (!result.ok) { if (attempt === 0 && result.error.code === 'REMOTE_CONFLICT') break; return result; }
        const identity = JSON.stringify([result.value.serverId, result.value.epoch, result.value.version]);
        if (snapshot !== undefined && identity !== snapshot) break;
        snapshot = identity;
        canCacheHistory &&= result.value.historyDelta === true && result.value.offline !== true;
        result.value.states.forEach(state => states.set(state.archiveId, state));
        if (offset + result.value.states.length >= result.value.total) {
          const next = [...states.values()];
          if (canCacheHistory) {
            const { serverId, epoch, version } = result.value;
            saveHistorySnapshot(scopeId, { serverId, epoch, version, states: next });
          } else if (kind === 'history' && !result.value.offline) invalidateRouteCache(historySnapshotKey(scopeId));
          return ok(next);
        }
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
