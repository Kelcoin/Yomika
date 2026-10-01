/** Thumbnails are data URLs keyed by scope + archive, so the map grew with the
 * library. Both a count and a byte budget are needed: one cover can be a few
 * hundred kilobytes, and a big library would still blow past a count cap. */
const MAX_ENTRIES = 64;
const MAX_BYTES = 4 * 1024 * 1024;

const cache = new Map<string, string>();
const pending = new Map<string, { startedAt: number; promise: Promise<string | undefined> }>();
let totalBytes = 0;

function dropOldest(): void {
  while (cache.size > MAX_ENTRIES || (totalBytes > MAX_BYTES && cache.size > 1)) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    const value = cache.get(oldest.value);
    cache.delete(oldest.value);
    totalBytes -= value?.length ?? 0;
    if (totalBytes < 0) totalBytes = 0;
  }
}

function store(key: string, value: string): void {
  const previous = cache.get(key);
  if (previous !== undefined) totalBytes -= previous.length;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  totalBytes += value.length;
  dropOldest();
}

export function getThumbnail(scopeId: string, archiveId: string): string | undefined {
  return cache.get(`${scopeId}:${archiveId}`);
}

export function setThumbnail(scopeId: string, archiveId: string, value: string): void {
  store(`${scopeId}:${archiveId}`, value);
}

export function resetThumbnailCacheForTests(): void {
  cache.clear();
  pending.clear();
  totalBytes = 0;
}

export function loadThumbnailOnce(key: string, loader: () => Promise<string | undefined>): Promise<string | undefined> {
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  // A disconnected view must not leave an unresolved request blocking every
  // later consumer. Reuse only recent in-flight requests.
  if (existing && Date.now() - existing.startedAt < 2000) return existing.promise;
  const request = loader().then((value) => {
    if (value) store(key, value);
    return value;
  });
  const entry = { startedAt: Date.now(), promise: request };
  pending.set(key, entry);
  const clear = () => {
    if (pending.get(key) === entry) pending.delete(key);
  };
  void request.then(clear, clear);
  return request;
}
