import { act, render } from '@testing-library/react';

import { RetainedPage } from '../../src/app/RetainedPage';
import { CardTagRows } from '../../src/components/CardTagRows';
import { clearTagTranslations, installTagTranslations } from '../../src/lib/tags';

/** jsdom 不做布局：胶囊宽度与槽宽都得由测试自己报。
 *
 * 这里模拟的正是真窗口里那条路：卡片先在**看不见**的容器里挂载（`getBoundingClientRect`
 * 与 `clientWidth` 都报 0），随后容器显示出来，`ResizeObserver` 报出真的槽宽。
 * 这条路上组件手里的胶囊宽度表还停在「一排 0」，而「填满」分支会把 0 当成 5px ——
 * 于是每一个标签都被算成装得下，全部挤进第一行。 */
function installMeasureFake() {
  const originalObserver = window.ResizeObserver;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const callbacks = new Map<Element, ResizeObserverCallback>();
  const state = { laidOut: false, containerWidth: 134, chipWidth: 70, paintScale: 1 };

  class FakeResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) { callbacks.set(target, this.callback); }
    unobserve(target: Element) { callbacks.delete(target); }
    disconnect() { callbacks.clear(); }
  }

  window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.classList?.contains('card-tag-measure') && state.laidOut ? state.chipWidth : 0; } });
  HTMLElement.prototype.getBoundingClientRect = function measureStub(this: HTMLElement) {
    if (this.classList?.contains('card-tag-measure')) {
      const width = state.laidOut ? state.chipWidth * state.paintScale : 0;
      return { width, height: 20, top: 0, left: 0, right: width, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return originalRect.call(this);
  };

  return {
    state,
    /** 组件的槽宽是从元素自己身上读的：给这一条元素装上会变的那一个数。 */
    track(root: HTMLElement) {
      Object.defineProperty(root, 'clientWidth', {
        configurable: true,
        get: () => (state.laidOut ? state.containerWidth : 0),
      });
    },
    fire(root: HTMLElement) {
      const callback = callbacks.get(root);
      if (!callback) throw new Error('组件没有观察这个标签槽');
      callback([{ target: root } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    },
    restore() {
      window.ResizeObserver = originalObserver;
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalOffset) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffset);
    },
  };
}

/** 每个物理行里挤了几个胶囊。 */
function rowLengths(container: HTMLElement): number[] {
  return [...container.querySelectorAll('.archive-row-tag-line')]
    .map((line) => line.querySelectorAll('.metadata-chip').length);
}

const TAGS = [
  'language:chinese',
  'female:big breasts',
  'artist:somebody',
  'group:some circle',
  'other:short',
  'male:sole male',
];

describe('card tag rows', () => {
  it('uses CSS wrapping without hidden measurement chips on dense responsive lists', () => {
    const fake = installMeasureFake();
    try {
      const { container } = render(<CardTagRows tags={TAGS} rowCount={3} fill layout="wrap" leading={[{label:'无修正',tone:'is-positive'}]} className="tags" />);
      expect(container.querySelector('.card-tag-measures')).toBeNull();
      expect(container.querySelector('.card-tag-waterfall')).toHaveClass('is-wrapped');
      expect(container.querySelectorAll('.metadata-chip')).toHaveLength(TAGS.length+1);
      expect(container.querySelector('.metadata-chip')).toHaveTextContent('无修正');
    } finally { fake.restore(); }
  });

  it('updates mounted chips when translations are installed or cleared', () => {
    clearTagTranslations();
    const { container } = render(<CardTagRows tags={['artist:somebody']} rowCount={1} className="tags" />);
    const visible = () => container.querySelector('.archive-row-tag-line')?.textContent;
    expect(visible()).toBe('somebody');
    act(() => installTagTranslations({ artist: { somebody: '某位画师' } }));
    expect(visible()).toBe('某位画师');
    act(() => clearTagTranslations());
    expect(visible()).toBe('somebody');
  });

  it('measures a retained page synchronously when it becomes active', () => {
    const fake = installMeasureFake();
    try {
      const view = (active: boolean) => <RetainedPage active={active}><CardTagRows tags={TAGS} rowCount={2} fill className="tags" /></RetainedPage>;
      const { container, rerender } = render(view(false));
      const root = container.querySelector<HTMLElement>('.tags')!;
      fake.track(root);
      fake.state.laidOut = true;
      // No observer callback: activation must fix the rows before the reveal paints.
      rerender(view(true));
      expect(rowLengths(container)).toEqual([1, 1]);
    } finally { fake.restore(); }
  });

  it('keeps tag packing stable while the card is visually scaled on press', () => {
    const fake = installMeasureFake();
    try {
      const { container } = render(<CardTagRows tags={TAGS} rowCount={2} fill className="tags" />);
      const root = container.querySelector<HTMLElement>('.tags')!;
      fake.track(root);
      fake.state.laidOut = true;
      fake.state.chipWidth = 64;
      act(() => fake.fire(root));
      expect(rowLengths(container)).toEqual([1, 1]);
      fake.state.paintScale = .97;
      act(() => fake.fire(root));
      expect(rowLengths(container)).toEqual([1, 1]);
    } finally { fake.restore(); }
  });

  it('re-measures the chips when a card that mounted unseen is laid out at last', () => {
    const fake = installMeasureFake();
    try {
      const { container } = render(
        <CardTagRows tags={TAGS} rowCount={2} fill className="archive-thumb-card-tags" />,
      );
      const root = container.querySelector<HTMLElement>('.archive-thumb-card-tags');
      if (!root) throw new Error('标签槽没渲染出来');
      fake.track(root);

      // 挂载那一拍还在看不见的容器里：量到一排 0 时该走「短行优先」的瀑布，
      // 两行摊开 —— 0 宽只是没量到，不等于「一行装得下」。
      expect(rowLengths(container)).toEqual([3, 3]);

      // 容器显示出来：槽宽 134、每个胶囊 70 —— 134 装不下两个（70 + 4 + 70 > 134）。
      fake.state.laidOut = true;
      act(() => fake.fire(root));

      expect(rowLengths(container)).toEqual([1, 1]);
    } finally {
      fake.restore();
    }
  });
});
