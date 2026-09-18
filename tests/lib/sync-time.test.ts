import { describe, expect, it } from 'vitest';

import { formatSyncAge, parseSyncTimestamp } from '../../src/lib/syncTime';

describe('sync time', () => {
  it('reads the native UTC stamp, not the local clock', () => {
    // SQLite 的 CURRENT_TIMESTAMP 是 UTC 且不带 Z；当成当地时间会差出一个时区。
    expect(parseSyncTimestamp('2026-09-17 10:00:00')).toBe(Date.parse('2026-09-17T10:00:00Z'));
    expect(parseSyncTimestamp('2026-09-17T10:00:00.000Z')).toBe(Date.parse('2026-09-17T10:00:00Z'));
    expect(parseSyncTimestamp(null)).toBeUndefined();
    expect(parseSyncTimestamp('不是时间')).toBeUndefined();
  });

  it('says how long ago the last sync was', () => {
    const now = Date.parse('2026-09-17T12:00:00Z');
    expect(formatSyncAge(null, now)).toBe('还没同步过');
    expect(formatSyncAge('2026-09-17 11:59:30', now)).toBe('刚刚同步');
    expect(formatSyncAge('2026-09-17 11:30:00', now)).toBe('30 分钟前同步');
    expect(formatSyncAge('2026-09-17 09:00:00', now)).toBe('3 小时前同步');
    expect(formatSyncAge('2026-09-15 12:00:00', now)).toBe('2 天前同步');
  });
});
