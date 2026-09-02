import { afterEach, describe, expect, it, vi } from 'vitest';
import tauriConfig from '../../src-tauri/tauri.conf.json';
import {
  UnifiedImageCache,
  type ImageCacheRepository,
  type ImageHandle,
} from '../../src/lib/unifiedImageCache';

function blobUrlFactory() {
  let next = 0;
  const revoked: string[] = [];
  return {
    create: vi.fn(() => `blob:test-${next++}`),
    revoke: vi.fn((url: string) => revoked.push(url)),
    revoked,
  };
}

function repository(bytes = new Uint8Array([1, 2, 3])): ImageCacheRepository & { reads: number; fetches: number } {
  let reads = 0;
  let fetches = 0;
  return {
    get reads() { return reads; },
    get fetches() { return fetches; },
    read: vi.fn(async () => { reads += 1; return null; }),
    fetch: vi.fn(async () => { fetches += 1; return { bytes, mime: 'image/jpeg' }; }),
    store: vi.fn(async () => undefined),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('UnifiedImageCache', () => {
  it('produces image URLs allowed by the desktop content security policy', async () => {
    const repo = repository();
    const cache = new UnifiedImageCache(repo, {
      createObjectURL: () => 'blob:https://tauri.localhost/image-1',
      revokeObjectURL: vi.fn(),
      maxBytes: 1024,
    });

    const handle = await cache.load({
      scopeId: 'scope-a',
      archiveId: 'archive-a',
      rendition: 'cover',
      pageIndex: 0,
    });
    const imageSources = tauriConfig.app.security.csp
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === 'img-src')
      ?.slice(1) ?? [];

    expect(imageSources).toContain(`${new URL(handle.url).protocol}`);
  });

  it('coalesces concurrent reads and releases the blob only after the final consumer', async () => {
    const urls = blobUrlFactory();
    const repo = repository();
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024 });
    const key = { scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'cover' as const, pageIndex: 0 };

    const [first, second] = await Promise.all([cache.load(key), cache.load(key)]);

    expect(first.url).toBe(second.url);
    expect(repo.fetch).toHaveBeenCalledTimes(1);
    cache.release(first);
    expect(urls.revoke).not.toHaveBeenCalled();
    cache.release(second);
    expect(urls.revoke).toHaveBeenCalledWith(first.url);
  });

  it('returns a persistent hit without fetching the network', async () => {
    const urls = blobUrlFactory();
    const repo = repository();
    repo.read = vi.fn(async () => ({ bytes: new Uint8Array([9]), mime: 'image/png' }));
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024 });

    const handle = await cache.load({ scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'page-thumbnail', pageIndex: 4 });

    expect(handle.url).toBe('blob:test-0');
    expect(repo.read).toHaveBeenCalledTimes(1);
    expect(repo.fetch).not.toHaveBeenCalled();
  });

  it('evicts the least recently used unreferenced entry when the byte bound is exceeded', async () => {
    const urls = blobUrlFactory();
    const repo = repository(new Uint8Array([1, 2, 3, 4]));
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 5, maxEntries: 2 });

    const first = await cache.load({ scopeId: 'scope-a', archiveId: 'a', rendition: 'cover', pageIndex: 0 });
    cache.release(first);
    const second = await cache.load({ scopeId: 'scope-a', archiveId: 'b', rendition: 'cover', pageIndex: 0 });
    cache.release(second);
    await cache.load({ scopeId: 'scope-a', archiveId: 'c', rendition: 'cover', pageIndex: 0 });

    expect(urls.revoke).toHaveBeenCalledWith(first.url);
  });

  it('supports consumer cancellation without leaving an in-flight request behind', async () => {
    const urls = blobUrlFactory();
    const repo = repository();
    repo.fetch = vi.fn((_identity, signal) => new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024 });
    const controller = new AbortController();
    const promise = cache.load({ scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'reader-page', pageIndex: 1 }, { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.inFlightCount()).toBe(0);
  });

  it('forgets an abandoned request even when the repository never settles', async () => {
    const urls = blobUrlFactory();
    const repo = repository();
    repo.fetch = vi.fn(() => new Promise<never>(() => undefined));
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024 });
    const controller = new AbortController();
    const promise = cache.load(
      { scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'reader-page', pageIndex: 1 },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(repo.fetch).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.inFlightCount()).toBe(0);
  });

  it('rejects an already aborted memory hit instead of pinning a reference nobody can release', async () => {
    const urls = blobUrlFactory();
    const repo = repository();
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024 });
    const key = { scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'cover' as const, pageIndex: 0 };

    // Keep the entry referenced so the second load takes the memory fast path.
    const first = await cache.load(key);
    const controller = new AbortController();
    controller.abort();

    await expect(cache.load(key, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });

    // The aborted consumer must not have taken a reference it can never return.
    cache.release(first);
    expect(urls.revoke).toHaveBeenCalledWith(first.url);
    expect(repo.fetch).toHaveBeenCalledTimes(1);
  });
});

void (undefined as unknown as ImageHandle);
