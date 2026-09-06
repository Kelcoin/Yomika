export interface Versioned<T> {
  payload: T;
  logicalClock: number;
  wallClock: string;
  deviceId: string;
}

export interface ProgressPayload {
  archiveId: string;
  pageIndex: number;
  pageCount: number;
}

export interface MergeResult<T> {
  value: Versioned<T>;
  conflict?: Versioned<T>;
}

export function mergeReadingProgress(
  local: Versioned<ProgressPayload>,
  remote: Versioned<ProgressPayload>,
): MergeResult<ProgressPayload> {
  const [winner, loser] = compareVersion(local, remote) >= 0 ? [local, remote] : [remote, local];
  const crossDeviceRegression = winner.deviceId !== loser.deviceId && winner.payload.pageIndex < loser.payload.pageIndex;
  return crossDeviceRegression ? { value: loser, conflict: winner } : { value: winner };
}

export interface HistoryRecord {
  archiveId: string;
  pageIndex: number;
  visitedAt: string;
}

export function mergeHistory(local: HistoryRecord, remote: HistoryRecord): HistoryRecord {
  if (local.archiveId !== remote.archiveId) throw new Error('Cannot merge history for different archives');
  return {
    archiveId: local.archiveId,
    pageIndex: Math.max(local.pageIndex, remote.pageIndex),
    visitedAt: compareTimestamp(local.visitedAt, remote.visitedAt) >= 0 ? local.visitedAt : remote.visitedAt,
  };
}

export interface WatchlistPayload {
  archiveId: string;
  deleted: boolean;
}

export function mergeWatchlist(
  local: Versioned<WatchlistPayload>,
  remote: Versioned<WatchlistPayload>,
): Versioned<WatchlistPayload> {
  if (local.payload.archiveId !== remote.payload.archiveId) throw new Error('Cannot merge watchlist entries for different archives');
  return compareVersion(local, remote) >= 0 ? local : remote;
}

/** Compares two wall clocks as instants. Lexical comparison only happens to work
 * while every writer emits the same `Z` format; a record carrying a `+08:00`
 * offset would otherwise sort by its printed digits instead of its instant. */
function compareTimestamp(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return left < right ? -1 : left > right ? 1 : 0;
  return leftTime - rightTime;
}

function compareVersion<T>(left: Versioned<T>, right: Versioned<T>): number {
  if (left.logicalClock !== right.logicalClock) return left.logicalClock - right.logicalClock;
  const wallClockOrder = compareTimestamp(left.wallClock, right.wallClock);
  return wallClockOrder !== 0 ? wallClockOrder : left.deviceId.localeCompare(right.deviceId);
}
