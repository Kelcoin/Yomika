import type { DedupPairInput } from '../repositories/nativeDedupRepository';
import type { SyncJournalRecord } from '../domain/library';

export interface ReadoshiImportReport {
  pairs: DedupPairInput[];
  skipped: number;
  format: 'array' | 'pairs' | 'scoped' | 'legacy';
}

type UnknownRecord = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function pair(left: unknown, right: unknown): DedupPairInput | undefined {
  const leftId = text(left);
  const rightId = text(right);
  if (!leftId || !rightId || leftId === rightId) return undefined;
  return { leftArchiveId: leftId, rightArchiveId: rightId, source: 'readoshi', diagnostics: null };
}

function readPair(value: unknown): DedupPairInput | undefined {
  if (Array.isArray(value) && value.length >= 2) return pair(value[0], value[1]);
  if (!value || typeof value !== 'object') return undefined;
  const item = value as UnknownRecord;
  return pair(
    item.leftArchiveId ?? item.left_archive_id ?? item.left ?? item.a ?? item.first,
    item.rightArchiveId ?? item.right_archive_id ?? item.right ?? item.b ?? item.second,
  );
}

function collectPairs(value: unknown, output: DedupPairInput[]): number {
  if (Array.isArray(value)) {
    let skipped = 0;
    for (const item of value) {
      const parsed = readPair(item);
      if (parsed) output.push(parsed);
      else if (item && typeof item === 'object' && !Array.isArray(item)) skipped += collectPairs(item, output);
      else skipped += 1;
    }
    return skipped;
  }
  if (!value || typeof value !== 'object') return 1;
  const object = value as UnknownRecord;
  const direct = readPair(object);
  if (direct) {
    output.push(direct);
    return 0;
  }
  let skipped = 0;
  for (const key of ['pairs', 'nonDuplicates', 'non_duplicates', 'nonDuplicatePairs', 'relations', 'duplicateExclusions', 'data', 'export', 'state', 'worker']) {
    if (key in object) skipped += collectPairs(object[key], output);
  }
  // Readoshi legacy export can be an object keyed by archive ID with an array of
  // excluded IDs as its value: {"123":["456","789"]}.
  if (output.length === 0) {
    for (const [left, rights] of Object.entries(object)) {
      if (!Array.isArray(rights)) continue;
      for (const right of rights) {
        const parsed = pair(left, right);
        if (parsed) output.push(parsed);
        else skipped += 1;
      }
    }
  }
  return skipped;
}

export function compareDedupSyncVersion(left: Pick<SyncJournalRecord, 'logicalClock' | 'wallClock' | 'deviceId'>, right: Pick<SyncJournalRecord, 'logicalClock' | 'wallClock' | 'deviceId'>): number {
  if (left.logicalClock !== right.logicalClock) return left.logicalClock - right.logicalClock;
  const wall = left.wallClock.localeCompare(right.wallClock);
  return wall || left.deviceId.localeCompare(right.deviceId);
}

/** Merge remote/local relation events. Newer tombstones remain authoritative. */
export function mergeDedupSyncRecords(records: readonly SyncJournalRecord[]): SyncJournalRecord[] {
  const latest = new Map<string, SyncJournalRecord>();
  for (const record of records) {
    if (record.objectType !== 'dedup_non_duplicate') continue;
    const current = latest.get(`${record.scopeId}/${record.objectId}`);
    if (!current || compareDedupSyncVersion(record, current) > 0) latest.set(`${record.scopeId}/${record.objectId}`, record);
  }
  return [...latest.values()].sort((left, right) => left.scopeId.localeCompare(right.scopeId) || left.objectId.localeCompare(right.objectId));
}

export function parseReadoshiNonDuplicateExport(input: unknown, targetScopeId?: string): ReadoshiImportReport {
  if (!targetScopeId?.trim()) throw new Error('导入 Readoshi 不重复关系前必须指定目标服务器');
  let value: unknown = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input) as unknown; }
    catch { throw new Error('Readoshi 不重复关系文件不是有效 JSON'); }
  }
  const pairs: DedupPairInput[] = [];
  const skipped = collectPairs(value, pairs);
  const unique = new Map(pairs.map((item) => {
    const key = [item.leftArchiveId, item.rightArchiveId].sort().join('|');
    return [key, { ...item, diagnostics: { source: 'readoshi', targetScopeId } }];
  }));
  const root = value && typeof value === 'object' ? value as UnknownRecord : undefined;
  const format = Array.isArray(value) ? 'array' : root && ('scopeId' in root || 'scope_id' in root) ? 'scoped' : root && ('pairs' in root || 'nonDuplicates' in root || 'non_duplicates' in root) ? 'pairs' : 'legacy';
  return { pairs: [...unique.values()], skipped, format };
}
