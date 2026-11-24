import { parseMigrationExport } from './dataMigration';

/** 待看、历史与非重复标记现在由 LANraragi 插件托管（`plugins/lanraragi/YomikaBridge.pm`），
 *  应用里不再有它们的本地导入导出：设置里的通用导入导出只搬本机数据，这三类改在
 *  「服务器阅读数据」这一页里对着插件做。这个模块只做两件事——把插件读回来的状态折成
 *  一份可保存的文件，以及把旧应用导出 / Readoshi worker 导出折成能写进插件的条目。 */

export const BRIDGE_TRANSFER_KIND = 'yomika-bridge-transfer';
export const BRIDGE_TRANSFER_VERSION = 1;

export interface BridgeTransferHistory { archiveId: string; pageIndex: number; visitedAt: string }
export interface BridgeTransferWatchlist { archiveId: string; addedAt: string }
export interface BridgeTransferPair { archiveIdA: string; archiveIdB: string }

export interface BridgeTransfer {
  kind: typeof BRIDGE_TRANSFER_KIND;
  version: number;
  exportedAt: string;
  serverScope: string;
  watchlist: BridgeTransferWatchlist[];
  history: BridgeTransferHistory[];
  nonDuplicates: BridgeTransferPair[];
}

/** 插件状态里与这三类有关的那几个字段；只要这几个，导出就不必认识整份状态。 */
export interface BridgeTransferState {
  archiveId: string;
  historyAt: string | null;
  watchlistAt: string | null;
  historyPageIndex?: number | undefined;
  progress: { pageIndex: number } | null;
}

export type ParsedBridgeTransfer =
  | { kind: 'transfer'; payload: BridgeTransfer }
  | { kind: 'legacy'; payload: BridgeTransfer }
  | { kind: 'invalid'; reason: string };

/** 插件与旧应用写的时间戳有两种：插件用 ISO（`…T…Z`），旧的 SQLite 行用空格分隔。
 *  两者按字典序比较会颠倒（'T' > ' '），所以导入前统一折成 ISO；读不懂的就丢掉，
 *  让那条记录按「没有时间」被跳过，而不是写进一个比较起来会出错的值。 */
export function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)
    ? text
    : text.replace(' ', 'T').replace(/Z?$/, 'Z');
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

/** 插件的键是 `a:b` 且要求 a < b，这里照同一口径归一，免得服务端拒收。 */
export function nonDuplicatePair(left: string, right: string): BridgeTransferPair | undefined {
  if (!left || !right || left === right) return undefined;
  return left < right ? { archiveIdA: left, archiveIdB: right } : { archiveIdA: right, archiveIdB: left };
}

export function buildBridgeTransfer(input: {
  scopeId: string;
  states: readonly BridgeTransferState[];
  pairs: readonly BridgeTransferPair[];
  exportedAt?: string;
}): BridgeTransfer {
  const history: BridgeTransferHistory[] = [];
  const watchlist: BridgeTransferWatchlist[] = [];
  for (const state of input.states) {
    const visitedAt = isoTimestamp(state.historyAt);
    if (visitedAt) {
      history.push({ archiveId: state.archiveId, pageIndex: state.historyPageIndex ?? state.progress?.pageIndex ?? 0, visitedAt });
    }
    const addedAt = isoTimestamp(state.watchlistAt);
    if (addedAt) watchlist.push({ archiveId: state.archiveId, addedAt });
  }
  history.sort((a, b) => b.visitedAt.localeCompare(a.visitedAt));
  watchlist.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const seen = new Set<string>();
  const nonDuplicates: BridgeTransferPair[] = [];
  for (const pair of input.pairs) {
    const key = `${pair.archiveIdA}:${pair.archiveIdB}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nonDuplicates.push(pair);
  }
  return {
    kind: BRIDGE_TRANSFER_KIND,
    version: BRIDGE_TRANSFER_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    serverScope: input.scopeId,
    watchlist,
    history,
    nonDuplicates,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseTransfer(value: unknown): BridgeTransfer | undefined {
  const record = asRecord(value);
  if (!record || record.kind !== BRIDGE_TRANSFER_KIND) return undefined;
  const watchlist: BridgeTransferWatchlist[] = [];
  const history: BridgeTransferHistory[] = [];
  const nonDuplicates: BridgeTransferPair[] = [];
  for (const entry of Array.isArray(record.watchlist) ? record.watchlist : []) {
    const item = asRecord(entry);
    const archiveId = typeof item?.archiveId === 'string' ? item.archiveId : '';
    const addedAt = isoTimestamp(item?.addedAt);
    if (archiveId && addedAt) watchlist.push({ archiveId, addedAt });
  }
  for (const entry of Array.isArray(record.history) ? record.history : []) {
    const item = asRecord(entry);
    const archiveId = typeof item?.archiveId === 'string' ? item.archiveId : '';
    const visitedAt = isoTimestamp(item?.visitedAt);
    const pageIndex = typeof item?.pageIndex === 'number' && Number.isInteger(item.pageIndex) && item.pageIndex >= 0 ? item.pageIndex : 0;
    if (archiveId && visitedAt) history.push({ archiveId, pageIndex, visitedAt });
  }
  for (const entry of Array.isArray(record.nonDuplicates) ? record.nonDuplicates : []) {
    const item = asRecord(entry);
    const pair = nonDuplicatePair(typeof item?.archiveIdA === 'string' ? item.archiveIdA : '', typeof item?.archiveIdB === 'string' ? item.archiveIdB : '');
    if (pair) nonDuplicates.push(pair);
  }
  return {
    kind: BRIDGE_TRANSFER_KIND,
    version: BRIDGE_TRANSFER_VERSION,
    exportedAt: isoTimestamp(record.exportedAt) ?? new Date().toISOString(),
    serverScope: typeof record.serverScope === 'string' ? record.serverScope : '',
    watchlist,
    history,
    nonDuplicates,
  };
}

/** 旧应用导出（`yomika-export` 统一信封）与 Readoshi worker v3 导出都能读：
 *  它们装的正是这三类数据，现在只是换个落点——写进插件而不是本机。 */
export function parseBridgeTransfer(text: string): ParsedBridgeTransfer {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: '不是一份 JSON 文件' };
  }
  const transfer = parseTransfer(value);
  if (transfer) return { kind: 'transfer', payload: transfer };
  const parsed = parseMigrationExport(text);
  if (parsed.kind === 'invalid') return { kind: 'invalid', reason: parsed.reason };
  if (parsed.kind === 'workerV3') {
    const { history, watchlist, dedupe } = parsed.payload;
    const pairs = dedupe.pairs
      .map((pair) => nonDuplicatePair(pair.leftArchiveId, pair.rightArchiveId))
      .filter((pair): pair is BridgeTransferPair => pair !== undefined);
    const payload = buildBridgeTransfer({
      scopeId: parsed.payload.serverScope,
      states: [],
      pairs,
    });
    for (const entry of history.entries) {
      const visitedAt = isoTimestamp(entry.visitedAt);
      if (visitedAt) payload.history.push({ archiveId: entry.archiveId, pageIndex: Math.max(0, Math.trunc(entry.pageIndex)), visitedAt });
    }
    for (const entry of watchlist.entries) {
      const addedAt = isoTimestamp(entry.addedAt);
      if (addedAt) payload.watchlist.push({ archiveId: entry.archiveId, addedAt });
    }
    return { kind: 'legacy', payload };
  }
  if (parsed.kind === 'unified') {
    const pairs: BridgeTransferPair[] = [];
    const payload = buildBridgeTransfer({ scopeId: parsed.payload.scopeId, states: [], pairs });
    for (const item of parsed.payload.items) {
      const visitedAt = isoTimestamp(item.visitedAt);
      if (visitedAt) payload.history.push({ archiveId: item.archiveId, pageIndex: Math.max(0, Math.trunc(item.pageIndex ?? 0)), visitedAt });
    }
    for (const entry of parsed.payload.readingList ?? []) {
      const addedAt = isoTimestamp(entry.addedAt);
      if (addedAt) payload.watchlist.push({ archiveId: entry.archiveId, addedAt });
    }
    return { kind: 'legacy', payload };
  }
  return { kind: 'invalid', reason: '这份文件里没有待看、历史或非重复标记' };
}
