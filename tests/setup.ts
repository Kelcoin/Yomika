import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';

import { setImageDecoderForTests } from '../src/lib/decodeImage';
import { resetRouteCacheForTests } from '../src/lib/routeCache';
import { resetOverlayBackGuardForTests } from '../src/lib/overlayBackGuard';
import { resetServerPresenceForTests } from '../src/lib/serverPresence';
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
  // 浮层的返回栈也是模块级的：上一个用例留下的浮层会决定下一个用例的返回行为。
  resetOverlayBackGuardForTests();
  // 「有没有服务器」同样记在模块里，而且它是**首帧初值**：上一个用例读到过
  // 「一台都没有」的话，下一个用例的骨架就没了。
  resetServerPresenceForTests();
  // 图片解码器同理：一个用例装上的假解码器会决定下一个用例换不换 src。复位到默认的
  // 那个（见下），而不是 undefined——jsdom 里真解码会一直挂着。
  setImageDecoderForTests(alreadyDecoded);
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith('yomika:library-categories:') || key === 'yomika.last-nav') window.localStorage.removeItem(key);
    // 「跳过这个版本」是记在 localStorage 里的：一个用例跳过之后，下一个用例的启动
    // 检查就会安静下来——而它要验的正是「弹窗出现了」。
    else if (key?.startsWith('yomika.update.')) window.localStorage.removeItem(key);
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

// jsdom 不解码图片：`new Image()` 上的 `decode()` 会一直挂着（也不是它没实现，而是没有
// 加载这件事）。所以默认给一个「已经解好」的替身——换图那一步在测试里立刻生效；真正要验
// 「解完才换」的用例自己装一个可控的（见 tests/components/reader-screen.test.tsx）。
const alreadyDecoded = () => Promise.resolve();
setImageDecoderForTests(alreadyDecoded);

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
