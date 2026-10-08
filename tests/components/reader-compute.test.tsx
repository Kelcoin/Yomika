import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { setImageDecoderForTests } from '../../src/lib/decodeImage';
import { ComputedImageCache } from '../../src/lib/computedImageCache';
import { useComputedPage, type ComputedPageRequest } from '../../src/lib/readerCompute';
import type { ComputeJobSnapshot } from '../../src/domain/compute';

const LEASE_ID = 'a'.repeat(32);
const LEASE_URL = `yomika-image://asset/${LEASE_ID}`;

function snapshot(overrides: Partial<ComputeJobSnapshot> = {}): ComputeJobSnapshot {
  return {
    jobId: 'job-1',
    key: {
      inputId: 'archive-a:12',
      settingsId: 'settings-1',
      sourceRevision: 'rev-1',
      backend: 'directml',
      generation: 1,
    },
    priority: 'foreground',
    state: { running: { stage: 'upscale', index: 0 } },
    subscribers: 1,
    sequence: 1,
    createdMs: 0,
    settledMs: null,
    ...overrides,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1',
    stageId: 'upscale',
    artifactId: 'artifact-1',
    stagingName: 'upscale.bin',
    path: 'E:\\data\\compute\\staging\\upscale.bin',
    cacheRelative: 'cache/images/ab/abcdef.bin',
    byteLength: 1_048_576,
    contentHash: 'ab'.repeat(32),
    width: 1536,
    height: 2048,
    engineId: 'realcugan',
    enginePrecision: 'fp32',
    // 引擎交代（政策 + 回退）是 7-b-ix 才加的两栏：这条夹具原本的形态就是「没交代」。
    enginePolicy: null,
    engineFallback: null,
    pipelineRevision: 'rev:v1:deadbeef',
    verified: true,
    ...overrides,
  };
}

function makeRepository() {
  const listeners = new Set<(event: ComputeJobSnapshot) => void>();
  const calls: string[] = [];
  let served = 0;
  const repository = {
    onJobChanged(handler: (event: ComputeJobSnapshot) => void) {
      calls.push('subscribe');
      listeners.add(handler);
      return () => { listeners.delete(handler); calls.push('unsubscribe'); };
    },
    async submit(payload: unknown) {
      calls.push('submit');
      void payload;
      // 刚入队的诚实形状：这时还没有任何产物，所以页面必须还是空的。
      // 「提交回来时任务已经在跑」（宿主把提交并进了已在跑的任务）另有一条用例。
      return {
        ok: true as const,
        value: {
          jobId: 'job-1',
          subscriptionId: 7,
          coalesced: false,
          snapshot: snapshot({ state: 'queued', sequence: 1 }),
          evicted: null,
        },
      };
    },
    async cancel(jobId: string, subscriptionId: number) {
      calls.push(`cancel:${jobId}:${subscriptionId}`);
      // `CancelOutcome` 是外部标签的枚举：`AlreadyTerminal` 是**单位变体**，序列化成字符串。
      return { ok: true as const, value: 'alreadyTerminal' as const };
    },
    async jobArtifacts(jobId: string) {
      calls.push(`artifacts:${jobId}`);
      // 每次问都回一份**内容不同**的产物：缓存按内容共享，两次给同一个哈希的话，
      // 第二次会直接命中缓存里那一份，「新图解不开」这条就永远测不到。
      served += 1;
      const hash = String(served).repeat(64).slice(0, 64);
      return {
        ok: true as const,
        value: [
          artifact({ artifactId: `artifact-${served}`, contentHash: hash, verified: false, cacheRelative: null }),
          artifact({ artifactId: `artifact-${served}`, contentHash: hash }),
        ],
      };
    },
    async acquireArtifact(jobId: string, artifactId: string) {
      calls.push(`acquire:${jobId}:${artifactId}`);
      return {
        ok: true as const,
        value: {
          leaseId: LEASE_ID,
          artifactId,
          jobId,
          url: LEASE_URL,
          mime: 'image/png',
          byteLength: 1_048_576,
          width: 1536,
          height: 2048,
          estimatedDecodedBytes: 12_582_912,
          pipelineRevision: 'rev:v1:deadbeef',
          expiresInMs: 600_000,
        },
      };
    },
    async releaseArtifact(leaseId: string) {
      calls.push(`releaseArtifact:${leaseId}`);
      return { ok: true as const, value: undefined };
    },
  };
  return {
    repository,
    calls,
    /** 测试里当事件总线用：真实后端是 Tauri 的 `emit`。 */
    emit(event: ComputeJobSnapshot) {
      for (const handler of [...listeners]) handler(event);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function makeCache() {
  const releaseLease = vi.fn(async () => undefined);
  const cache = new ComputedImageCache({ releaseLease, revokeObjectURL: vi.fn() });
  return { cache, releaseLease };
}

const request: ComputedPageRequest = {
  key: {
    inputId: 'archive-a:12',
    settingsId: 'settings-1',
    sourceRevision: 'rev-1',
    backend: 'directml',
    generation: 1,
  },
  priority: 'foreground',
  input: { inputId: 'archive-a:12', contentHash: 'cd'.repeat(32), byteLength: 4096 },
  pipeline: [{ stageId: 'upscale', modelSpecId: 'realcugan-2x', enginePolicy: 'gpu' }],
  outputGrantId: 'grant-1',
  deadlineMs: 60_000,
};

function Probe({
  repository,
  cache,
  pageKey,
  pageRequest,
}: {
  repository: ReturnType<typeof makeRepository>['repository'];
  cache: ComputedImageCache;
  pageKey: string;
  pageRequest: ComputedPageRequest | undefined;
}) {
  const state = useComputedPage({ repository, cache, key: pageKey, request: pageRequest });
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <span data-testid="url">{state.url ?? 'none'}</span>
      <span data-testid="error">{state.error?.code ?? 'none'}</span>
    </div>
  );
}

describe('reader compute lifecycle', () => {
  it('subscribes before submitting, so a job that finishes at once is not lost', async () => {
    const fake = makeRepository();
    const { cache } = makeCache();
    // 最尖的那种时序：submit 还没返回，worker 已经把终态送回来了（命中缓存时就是这样）。
    const realSubmit = fake.repository.submit.bind(fake.repository);
    fake.repository.submit = async (payload: unknown) => {
      const result = await realSubmit(payload);
      fake.emit(snapshot({ state: 'completed', sequence: 2, settledMs: 5 }));
      return result;
    };
    const view = render(<Probe repository={fake.repository} cache={cache} pageKey="page-1" pageRequest={request} />);

    await waitFor(() => expect(view.getByTestId('url').textContent).toBe(LEASE_URL));
    expect(fake.calls.indexOf('subscribe')).toBeLessThan(fake.calls.indexOf('submit'));
    // 未核验的产物（`verified: false`/没有发布落点）不能拿：worker 自报的字段不是证据。
    expect(fake.calls).toContain('acquire:job-1:artifact-1');
    expect(fake.calls).not.toContain('acquire:job-1:artifact-0');
  });

  it('picks up an artifact that was published before this page asked (coalesced submit)', async () => {
    const fake = makeRepository();
    const { cache } = makeCache();
    // 重新进入阅读器：宿主把这次提交并进了已经在跑的那个任务，应答里就是 `running`，
    // 而更早阶段的产物已经发布了。这时候必须立刻去问，等下一次阶段切换才显示，
    // 等于把「已经躺在磁盘上的图」白白按住一个阶段（用户看到的就是原图迟迟不换）。
    fake.repository.submit = async () => ({
      ok: true as const,
      value: {
        jobId: 'job-1',
        subscriptionId: 7,
        coalesced: true,
        snapshot: snapshot({ state: { running: { stage: 'upscale', index: 1 } }, sequence: 3 }),
        evicted: null,
      },
    });
    const view = render(<Probe repository={fake.repository} cache={cache} pageKey="page-1" pageRequest={request} />);

    await waitFor(() => expect(view.getByTestId('url').textContent).toBe(LEASE_URL));
    expect(fake.calls).toContain('acquire:job-1:artifact-1');
  });

  it('ignores an artifact event that belongs to another generation', async () => {
    const fake = makeRepository();
    const { cache } = makeCache();
    const view = render(<Probe repository={fake.repository} cache={cache} pageKey="page-1" pageRequest={request} />);
    await waitFor(() => expect(fake.calls).toContain('submit'));

    act(() => {
      fake.emit(snapshot({ state: 'completed', sequence: 3, key: { ...snapshot().key, generation: 2 } }));
    });

    // 上一代的完成事件落在新一代要显示的那一页上，就是把旧设置的结果贴到新设置上。
    expect(fake.calls.filter((call) => call.startsWith('artifacts:'))).toHaveLength(0);
    expect(view.getByTestId('url').textContent).toBe('none');
  });

  it('swaps the page only after the new image decodes', async () => {
    const fake = makeRepository();
    const { cache } = makeCache();
    let finishDecode: (() => void) | undefined;
    setImageDecoderForTests(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
    const view = render(<Probe repository={fake.repository} cache={cache} pageKey="page-1" pageRequest={request} />);

    act(() => {
      fake.emit(snapshot({ state: 'completed', sequence: 4, settledMs: 9 }));
    });
    await waitFor(() => expect(fake.calls).toContain('acquire:job-1:artifact-1'));
    // 解好之前页面还是空的：先设 src 再解码就是那道黑闪。
    expect(view.getByTestId('url').textContent).toBe('none');

    await act(async () => {
      finishDecode?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByTestId('url').textContent).toBe(LEASE_URL));
    setImageDecoderForTests(undefined);
  });

  it('keeps the version that is already on screen when the next one cannot decode', async () => {
    const fake = makeRepository();
    const { cache } = makeCache();
    setImageDecoderForTests(() => Promise.resolve());
    const view = render(<Probe repository={fake.repository} cache={cache} pageKey="page-1" pageRequest={request} />);
    act(() => { fake.emit(snapshot({ state: 'completed', sequence: 5, settledMs: 9 })); });
    await waitFor(() => expect(view.getByTestId('url').textContent).toBe(LEASE_URL));

    // 同一页换了设置（新任务、新世代）：新图解不开，就必须留着已经显示的那一版。
    setImageDecoderForTests(() => Promise.reject(new Error('decode failed')));
    const next: ComputedPageRequest = {
      ...request,
      key: { ...request.key, settingsId: 'settings-2' },
      pipeline: [{ stageId: 'upscale', modelSpecId: 'realcugan-2x-denoise3x', enginePolicy: 'gpu' }],
    };
    view.rerender(<Probe repository={fake.repository} cache={cache} pageKey="page-1" pageRequest={next} />);
    await waitFor(() => expect(fake.calls.filter((call) => call === 'submit')).toHaveLength(2));
    act(() => { fake.emit(snapshot({ state: 'completed', sequence: 6, settledMs: 12 })); });

    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('failed'));
    expect(view.getByTestId('url').textContent).toBe(LEASE_URL);
    setImageDecoderForTests(undefined);
  });

  it('reports a terminal failure with its code and leaves the previous page alone', async () => {
    const fake = makeRepository();
    const { cache } = makeCache();
    const view = render(<Probe repository={fake.repository} cache={cache} pageKey="page-1" pageRequest={request} />);
    await waitFor(() => expect(fake.calls).toContain('submit'));

    // 失败终态是外部标签的形式（Rust 那个 enum 没有 `tag`）：`{"failed":{"code":…}}`。
    act(() => {
      fake.emit({
        ...snapshot({ sequence: 8, settledMs: 8 }),
        state: { failed: { code: 'GPU_BACKEND_UNAVAILABLE' } },
      });
    });

    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('failed'));
    expect(view.getByTestId('error').textContent).toBe('GPU_BACKEND_UNAVAILABLE');
    // 这一页原本什么都没有，失败之后也不该突然冒出一张图。
    expect(view.getByTestId('url').textContent).toBe('none');
  });

  it('cancels its subscription and hands the lease back when the reader is unmounted', async () => {
    const fake = makeRepository();
    const { cache, releaseLease } = makeCache();
    const view = render(<Probe repository={fake.repository} cache={cache} pageKey="page-1" pageRequest={request} />);
    act(() => { fake.emit(snapshot({ state: 'completed', sequence: 9, settledMs: 4 })); });
    await waitFor(() => expect(view.getByTestId('url').textContent).toBe(LEASE_URL));

    view.unmount();

    // 离开阅读器：先撤订阅（宿主不必再为这个消费者留着结果），再把 pin 还掉。
    await waitFor(() => expect(fake.calls).toContain('cancel:job-1:7'));
    expect(releaseLease).toHaveBeenCalledWith(LEASE_ID);
    // 退订之后事件总线里不许再留着这个消费者。
    expect(fake.listenerCount()).toBe(0);
  });

  it('submits nothing when the caller has no request to make', async () => {
    const fake = makeRepository();
    const { cache } = makeCache();
    render(<Probe repository={fake.repository} cache={cache} pageKey="page-1" pageRequest={undefined} />);

    await Promise.resolve();
    expect(fake.calls).toEqual([]);
  });

  it('cancels a subscription that arrives after the reader already unmounted', async () => {
    const { repository, calls } = makeRepository();
    const { cache } = makeCache();
    let resolve!: (value: Awaited<ReturnType<typeof repository.submit>>) => void;
    const result = await repository.submit(request);
    repository.submit = vi.fn(() => new Promise<Awaited<ReturnType<typeof repository.submit>>>((done) => { resolve = done; }));
    function View() {
      useComputedPage({ repository, cache, key: 'page-1', request });
      return null;
    }
    const view = render(<View />);
    await waitFor(() => expect(repository.submit).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { resolve(result); });
    expect(calls).toContain('cancel:job-1:7');
  });

});
