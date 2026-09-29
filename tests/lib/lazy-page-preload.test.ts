import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** 切页时那一闪是 Suspense 的兜底：chunk 还没到，整页被临时换成加载动画，到了再换
 * 回来。chunk 只在第一次进某个页面时缺，所以那一闪是偶发的（一次会话里每个页面各
 * 一次）。启动稳定之后空闲时把它们一次性取回来（`preloadLazyPages`），之后切页不再
 * 挂起。
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

  it('starts the warm-up once the app is up, not on the first navigation', () => {
    expect(app).toMatch(/preloadLazyPages\(\)/);
  });
});
