import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

import { resetRouteCacheForTests } from '../src/lib/routeCache';

// Cross-route snapshots are module-level, so one test's library state would
// otherwise seed the next test's first render. The categories' localStorage
// mirror leaks the same way.
afterEach(() => {
  resetRouteCacheForTests();
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith('yomika:library-categories:')) window.localStorage.removeItem(key);
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
