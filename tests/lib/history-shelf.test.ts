import { describe, expect, it } from 'vitest';

import type { ArchiveRecord, ReadingHistoryRecord } from '../../src/domain/library';
import { historyShelfArchives } from '../../src/lib/historyShelf';

const archive = (archiveId: string, pageCount: number) => ({
  serverId: 's', archiveId, title: `档案${archiveId}`, pageCount, updatedAt: '2026-09-01T00:00:00Z',
} satisfies ArchiveRecord);

const entry = (archiveId: string, pageIndex: number, visitedAt: string) => ({
  scopeId: 's', archiveId, pageIndex, visitedAt, deviceId: 'device-a', revision: 1,
} satisfies ReadingHistoryRecord);

const byId = (archives: readonly ArchiveRecord[]) => new Map(archives.map((item) => [item.archiveId, item]));

describe('history shelf derivation', () => {
  it('reads newest first, whatever order the rows arrive in', () => {
    // 首页和历史页面共用这一条口径：两边排出来的顺序必须一样，否则同一批记录在两页里
    // 是不同的次序。
    const history = [
      entry('older', 1, '2026-08-01T00:00:00Z'),
      entry('newer', 2, '2026-09-01T00:00:00Z'),
      entry('middle', 3, '2026-08-15T00:00:00Z'),
    ];
    const archives = byId([archive('older', 10), archive('newer', 10), archive('middle', 10)]);
    expect(historyShelfArchives(history, archives).map((item) => item.archiveId)).toEqual(['newer', 'middle', 'older']);
  });

  it('drops a record whose archive is not in the local mirror', () => {
    const history = [entry('resolved', 1, '2026-09-01T00:00:00Z'), entry('gone', 1, '2026-08-01T00:00:00Z')];
    const archives = byId([archive('resolved', 10)]);
    expect(historyShelfArchives(history, archives).map((item) => item.archiveId)).toEqual(['resolved']);
  });

  it('hides finished records and keeps filling the limit from further down', () => {
    // 用户报的那一条：真实库上前六条里就有一条已读完，于是首页那一排只画出五张，更早的
    // 未读完记录永远补不上来。隐藏已读完之后，「一排」是过滤之后的前六条，不是前六条
    // 过滤之后剩下的。
    const history = [
      entry('done', 11, '2026-09-08T00:00:00Z'),
      entry('b', 1, '2026-09-07T00:00:00Z'),
      entry('c', 1, '2026-09-06T00:00:00Z'),
      entry('d', 1, '2026-09-05T00:00:00Z'),
      entry('e', 1, '2026-09-04T00:00:00Z'),
      entry('f', 1, '2026-09-03T00:00:00Z'),
      entry('g', 1, '2026-09-02T00:00:00Z'),
    ];
    const archives = byId(history.map((item) => archive(item.archiveId, 12)));
    expect(historyShelfArchives(history, archives, { hideFinished: true, limit: 6 }).map((item) => item.archiveId))
      .toEqual(['b', 'c', 'd', 'e', 'f', 'g']);
    // 反过来：开关开着（默认）时，已读完的照样在，排在最前。
    expect(historyShelfArchives(history, archives, { limit: 6 }).map((item) => item.archiveId))
      .toEqual(['done', 'b', 'c', 'd', 'e', 'f']);
  });

  it('counts a record saved one page short of the end as finished', () => {
    // 95% 的宽限（见 isArchiveFinished）：双页展的尾页可能丢一次保存，200 页读到 191 页
    // 就算读完；停在 190 页（正好 95%）不算。
    const history = [entry('short', 190, '2026-09-01T00:00:00Z'), entry('exact', 189, '2026-08-15T00:00:00Z'), entry('mid', 100, '2026-08-01T00:00:00Z')];
    const archives = byId(history.map((item) => archive(item.archiveId, 200)));
    expect(historyShelfArchives(history, archives, { hideFinished: true }).map((item) => item.archiveId))
      .toEqual(['exact', 'mid']);
  });

  it('keeps the whole list when no limit is asked for (the history page)', () => {
    const history = [entry('a', 1, '2026-09-01T00:00:00Z'), entry('b', 1, '2026-08-01T00:00:00Z')];
    const archives = byId([archive('a', 10), archive('b', 10)]);
    expect(historyShelfArchives(history, archives)).toHaveLength(2);
  });
});
