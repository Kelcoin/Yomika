import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let narrow = false;
let listeners: Set<() => void>;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  narrow = false;
  listeners = new Set();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return narrow; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })));
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0');
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 0 });
  delete document.documentElement.dataset.nativeMobile;
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.layout;
});

function resize(compact: boolean) {
  act(() => { narrow = compact; for (const listener of listeners) listener(); });
}

it.each(['Android', 'iPhone', 'iPad'])('%s keeps CSS and React compact across landscape rotation', async ua => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  const mode = await import('../../src/lib/layoutMode');
  const { useMediaQuery } = await import('../../src/lib/useMediaQuery');
  dispose = mode.initializeLayoutMode();
  const hook = renderHook(() => useMediaQuery(mode.COMPACT_WIDTH_QUERY));
  resize(true);
  resize(false);
  expect(hook.result.current).toBe(true);
  expect(document.documentElement.dataset.layout).toBe('compact');
});

it('recognizes iPadOS desktop user agents even with a wide viewport', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 5 });
  const mode = await import('../../src/lib/layoutMode');
  expect(mode.isCompactLayout()).toBe(true);
});

it('keeps a touchscreen Windows PC responsive to its window width', async () => {
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 10 });
  const mode = await import('../../src/lib/layoutMode');
  const { useMediaQuery } = await import('../../src/lib/useMediaQuery');
  dispose = mode.initializeLayoutMode();
  const hook = renderHook(() => useMediaQuery(mode.COMPACT_WIDTH_QUERY));
  expect(hook.result.current).toBe(false);
  resize(true);
  expect(hook.result.current).toBe(true);
  expect(document.documentElement.dataset.layout).toBe('compact');
  resize(false);
  expect(hook.result.current).toBe(false);
  expect(document.documentElement.dataset.layout).toBe('desktop');
});

it('uses native platform detection when the mobile WebView has a desktop UA', async () => {
  const mode = await import('../../src/lib/layoutMode');
  const { useMediaQuery } = await import('../../src/lib/useMediaQuery');
  dispose = mode.initializeLayoutMode();
  const hook = renderHook(() => useMediaQuery(mode.COMPACT_WIDTH_QUERY));
  act(() => mode.setLayoutPlatform('android'));
  expect(hook.result.current).toBe(true);
  expect(document.documentElement.dataset.layout).toBe('compact');
});

it('does not change unrelated media queries on mobile devices', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
  const { useMediaQuery } = await import('../../src/lib/useMediaQuery');
  const hook = renderHook(() => useMediaQuery('(prefers-reduced-motion: reduce)'));
  expect(hook.result.current).toBe(false);
});
