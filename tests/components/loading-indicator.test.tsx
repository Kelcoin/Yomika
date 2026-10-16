import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LoadingIndicator } from '../../src/components/LoadingIndicator';

/** 2026-10-16 用户：「重新绘制一个阅读模式的加载动画，中间不要有LOGO啥的，简洁一点」。
 *
 * 形状（去轨道、44px、一段会伸缩的弧）由 `styles/reader.css` 里按容器选的规则决定，
 * jsdom 不排版、读不到那些读数，所以形状由 `tests/design-system-contract.test.ts`
 * 的条款守；这里守的是**组件这一层**：标记里不再有第二枚画（品牌标），以及无障碍名字
 * 与三档尺寸没有被顺手改掉。 */

it('draws one mark and no brand glyph inside it', () => {
  const { container } = render(<LoadingIndicator />);

  expect(screen.getByRole('status', { name: '正在加载' })).not.toBeNull();
  expect(container.querySelector('.loading-indicator')?.className).toBe('loading-indicator is-md');
  expect(container.querySelectorAll('svg')).toHaveLength(1);
  expect(container.querySelectorAll('.loading-indicator-track')).toHaveLength(1);
  expect(container.querySelectorAll('.loading-indicator-arc')).toHaveLength(1);
  // 中间那枚品牌标是这次拿掉的东西：它一回来，这条就红。
  expect(container.querySelector('.yomika-mark')).toBeNull();
});

it('keeps the three sizes on the same mark', () => {
  const { container } = render(<LoadingIndicator size="lg" label="正在打开" />);

  expect(container.querySelector('.loading-indicator')?.className).toBe('loading-indicator is-lg');
  expect(screen.getByRole('status', { name: '正在打开' })).not.toBeNull();
  expect(container.querySelector('.yomika-mark')).toBeNull();
});

it('leaves the inline mark bare so a status line does not announce the wait twice', () => {
  const { container } = render(<LoadingIndicator inline />);

  const mark = container.querySelector('.loading-mark');
  expect(mark?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('.loading-indicator')).toBeNull();
  expect(container.querySelectorAll('svg')).toHaveLength(1);
  expect(container.querySelector('.yomika-mark')).toBeNull();
});
