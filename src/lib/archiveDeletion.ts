import type { ArchiveRecord } from '../domain/library';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { invalidateRouteCache } from './routeCache';

// Keep this policy aligned with favorite_sync_satisfied in commands/library.rs
// (dedup deletion). Missing galleries cannot be unfavorited through a live page;
// authentication, access challenges and transient outages are still failures.
function missingEhGallery(code: string): boolean {
  return code === 'EH_GALLERY_DELETED' || code === 'EH_GALLERY_COPYRIGHT_REMOVED';
}

export function ehGalleryFromTags(tags: readonly string[]) {
  for (const tag of tags) {
    const normalized = tag.trim();
    if (!/^source\s*:/i.test(normalized)) continue;
    const source = normalized.replace(/^source\s*:/i, '').trim();
    try {
      const url = new URL(/^https?:\/\//i.test(source) ? source : `https://${source}`);
      if (!['e-hentai.org', 'exhentai.org'].includes(url.hostname) || !['https:', 'http:'].includes(url.protocol)) continue;
      const match = /^\/g\/(\d+)\/([a-f0-9]+)\/?$/i.exec(url.pathname);
      if (match) return { galleryId: match[1]!, token: match[2]! };
    } catch { /* A non-gallery source does not identify an E-Hentai favorite. */ }
  }
  return undefined;
}

export async function deleteArchiveWithFavoriteSync(archive: Pick<ArchiveRecord, 'serverId' | 'archiveId'>, syncFavorite: boolean) {
  const library = new NativeLibraryRepository();
  if (syncFavorite) {
    // Use saved metadata, not an edited or stale card's source tag.
    const metadata = await library.loadArchiveMetadata(archive.serverId, archive.archiveId);
    if (!metadata.ok) throw new Error(metadata.error.message);
    const gallery = ehGalleryFromTags(metadata.value.tags.split(','));
    if (gallery) {
      const eh = new NativeEhRepository();
      const accounts = await eh.listAccounts();
      if (!accounts.ok) throw new Error(accounts.error.message);
      const account = accounts.value.find((account) => account.isActive);
      if (!account) throw new Error('请先登录 E-Hentai，或关闭本次收藏同步删除');
      let removed = await eh.removeFavorite(account.id, gallery.galleryId, gallery.token);
      // Permanent gallery removal does not prevent deleting the LRR archive.
      // Only transient failures are retried; exhaustion keeps the archive intact.
      for (let attempt = 1; !removed.ok && !missingEhGallery(removed.error.code) && removed.error.retryable && attempt < 3; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt * 150));
        removed = await eh.removeFavorite(account.id, gallery.galleryId, gallery.token);
      }
      if (!removed.ok && !missingEhGallery(removed.error.code)) throw new Error(`收藏同步删除失败：${removed.error.message}`);
    }
  }
  const result = await library.deleteArchive(archive.serverId, archive.archiveId);
  if (!result.ok) throw new Error(result.error.message);
  for (const prefix of ['library:', 'archive-detail:', 'recommendations:', 'home:', 'state:']) invalidateRouteCache(prefix);
}
