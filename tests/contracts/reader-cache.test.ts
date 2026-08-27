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
});
