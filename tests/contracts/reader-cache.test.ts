import { describe, expect, it, vi } from 'vitest';

import { ReaderPageCache } from '../../src/services/readerPageCache';

describe('reader page cache', () => {
  it('deduplicates concurrent page loads by scoped cache key', async () => {
    const fetcher = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    const cache = new ReaderPageCache(fetcher);

    const [first, second] = await Promise.all([
      cache.load({ scopeId: 'scope-a', archiveId: 'a', pageIndex: 0, url: 'https://example.test/a' }),
      cache.load({ scopeId: 'scope-a', archiveId: 'a', pageIndex: 0, url: 'https://example.test/a' }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(first)).toEqual(new Uint8Array(second));
  });

  it('does not reuse bytes across server scopes', async () => {
    const fetcher = vi.fn(async (url: string) => new TextEncoder().encode(url).buffer);
    const cache = new ReaderPageCache(fetcher);

    await cache.load({ scopeId: 'scope-a', archiveId: 'a', pageIndex: 0, url: 'https://example.test/a' });
    await cache.load({ scopeId: 'scope-b', archiveId: 'a', pageIndex: 0, url: 'https://example.test/a' });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps only the most recently used pages so a long archive cannot grow without bound', async () => {
    const fetcher = vi.fn(async (url: string) => new TextEncoder().encode(url).buffer);
    const cache = new ReaderPageCache(fetcher, 2);
    const page = (pageIndex: number) => ({ scopeId: 'scope-a', archiveId: 'a', pageIndex, url: `https://example.test/${pageIndex}` });

    await cache.load(page(0));
    await cache.load(page(1));
    await cache.load(page(0)); // refreshes page 0
    await cache.load(page(2)); // evicts page 1, the least recently used

    await cache.load(page(0));
    expect(fetcher).toHaveBeenCalledTimes(3);
    await cache.load(page(1));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
