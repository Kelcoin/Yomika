import { describe, expect, it } from 'vitest';

import { markCategoriesRefreshed, resetLibrarySyncStateForTests, shouldRefreshCategories } from '../../src/lib/librarySync';

describe('category refresh throttle', () => {
  it('refreshes the first time a server is seen and then holds off for the TTL', () => {
    resetLibrarySyncStateForTests();
    const start = 1_760_000_000_000;

    expect(shouldRefreshCategories('scope-a', start)).toBe(true);
    markCategoriesRefreshed('scope-a', start);

    expect(shouldRefreshCategories('scope-a', start + 60_000)).toBe(false);
    expect(shouldRefreshCategories('scope-a', start + 5 * 60 * 1000)).toBe(true);
  });

  it('tracks servers independently and ignores a missing id', () => {
    resetLibrarySyncStateForTests();
    const start = 1_760_000_000_000;
    markCategoriesRefreshed('scope-a', start);

    expect(shouldRefreshCategories('scope-b', start)).toBe(true);
    expect(shouldRefreshCategories('', start)).toBe(false);
  });
});
