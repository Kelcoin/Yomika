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
    const transform = remoteTransform({ device: '192.168.1.9:47653', source: 'enhanced', op: 'dlssnr', modelId: '', scale: 2, passes: '' });
    const identity = { scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition: 'remote' as const, pageIndex: 2, modelId: 'local-upscale', transform };
    await new NativeImageCacheAdapter().fetch(identity);
    expect(adapter).toHaveBeenCalledWith('remote_compute_process', { input: expect.objectContaining({ source: 'enhanced', upscaleModel: 'local-upscale' }) });
    const otherDevice = remoteTransform({ device: '192.168.1.10:47653', source: 'enhanced', op: 'dlssnr', modelId: '', scale: 2, passes: '' });
    expect(createImageCacheKey(identity)).not.toBe(createImageCacheKey({ ...identity, transform: otherDevice }));
  });
});
