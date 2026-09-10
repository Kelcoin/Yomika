/** Cross-route snapshots so switching pages and coming back does not start from
 * an empty screen — and, while a snapshot is fresh, does not refetch either.
 *
 * This used to be deliberately stale-while-revalidate: render the snapshot and
 * refresh anyway, on the grounds that the request was a local SQLite query.
 * The library list now comes from LANraragi over HTTP, so a refresh on every
 * mount is a round trip the user pays for each time they switch tabs. A route
 * reads its snapshot with a max age it chooses, and skips the fetch while that
 * holds; anything older revalidates as before.
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

/** Age of a snapshot in milliseconds, or `undefined` if there is none. Lets a
 * route render a slightly older snapshot while still deciding to revalidate. */
export function routeCacheAge(key: string): number | undefined {
  const entry = entries.get(key);
  return entry ? Date.now() - entry.at : undefined;
}

export function writeRouteCache(key: string, value: unknown): void {
  entries.set(key, { value, at: Date.now() });
}

export function invalidateRouteCache(prefix?: string): void {
  if (!prefix) {
    entries.clear();
  } else {
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('yomika:route-cache-invalidated', { detail: { prefix } }));
  }
}

export function resetRouteCacheForTests(): void {
  entries.clear();
}
