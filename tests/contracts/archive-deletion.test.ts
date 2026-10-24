import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteArchiveWithFavoriteSync, ehGalleryFromTags } from '../../src/lib/archiveDeletion';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);
const archive = { serverId: 's', archiveId: 'a' };
const metadata = { archiveId: 'a', title: 'Title', filename: 'a.zip', tags: 'source:https://e-hentai.org/g/123/abc123/', extension: 'zip', progress: 0, pageCount: 10, lastReadTime: 0, size: 100 };
const account = { id: 'eh', label: 'EH', host: 'e-hentai.org', cookieRef: 'secret-ref', isActive: true, status: 'verified', createdAt: '', updatedAt: '' };

describe('archive deletion with favorite sync', () => {
  it('keeps the archive when all transient favorite retries fail', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_eh_accounts') return { ok: true, value: [account] };
      return { ok: false, error: { code: 'EH_UNAVAILABLE', message: 'Still in favorites', retryable: true } };
    });
    setInvokeAdapterForTests(adapter);
    await expect(deleteArchiveWithFavoriteSync(archive, true)).rejects.toThrow('Still in favorites');
    expect(adapter.mock.calls.filter(([command]) => command === 'remove_eh_favorite')).toHaveLength(3);
    expect(adapter.mock.calls.some(([command]) => command === 'delete_archive')).toBe(false);
  });
  it('accepts gallery source tags only on exact E-Hentai hosts', () => {
    expect(ehGalleryFromTags(['source:https://e-hentai.org.evil.test/g/123/abc/'])).toBeUndefined();
    expect(ehGalleryFromTags(['source:exhentai.org/g/123/abc/'])).toEqual({ galleryId: '123', token: 'abc' });
    expect(ehGalleryFromTags([' source: https://e-hentai.org/g/123/abc/ '])).toEqual({ galleryId: '123', token: 'abc' });
    expect(ehGalleryFromTags(['source:https://other.test/', metadata.tags])).toEqual({ galleryId: '123', token: 'abc123' });
  });

  it('does not delete the archive after a failed favorite operation', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_eh_accounts') return { ok: true, value: [account] };
      return { ok: false, error: { code: 'EH_REAUTH_REQUIRED', message: 'Login expired', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    await expect(deleteArchiveWithFavoriteSync(archive, true)).rejects.toThrow('Login expired');
    expect(adapter.mock.calls.map(([command]) => command)).toEqual(['load_archive_metadata', 'list_eh_accounts', 'remove_eh_favorite']);
  });

  it('removes favorite before archive and skips EH entirely when disabled', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_eh_accounts') return { ok: true, value: [account] };
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    await deleteArchiveWithFavoriteSync(archive, true);
    expect(adapter.mock.calls.map(([command]) => command)).toEqual(['load_archive_metadata', 'list_eh_accounts', 'remove_eh_favorite', 'delete_archive']);
    adapter.mockClear();
    await deleteArchiveWithFavoriteSync(archive, false);
    expect(adapter.mock.calls.map(([command]) => command)).toEqual(['delete_archive']);
  });
});
