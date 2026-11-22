import { describe, expect, it, vi } from 'vitest';
import { NativeLibraryRepository } from '../src/repositories/nativeLibraryRepository';
import { mirrorFavorites, loadFavoriteArchives } from '../src/lib/favoritesMirror';

describe('remote favorites authority', () => {
  it('counts category lookup failures and missing category as failed writes', async () => {
    vi.spyOn(NativeLibraryRepository.prototype, 'readFavoritesCategory').mockResolvedValue({ ok: true, value: null });
    expect(await mirrorFavorites('s', ['a'], true)).toBe(1);
    vi.restoreAllMocks();
  });
  it('does not report failed remote writes as success', async () => {
    vi.spyOn(NativeLibraryRepository.prototype, 'readFavoritesCategory').mockResolvedValue({ ok: true, value: { id: 'fav', archives: [] } });
    vi.spyOn(NativeLibraryRepository.prototype, 'addArchiveToCategory').mockResolvedValue({ ok: false, error: { code: 'NETWORK', message: 'offline', retryable: true } });
    const local = vi.spyOn(NativeLibraryRepository.prototype, 'setWatchlist');
    expect(await mirrorFavorites('s', ['a'], true)).toBe(1);
    expect(local).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('exposes metadata failures instead of silently presenting a complete shelf', async () => {
    vi.spyOn(NativeLibraryRepository.prototype, 'listArchivesByIds').mockResolvedValue({ ok: true, value: [] });
    vi.spyOn(NativeLibraryRepository.prototype, 'loadArchiveMetadata').mockResolvedValue({ ok: false, error: { code: 'NETWORK', message: 'offline', retryable: true } });
    await expect(loadFavoriteArchives('s', ['remote'])).rejects.toThrow('offline');
    vi.restoreAllMocks();
  });
  it('keeps the public local watchlist API on established pending-reading storage', async () => {
    const pending = vi.spyOn(NativeLibraryRepository.prototype, 'listReadingList').mockResolvedValue({ ok: true, value: [] });
    await new NativeLibraryRepository().listWatchlist('scope');
    expect(pending).toHaveBeenCalledWith('scope');
    vi.restoreAllMocks();
  });
  it('keeps valid members when a remote-only favorite is definitely missing', async () => {
    vi.spyOn(NativeLibraryRepository.prototype, 'listArchivesByIds').mockResolvedValue({ ok: true, value: [] });
    vi.spyOn(NativeLibraryRepository.prototype, 'loadArchiveMetadata').mockImplementation(async (_server, id) => id === 'missing'
      ? { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'missing', retryable: false } }
      : { ok: true, value: { archiveId: id, title: id, filename: '', tags: '', extension: '', progress: 0, pageCount: 3, lastReadTime: 0, size: 1 } });
    expect((await loadFavoriteArchives('s', ['missing', 'valid'])).map(a => a.archiveId)).toEqual(['valid']);
    vi.restoreAllMocks();
  });
  it('hydrates a cold shelf with category pages in membership order', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const record = (archiveId: string) => ({ serverId: 's', archiveId, title: archiveId, pageCount: 3, tags: [], updatedAt: '' });
    vi.spyOn(NativeLibraryRepository.prototype, 'listArchivesByIds').mockResolvedValue({ ok: true, value: [] });
    const pages = vi.spyOn(NativeLibraryRepository.prototype, 'searchArchivesPage')
      .mockResolvedValueOnce({ ok: true, value: { items: ['f', 'd', 'e', 'stale'].map(record), total: 7, hasMore: true } })
      .mockResolvedValueOnce({ ok: true, value: { items: ['c', 'a', 'b'].map(record), total: 7, hasMore: false } });
    const metadata = vi.spyOn(NativeLibraryRepository.prototype, 'loadArchiveMetadata');
    expect((await loadFavoriteArchives('s', ids, 'fav')).map(item => item.archiveId)).toEqual(ids);
    expect(pages).toHaveBeenLastCalledWith('s', 4, { categoryId: 'fav' });
    expect(metadata).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('limits metadata requests to four at once', async () => {
    vi.spyOn(NativeLibraryRepository.prototype, 'listArchivesByIds').mockResolvedValue({ ok: true, value: [] });
    let active = 0, peak = 0;
    const metadata = vi.spyOn(NativeLibraryRepository.prototype, 'loadArchiveMetadata').mockImplementation(async (_server, id) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return { ok: true, value: { archiveId: id, title: id, filename: '', tags: '', extension: '', progress: 0, pageCount: 3, lastReadTime: 0, size: 1 } };
    });
    expect(await loadFavoriteArchives('s', Array.from({ length: 10 }, (_, i) => String(i)))).toHaveLength(10);
    expect(peak).toBe(4);
    expect(metadata).toHaveBeenCalledTimes(10);
    expect(NativeLibraryRepository.prototype.listArchivesByIds).toHaveBeenCalledWith('s', expect.any(Array), { resolveMissing: false });
    vi.restoreAllMocks();
  });
  it('resolves remote-only metadata and excludes stale local favorites', async () => {
    vi.spyOn(NativeLibraryRepository.prototype, 'listArchivesByIds').mockResolvedValue({ ok: true, value: [] });
    vi.spyOn(NativeLibraryRepository.prototype, 'loadArchiveMetadata').mockResolvedValue({ ok: true, value: { archiveId: 'remote', title: 'Remote', filename: '', tags: '', extension: '', progress: 0, pageCount: 3, lastReadTime: 0, size: 1 } });
    const result = await loadFavoriteArchives('s', ['remote']);
    expect(result.map(a => a.archiveId)).toEqual(['remote']);
    vi.restoreAllMocks();
  });
});
