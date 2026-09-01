const cache = new Map<string, string>();
const pending = new Map<string, { startedAt: number; promise: Promise<string | undefined> }>();

export function getThumbnail(scopeId: string, archiveId: string): string | undefined {
  return cache.get(`${scopeId}:${archiveId}`);
}

export function setThumbnail(scopeId: string, archiveId: string, value: string): void {
  cache.set(`${scopeId}:${archiveId}`, value);
}

export function resetThumbnailCacheForTests(): void {
  cache.clear();
  pending.clear();
}

export function loadThumbnailOnce(key: string, loader: () => Promise<string | undefined>): Promise<string | undefined> {
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  // A disconnected view must not leave an unresolved request blocking every
  // later consumer. Reuse only recent in-flight requests.
  if (existing && Date.now() - existing.startedAt < 2000) return existing.promise;
  const request = loader().then((value) => {
    if (value) cache.set(key, value);
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
