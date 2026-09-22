import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeCacheRepository } from '../../src/repositories/nativeCacheRepository';

afterEach(resetInvokeAdapterForTests);

describe('native cache bridge', () => {
  it('reads a persisted image as raw bytes and sniffs its type', async () => {
    // 命中走的是二进制体：一页 1.5MB 的 JPEG 若走 JSON 数字数组 + zod 逐个校验，
    // 主线程一次就要停 200–280ms（阅读器一次开三页＝加载动画一顿一顿的）。
    const adapter = vi.fn(async () => ({ ok: true, value: [0xff, 0xd8, 0xff, 0xe0] }));
    setInvokeAdapterForTests(adapter);
    const identity = { scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'cover' as const, pageIndex: 0 };

    const result = await new NativeCacheRepository().readImage(identity);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.value?.bytes ?? [])).toEqual([0xff, 0xd8, 0xff, 0xe0]);
      // 类型由字节认，不再跟着 IPC 多带一个字段。
      expect(result.value?.mime).toBe('image/jpeg');
    }
    expect(adapter).toHaveBeenCalledWith('cache_read_image', { identity });
  });

  it('treats an empty body as no cached entry', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: [] }));
    setInvokeAdapterForTests(adapter);
    const identity = { scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'reader-page' as const, pageIndex: 4 };

    await expect(new NativeCacheRepository().readImage(identity)).resolves.toEqual({ ok: true, value: null });
  });

  it('passes a read failure through as an error rather than a miss', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'UNKNOWN', message: 'Database lock failed', retryable: true } }));
    setInvokeAdapterForTests(adapter);
    const identity = { scopeId: 'scope-a', archiveId: 'archive-a', rendition: 'cover' as const, pageIndex: 0 };

    await expect(new NativeCacheRepository().readImage(identity))
      .resolves.toEqual({ ok: false, error: { code: 'UNKNOWN', message: 'Database lock failed', retryable: true } });
  });

  it('reads indexed cache usage and defaults enhancement categories from older responses', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: {
      bytes: 4096,
      entries: 2,
      byRendition: {
        cover: { bytes: 1024, entries: 1 },
        'page-thumbnail': { bytes: 1024, entries: 0 },
        'reader-page': { bytes: 2048, entries: 1 },
        other: { bytes: 0, entries: 0 },
      },
    } }));
    setInvokeAdapterForTests(adapter);
    await expect(new NativeCacheRepository().stats()).resolves.toEqual({ ok: true, value: {
      bytes: 4096,
      entries: 2,
      byRendition: {
        cover: { bytes: 1024, entries: 1 },
        'page-thumbnail': { bytes: 1024, entries: 0 },
        'reader-page': { bytes: 2048, entries: 1 },
        enhanced: { bytes: 0, entries: 0 },
        decensored: { bytes: 0, entries: 0 },
        inference: { bytes: 0, entries: 0 },
        other: { bytes: 0, entries: 0 },
      },
    } });
    expect(adapter).toHaveBeenCalledWith('cache_stats', {});
  });

  it('clears only unprotected image cache entries', async () => {
    const value = { removedEntries: 2, removedFiles: 2, bytesFreed: 4096, protectedBytes: 128 };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);
    await expect(new NativeCacheRepository().clearImages()).resolves.toEqual({ ok: true, value });
    expect(adapter).toHaveBeenCalledWith('cache_clear_images', {});
  });

  it('invalidates cache entries for one archive only', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { removedEntries: 1, removedFiles: 1, bytesFreed: 512 } }));
    setInvokeAdapterForTests(adapter);
    await expect(new NativeCacheRepository().invalidateArchive('scope-a', 'archive-a')).resolves.toEqual({ ok: true, value: { removedEntries: 1, removedFiles: 1, bytesFreed: 512 } });
    expect(adapter).toHaveBeenCalledWith('cache_invalidate_archive', { scopeId: 'scope-a', archiveId: 'archive-a' });
  });

  it('runs one bounded quota-eviction batch', async () => {
    const value = { removedEntries: 2, removedFiles: 1, bytesFreed: 6, remainingBytes: 14, quotaSatisfied: true, hasMore: false };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeCacheRepository().evict({ maxBytes: 14, batchLimit: 64 })).resolves.toEqual({ ok: true, value });
    expect(adapter).toHaveBeenCalledWith('cache_evict', { input: { maxBytes: 14, batchLimit: 64 } });
  });
});
