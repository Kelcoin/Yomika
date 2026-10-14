import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { lazyPages, preloadLazyPages } from '../../src/app/routes';

/** Keep navigation and warm-up import coverage together; verify actual batching below. */
describe('lazy page preloading', () => {
  const routes = readFileSync(resolve(__dirname, '../../src/app/routes.tsx'), 'utf8');
  const app = readFileSync(resolve(__dirname, '../../src/app/App.tsx'), 'utf8');

  it('declares every lazy page in one place and lazy-loads through it', () => {
    const declared = new Set([...routes.matchAll(/^\s{2}(\w+): \(\) => import\(/gm)].map((match) => match[1] ?? ''));
    expect(declared.size).toBeGreaterThanOrEqual(5);

    // 每个 `lazy()` 都从 lazyPages 取：写死一个 import 就绕过了预热。
    const lazyCalls = [...routes.matchAll(/lazy\(\(\) => ([^)]+(?:\)[^)]*)?)\)/g)].map((match) => match[1] ?? '');
    expect(lazyCalls.length).toBeGreaterThanOrEqual(5);
    const used = lazyCalls.map((call) => {
      const key = /^lazyPages\.(\w+)\(\)/.exec(call);
      expect(key, `lazy() 必须走 lazyPages：${call}`).not.toBeNull();
      return key?.[1] ?? '';
    });
    expect([...new Set(used)].sort()).toEqual([...declared].sort());
  });

  it('starts the warm-up once the app is up, not on the first navigation', () => {
    expect(app).toMatch(/preloadLazyPages\(/);
  });

  /** 上面几条读的是源码文本，钉不住时机；这一条真的调一次。 */
  it('warms common code first in bounded batches without blocking first paint', async () => {
    const pages = lazyPages as Record<string, () => Promise<unknown>>;
    const originals = new Map<string, () => Promise<unknown>>(Object.entries(pages));
    const loaded: string[] = [];
    for (const key of Object.keys(pages)) pages[key] = async () => { loaded.push(key); return {}; };

    try {
      vi.useFakeTimers();
      const stop = preloadLazyPages();
      // 同步一条都不取：这时首帧还在渲染，取字节会跟它抢主线程。
      expect(loaded).toEqual([]);

      // Common leaves load first, with each subsequent task spaced apart.
      await vi.advanceTimersByTimeAsync(500);
      expect(loaded).toEqual(['settings']);
      await vi.advanceTimersByTimeAsync(150);
      expect(loaded).toEqual(['settings', 'localArchives']);
      await vi.advanceTimersByTimeAsync(5000);
      expect(loaded.sort()).toEqual([...originals.keys()].sort());
      stop();
    } finally {
      for (const [key, page] of originals) pages[key] = page;
      vi.useRealTimers();
    }
  });
});
