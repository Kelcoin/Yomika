import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeDlssnrRepository } from '../../src/repositories/nativeDlssnrRepository';
import { NativeInferenceRepository } from '../../src/repositories/nativeInferenceRepository';

afterEach(resetInvokeAdapterForTests);

/** 一张最小的 PNG（只要能被 `detectImageMime` 认出来，本组测试不看内容）。 */
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

type Payload = { input: Record<string, unknown> };

/** 记下每次调用的负载，好断言 `priority` 有没有被转过去。 */
function recordingAdapter() {
  return vi.fn(async (_command: string, _request?: unknown) => PNG);
}

describe('derived page priority bridge', () => {
  it('sends the reader-window hint with upscale, decensor and dlssnr requests', async () => {
    const adapter = recordingAdapter();
    setInvokeAdapterForTests(adapter);
    const inference = new NativeInferenceRepository();
    await inference.upscalePage({ scopeId: 's', archiveId: 'a', pageIndex: 3, modelId: 'm', taskId: 't', priority: 'foreground' });
    await inference.decensorPage({ scopeId: 's', archiveId: 'a', pageIndex: 3, modelId: 'm', taskId: 't', priority: 'foreground' });
    await new NativeDlssnrRepository().applyPage({ scopeId: 's', archiveId: 'a', pageIndex: 3, settings: { passes: [] }, taskId: 't', priority: 'foreground' });

    const inputs = adapter.mock.calls.map(([, request]) => (request as Payload).input);
    expect(inputs.map((input) => input.priority)).toEqual(['foreground', 'foreground', 'foreground']);
  });

  it('leaves the hint out when the caller has no window to report', async () => {
    // 后台整本预扫之外的调用（比如设置页的试跑）不该自带一个优先级：原生那侧的默认
    // 是「后台，不抢占任何人」。
    const adapter = recordingAdapter();
    setInvokeAdapterForTests(adapter);
    await new NativeInferenceRepository().decensorPage({ scopeId: 's', archiveId: 'a', pageIndex: 0, modelId: 'm' });
    await new NativeDlssnrRepository().applyPage({ scopeId: 's', archiveId: 'a', pageIndex: 0, settings: { passes: [] } });

    for (const [, request] of adapter.mock.calls) {
      expect((request as Payload).input).not.toHaveProperty('priority');
    }
  });
});
