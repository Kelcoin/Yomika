import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardProgressBar, cardProgressWidth } from '../../src/components/CardProgressBar';

/** 底层那一层判据：量法与填充几何。
 *
 * jsdom 里没有排版引擎，也从来不给 `clientWidth` 真值——所以这里量到的宽度是**假的**
 * （见下面那个 `Object.defineProperty`）。它证明的是「量到了就换算成绝对长度、容器一变
 * 就重量一次」，不是「真渲染引擎里它长这样」；真几何在工装页上量
 * （`debug_outputs/progress-bar/`，无头 Edge + CDP）。两层缺一不可：这一层能在三连里
 * 一直跑，工装页那一层才看得见圆角、裁切和真像素。 */

let trackWidth = 300;

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

function installMeasure(): void {
  trackWidth = 300;
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('archive-card-progress') ? trackWidth : 0;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});

describe('card progress bar', () => {
  it('gives positive progress a visible minimum without filling an unread card or overflowing a narrow track', () => {
    expect(cardProgressWidth(100 / 259, 150, false)).toBe('6px');
    expect(cardProgressWidth(0.01, 3, false)).toBe('3px');
    expect(cardProgressWidth(0, 150, false)).toBe('0px');
    expect(cardProgressWidth(100, 150, false)).toBe('150px');
  });
  it('turns the measured track into an absolute length, and follows the card corners', () => {
    // 量到宽度：填充写绝对长度（百分比的计算值在列宽变化时一模一样，过渡会跳过）。
    expect(cardProgressWidth(20, 300, false)).toBe('60px');
    // 宽行/设置行：只算两段圆角之间的直边，1% 才不会整段落在圆角弧里被裁掉。
    expect(cardProgressWidth(20, 300, true)).toBe('calc(var(--radius-card) + (300px - 2 * var(--radius-card)) * 0.2)');
    // 还没量到就先按百分比画，首帧不会空着。
    expect(cardProgressWidth(20, 0, false)).toBe('min(100%, max(6px, 20%))');
    expect(cardProgressWidth(20, 0, true)).toBe('calc(var(--radius-card) + (100% - 2 * var(--radius-card)) * 0.2)');
    // 画满时前端已经顶到边缘，不再让位给圆角。
    expect(cardProgressWidth(100, 300, true)).toBe('300px');
    expect(cardProgressWidth(0, 300, true)).toBe('0px');
  });

  it('re-measures the track when the row changes width instead of keeping a stale reading', () => {
    installMeasure();
    const { container } = render(<CardProgressBar percent={20} label="下载进度" cornerAware />);
    const fill = container.querySelector<HTMLElement>('.archive-card-progress-fill');
    expect(fill?.style.width).toBe('calc(var(--radius-card) + (300px - 2 * var(--radius-card)) * 0.2)');

    trackWidth = 500;
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();
    act(() => observer?.fire());
    expect(fill?.style.width).toBe('calc(var(--radius-card) + (500px - 2 * var(--radius-card)) * 0.2)');
  });

  it('updates download progress by clipping a stable fill layer', () => {
    installMeasure();
    const { container, rerender } = render(<CardProgressBar percent={10} label="下载进度" cornerAware composited />);
    const fill = container.querySelector<HTMLElement>('.archive-card-progress-fill')!;
    const before = fill.style.clipPath;
    expect(fill.style.width).toBe('100%');
    expect(before).toContain('inset(');
    rerender(<CardProgressBar percent={80} label="下载进度" cornerAware composited />);
    expect(fill.style.width).toBe('100%');
    expect(fill.style.clipPath).not.toBe(before);
    expect(container.querySelector('.archive-card-progress')).toHaveClass('is-composited');
  });

  it('draws an indeterminate bar without a value, and a complete one without the round head', () => {
    installMeasure();
    const { container, rerender } = render(<CardProgressBar percent={0} label="下载进度" indeterminate cornerAware />);
    const bar = container.querySelector('.archive-card-progress');
    expect(bar).toHaveClass('is-indeterminate');
    expect(bar).not.toHaveClass('is-complete');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(container.querySelector<HTMLElement>('.archive-card-progress-fill')?.style.width).toBe('');

    rerender(<CardProgressBar percent={100} label="下载进度" cornerAware />);
    expect(bar).not.toHaveClass('is-indeterminate');
    expect(bar).toHaveClass('is-complete');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(container.querySelector<HTMLElement>('.archive-card-progress-fill')?.style.width).toBe('300px');
  });
});
