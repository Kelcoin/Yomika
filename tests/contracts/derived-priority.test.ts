import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import type { ReaderPagePayload } from '../../src/domain/compute';
import { NativeComputeCenterRepository } from '../../src/repositories/nativeComputeCenterRepository';
import { NativeComputeRepository } from '../../src/repositories/nativeComputeRepository';
import { NativeDlssnrRepository } from '../../src/repositories/nativeDlssnrRepository';

afterEach(resetInvokeAdapterForTests);

/** 一张最小的 PNG（只要能被 `detectImageMime` 认出来，本组测试不看内容）。 */
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

type Payload = { input: Record<string, unknown> };

/** 记下每次调用的负载，好断言 `priority` 有没有被转过去。 */
function recordingAdapter() {
  return vi.fn(async (_command: string, _request?: unknown) => PNG);
}

/** 重计算那两道门的档位在 `payload` 里（请求的身份由宿主铸），dlssnr 与远端在 `input` 里。 */
function priorityOf(request: unknown): unknown {
  const args = request as { payload?: Record<string, unknown>; input?: Record<string, unknown> };
  return (args.payload ?? args.input)?.priority;
}

describe('derived page priority bridge', () => {
  it('sends the reader-window hint with every derived-page request', async () => {
    const adapter = recordingAdapter();
    setInvokeAdapterForTests(adapter);
    const compute = new NativeComputeRepository();
    const reader: ReaderPagePayload = {
      scopeId: 's',
      archiveId: 'a',
      pageIndex: 3,
      modelId: 'm',
      generation: 1,
      priority: 'foreground',
      deadlineMs: 0,
    };
    await compute.submitReaderPage(reader);
    await new NativeDlssnrRepository().applyPage({ scopeId: 's', archiveId: 'a', pageIndex: 3, settings: { passes: [] }, taskId: 't', priority: 'foreground' });
    await new NativeComputeCenterRepository().remoteProcess({
      url: 'https://host',
      token: 'tok',
      params: { op: 'upscale' },
      scopeId: 's',
      archiveId: 'a',
      pageIndex: 3,
      taskId: 't',
      priority: 'foreground',
    });

    expect(adapter.mock.calls.map(([command]) => command)).toEqual([
      'compute_submit_reader_page',
      'dlssnr_apply_page',
      'remote_compute_process',
    ]);
    expect(adapter.mock.calls.map(([, request]) => priorityOf(request))).toEqual([
      'foreground',
      'foreground',
      'foreground',
    ]);
  });

  it('leaves the hint out when the caller has no window to report', async () => {
    // 后台整本预扫之外的调用（比如设置页的试跑）不该自带一个优先级：原生那侧的默认
    // 是「后台，不抢占任何人」。重计算那两道门的档位是**必填**的（两边一起来铸身份，
    // 渲染进程必须说清这一页是前台还是后台），所以这里只有 dlssnr 与远端两道门。
    const adapter = recordingAdapter();
    setInvokeAdapterForTests(adapter);
    await new NativeDlssnrRepository().applyPage({ scopeId: 's', archiveId: 'a', pageIndex: 0, settings: { passes: [] } });
    await new NativeComputeCenterRepository().remoteProcess({
      url: 'https://host',
      token: 'tok',
      params: { op: 'upscale' },
      scopeId: 's',
      archiveId: 'a',
      pageIndex: 0,
    });

    for (const [, request] of adapter.mock.calls) {
      expect((request as Payload).input).not.toHaveProperty('priority');
    }
  });
});
