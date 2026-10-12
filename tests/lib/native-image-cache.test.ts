import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { dlssnrTransform, NativeImageCacheAdapter, remoteTransform, renditionErrorCode } from '../../src/lib/nativeImageCache';
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

  it('keeps the native code when a computed rendition is not produced', async () => {
    // 阅读器这两档（DLSSNR / 远端）算不出来时抛出去的东西**必须带着码**：上层（阅读器的
    // 派生队列）按码判「这是阵发问题还是这一页的定局」（`RETRYABLE_COMPUTE_ERROR_CODES`）
    // ——队列满、worker 手上正有一件这类只是「现在没位置」，把这一页记成「做过了」就等于
    // 这一趟阅读里再也拿不到那一版（docs/71:645 第四句）。这里只抛一句话，那个码就丢在
    // 这一层了，上层只能把每一次阵发失败都当成定局：那正是「开着 DLSSNR 却一直没有反应」。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'dlssnr_apply_page') {
        return { ok: false, error: { code: 'COMPUTE_QUEUE_FULL', message: '计算队列满了：Pressure', retryable: true } };
      }
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, remoteComputeUrl: '192.168.1.9:47653', remoteComputeToken: 'paired-token' } };
      if (command === 'remote_compute_process') {
        return { ok: false, error: { code: 'COMPUTE_WORKER_BUSY', message: '计算进程手上正有一件', retryable: true } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeImageCacheAdapter();
    const rejected = async (identity: Parameters<NativeImageCacheAdapter['fetch']>[0]) => {
      try {
        const fetched = await repository.fetch(identity);
        throw new Error(`这一版没算出来时不该当成功：${fetched.mime}`);
      } catch (error) {
        return error;
      }
    };

    const dlssnr = await rejected({
      scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a',
      rendition: 'dlssnr', pageIndex: 4, transform: dlssnrTransform('reader-page', ''),
    });
    expect(renditionErrorCode(dlssnr)).toBe('COMPUTE_QUEUE_FULL');

    const remote = await rejected({
      scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a',
      rendition: 'remote', pageIndex: 4,
      transform: remoteTransform({ device: '192.168.1.9:47653', source: 'reader-page', chain: ['upscale'] }),
    });
    expect(renditionErrorCode(remote)).toBe('COMPUTE_WORKER_BUSY');
  });
});
