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
  /** Approximate retained size, used by the byte budget below. */
  size: number;
}

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
/** Snapshots are written per archive visited (three detail keys each) plus one
 * per recommendation page and one library page, so an unbounded map grew with
 * the library. Mostly small, but a library page holds hundreds of records. */
const MAX_ENTRIES = 64;
/** Big snapshots are the real risk: one library page can be megabytes, so the
 * entry count alone is not a bound. */
const MAX_BYTES = 8 * 1024 * 1024;
/** Depth to walk when measuring; enough to count records without serializing
 * every byte of a large snapshot on each write. */
const SIZE_DEPTH = 3;

const entries = new Map<string, CacheEntry>();
let totalBytes = 0;

function estimateSize(value: unknown, depth = SIZE_DEPTH): number {
  if (value === null || value === undefined) return 8;
  switch (typeof value) {
    case 'string':
      return value.length * 2;
    case 'number':
    case 'bigint':
      return 8;
    case 'boolean':
      return 4;
    default:
      break;
  }
  if (value instanceof Date) return 8;
  if (depth <= 0) return 16;
  if (Array.isArray(value)) {
    let sum = 16;
    for (const item of value) sum += estimateSize(item, depth - 1);
    return sum;
  }
  if (typeof value === 'object') {
    let sum = 16;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      sum += key.length * 2 + estimateSize(item, depth - 1);
    }
    return sum;
  }
  return 0;
}

function dropEntry(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  totalBytes -= entry.size;
  if (totalBytes < 0) totalBytes = 0;
}

/** Insertion order is the eviction order; a read re-inserts its key so the
 * snapshots actually being shown survive a burst of one-off detail visits. */
function evictOverBudget(): void {
  while (entries.size > MAX_ENTRIES || (totalBytes > MAX_BYTES && entries.size > 1)) {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    dropEntry(oldest.value);
  }
}

export function readRouteCache<T>(key: string, maxAgeMs = DEFAULT_MAX_AGE_MS): T | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > maxAgeMs) {
    dropEntry(key);
    return undefined;
  }
  entries.delete(key);
  entries.set(key, entry);
  return entry.value as T;
}

/** Age of a snapshot in milliseconds, or `undefined` if there is none. Lets a
 * route render a slightly older snapshot while still deciding to revalidate. */
export function routeCacheAge(key: string): number | undefined {
  const entry = entries.get(key);
  return entry ? Date.now() - entry.at : undefined;
}

export function writeRouteCache(key: string, value: unknown): void {
  dropEntry(key);
  const entry: CacheEntry = { value, at: Date.now(), size: estimateSize(value) };
  entries.set(key, entry);
  totalBytes += entry.size;
  evictOverBudget();
}

/** Retained byte total, for tests and diagnostics. */
export function routeCacheBytesForTests(): number {
  return totalBytes;
}

export function invalidateRouteCache(prefix?: string): void {
  if (!prefix) {
    entries.clear();
    totalBytes = 0;
  } else {
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) dropEntry(key);
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('yomika:route-cache-invalidated', { detail: { prefix } }));
  }
}

export function resetRouteCacheForTests(): void {
  entries.clear();
  totalBytes = 0;
}
