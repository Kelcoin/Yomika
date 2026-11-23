import type { ArchiveRecord } from '../domain/library';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
const repository = new NativeLibraryRepository();

/** Favorites has one authority: the server category. Failures never become local success. */
export async function mirrorFavorites(serverId: string, archiveIds: readonly string[], next: boolean): Promise<number> {
  if (!archiveIds.length) return 0;
  try {
    const favorites = await repository.readFavoritesCategory(serverId);
    if (!favorites.ok || !favorites.value) return archiveIds.length;
    const results = await Promise.allSettled(archiveIds.map(id => next
      ? repository.addArchiveToCategory(serverId, favorites.value!.id, id)
      : repository.removeArchiveFromCategory(serverId, favorites.value!.id, id)));
    return results.filter(result => result.status === 'rejected' || !result.value.ok).length;
  } catch { return archiveIds.length; }
}

/** Resolve remote-only favorites without unbounded parallel metadata requests. */
export async function loadFavoriteArchives(serverId: string, ids: readonly string[], categoryId?: string, options: { onAvailable?: (archives: ArchiveRecord[]) => void; signal?: AbortSignal } = {}): Promise<ArchiveRecord[]> {
  const unique = [...new Set(ids)];
  const cached = await repository.listArchivesByIds(serverId, unique, { resolveMissing: false });
  if (!cached.ok) throw new Error(cached.error.message);
  const { signal, onAvailable } = options;
  const membership = new Set(unique);
  const records = new Map(cached.value.filter(a => membership.has(a.archiveId)).map(a => [a.archiveId, a]));
  if (!signal?.aborted && records.size) onAvailable?.([...records.values()]);
  // A cold static shelf may have hundreds of members. Populate the mirror in
  // pages before resolving outliers (including archives absent from search).
  if (categoryId && unique.length - records.size > 4) {
    let start = 0;
    for (let page = 0; !signal?.aborted && page < 4 && records.size < unique.length; page++) {
      const result = await repository.searchArchivesPage(serverId, start, { categoryId });
      if (!result.ok || signal?.aborted) break;
      const available = result.value.items.filter(archive => membership.has(archive.archiveId));
      for (const archive of available) records.set(archive.archiveId, archive);
      if (available.length) onAvailable?.(available);
      if (!result.value.hasMore || result.value.items.length === 0) break;
      start += result.value.items.length;
    }
  }
  const missing = unique.filter(id => !records.has(id));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (!signal?.aborted && cursor < missing.length) {
      const id = missing[cursor++]!;
      const metadata = await repository.loadArchiveMetadata(serverId, id);
      if (signal?.aborted) return;
      if (!metadata.ok) {
        if (metadata.error.code === 'LRR_NOT_FOUND') continue;
        throw new Error(metadata.error.message);
      }
      const value = metadata.value;
      const archive = { serverId, archiveId: id, title: value.title, pageCount: value.pageCount,
        fileSize: value.size, tags: value.tags.split(',').map(tag => tag.trim()).filter(Boolean), updatedAt: new Date().toISOString() };
      records.set(id, archive);
      onAvailable?.([archive]);
    }
  }));
  return unique.map(id => records.get(id)).filter((record): record is ArchiveRecord => Boolean(record));
}
