import { afterEach, describe, expect, it, vi } from 'vitest';
import tauriConfig from '../../src-tauri/tauri.conf.json';
import {
  UnifiedImageCache,
  peekCachedImage,
  peekCachedImageUrl,
  type CachedImageData,
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

  it('never takes a page away from a consumer that is still holding it', async () => {
    // 内存里留下的都是**有引用**的条目：谁手上还拿着 handle，回收就不动它（阅读器
    // 的会话派生图就是这么存的）。上限只是兜底，真正的边界来自调用方放手的时机——
    // 所以这里验的是「不会把别人正在看的那一页撤掉」。
    const urls = blobUrlFactory();
    const repo = repository(new Uint8Array([1, 2, 3, 4]));
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 4, maxEntries: 1 });
    const identity = (archiveId: string) => ({ scopeId: 'scope-a', archiveId, rendition: 'reader-page' as const, pageIndex: 0 });

    const held = await cache.load(identity('a'));
    const alsoHeld = await cache.load(identity('b'));

    expect(urls.revoke).not.toHaveBeenCalled();
    expect(held.url).toBe('blob:test-0');
    expect(alsoHeld.url).toBe('blob:test-1');

    // 最后一放手就立刻撤掉（撤销 URL 与实现里那句「释放到 0 引用即撤销」同一条）。
    cache.release(held);
    cache.release(alsoHeld);
    expect(urls.revoke).toHaveBeenCalledWith(held.url);
    expect(urls.revoke).toHaveBeenCalledWith(alsoHeld.url);
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

  it('caps how many repository fetches run at once', async () => {
    const urls = blobUrlFactory();
    const repo = repository();
    let started = 0;
    let peak = 0;
    let inFlight = 0;
    const release: Array<() => void> = [];
    repo.fetch = vi.fn(() => {
      started += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<CachedImageData>((resolve) => release.push(() => {
        inFlight -= 1;
        resolve({ bytes: new Uint8Array([1]), mime: 'image/jpeg' });
      }));
    });
    const cache = new UnifiedImageCache(repo, {
      createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024, maxConcurrentFetches: 4,
    });

    const loads = Array.from({ length: 20 }, (_, index) => cache.load({
      scopeId: 'scope-a', archiveId: `archive-${index}`, rendition: 'cover' as const, pageIndex: 0,
    }));
    await vi.waitFor(() => expect(started).toBe(4));

    // Release one at a time: a queued fetch may only start as one finishes.
    for (let index = 0; index < 20; index += 1) {
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
      release.shift()!();
    }
    await Promise.all(loads);

    expect(peak).toBeLessThanOrEqual(4);
    expect(repo.fetch).toHaveBeenCalledTimes(20);
  });
});

describe('UnifiedImageCache covers that outlive a remount', () => {
  const key = { scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'cover' as const, pageIndex: 0 };

  it('hands back a cached cover synchronously so a remount paints it on the first frame', async () => {
    const urls = blobUrlFactory();
    const repo = repository();
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024 });

    expect(peekCachedImage(cache, key)).toBeUndefined();
    expect(peekCachedImageUrl(cache, key)).toBeUndefined();

    const loaded = await cache.load(key, { retain: true });
    cache.release(loaded);

    // 同步接口在最后一个消费者放手之后仍然给得出这张图：这正是「切页时封面不闪」
    // 的全部依据——重挂载的第一帧就能拿到 url，而不是先摆一个骨架。
    const peeked = peekCachedImage(cache, key);
    expect(peeked?.url).toBe(loaded.url);
    expect(peekCachedImageUrl(cache, key)).toBe(loaded.url);
    expect(repo.fetch).toHaveBeenCalledTimes(1);
    expect(urls.revoke).not.toHaveBeenCalled();

    // 同步拿到的引用必须还回去，否则这张图会被永久钉死在表里。
    cache.release(peeked!);
    expect(urls.revoke).not.toHaveBeenCalled();
    expect(peekCachedImageUrl(cache, key)).toBe(loaded.url);
  });

  it('revokes an unretained cover on its last release even if it was peeked at', async () => {
    const urls = blobUrlFactory();
    const repo = repository();
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024 });

    const loaded = await cache.load(key);
    // 纯读的 peek（渲染期用的那个）不动引用计数——否则没人放手，条目永远撤不掉。
    expect(peekCachedImageUrl(cache, key)).toBe(loaded.url);
    expect(peekCachedImageUrl(cache, key)).toBe(loaded.url);

    cache.release(loaded);
    expect(urls.revoke).toHaveBeenCalledWith(loaded.url);
    expect(peekCachedImageUrl(cache, key)).toBeUndefined();
  });

  it('still bounds retained covers, dropping the least recently used one first', async () => {
    const urls = blobUrlFactory();
    const repo = repository(new Uint8Array([1, 2, 3, 4]));
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 5, maxEntries: 2 });
    const cover = (archiveId: string) => ({ scopeId: 'scope-a', archiveId, rendition: 'cover' as const, pageIndex: 0 });

    const first = await cache.load(cover('a'), { retain: true });
    cache.release(first);
    expect(urls.revoke).not.toHaveBeenCalled();

    // 保留不是无上限：96MiB / 256 条那套预算照样能把它挤出去。
    const second = await cache.load(cover('b'), { retain: true });
    cache.release(second);

    expect(urls.revoke).toHaveBeenCalledWith(first.url);
    expect(peekCachedImageUrl(cache, cover('a'))).toBeUndefined();
    expect(peekCachedImageUrl(cache, cover('b'))).toBe(second.url);
  });

  it('treats a cache stand-in without the synchronous interface as a miss', () => {
    // 有些地方注入的是精简替身（组件测试的 mock、只读适配层）：它们只有 load /
    // release。守卫让这种替身退回异步取图，而不是 TypeError 崩一屏。
    const stub = { load: vi.fn(), release: vi.fn() } as unknown as UnifiedImageCache;

    expect(peekCachedImage(stub, key)).toBeUndefined();
    expect(peekCachedImageUrl(stub, key)).toBeUndefined();
  });
});

void (undefined as unknown as ImageHandle);
