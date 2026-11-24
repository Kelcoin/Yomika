import { describe, expect, it } from 'vitest';
import {
  BRIDGE_TRANSFER_KIND,
  BRIDGE_TRANSFER_VERSION,
  buildBridgeTransfer,
  isoTimestamp,
  nonDuplicatePair,
  parseBridgeTransfer,
  type BridgeTransferState,
} from '../../src/lib/bridgeDataTransfer';

const state = (over: Partial<BridgeTransferState> & { archiveId: string }): BridgeTransferState => ({
  historyAt: null,
  watchlistAt: null,
  progress: null,
  ...over,
});

describe('isoTimestamp', () => {
  it('keeps an ISO instant and folds the SQLite spelling into the same one', () => {
    // 插件写 ISO，旧行写空格：两种都得折成同一种，否则字典序会把 'T' 排到 ' ' 之后。
    expect(isoTimestamp('2026-09-13T09:35:33.362Z')).toBe('2026-09-13T09:35:33.362Z');
    expect(isoTimestamp('2026-09-13 09:35:33.362')).toBe('2026-09-13T09:35:33.362Z');
    expect(isoTimestamp('2026-09-13 09:35:33')).toBe('2026-09-13T09:35:33.000Z');
  });

  it('drops what it cannot read instead of writing a value that sorts wrong', () => {
    expect(isoTimestamp('')).toBeUndefined();
    expect(isoTimestamp('   ')).toBeUndefined();
    expect(isoTimestamp('yesterday')).toBeUndefined();
    expect(isoTimestamp(1789292133362)).toBeUndefined();
    expect(isoTimestamp(null)).toBeUndefined();
  });
});

describe('nonDuplicatePair', () => {
  it('orders the halves the way the plugin key wants them', () => {
    expect(nonDuplicatePair('bbb', 'aaa')).toEqual({ archiveIdA: 'aaa', archiveIdB: 'bbb' });
    expect(nonDuplicatePair('aaa', 'bbb')).toEqual({ archiveIdA: 'aaa', archiveIdB: 'bbb' });
  });

  it('refuses a pair it could not key', () => {
    expect(nonDuplicatePair('aaa', 'aaa')).toBeUndefined();
    expect(nonDuplicatePair('', 'bbb')).toBeUndefined();
    expect(nonDuplicatePair('aaa', '')).toBeUndefined();
  });
});

describe('buildBridgeTransfer', () => {
  it('reads history and watchlist off the hosted state and sorts newest first', () => {
    const document = buildBridgeTransfer({
      scopeId: 'scope-a',
      states: [
        state({ archiveId: 'a1', historyAt: '2026-09-13 09:35:33.362', watchlistAt: '2026-09-01 08:00:00.000', historyPageIndex: 148 }),
        state({ archiveId: 'a2', historyAt: '2026-09-14T10:00:00.000Z', progress: { pageIndex: 7 } }),
        state({ archiveId: 'a3', watchlistAt: '2026-09-02 08:00:00.000' }),
        state({ archiveId: 'a4' }),
      ],
      pairs: [{ archiveIdA: 'aaa', archiveIdB: 'bbb' }, { archiveIdA: 'aaa', archiveIdB: 'bbb' }],
      exportedAt: '2026-09-15T00:00:00.000Z',
    });

    expect(document.kind).toBe(BRIDGE_TRANSFER_KIND);
    expect(document.version).toBe(BRIDGE_TRANSFER_VERSION);
    expect(document.serverScope).toBe('scope-a');
    expect(document.exportedAt).toBe('2026-09-15T00:00:00.000Z');
    // 历史按时间倒序；页码优先取 historyPageIndex，没有才回落进度。
    expect(document.history).toEqual([
      { archiveId: 'a2', pageIndex: 7, visitedAt: '2026-09-14T10:00:00.000Z' },
      { archiveId: 'a1', pageIndex: 148, visitedAt: '2026-09-13T09:35:33.362Z' },
    ]);
    expect(document.watchlist).toEqual([
      { archiveId: 'a3', addedAt: '2026-09-02T08:00:00.000Z' },
      { archiveId: 'a1', addedAt: '2026-09-01T08:00:00.000Z' },
    ]);
    // 同一对只写一次：插件的键是 a:b，重复写只是白跑一趟。
    expect(document.nonDuplicates).toEqual([{ archiveIdA: 'aaa', archiveIdB: 'bbb' }]);
  });
});

describe('parseBridgeTransfer', () => {
  it('round-trips its own file', () => {
    const document = buildBridgeTransfer({
      scopeId: 'scope-a',
      states: [state({ archiveId: 'a1', historyAt: '2026-09-13 09:35:33.362', historyPageIndex: 148 })],
      pairs: [{ archiveIdA: 'aaa', archiveIdB: 'bbb' }],
      exportedAt: '2026-09-15T00:00:00.000Z',
    });
    const parsed = parseBridgeTransfer(JSON.stringify(document));
    expect(parsed.kind).toBe('transfer');
    if (parsed.kind !== 'transfer') return;
    expect(parsed.payload).toEqual(document);
  });

  it('takes a readoshi worker v3 export as legacy input', () => {
    // 旧的 worker 导出还是那三类数据，只是从前写本地、现在写插件。
    const parsed = parseBridgeTransfer(JSON.stringify({
      version: 3,
      scope: 'token-and-server-md5',
      serverScope: 'f4fe9bbfa7d17b5bcd601ca76192b539',
      exportedAt: '2026-09-13T12:21:55.353Z',
      sections: {
        history: { history: JSON.stringify({ histories: [{ id: 'a1', page: 148, time: 1789292133362 }] }) },
        watchlist: { watchlist: JSON.stringify({ items: [{ id: 'w1', addedAt: 1788539817490 }] }) },
        dedupe: { dedupe: JSON.stringify(['bbb|aaa']) },
      },
    }));
    expect(parsed.kind).toBe('legacy');
    if (parsed.kind !== 'legacy') return;
    expect(parsed.payload.serverScope).toBe('f4fe9bbfa7d17b5bcd601ca76192b539');
    expect(parsed.payload.history).toEqual([
      { archiveId: 'a1', pageIndex: 148, visitedAt: '2026-09-13T09:35:33.362Z' },
    ]);
    expect(parsed.payload.watchlist).toEqual([
      { archiveId: 'w1', addedAt: '2026-09-04T16:36:57.490Z' },
    ]);
    // 旧文件里那一对是反着写的，落点照样按 a<b 归一。
    expect(parsed.payload.nonDuplicates).toEqual([{ archiveIdA: 'aaa', archiveIdB: 'bbb' }]);
  });

  it('takes a unified app export as legacy input', () => {
    const parsed = parseBridgeTransfer(JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-09-13T12:21:55.353Z',
      scopeId: 'scope-a',
      items: [{ archiveId: 'a1', pageIndex: 12, visitedAt: '2026-09-13T09:35:33.362Z' }],
      readingList: [{ archiveId: 'w1', addedAt: '2026-09-04T16:36:57.490Z' }],
    }));
    expect(parsed.kind).toBe('legacy');
    if (parsed.kind !== 'legacy') return;
    expect(parsed.payload.serverScope).toBe('scope-a');
    expect(parsed.payload.history).toEqual([
      { archiveId: 'a1', pageIndex: 12, visitedAt: '2026-09-13T09:35:33.362Z' },
    ]);
    expect(parsed.payload.watchlist).toEqual([
      { archiveId: 'w1', addedAt: '2026-09-04T16:36:57.490Z' },
    ]);
  });

  it('names what is wrong instead of writing half a document', () => {
    expect(parseBridgeTransfer('not json')).toEqual({ kind: 'invalid', reason: '不是一份 JSON 文件' });
    expect(parseBridgeTransfer(JSON.stringify({ hello: 'world' })).kind).toBe('invalid');
  });
});
