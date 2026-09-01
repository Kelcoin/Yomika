import { describe, expect, it } from 'vitest';
import { compareDedupSyncVersion, mergeDedupSyncRecords, parseReadoshiNonDuplicateExport } from '../../src/lib/readoShiDedupeImport';

describe('Readoshi non-duplicate import', () => {
  it('accepts arrays and pairs wrapper', () => {
    expect(parseReadoshiNonDuplicateExport([[2, 1], ['1', '2'], ['x', 'x']], 'server-a')).toMatchObject({
      format: 'array', skipped: 1, pairs: [{ leftArchiveId: '1', rightArchiveId: '2' }],
    });
    expect(parseReadoshiNonDuplicateExport({ pairs: [{ left: 'a', right: 'b' }] }, 'server-a').pairs).toHaveLength(1);
  });

  it('accepts legacy archive-to-list export and requires scope', () => {
    expect(() => parseReadoshiNonDuplicateExport({ a: ['b'] })).toThrow(/指定目标服务器/);
    expect(parseReadoshiNonDuplicateExport({ a: ['b', 'c'], b: ['a'] }, 'server-a').pairs).toHaveLength(2);
  });

  it('deduplicates reversed pairs and rejects invalid JSON', () => {
    expect(parseReadoshiNonDuplicateExport('{"pairs":[{"leftArchiveId":"a","rightArchiveId":"b"},["b","a"]]}', 'server-a').pairs).toHaveLength(1);
    expect(() => parseReadoshiNonDuplicateExport('{bad', 'server-a')).toThrow(/有效 JSON/);
  });

  it('keeps deterministic newest tombstone during sync merge', () => {
    const base = { sequence: 1, scopeId: 's', objectId: 'a|b', objectType: 'dedup_non_duplicate', operation: 'upsert' as const, deviceId: 'a', logicalClock: 3, wallClock: '2026-01-01T00:00:00Z', baseHash: null, payloadHash: 'x', payloadJson: '{}', status: 'completed' as const, attemptCount: 0, lastError: null };
    const tombstone = { ...base, sequence: 2, operation: 'delete' as const, deviceId: 'b', wallClock: '2026-01-02T00:00:00Z' };
    expect(compareDedupSyncVersion(tombstone, base)).toBeGreaterThan(0);
    expect(mergeDedupSyncRecords([base, tombstone])).toEqual([tombstone]);
  });
});
