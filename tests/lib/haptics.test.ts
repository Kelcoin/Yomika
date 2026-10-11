import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { hapticFeedback } from '../../src/lib/haptics';

/** 手机才有马达，所以判据是 UA：这层门不只看得到命令，还决定桌面上要不要白跑一趟 IPC。 */

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function stubUserAgent(value: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
}

let originalUserAgent = '';
let calls: Array<{ command: string; args: Record<string, unknown> | undefined }>;

/** 装一个把每条命令记下来的适配器；`reply` 决定它怎么回答（失败/异常都有用）。 */
function installAdapter(reply: (command: string) => unknown = () => ({ ok: true, value: null })) {
  calls = [];
  setInvokeAdapterForTests(vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return reply(command);
  }));
}

beforeEach(() => {
  originalUserAgent = navigator.userAgent;
});

afterEach(() => {
  resetInvokeAdapterForTests();
  stubUserAgent(originalUserAgent);
});

describe('haptic feedback', () => {
  it('asks the native side for a tap on a phone, with the default strength', async () => {
    stubUserAgent(ANDROID_UA);
    installAdapter();

    hapticFeedback();
    hapticFeedback('heavy');
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[0]).toEqual({ command: 'haptic_feedback', args: { kind: 'medium' } });
    expect(calls[1]).toEqual({ command: 'haptic_feedback', args: { kind: 'heavy' } });
  });

  it('counts an iPhone as a phone too', async () => {
    stubUserAgent(IPHONE_UA);
    installAdapter();

    hapticFeedback('light');
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]?.args).toEqual({ kind: 'light' });
  });

  it('does not even call out on a desktop, where there is no motor to drive', async () => {
    stubUserAgent(WINDOWS_UA);
    installAdapter();

    hapticFeedback();
    hapticFeedback('heavy');
    await Promise.resolve();

    expect(calls).toEqual([]);
  });

  it('swallows a failed or throwing command, so the press it confirms still works', async () => {
    stubUserAgent(ANDROID_UA);
    installAdapter((command) => (command === 'haptic_feedback'
      ? { ok: false, error: { code: 'PLATFORM_UNAVAILABLE', message: '没有振动器', retryable: true } }
      : { ok: true, value: null }));

    expect(() => hapticFeedback()).not.toThrow();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // 命令整个抛出来也一样：这是并发即忘的反馈，不该在长按那条路上留下未处理的 rejection。
    installAdapter(() => { throw new Error('native bridge is gone'); });
    expect(() => hapticFeedback('selection')).not.toThrow();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });
});
