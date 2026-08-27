import { describe, expect, it } from 'vitest';
import { parseLegacyExport } from '../../src/domain/legacyImport';

describe('legacy import boundary', () => {
  it('imports history/watchlist/dedupe records and strips credentials', () => {
    const result = parseLegacyExport(JSON.stringify({
      history: [{ archiveId: 'a1', pageIndex: 4 }],
      watchlist: [{ archiveId: 'a2', deleted: false }],
      nonDuplicate: [{ path: 'C:/a.cbz', hash: 'abc' }],
      apiKey: 'secret', cookie: 'session-secret',
    }));
    expect(result).toEqual({
      history: [{ archiveId: 'a1', pageIndex: 4 }],
      watchlist: [{ archiveId: 'a2', deleted: false }],
      dedupe: [{ path: 'C:/a.cbz', hash: 'abc' }],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects malformed export without partial records', () => {
    expect(() => parseLegacyExport('{"history":[{"pageIndex":-1}]}')).toThrow('Invalid legacy export');
  });
});
