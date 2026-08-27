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
    visitedAt: local.visitedAt >= remote.visitedAt ? local.visitedAt : remote.visitedAt,
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

function compareVersion<T>(left: Versioned<T>, right: Versioned<T>): number {
  if (left.logicalClock !== right.logicalClock) return left.logicalClock - right.logicalClock;
  const wallClockOrder = left.wallClock.localeCompare(right.wallClock);
  return wallClockOrder !== 0 ? wallClockOrder : left.deviceId.localeCompare(right.deviceId);
}
