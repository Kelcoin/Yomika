import { describe, expect, it } from 'vitest';

import { mergeHistory, mergeReadingProgress, mergeWatchlist, type Versioned } from '../../src/domain/sync';

function versioned<T>(payload: T, logicalClock: number, deviceId: string, wallClock = '2026-08-26T00:00:00.000Z'): Versioned<T> {
  return { payload, logicalClock, deviceId, wallClock };
}

describe('sync merge policies', () => {
  it('rejects cross-device reading progress regression by default', () => {
    const local = versioned({ archiveId: 'a1', pageIndex: 8, pageCount: 20 }, 4, 'device-a');
    const remote = versioned({ archiveId: 'a1', pageIndex: 3, pageCount: 20 }, 5, 'device-b');

    expect(mergeReadingProgress(local, remote)).toEqual({ value: local, conflict: remote });
  });

  it('uses logical clock, wall clock, then device id for progress', () => {
    const older = versioned({ archiveId: 'a1', pageIndex: 4, pageCount: 20 }, 4, 'device-z', '2026-08-26T00:00:00.000Z');
    const newer = versioned({ archiveId: 'a1', pageIndex: 6, pageCount: 20 }, 4, 'device-a', '2026-08-26T01:00:00.000Z');
    expect(mergeReadingProgress(older, newer).value).toEqual(newer);

    const tieA = versioned({ archiveId: 'a1', pageIndex: 6, pageCount: 20 }, 4, 'device-a');
    const tieB = versioned({ archiveId: 'a1', pageIndex: 7, pageCount: 20 }, 4, 'device-b');
    expect(mergeReadingProgress(tieA, tieB).value).toEqual(tieB);
  });

  it('orders wall clocks by instant, not by printed digits', () => {
    // 02:00+08:00 is Aug 25 18:00Z, i.e. older than 01:00Z on Aug 26, even
    // though it sorts later as a string.
    const local = versioned({ archiveId: 'a1', pageIndex: 5, pageCount: 20 }, 4, 'device-a', '2026-08-26T02:00:00+08:00');
    const remote = versioned({ archiveId: 'a1', pageIndex: 5, pageCount: 20 }, 4, 'device-b', '2026-08-26T01:00:00Z');

    expect(mergeReadingProgress(local, remote).value).toEqual(remote);
  });

  it('keeps the maximum history page and latest visit', () => {
    expect(mergeHistory(
      { archiveId: 'a1', pageIndex: 9, visitedAt: '2026-08-25T00:00:00Z' },
      { archiveId: 'a1', pageIndex: 3, visitedAt: '2026-08-26T00:00:00Z' },
    )).toEqual({ archiveId: 'a1', pageIndex: 9, visitedAt: '2026-08-26T00:00:00Z' });
  });

  it('keeps the later visit across mixed timestamp offsets', () => {
    expect(mergeHistory(
      { archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-26T02:00:00+08:00' },
      { archiveId: 'a1', pageIndex: 4, visitedAt: '2026-08-26T01:00:00Z' },
    ).visitedAt).toBe('2026-08-26T01:00:00Z');
  });

  it('keeps a watchlist tombstone over stale adds but permits a newer explicit re-add', () => {
    const add = versioned({ archiveId: 'a1', deleted: false }, 3, 'device-a');
    const remove = versioned({ archiveId: 'a1', deleted: true }, 4, 'device-b');
    const reAdd = versioned({ archiveId: 'a1', deleted: false }, 5, 'device-a');

    expect(mergeWatchlist(add, remove)).toEqual(remove);
    expect(mergeWatchlist(remove, add)).toEqual(remove);
    expect(mergeWatchlist(remove, reAdd)).toEqual(reAdd);
  });
});
