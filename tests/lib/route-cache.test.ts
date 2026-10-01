import { describe, expect, it, vi } from 'vitest';

import { invalidateRouteCache, readRouteCache, resetRouteCacheForTests, routeCacheBytesForTests, writeRouteCache } from '../../src/lib/routeCache';

describe('route cache', () => {
  it('returns a written snapshot and forgets an aged one', () => {
    resetRouteCacheForTests();
    writeRouteCache('library:workspace', { archives: ['a1'] });

    expect(readRouteCache<{ archives: string[] }>('library:workspace')?.archives).toEqual(['a1']);

    // Snapshots exist to avoid an empty first render, not to serve stale data
    // forever.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    expect(readRouteCache('library:workspace')).toBeUndefined();
    vi.restoreAllMocks();

    expect(readRouteCache('never:written')).toBeUndefined();
  });

  it('keeps a bounded number of snapshots, dropping the oldest first', () => {
    resetRouteCacheForTests();
    // A detail snapshot is written per archive visited (three keys each), plus one
    // per recommendation page: without a bound this map grows with the library.
    for (let index = 0; index < 500; index += 1) writeRouteCache(`archive-detail:server:${index}`, { title: `archive ${index}` });

    expect(readRouteCache('archive-detail:server:0')).toBeUndefined();
    expect(readRouteCache('archive-detail:server:499')).toEqual({ title: 'archive 499' });
  });

  it('keeps a bounded number of bytes, not just a bounded number of snapshots', () => {
    resetRouteCacheForTests();
    // One library snapshot is a page of records and can be huge, so an entry cap
    // alone is not a bound. The count here is deliberately below the entry cap:
    // only a byte budget can evict under it.
    const heavy = { archives: 'x'.repeat(1_000_000) };
    for (let index = 0; index < 24; index += 1) writeRouteCache(`library:${index}`, heavy);

    // 24 entries of about 2MB each: the retained total has to come back under
    // the budget rather than sitting at the ~48MB that were written.
    expect(routeCacheBytesForTests()).toBeLessThan(24 * 2_000_000);
    expect(readRouteCache('library:0')).toBeUndefined();
    expect(readRouteCache('library:23')).toEqual(heavy);
  });

  it('invalidates by prefix and wholesale', () => {
    resetRouteCacheForTests();
    writeRouteCache('library:workspace', 1);
    writeRouteCache('detail:a1', 2);
    writeRouteCache('detail:a2', 3);

    invalidateRouteCache('detail:');
    expect(readRouteCache('library:workspace')).toBe(1);
    expect(readRouteCache('detail:a1')).toBeUndefined();
    expect(readRouteCache('detail:a2')).toBeUndefined();

    invalidateRouteCache();
    expect(readRouteCache('library:workspace')).toBeUndefined();
  });
});
