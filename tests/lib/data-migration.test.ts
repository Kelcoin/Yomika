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
      readingList: [
        { archiveId: 'r1', addedAt: '2026-08-30T00:00:00Z', deleted: false },
        { archiveId: 'rgone', addedAt: '2026-08-01T00:00:00Z', deleted: true },
      ],
    });

    expect(payload).toEqual({
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      exportedAt: '2026-09-03T00:00:00.000Z',
      scopeId: 'scope-a',
      items: [
        { archiveId: 'a1', pageIndex: 4, visitedAt: '2026-09-01T00:00:00Z' },
      ],
      lastSync: 0,
      readingList: [{ archiveId: 'r1', addedAt: '2026-08-30T00:00:00Z' }],
      readingListDeleted: ['rgone'],
    });
  });

  it('round-trips its own export', () => {
    const payload = buildMigrationExport({ scopeId: 'scope-a', history: [], readingList: [], exportedAt: '2026-09-03T00:00:00.000Z' });
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

describe('readoshi worker v3 export', () => {
  const envelope = (sections: unknown) => JSON.stringify({
    version: 3,
    scope: 'token-and-server-md5',
    serverScope: 'f4fe9bbfa7d17b5bcd601ca76192b539',
    exportedAt: '2026-09-13T12:21:55.353Z',
    sections,
  });

  it('parses the worker envelope with JSON-string sections', () => {
    const parsed = parseMigrationExport(envelope({
      history: { history: JSON.stringify({
        schemaVersion: 3,
        histories: [{ id: 'a1', page: 148, time: 1789292133362 }],
        deleted: [{ id: 'a3', deletedAt: 1788968271229 }],
      }) },
      watchlist: { watchlist: JSON.stringify({
        schemaVersion: 3,
        items: [{ id: 'w1', addedAt: 1788539817490 }],
        deleted: [{ id: 'w2', deletedAt: 1789008149455 }],
      }) },
      dedupe: { dedupe: JSON.stringify(['aaa|bbb']) },
    }));

    expect(parsed.kind).toBe('workerV3');
    if (parsed.kind !== 'workerV3') return;
    expect(parsed.payload.serverScope).toBe('f4fe9bbfa7d17b5bcd601ca76192b539');
    // Timestamps land in SQLite-style UTC so the visited_at index and the
    // sync merge keep comparing them lexicographically.
    expect(parsed.payload.history.entries).toEqual([
      { archiveId: 'a1', pageIndex: 148, visitedAt: '2026-09-13 09:35:33.362' },
    ]);
    expect(parsed.payload.history.deletedIds).toEqual(['a3']);
    expect(parsed.payload.watchlist.entries).toEqual([
      { archiveId: 'w1', addedAt: '2026-09-04 16:36:57.490' },
    ]);
    expect(parsed.payload.watchlist.tombstones).toEqual([
      { archiveId: 'w2', deletedAt: '2026-09-10 02:42:29.455' },
    ]);
    expect(parsed.payload.dedupe.pairs).toEqual([{ leftArchiveId: 'aaa', rightArchiveId: 'bbb' }]);
  });

  it('accepts sections stored under the raw KV key or as objects', () => {
    const parsed = parseMigrationExport(envelope({
      history: { 'history:token:scope': { histories: [{ id: 'a1', page: 2, time: 1789292133362 }] } },
      watchlist: { watchlist: { items: [{ id: 'w1', addedAt: 1788539817490 }] } },
    }));
    expect(parsed.kind).toBe('workerV3');
    if (parsed.kind !== 'workerV3') return;
    expect(parsed.payload.history.entries).toEqual([
      { archiveId: 'a1', pageIndex: 2, visitedAt: '2026-09-13 09:35:33.362' },
    ]);
    expect(parsed.payload.watchlist.entries).toEqual([{ archiveId: 'w1', addedAt: '2026-09-04 16:36:57.490' }]);
  });

  it('counts broken rows instead of failing, and still imports the rest', () => {
    const parsed = parseMigrationExport(envelope({
      history: { history: JSON.stringify({ histories: [{ id: 'ok', page: 3, time: 1789292133362 }, { id: '', page: 4, time: 1 }, { id: 'bad', page: -1, time: 1 }, 'junk'] }) },
      watchlist: { watchlist: JSON.stringify({ items: [{ id: 'w1' }, 42] }) },
      dedupe: { dedupe: JSON.stringify(['aaa|bbb', 'same|same', 9]) },
    }));
    expect(parsed.kind).toBe('workerV3');
    if (parsed.kind !== 'workerV3') return;
    expect(parsed.payload.history.entries).toEqual([{ archiveId: 'ok', pageIndex: 3, visitedAt: '2026-09-13 09:35:33.362' }]);
    expect(parsed.payload.history.skipped).toBe(3);
    expect(parsed.payload.watchlist.entries[0]?.archiveId).toBe('w1');
    // 缺 addedAt 的活条目回退为导入时刻，仍满足 added_at NOT NULL。
    expect(parsed.payload.watchlist.entries[0]?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(parsed.payload.watchlist.skipped).toBe(1);
    expect(parsed.payload.dedupe.pairs).toEqual([{ leftArchiveId: 'aaa', rightArchiveId: 'bbb' }]);
    expect(parsed.payload.dedupe.skipped).toBe(2);
  });

  it('rejects a v3 envelope without a server fingerprint', () => {
    const parsed = parseMigrationExport(JSON.stringify({ version: 3, scope: 'token-and-server-md5', sections: {} }));
    expect(parsed).toMatchObject({ kind: 'invalid', reason: '导出内容缺少服务器指纹（serverScope）' });
  });

  it('tells the passphrase-encrypted credential file apart from a data export', () => {
    // 凭据文件有自己的 kind：导入端据此先要口令，而不是把它当记录去导。解不开口令
    // 是原生侧的事，前端只负责分流。
    expect(parseMigrationExport('{"kind":"yomika-credentials","schemaVersion":1,"salt":"c2FsdA==","nonce":"bm9uY2U=","payload":"Y2lwaGVy"}'))
      .toEqual({ kind: 'credentials' });
    expect(parseMigrationExport('{"kind":"yomika-scope-export","schemaVersion":1,"document":{"objects":{}}}'))
      .toEqual({ kind: 'scoped' });
  });

  it('rejects an unknown version field instead of misreading it as legacy', () => {
    expect(parseMigrationExport('{"version":4,"sections":{}}')).toMatchObject({ kind: 'invalid', reason: '不支持的 worker 导出结构' });
  });
});
