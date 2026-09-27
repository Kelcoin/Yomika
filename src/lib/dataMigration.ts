import { DATA_EXPORT_KIND } from '../domain/dataExport';
import { CREDENTIAL_EXPORT_KIND } from '../domain/credentialWire';

/** Data migration payloads.
 *
 * 现在导出的是「按导入导出范围里记录那一半折出来的同步文档」（见 domain/syncWire 的
 * ScopedExportReportSchema，由原生侧的 export_scoped_data 生成；凭据那一半走口令加密
 * 的凭据文件），这里保留的是**导入**侧认识的所有形状：本机的同步文档、口令加密的凭据
 * 文件、Readoshi worker v3、更早的 Yomika 统一信封，以及旧的偏好设置 blob。旧的导出
 * 仍要能导进来——换过版本的人手里还留着那些文件。
 */
export const MIGRATION_SCHEMA_VERSION = 1;

/** 原生侧导出的信封标记（`kind`）。 */
export const SCOPED_EXPORT_KIND = 'yomika-scope-export';

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
  /** 收藏夹曾经不在本机的导出里；旧信封可能还带着墓碑 id，导入端照收。 */
  deleted?: string[] | undefined;
  lastSync: number;
  /** 待看 (reading_list) — never part of the original Readoshi envelope;
   * optional so older exports and imports keep round-tripping. */
  readingList?: MigrationListEntry[] | undefined;
  readingListDeleted?: string[] | undefined;
}

export interface MigrationListEntry { archiveId: string; addedAt: string }

export interface HistorySource { archiveId: string; pageIndex: number; visitedAt: string }
export interface WatchlistSource { archiveId: string; addedAt: string; deleted: boolean }

/** 更早那一版的导出信封（历史 + 待看 + 墓碑 id 列表）。现在不再由本应用生成——
 * 导出走的是同步文档——但旧文件仍在导入路径上，测试也用它造样本。 */
export function buildMigrationExport(input: {
  scopeId: string;
  history: readonly HistorySource[];
  readingList?: readonly WatchlistSource[];
  exportedAt?: string;
}): MigrationExport {
  const items = new Map<string, MigrationItem>();
  for (const entry of input.history) {
    items.set(entry.archiveId, { archiveId: entry.archiveId, pageIndex: entry.pageIndex, visitedAt: entry.visitedAt });
  }
  const readingList = (input.readingList ?? []).filter((entry) => !entry.deleted)
    .map((entry) => ({ archiveId: entry.archiveId, addedAt: entry.addedAt }));
  return {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    scopeId: input.scopeId,
    items: [...items.values()],
    lastSync: 0,
    readingList,
    readingListDeleted: (input.readingList ?? []).filter((entry) => entry.deleted).map((entry) => entry.archiveId),
  };
}

export type ParsedMigration =
  | { kind: 'export'; payload: { items: string[] } }
  | { kind: 'credentials' }
  | { kind: 'scoped' }
  | { kind: 'unified'; payload: MigrationExport }
  | { kind: 'workerV3'; payload: WorkerV3Payload }
  | { kind: 'legacy' }
  | { kind: 'invalid'; reason: string };

/** The Readoshi worker's v3 export envelope (worker.js exportKV): `version: 3`
 * with per-section payloads keyed by neutral names. The section values are the
 * raw KV blobs — either the JSON string itself or a pre-parsed object, and the
 * wrapper object may carry the section under its neutral name or the raw
 * (token-embedded) KV key, so both shapes are accepted here like worker
 * importKV does with its firstObjectValue fallback. */
export interface WorkerV3Payload {
  serverScope: string;
  history: {
    entries: WorkerV3HistoryEntry[];
    deletedIds: string[];
    skipped: number;
  };
  watchlist: {
    entries: WorkerV3WatchlistEntry[];
    tombstones: { archiveId: string; deletedAt: string }[];
    skipped: number;
  };
  dedupe: {
    pairs: { leftArchiveId: string; rightArchiveId: string }[];
    skipped: number;
  };
}

export interface WorkerV3HistoryEntry { archiveId: string; pageIndex: number; visitedAt: string }
export interface WorkerV3WatchlistEntry { archiveId: string; addedAt: string }

type UnknownRecord = Record<string, unknown>;

/** SQLite-style UTC timestamp ('YYYY-MM-DD HH:MM:SS.SSS'): the existing rows
 * carry SQLite CURRENT_TIMESTAMP values, and the history index (visited_at
 * DESC) and the sync merge compare timestamps lexicographically — a 'T'
 * ISO string would sort after every space-format time of the same day. */
export function workerTimestamp(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
}

function firstObjectValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const values = Object.values(value as UnknownRecord);
  return values.length ? values[0] : undefined;
}

/** A section value from the export can be the JSON string itself, a
 * pre-parsed object, or a wrapper keyed by the raw (token-embedded) KV key —
 * mirror the worker's own importKV tolerance. */
function parseSectionValue(value: unknown): unknown {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function resolveSection(payload: unknown): unknown {
  const direct = parseSectionValue(payload);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    const record = direct as UnknownRecord;
    // The KV blob itself (schemaVersion or the list fields present) versus a
    // one-key wrapper keyed by the neutral name or the raw KV key.
    if (record.schemaVersion !== undefined || isSectionList(record.histories) || isSectionList(record.items)) return direct;
    const inner = firstObjectValue(direct);
    return parseSectionValue(inner) ?? inner;
  }
  return undefined;
}

function isSectionList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function nonEmptyId(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** v3 history KV blob: {schemaVersion, histories:[{id,page,time}], hideRead,
 * deleted:[{id,deletedAt}], lastSync}. Entries the worker itself would have
 * stored verbatim are re-validated entry by entry here; broken rows are
 * counted, not fatal (the whole import is still atomic in the native side). */
function parseWorkerHistory(section: unknown): { entries: WorkerV3HistoryEntry[]; deletedIds: string[]; skipped: number } {
  const root = section && typeof section === 'object' ? section as UnknownRecord : undefined;
  const rawList = isSectionList(root?.histories) ? root.histories : [];
  const rawDeleted = isSectionList(root?.deleted) ? root.deleted : [];
  const entries: WorkerV3HistoryEntry[] = [];
  const deletedIds: string[] = [];
  let skipped = 0;
  for (const item of rawList) {
    const record = item && typeof item === 'object' ? item as UnknownRecord : undefined;
    const id = record ? nonEmptyId(record.id) : '';
    const page = record ? record.page : undefined;
    if (!id || typeof page !== 'number' || !Number.isInteger(page) || page < 0) { skipped += 1; continue; }
    const visitedAt = workerTimestamp(record?.time);
    if (!visitedAt) { skipped += 1; continue; }
    entries.push({ archiveId: id, pageIndex: page, visitedAt });
  }
  for (const item of rawDeleted) {
    const record = item && typeof item === 'object' ? item as UnknownRecord : undefined;
    const id = record ? nonEmptyId(record.id) : '';
    if (!id) { skipped += 1; continue; }
    deletedIds.push(id);
  }
  return { entries, deletedIds, skipped };
}

/** v3 watchlist KV blob: {schemaVersion, items:[{id,addedAt}], deleted, lastSync}. */
function parseWorkerWatchlist(section: unknown): { entries: WorkerV3WatchlistEntry[]; tombstones: { archiveId: string; deletedAt: string }[]; skipped: number } {
  const root = section && typeof section === 'object' ? section as UnknownRecord : undefined;
  const rawItems = isSectionList(root?.items) ? root.items : [];
  const rawDeleted = isSectionList(root?.deleted) ? root.deleted : [];
  const entries: WorkerV3WatchlistEntry[] = [];
  const tombstones: { archiveId: string; deletedAt: string }[] = [];
  let skipped = 0;
  for (const item of rawItems) {
    const record = item && typeof item === 'object' ? item as UnknownRecord : undefined;
    const id = record ? nonEmptyId(record.id) : '';
    const addedAt = workerTimestamp(record?.addedAt);
    if (!id) { skipped += 1; continue; }
    // added_at is NOT NULL locally; an export without one falls back to now.
    entries.push({ archiveId: id, addedAt: addedAt || workerTimestamp(Date.now()) });
  }
  for (const item of rawDeleted) {
    const record = item && typeof item === 'object' ? item as UnknownRecord : undefined;
    const id = record ? nonEmptyId(record.id) : '';
    const deletedAt = workerTimestamp(record?.deletedAt);
    if (!id) { skipped += 1; continue; }
    // A tombstone without a timestamp is still a tombstone: fall back to now.
    tombstones.push({ archiveId: id, deletedAt: deletedAt || workerTimestamp(Date.now()) });
  }
  return { entries, tombstones, skipped };
}

/** v3 dedupe KV blob: a JSON array of 'a|b' pair strings, normalized by the
 * worker (both halves sorted lexicographically). Pairs here are split and
 * re-normalized by the native importer, so only a rough shape check runs. */
function parseWorkerDedupe(section: unknown): { pairs: { leftArchiveId: string; rightArchiveId: string }[]; skipped: number } {
  const raw = firstObjectValue(section) ?? section;
  const parsed = typeof raw === 'string' ? parseSectionValue(raw) : raw;
  if (!Array.isArray(parsed)) return { pairs: [], skipped: 1 };
  const pairs: { leftArchiveId: string; rightArchiveId: string }[] = [];
  let skipped = 0;
  for (const item of parsed) {
    if (typeof item !== 'string') { skipped += 1; continue; }
    const halves = item.split('|').map((part) => part.trim()).filter(Boolean);
    const left = halves[0] ?? '';
    const right = halves[1] ?? '';
    if (left && right && left !== right) {
      pairs.push({ leftArchiveId: left, rightArchiveId: right });
    } else {
      skipped += 1;
    }
  }
  return { pairs, skipped };
}

export function parseWorkerV3Export(value: unknown): ParsedMigration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: '导出内容必须是一个 JSON 对象' };
  }
  const record = value as UnknownRecord;
  if (record.version !== 3 || typeof record.sections !== 'object' || record.sections === null) {
    return { kind: 'invalid', reason: '不支持的 worker 导出结构' };
  }
  const sections = record.sections as UnknownRecord;
  const serverScope = nonEmptyId(record.serverScope);
  if (!serverScope) return { kind: 'invalid', reason: '导出内容缺少服务器指纹（serverScope）' };
  const payload: WorkerV3Payload = {
    serverScope,
    history: parseWorkerHistory(resolveSection(sections.history)),
    watchlist: parseWorkerWatchlist(resolveSection(sections.watchlist)),
    dedupe: parseWorkerDedupe(sections.dedupe),
  };
  return { kind: 'workerV3', payload };
}

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
  const record = value as Partial<MigrationExport> & UnknownRecord;
  // 新版数据迁移文件（docs/30）：结构校验很轻——items 是勾选框的依据，
  // 其余字段的校验在原生侧 import_data 里逐类做。
  if (record.kind === DATA_EXPORT_KIND) {
    if (record.schemaVersion !== MIGRATION_SCHEMA_VERSION) {
      return { kind: 'invalid', reason: `不支持的导出版本：${String(record.schemaVersion)}` };
    }
    const items = Array.isArray(record.items)
      ? (record.items as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    return { kind: 'export', payload: { items } };
  }
  // 旧版口令加密的凭据文件：口令链路已移除，只认出来给一句明确的说明。
  if (record.kind === CREDENTIAL_EXPORT_KIND) return { kind: 'credentials' };
  // 本机导出的那一份（同步文档信封）：原生侧的导入命令认它，这里只需要把它从别的
  // 形状里分出来，结构上的校验留给原生侧——那边本来就要逐字段读一遍。
  if (record.kind === SCOPED_EXPORT_KIND) {
    if (record.schemaVersion !== MIGRATION_SCHEMA_VERSION) {
      return { kind: 'invalid', reason: `不支持的导出版本：${String(record.schemaVersion)}` };
    }
    const document = record.document;
    if (!document || typeof document !== 'object' || !('objects' in document)) {
      return { kind: 'invalid', reason: '导出内容缺少 objects' };
    }
    return { kind: 'scoped' };
  }
  // The Readoshi worker's v3 envelope uses `version`, not `schemaVersion` —
  // check it before the legacy fallback or it would be misread as a legacy
  // preferences blob and hit the wrong decoder.
  if ('version' in record) return parseWorkerV3Export(value);
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
      deleted: Array.isArray(record.deleted)
        ? record.deleted.filter((id): id is string => typeof id === 'string')
        : undefined,
      lastSync: typeof record.lastSync === 'number' ? record.lastSync : 0,
      readingList: Array.isArray(record.readingList)
        ? (record.readingList as unknown[]).filter((entry): entry is MigrationListEntry => {
            const candidate = entry as Partial<MigrationListEntry> | null;
            return Boolean(candidate && typeof candidate.archiveId === 'string' && typeof candidate.addedAt === 'string');
          })
        : undefined,
      readingListDeleted: Array.isArray(record.readingListDeleted)
        ? (record.readingListDeleted as unknown[]).filter((id): id is string => typeof id === 'string')
        : undefined,
    },
  };
}
