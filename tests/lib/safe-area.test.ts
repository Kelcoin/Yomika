import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { applySystemInsets, syncSystemInsets } from '../../src/lib/safeArea';

/** 只有 Tauri 里那条路才会问原生（浏览器里没有系统栏叠在页面上）。 */
function pretendNative(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async () => null } });
}

const variables = () => ({
  top: document.documentElement.style.getPropertyValue('--safe-top'),
  bottom: document.documentElement.style.getPropertyValue('--safe-bottom'),
});

describe('system insets', () => {
  beforeEach(pretendNative);
  afterEach(() => {
    resetInvokeAdapterForTests();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    document.documentElement.style.removeProperty('--safe-top');
    document.documentElement.style.removeProperty('--safe-bottom');
  });

  it('writes what the native side measured into the CSS variables', async () => {
    setInvokeAdapterForTests(async (command) => (command === 'system_insets'
      ? { ok: true, value: { top: 28, bottom: 48 } }
      : { ok: true, value: null }));

    await syncSystemInsets();
    // 页面就是靠这两个值避开状态栏与手势条的（Android 上 env() 给的是 0）。
    expect(variables()).toEqual({ top: '28px', bottom: '48px' });
  });

  it('clears the inline values when the platform reports none', async () => {
    // iOS 那边 `env(safe-area-inset-*)` 是准的：写死 0 会把真实的安全区抹平，
    // 所以两个都是 0 的时候要把内联值撤掉，让 tokens.css 里那条兜底生效。
    applySystemInsets(30, 50);
    setInvokeAdapterForTests(async () => ({ ok: true, value: { top: 0, bottom: 0 } }));

    await syncSystemInsets();
    expect(variables()).toEqual({ top: '', bottom: '' });
  });
});
