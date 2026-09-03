import { describe, expect, it } from 'vitest';

import {
  MIGRATION_SCHEMA_VERSION,
  buildMigrationExport,
  parseMigrationExport,
} from '../../src/lib/dataMigration';

describe('data migration envelope', () => {
  it('builds the Readoshi-shaped export from local records', () => {
    const payload = buildMigrationExport({
      scopeId: 'scope-a',
      exportedAt: '2026-09-03T00:00:00.000Z',
      history: [{ archiveId: 'a1', pageIndex: 4, visitedAt: '2026-09-01T00:00:00Z' }],
      watchlist: [
        { archiveId: 'a1', addedAt: '2026-08-30T00:00:00Z', deleted: false },
        { archiveId: 'a2', addedAt: '2026-08-29T00:00:00Z', deleted: false },
        { archiveId: 'gone', addedAt: '2026-08-01T00:00:00Z', deleted: true },
      ],
    });

    expect(payload).toEqual({
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      exportedAt: '2026-09-03T00:00:00.000Z',
      scopeId: 'scope-a',
      items: [
        { archiveId: 'a1', pageIndex: 4, visitedAt: '2026-09-01T00:00:00Z', addedAt: '2026-08-30T00:00:00Z' },
        { archiveId: 'a2', addedAt: '2026-08-29T00:00:00Z' },
      ],
      deleted: ['gone'],
      lastSync: 0,
    });
  });

  it('round-trips its own export', () => {
    const payload = buildMigrationExport({ scopeId: 'scope-a', history: [], watchlist: [], exportedAt: '2026-09-03T00:00:00.000Z' });
    const parsed = parseMigrationExport(JSON.stringify(payload));
    expect(parsed).toEqual({ kind: 'unified', payload });
  });

  it('treats a payload without schemaVersion, and an encoded blob, as legacy input', () => {
    expect(parseMigrationExport('{"preferences":{"theme":"dark"}}')).toEqual({ kind: 'legacy' });
    // The old preferences export is an encoded string rather than JSON.
    expect(parseMigrationExport('eyJ0aGVtZSI6ImRhcmsifQ==')).toEqual({ kind: 'legacy' });
  });

  it('rejects empty, non-object, and future payloads', () => {
    expect(parseMigrationExport('')).toMatchObject({ kind: 'invalid' });
    expect(parseMigrationExport('[]')).toMatchObject({ kind: 'invalid' });
    expect(parseMigrationExport('{"schemaVersion":99,"items":[]}')).toMatchObject({ kind: 'invalid', reason: '不支持的导出版本：99' });
    expect(parseMigrationExport('{"schemaVersion":1}')).toMatchObject({ kind: 'invalid' });
  });

  it('drops malformed entries instead of failing the whole import', () => {
    const parsed = parseMigrationExport('{"schemaVersion":1,"items":[{"archiveId":"ok"},{"noId":true}],"deleted":["gone",7]}');
    expect(parsed).toEqual({
      kind: 'unified',
      payload: { schemaVersion: 1, exportedAt: '', scopeId: '', items: [{ archiveId: 'ok' }], deleted: ['gone'], lastSync: 0 },
    });
  });
});
