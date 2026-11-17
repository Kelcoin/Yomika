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
export async function loadFavoriteArchives(serverId: string, ids: readonly string[]): Promise<ArchiveRecord[]> {
  const unique = [...new Set(ids)];
  const cached = await repository.listArchivesByIds(serverId, unique, { resolveMissing: false });
  if (!cached.ok) throw new Error(cached.error.message);
  const membership = new Set(unique);
  const records = new Map(cached.value.filter(a => membership.has(a.archiveId)).map(a => [a.archiveId, a]));
  const missing = unique.filter(id => !records.has(id));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (cursor < missing.length) {
      const id = missing[cursor++]!;
      const metadata = await repository.loadArchiveMetadata(serverId, id);
      if (!metadata.ok) {
        if (metadata.error.code === 'LRR_NOT_FOUND') continue;
        throw new Error(metadata.error.message);
      }
      const value = metadata.value;
      records.set(id, { serverId, archiveId: id, title: value.title, pageCount: value.pageCount,
        fileSize: value.size, tags: value.tags.split(',').map(tag => tag.trim()).filter(Boolean), updatedAt: new Date().toISOString() });
    }
  }));
  return unique.map(id => records.get(id)).filter((record): record is ArchiveRecord => Boolean(record));
}
