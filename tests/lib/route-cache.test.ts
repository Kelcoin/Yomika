import { describe, expect, it, vi } from 'vitest';

import { invalidateRouteCache, readRouteCache, resetRouteCacheForTests, writeRouteCache } from '../../src/lib/routeCache';

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
