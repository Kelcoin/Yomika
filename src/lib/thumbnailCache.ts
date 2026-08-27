const cache = new Map<string, string>();

export function getThumbnail(scopeId: string, archiveId: string): string | undefined {
  return cache.get(`${scopeId}:${archiveId}`);
}

export function setThumbnail(scopeId: string, archiveId: string, value: string): void {
  cache.set(`${scopeId}:${archiveId}`, value);
}

export function resetThumbnailCacheForTests(): void {
  cache.clear();
}
