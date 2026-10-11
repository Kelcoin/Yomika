import { act, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SplashFrame } from '../../src/components/SplashFrame';

const root = resolve(__dirname, '../..');

/** html 里那段静态帧（`#root` 里内联的 SVG）与 React 那层必须逐属性相同：
 * 两帧同构图是这个开屏的全部依据，差一处就是「跳一下」。 */
function staticMark(): Element {
  const document = new DOMParser().parseFromString(
    readFileSync(resolve(root, 'index.html'), 'utf8'),
    'text/html',
  );
  const svg = document.querySelector('.app-splash-static svg');
  if (!svg) throw new Error('index.html 里没有静态开屏帧');
  return svg;
}

function shapeOf(svg: Element): string[] {
  return [...svg.querySelectorAll('*')].map(
    (node) => `${node.tagName}:${[...node.attributes]
      .map((attribute) => `${attribute.name}=${attribute.value}`)
      .sort()
      .join('|')}`,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('the React first frame', () => {
  it('is the very same picture as the static frame baked into index.html', () => {
    // 组件在测试环境里默认不出现（静态帧才是被测路径上的那一张），这里按真实运行
    // 时的方式把它打开。
    vi.stubEnv('MODE', 'development');
    render(<SplashFrame />);

    const live = document.querySelector('.app-splash svg');
    expect(live, 'React 那一帧要画出来').not.toBeNull();
    expect(shapeOf(live!)).toEqual(shapeOf(staticMark()));
    // wordmark 也一样：文案与那处 Vermilion 句点。
    expect(document.querySelector('.app-splash-wordmark')?.innerHTML).toBe('Yomika<i>.</i>');
  });

  it('starts visible and lets go of the screen only after the beat', () => {
    vi.stubEnv('MODE', 'development');
    vi.useFakeTimers();
    render(<SplashFrame />);

    // 入场就是可见：不能带任何淡入（静态帧刚被换掉，再淡入一次就是第二张开屏页）。
    const frame = document.querySelector('.app-splash');
    expect(frame?.className).toBe('app-splash');
    expect(frame?.getAttribute('aria-hidden')).toBe('true');

    act(() => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('.app-splash')?.className).toBe('app-splash is-leaving');

    act(() => { vi.advanceTimersByTime(400); });
    expect(document.querySelector('.app-splash')).toBeNull();
  });
});
