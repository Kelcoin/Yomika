import { describe, expect, it } from 'vitest';

import { markLibrarySynced, resetLibrarySyncStateForTests, shouldSyncLibrary } from '../../src/lib/librarySync';

describe('library remote sync throttle', () => {
  it('syncs the first time a server is seen and then holds off for the TTL', () => {
    resetLibrarySyncStateForTests();
    const start = 1_760_000_000_000;

    expect(shouldSyncLibrary('scope-a', start)).toBe(true);
    markLibrarySynced('scope-a', start);

    expect(shouldSyncLibrary('scope-a', start + 60_000)).toBe(false);
    expect(shouldSyncLibrary('scope-a', start + 5 * 60 * 1000)).toBe(true);
  });

  it('tracks servers independently and ignores a missing id', () => {
    resetLibrarySyncStateForTests();
    const start = 1_760_000_000_000;
    markLibrarySynced('scope-a', start);

    expect(shouldSyncLibrary('scope-b', start)).toBe(true);
    expect(shouldSyncLibrary('', start)).toBe(false);
  });
});
