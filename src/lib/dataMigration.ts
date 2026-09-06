/** Data migration payloads.
 *
 * Shape follows Readoshi's worker export (`worker.js`): a `schemaVersion`, an
 * `exportedAt` stamp, the live `items`, the `deleted` tombstones and the
 * `lastSync` watermark. One envelope means one import control instead of the
 * separate "旧配置" and "完整本地数据" forms, and an unknown payload can still be
 * recognised as a legacy preferences blob rather than silently failing.
 */
export const MIGRATION_SCHEMA_VERSION = 1;

export interface MigrationItem {
  archiveId: string;
  pageIndex?: number;
  visitedAt?: string;
  addedAt?: string;
}

export interface MigrationExport {
  schemaVersion: number;
  exportedAt: string;
  scopeId: string;
  items: MigrationItem[];
  deleted: string[];
  lastSync: number;
}

export interface HistorySource { archiveId: string; pageIndex: number; visitedAt: string }
export interface WatchlistSource { archiveId: string; addedAt: string; deleted: boolean }

export function buildMigrationExport(input: {
  scopeId: string;
  history: readonly HistorySource[];
  watchlist: readonly WatchlistSource[];
  exportedAt?: string;
}): MigrationExport {
  const items = new Map<string, MigrationItem>();
  for (const entry of input.history) {
    items.set(entry.archiveId, { archiveId: entry.archiveId, pageIndex: entry.pageIndex, visitedAt: entry.visitedAt });
  }
  for (const entry of input.watchlist) {
    if (entry.deleted) continue;
    items.set(entry.archiveId, { ...items.get(entry.archiveId), archiveId: entry.archiveId, addedAt: entry.addedAt });
  }
  return {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    scopeId: input.scopeId,
    items: [...items.values()],
    deleted: input.watchlist.filter((entry) => entry.deleted).map((entry) => entry.archiveId),
    lastSync: 0,
  };
}

export type ParsedMigration =
  | { kind: 'unified'; payload: MigrationExport }
  | { kind: 'legacy' }
  | { kind: 'invalid'; reason: string };

export function parseMigrationExport(text: string): ParsedMigration {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'invalid', reason: '请粘贴导出的 JSON 内容' };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // The old preferences export is an encoded blob, not JSON. Hand it to the
    // legacy importer instead of rejecting it.
    return { kind: 'legacy' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: '导出内容必须是一个 JSON 对象' };
  }
  const record = value as Partial<MigrationExport>;
  if (record.schemaVersion === undefined) return { kind: 'legacy' };
  if (record.schemaVersion !== MIGRATION_SCHEMA_VERSION) {
    return { kind: 'invalid', reason: `不支持的导出版本：${String(record.schemaVersion)}` };
  }
  if (!Array.isArray(record.items)) return { kind: 'invalid', reason: '导出内容缺少 items 列表' };
  return {
    kind: 'unified',
    payload: {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '',
      scopeId: typeof record.scopeId === 'string' ? record.scopeId : '',
      items: record.items.filter((item): item is MigrationItem => Boolean(item && typeof item.archiveId === 'string')),
      deleted: Array.isArray(record.deleted) ? record.deleted.filter((id): id is string => typeof id === 'string') : [],
      lastSync: typeof record.lastSync === 'number' ? record.lastSync : 0,
    },
  };
}
