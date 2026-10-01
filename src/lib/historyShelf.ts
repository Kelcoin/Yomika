import type { ArchiveRecord, ReadingHistoryRecord } from '../domain/library';
import { isArchiveFinished } from './archiveCardPresentation';

/** 历史记录在首页「继续阅读」与历史页面里的**共同口径**。
 *
 * 两处读的是同一条 `list_history`，各自再排一次序、各自再过滤一次就会漂移。首页从前
 * 只取列表前六条、再去掉已读完的，于是被隐藏的记录在一排里留下空格：用户的库上前六条
 * 里有一条已读完，那一排只画出五张，而更早的未读完记录明明还有（用户报的「首页与历史
 * 页面记录不一致」）。顺序、解析与已读完过滤现在只有这一份实现。
 *
 * - 顺序：访问时间倒序，和历史页面的时间线同一顺序。
 * - 解析不出档案的记录不算一条：档案可能已经不在本机镜像里。
 * - `hideFinished`：进度超过 95% 的记录不进来（首页那个开关；历史页面固定全显示）。
 * - `limit`：只要前几条（首页那一排是 20 条；历史页面不传，列全量）。
 */
export function historyShelfArchives(
  history: readonly ReadingHistoryRecord[],
  archiveById: ReadonlyMap<string, ArchiveRecord>,
  { hideFinished = false, limit }: { hideFinished?: boolean; limit?: number } = {},
): ArchiveRecord[] {
  const ordered = [...history].sort((left, right) => right.visitedAt.localeCompare(left.visitedAt));
  const visible: ArchiveRecord[] = [];
  for (const item of ordered) {
    const archive = archiveById.get(item.archiveId);
    if (!archive) continue;
    if (hideFinished && isArchiveFinished(archive.pageCount, item.pageIndex + 1)) continue;
    visible.push(archive);
    if (limit !== undefined && visible.length >= limit) break;
  }
  return visible;
}
