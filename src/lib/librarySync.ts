/** Throttles the passes that ask LANraragi for something whole-library shaped.
 *
 * The library list reads LANraragi directly and pages, so there is no longer a
 * background "pull the remote index" step to throttle — the offline mirror is
 * rebuilt only when the user asks for it, and the shelves confirm the handful of
 * ids they are about to show instead (see lib/archiveExistence.ts). What remains
 * here is the category pass: listing categories resolves every dynamic category
 * through an unpaged `/api/search`, so re-running it on every navigation is a
 * burst of full-library parses on the server.
 */
const REMOTE_SYNC_TTL_MS = 5 * 60 * 1000;

const lastCategoriesAt = new Map<string, number>();

export function shouldRefreshCategories(serverId: string, now = Date.now()): boolean {
  if (!serverId) return false;
  const last = lastCategoriesAt.get(serverId);
  return last === undefined || now - last >= REMOTE_SYNC_TTL_MS;
}

export function markCategoriesRefreshed(serverId: string, now = Date.now()): void {
  if (serverId) lastCategoriesAt.set(serverId, now);
}

export function resetLibrarySyncStateForTests(): void {
  lastCategoriesAt.clear();
}
