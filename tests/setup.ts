import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';

import { resetRouteCacheForTests } from '../src/lib/routeCache';
import { registerTauriListener, resetTauriEvents } from './tauriEvents';

// jsdom 里没有 Tauri 的事件总线，`listen` 会 reject（应用里那句 `.catch` 把它咽掉），
// 于是事件驱动的 UI 在测试里根本到不了。换成内存里的最小实现，测试用
// `emitTauriEvent(name, payload)` 发事件。
//
// 注意：这条 mock 必须写在 setup 里，而不是某个测试文件里——setup 会在
// 下面那次预加载**之前**执行，而组件是在预加载时求值的；测试文件里的 `vi.mock`
// 那时已经晚了，组件早就绑定了真的 `listen`。
vi.mock('@tauri-apps/api/event', async () => {
  const events = await import('./tauriEvents');
  return {
    listen: (name: string, handler: never) => Promise.resolve(events.registerTauriListener(name, handler)),
    emit: () => Promise.resolve(),
  };
});

// Cross-route snapshots are module-level, so one test's library state would
// otherwise seed the next test's first render. The categories' localStorage
// mirror leaks the same way — and so does the nav mirror, which is read *before*
// the first render (a leftover would decide the first frame of the next test).
afterEach(() => {
  resetRouteCacheForTests();
  resetTauriEvents();
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith('yomika:library-categories:') || key === 'yomika.last-nav') window.localStorage.removeItem(key);
  }
});

// The standalone pages load through React.lazy dynamic imports; under full
// parallel runs the first vite-node transform can outrun a findBy's default
// one-second wait (an occasional-flake class, not a behavior). Preloading the
// modules once here makes every dynamic import resolve from cache; awaiting
// keeps the work inside the environment's lifetime.
await Promise.all([
  import('../src/components/ReaderRoute'),
  import('../src/components/SettingsWorkspace'),
  import('../src/components/LocalArchivesWorkspace'),
  import('../src/components/UploadPanel'),
  import('../src/components/EhRouteWorkspace'),
  import('../src/components/MetadataEditRoute'),
  import('../src/components/DeduplicationWorkspace'),
]);

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  disconnect(): void {}
  observe(target: Element): void {
    const size = { blockSize: 600, inlineSize: 800 } as ResizeObserverSize;
    this.callback([{
      borderBoxSize: [size],
      contentBoxSize: [size],
      contentRect: { bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0, toJSON: () => ({}) },
      devicePixelContentBoxSize: [size],
      target,
    }], this);
  }
  unobserve(): void {}
}

window.ResizeObserver = TestResizeObserver;

let blobUrlSequence = 0;
if (!URL.createObjectURL) URL.createObjectURL = () => `blob:test-${blobUrlSequence++}`;
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => undefined;
