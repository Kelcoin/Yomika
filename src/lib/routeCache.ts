/** Cross-route snapshots so switching pages and coming back does not start from
 * an empty screen.
 *
 * Deliberately stale-while-revalidate: a mounted route renders the snapshot
 * immediately *and* still refreshes in the background. Skipping the refresh
 * would trade a flicker for stale data, and the request itself is already
 * cheap (the archive list is a local SQLite query).
 */
interface CacheEntry {
  value: unknown;
  at: number;
}

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
const entries = new Map<string, CacheEntry>();

export function readRouteCache<T>(key: string, maxAgeMs = DEFAULT_MAX_AGE_MS): T | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > maxAgeMs) {
    entries.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function writeRouteCache(key: string, value: unknown): void {
  entries.set(key, { value, at: Date.now() });
}

export function invalidateRouteCache(prefix?: string): void {
  if (!prefix) {
    entries.clear();
    return;
  }
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

export function resetRouteCacheForTests(): void {
  entries.clear();
}
