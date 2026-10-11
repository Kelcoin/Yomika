import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeImageCacheAdapter, remoteTransform } from '../../src/lib/nativeImageCache';
import { createImageCacheKey } from '../../src/domain/cache';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';

afterEach(resetInvokeAdapterForTests);

describe('NativeImageCacheAdapter', () => {
  it('reads a persistent cover before using the LANraragi command', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'cache_read_image') return { ok: true, value: [0xff, 0xd8, 0xff] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeImageCacheAdapter();
    const identity = { scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition: 'cover' as const, pageIndex: 0 };

    const cached = await repository.read(identity);

    expect(cached?.mime).toBe('image/jpeg');
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('uses one-based LANraragi page numbers when a page thumbnail misses', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_archive_page_thumbnail') return { ok: true, value: [0x89, 0x50, 0x4e, 0x47] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeImageCacheAdapter();
    const identity = { scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition: 'page-thumbnail' as const, pageIndex: 3 };

    const fetched = await repository.fetch(identity);

    expect(fetched.mime).toBe('image/png');
    expect(adapter).toHaveBeenCalledWith('load_archive_page_thumbnail', { serverId: 'server-a', archiveId: 'archive-a', page: 4 });
  });

  it('passes the manifest path when loading a reader page', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_reader_page') return { ok: true, value: [0x47, 0x49, 0x46, 0x38] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeImageCacheAdapter();

    await repository.fetch({ scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition: 'reader-page', pageIndex: 2, sourcePath: 'chapter/02.gif' });

    expect(adapter).toHaveBeenCalledWith('load_reader_page', { serverId: 'server-a', archiveId: 'archive-a', pageIndex: 2, path: 'chapter/02.gif' });
  });

  it('passes the selected local rendition to remote processing and separates device cache keys', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, remoteComputeUrl: '192.168.1.9:47653', remoteComputeToken: 'paired-token' } };
      if (command === 'remote_compute_process') return [0x89, 0x50, 0x4e, 0x47];
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const transform = remoteTransform({ device: '192.168.1.9:47653', source: 'enhanced', chain: ['decensor', 'dlssnr'] });
    const identity = { scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition: 'remote' as const, pageIndex: 2, modelId: 'local-upscale', transform };
    await new NativeImageCacheAdapter().fetch(identity);
    expect(adapter).toHaveBeenCalledWith('remote_compute_process', {
      // 键传的是「做哪几档」这一串；模型/倍数/层数一个都不发，由对面那份设置决定。
      input: expect.objectContaining({
        source: 'enhanced',
        upscaleModel: 'local-upscale',
        params: { op: 'decensor', chain: ['decensor', 'dlssnr'] },
      }),
    });
    const otherDevice = remoteTransform({ device: '192.168.1.10:47653', source: 'enhanced', chain: ['decensor', 'dlssnr'] });
    expect(createImageCacheKey(identity)).not.toBe(createImageCacheKey({ ...identity, transform: otherDevice }));
  });

  it('refuses to run a model in the host for the two computed renditions', async () => {
    // 去码与超分这两版现在整条由 compute 那条链产出（宿主提交、worker 执行、产物认领）。
    // 拦一道不是为了「不拦就会读错图」——不拦会掉到下面那句笼统的 `Unsupported image
    // request`——而是因为出了这种事，日志里得写清楚：这两版归 compute 管，别在宿主里开模型。
    const adapter = vi.fn(async (command: string) => {
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeImageCacheAdapter();

    for (const rendition of ['decensored', 'enhanced'] as const) {
      await expect(
        repository.fetch({ scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition, pageIndex: 0 }),
      ).rejects.toThrow(/compute/);
    }
    expect(adapter).not.toHaveBeenCalled();
  });
});
