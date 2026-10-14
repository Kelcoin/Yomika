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
  it('loads a raw page while the derived image worker is stalled', async () => {
    const urls = blobUrlFactory();
    let finishDerived!: (data: CachedImageData) => void;
    let started!: () => void;
    const derivedStarted = new Promise<void>((resolve) => { started = resolve; });
    const data = { bytes: new Uint8Array([1]), mime: 'image/png' };
    const repo: ImageCacheRepository = {
      read: async () => null,
      fetch: async (identity) => {
        if (identity.rendition === 'dlssnr') {
          started();
          return new Promise<CachedImageData>((resolve) => { finishDerived = resolve; });
        }
        return data;
      },
      store: async () => undefined,
    };
    const cache = new UnifiedImageCache(repo, { createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024, maxConcurrentFetches: 1 });
    const identity = { scopeId: 's', archiveId: 'a', pageIndex: 0 };
    const derived = cache.load({ ...identity, rendition: 'dlssnr' });
    await derivedStarted;
    try {
      const raw = await Promise.race([
        cache.load({ ...identity, pageIndex: 1, rendition: 'reader-page' }),
        new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
      ]);
      expect(raw?.url).toBeDefined();
      if (raw) cache.release(raw);
    } finally {
      finishDerived(data);
      cache.release(await derived);
    }
  });

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

describe('UnifiedImageCache accounts for images it did not create', () => {
  const identity = { scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'enhanced' as const, pageIndex: 7 };

  it('returns an adopted image to its owner instead of revoking a URL it did not make', async () => {
    // 阅读器那条新路（`loadReaderComputedPage`）拿回来的是宿主的租借：URL 由宿主发，撤它
    // 撤不掉那份产物，真正欠着的是一条 pin。还 pin 的唯一时刻就是这张图真的离开内存。
    const urls = blobUrlFactory();
    const cache = new UnifiedImageCache(repository(), {
      createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024,
    });
    const released = vi.fn();

    const handle = cache.adopt(identity, { url: 'yomika-image://assets/lease-1', bytes: 40, release: released });

    expect(handle.url).toBe('yomika-image://assets/lease-1');
    expect(handle.bytes).toBe(40);
    expect(peekCachedImageUrl(cache, identity)).toBe(handle.url);

    cache.release(handle);

    expect(released).toHaveBeenCalledTimes(1);
    expect(urls.revoke).not.toHaveBeenCalled();
    expect(peekCachedImageUrl(cache, identity)).toBeUndefined();
  });

  it('refuses to hold two leases for one page, giving the newer one straight back', async () => {
    // 同一页排到两次（翻回来、设置又变一次）时，第二次算出来的那张不能悄悄留在表里：
    // 认领只认一条，多出来的那条当场还掉，不然宿主那边就有一条永远还不回去的 pin。
    const urls = blobUrlFactory();
    const cache = new UnifiedImageCache(repository(), {
      createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024,
    });
    const first = vi.fn();
    const second = vi.fn();

    const held = cache.adopt(identity, { url: 'yomika-image://assets/lease-1', bytes: 40, release: first });
    const again = cache.adopt(identity, { url: 'yomika-image://assets/lease-2', bytes: 40, release: second });

    expect(second).toHaveBeenCalledTimes(1);
    expect(again.url).toBe(held.url);

    cache.release(held);
    expect(first).not.toHaveBeenCalled();
    cache.release(again);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('lets a later load of the same page hit the adopted image without fetching it', async () => {
    // 两条路共用一张账：先认领进来的租借，后来的 `load` 必须命中它而不是再向仓库开一次口，
    // 否则同一张图会同时在内存里存在两份、而只有一份会被还。
    const urls = blobUrlFactory();
    const repo = repository();
    const cache = new UnifiedImageCache(repo, {
      createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 1024,
    });
    const released = vi.fn();

    const adopted = cache.adopt(identity, { url: 'yomika-image://assets/lease-1', bytes: 40, release: released });
    const loaded = await cache.load(identity);

    expect(loaded.url).toBe(adopted.url);
    expect(repo.read).not.toHaveBeenCalled();
    expect(repo.fetch).not.toHaveBeenCalled();

    cache.release(adopted);
    expect(released).not.toHaveBeenCalled();
    cache.release(loaded);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('weighs an adopted page in the same byte budget as the pages it decoded', async () => {
    // 尺子必须是同一把：`bytes` 记的是**编码后**的长度（与 `load` 记的 Blob 大小同义）。
    // 混用解码位图字节数的话，租借条目会在同一张预算里先被丢出去。
    const urls = blobUrlFactory();
    const cache = new UnifiedImageCache(repository(new Uint8Array([1, 2, 3])), {
      createObjectURL: urls.create, revokeObjectURL: urls.revoke, maxBytes: 5, maxEntries: 2,
    });
    const released = vi.fn();

    const adopted = cache.adopt(identity, { url: 'yomika-image://assets/lease-1', bytes: 4, release: released }, { retain: true });
    cache.release(adopted);
    expect(released).not.toHaveBeenCalled();

    // 4（认领）+ 3（这一张）= 7 > 5，最久没用过的那个被挤掉——挤掉就该还。
    const loaded = await cache.load({ ...identity, pageIndex: 8 });

    expect(loaded.bytes).toBe(3);
    expect(released).toHaveBeenCalledTimes(1);
    expect(peekCachedImageUrl(cache, identity)).toBeUndefined();
    expect(peekCachedImageUrl(cache, { ...identity, pageIndex: 8 })).toBe(loaded.url);
  });
  it('keeps decoded residency separate from compressed bytes on every handle path', async () => {
    const cache = new UnifiedImageCache(repository(), {
      createObjectURL: () => 'blob:unused', revokeObjectURL: vi.fn(), maxBytes: 1024,
    });
    const source = { url: 'yomika-image://assets/resident', bytes: 40, estimatedDecodedBytes: 16_000_000, release: vi.fn() };
    const adopted = cache.adopt(identity, source);
    const peeked = cache.peek(identity)!;
    const loaded = await cache.load(identity);
    for (const handle of [adopted, peeked, loaded]) {
      expect(handle.bytes).toBe(40);
      expect((handle as typeof handle & { estimatedDecodedBytes?: number }).estimatedDecodedBytes).toBe(16_000_000);
      cache.release(handle);
    }
  });

});

void (undefined as unknown as ImageHandle);
