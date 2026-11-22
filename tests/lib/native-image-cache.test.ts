import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { dlssnrTransform, getNativeImageCache, loadDlssnrReaderPage, loadRemoteReaderPage, NativeImageCacheAdapter, remoteTransform, renditionErrorCode } from '../../src/lib/nativeImageCache';
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

    expect(adapter).toHaveBeenCalledWith('load_reader_page', { serverId: 'server-a', archiveId: 'archive-a', pageIndex: 2, path: 'chapter/02.gif', taskId: expect.stringMatching(/^reader-fetch:/) });
  });

  it('cancels the actual original download and gives a retry its own task ID', async () => {
    let finish!: (value: unknown) => void;
    const adapter = vi.fn((command: string): Promise<unknown> => {
      if (command === 'load_reader_page') return new Promise(resolve => { finish = resolve; });
      if (command === 'inference_cancel_page') return Promise.resolve({ ok: true, value: true });
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeImageCacheAdapter();
    const identity = { scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition: 'reader-page' as const, pageIndex: 2, sourcePath: '02.jpg' };
    const controller = new AbortController();
    const first = repository.fetch(identity, controller.signal);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('load_reader_page', expect.anything()));
    const firstId = (adapter.mock.calls[0] as unknown as [string, { taskId: string }])[1].taskId;
    controller.abort();
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('inference_cancel_page', { taskId: firstId }));
    finish([0xff, 0xd8, 0xff]);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = repository.fetch(identity);
    await vi.waitFor(() => expect(adapter.mock.calls.filter(([name]) => name === 'load_reader_page')).toHaveLength(2));
    const secondId = (adapter.mock.calls.filter(([name]) => name === 'load_reader_page')[1] as unknown as [string, { taskId: string }])[1].taskId;
    expect(secondId).not.toBe(firstId);
    finish([0xff, 0xd8, 0xff]);
    await second;
  });

  it('passes the selected local rendition to remote processing and separates device cache keys', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, remoteComputeUrl: '192.168.1.9:47653', remoteComputeToken: 'paired-token' } };
      if (command === 'remote_compute_process') return [0x89, 0x50, 0x4e, 0x47];
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const transform = remoteTransform({ device: '192.168.1.9:47653', source: 'enhanced', chain: ['upscale', 'dlssnr'], revision: 'rev-a' });
    const identity = { scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition: 'remote' as const, pageIndex: 2, modelId: 'local-upscale', transform };
    await new NativeImageCacheAdapter().fetch(identity);
    expect(adapter).toHaveBeenCalledWith('remote_compute_process', {
      // 键传的是「做哪几档」这一串；模型/倍数/层数一个都不发，由对面那份设置决定。
      input: expect.objectContaining({
        source: 'enhanced',
        upscaleModel: 'local-upscale',
        params: { op: 'upscale', chain: ['upscale', 'dlssnr'] },
      }),
    });
    const otherDevice = remoteTransform({ device: '192.168.1.10:47653', source: 'enhanced', chain: ['upscale', 'dlssnr'], revision: 'rev-a' });
    expect(createImageCacheKey(identity)).not.toBe(createImageCacheKey({ ...identity, transform: otherDevice }));
  });

  it('keys a remote rendition by the plan revision the server actually runs', async () => {
    // docs/175 R11：模型内容、归一化参数、链顺序、那份 DLL 的内容都进了对面那一版身份。
    // 设备没变、起点没变、链没变——对面换了模型权重，这一版产物就必须另起一个键。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, remoteComputeUrl: '192.168.1.9:47653', remoteComputeToken: 'paired-token' } };
      if (command === 'remote_compute_process') return [0x89, 0x50, 0x4e, 0x47];
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const first = remoteTransform({ device: '192.168.1.9:47653', source: 'reader-page', chain: ['upscale'], revision: 'a'.repeat(64) });
    const second = remoteTransform({ device: '192.168.1.9:47653', source: 'reader-page', chain: ['upscale'], revision: 'b'.repeat(64) });
    const identity = { scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition: 'remote' as const, pageIndex: 2, transform: first };
    expect(createImageCacheKey(identity)).not.toBe(createImageCacheKey({ ...identity, transform: second }));

    await new NativeImageCacheAdapter().fetch(identity);
    // 键里那一版随请求一起过去：对面回包上会写明「这一次真正用的」是哪一版，两者对不上
    // 就说明身份变了，那一份产物不能按老版本存下来。
    expect(adapter).toHaveBeenCalledWith('remote_compute_process', {
      input: expect.objectContaining({ expectedRevision: 'a'.repeat(64) }),
    });
  });

  it('uses the Android remote lease without binary IPC and releases the exact version', async () => {
    vi.stubGlobal('YomikaTiles', { postMessage: vi.fn() });
    const result = { ok: true, value: { contentHash: 'e'.repeat(64), lease: {
      leaseId: 'test-remote-file', artifactId: 'image', jobId: 'reader-remote',
      url: 'yomika-image://assets/test-remote-file', mime: 'image/png',
      width: 100, height: 200, byteLength: 500, estimatedDecodedBytes: 80_000,
      pipelineRevision: 'remote-version', expiresInMs: 60_000,
    } } };
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'remote_compute_process_file') return result;
      if (command === 'compute_artifact_release') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(invoke);
    try {
      const identity = { scopeId: 'scope', serverId: 'server', archiveId: 'remote-lease-test', pageIndex: 5,
        rendition: 'remote' as const, transform: remoteTransform({ device: 'server', source: 'reader-page', chain: ['dlssnr'], revision: 'remote-version' }) };
      const handle = await loadRemoteReaderPage(identity, new AbortController().signal);
      expect(handle).toMatchObject({ url: result.value.lease.url, estimatedDecodedBytes: 80_000 });
      expect(invoke).toHaveBeenCalledWith('remote_compute_process_file', { input: expect.objectContaining({ pageIndex: 5, expectedRevision: 'remote-version' }) });
      expect(invoke.mock.calls.map(([command]) => command)).not.toContain('remote_compute_process');
      getNativeImageCache().release(handle);
      expect(invoke).toHaveBeenCalledWith('compute_artifact_release', { leaseId: 'test-remote-file' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('delivers local DLSSNR to the native reader without binary IPC', async () => {
    vi.stubGlobal('__yomikaNativeReaderPreview', true);
    const lease = {
      leaseId: 'test-local-dlssnr', artifactId: 'image', jobId: 'reader-dlssnr',
      url: 'yomika-image://assets/test-local-dlssnr', mime: 'image/png',
      width: 100, height: 200, byteLength: 500, estimatedDecodedBytes: 80_000,
      pipelineRevision: 'dlssnr-version', expiresInMs: 60_000,
    };
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
      if (command === 'dlssnr_apply_page_file') return { ok: true, value: { lease, contentHash: 'd'.repeat(64) } };
      if (command === 'compute_artifact_release') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(invoke);
    try {
      const handle = await loadDlssnrReaderPage({
        scopeId: 'scope', serverId: 'server', archiveId: 'dlssnr-file-test',
        pageIndex: 5, rendition: 'dlssnr', readerSession: 42,
      }, new AbortController().signal);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith('dlssnr_apply_page_file', {
        input: expect.objectContaining({ pageIndex: 5 }), readerSession: 42,
      });
      expect(handle.url).toBe(lease.url);
      getNativeImageCache().release(handle);
      expect(invoke).toHaveBeenCalledWith('compute_artifact_release', { leaseId: lease.leaseId });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to run a model in the host for the two computed renditions', async () => {
    // 超分这一版现在整条由 compute 那条链产出（宿主提交、worker 执行、产物认领）。
    // 拦一道不是为了「不拦就会读错图」——不拦会掉到下面那句笼统的 `Unsupported image
    // request`——而是因为出了这种事，日志里得写清楚：这一版归 compute 管，别在宿主里开模型。
    const adapter = vi.fn(async (command: string) => {
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeImageCacheAdapter();

    await expect(
      repository.fetch({ scopeId: 'scope-a', serverId: 'server-a', archiveId: 'archive-a', rendition: 'enhanced', pageIndex: 0 }),
    ).rejects.toThrow(/compute/);
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
      transform: remoteTransform({ device: '192.168.1.9:47653', source: 'reader-page', chain: ['upscale'], revision: 'rev-a' }),
    });
    expect(renditionErrorCode(remote)).toBe('COMPUTE_WORKER_BUSY');
  });
});
