/** Throttle for the background "pull the remote index" pass.
 *
 * The library route reads the local SQLite index, so an archive added in
 * LANraragi after the last sync stays invisible until something refreshes.
 * Syncing on every mount would re-hit the server each time the user switches
 * routes, so remember the last successful sync per server.
 */
const REMOTE_SYNC_TTL_MS = 5 * 60 * 1000;
const lastSyncedAt = new Map<string, number>();

export function shouldSyncLibrary(serverId: string, now = Date.now()): boolean {
  if (!serverId) return false;
  const last = lastSyncedAt.get(serverId);
  return last === undefined || now - last >= REMOTE_SYNC_TTL_MS;
}

export function markLibrarySynced(serverId: string, now = Date.now()): void {
  if (serverId) lastSyncedAt.set(serverId, now);
}

export function resetLibrarySyncStateForTests(): void {
  lastSyncedAt.clear();
}
