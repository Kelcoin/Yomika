import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { lazyPages, preloadLazyPages } from '../../src/app/routes';

/** 切页时那一闪是 Suspense 的兜底：chunk 还没到，整页被临时换成加载动画，到了再换
 * 回来。chunk 只在第一次进某个页面时缺，所以那一闪是偶发的（一次会话里每个页面各一
 * 次）。启动后尽快把它们一次性取回来（`preloadLazyPages`）之后就看不见了——预热的时机
 * 就是这一闪的条件：等主线程空闲往往已经晚于用户第一次点击。
 *
 * 这一条守的是「预热的清单」和「真正懒加载的页面」不漂开：新加一个懒加载页面却忘了
 * 走 `lazyPages`，或者把预热改成手写清单，那就会重新出现偶发的一闪——而且是那种
 * 「本地看不见、装机才偶尔看见」的问题。 */
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

  it('preloads the list itself rather than a hand-written copy', () => {
    // 预热直接用 lazyPages 的值：手写清单一改就漏。
    expect(routes).toMatch(/export function preloadLazyPages\(\): void \{/);
    expect(routes).toMatch(/for \(const page of Object\.values\(lazyPages\)\)/);
    // 失败不抛：真进那个页面时 Suspense 照旧兜底。
    expect(routes).toMatch(/void page\(\)\.catch\(\(\) => \{\}\)/);
  });

  it('fetches on a plain macrotask, with the idle callback kept as the fallback', () => {
    // 顺序有意义：先让出一轮宏任务（首帧已经画完，不再跟首屏抢主线程），空闲回调排在
    // 后面兜底——只留空闲那条路就是这次的线上问题，主线程一忙它迟迟不来。
    expect(routes).toMatch(/window\.setTimeout\(load, 0\)/);
    expect(routes).toMatch(/requestIdleCallback\(load, \{ timeout: 2000 \}\)/);
    expect(routes.indexOf('window.setTimeout(load, 0)')).toBeLessThan(routes.indexOf('requestIdleCallback(load'));
  });

  it('starts the warm-up once the app is up, not on the first navigation', () => {
    expect(app).toMatch(/preloadLazyPages\(\)/);
  });

  /** 上面几条读的是源码文本，钉不住时机；这一条真的调一次。 */
  it('starts fetching on the next macrotask and never blocks the first paint', async () => {
    const pages = lazyPages as Record<string, () => Promise<unknown>>;
    const originals = new Map<string, () => Promise<unknown>>(Object.entries(pages));
    const loaded: string[] = [];
    for (const key of Object.keys(pages)) pages[key] = async () => { loaded.push(key); return {}; };

    try {
      vi.useFakeTimers();
      preloadLazyPages();
      // 同步一条都不取：这时首帧还在渲染，取字节会跟它抢主线程。
      expect(loaded).toEqual([]);

      // 让出一轮宏任务（不是等空闲、也不是等 1200ms 那条兜底）就全部开始取。
      await vi.advanceTimersByTimeAsync(0);
      expect(loaded.sort()).toEqual([...originals.keys()].sort());
    } finally {
      for (const [key, page] of originals) pages[key] = page;
      vi.useRealTimers();
    }
  });
});
