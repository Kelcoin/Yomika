import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installPressFeedback } from '../../src/lib/pressFeedback';

/* 触屏"按下去看得见"的机制在 src/lib/pressFeedback.ts：`pointerdown` 落在哪个可点元素上，
 * 就给它一个瞬时的 `is-pressed`。jsdom 里 `pointerType` 是 undefined（不等于 `'mouse'`），
 * 所以走的正是真机触屏那条分支。
 *
 * 这一层只负责标记，颜色与揭图由样式表决定；下面钉的是"标记落在谁身上"——包括
 * `data-press-surface` 这个显式认领：阅读器概览的封面框不是可点元素，不认领就没人接住，
 * SFW 下按住也就永远看不清那张封面。 */

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

function mount(element: React.ReactElement) {
  stop = installPressFeedback();
  render(element);
}

describe('press feedback', () => {
  it('marks the pressable ancestor the finger landed in, until the finger lifts', () => {
    mount(<button type="button" data-testid="card"><span data-testid="cover" /></button>);

    fireEvent.pointerDown(screen.getByTestId('cover'));
    expect(screen.getByTestId('card')).toHaveClass('is-pressed');

    fireEvent.pointerUp(document);
    expect(screen.getByTestId('card')).not.toHaveClass('is-pressed');
  });

  it('marks an element that claims the press for itself', () => {
    mount(<span data-testid="frame" data-press-surface><span data-testid="cover" /></span>);

    fireEvent.pointerDown(screen.getByTestId('cover'));
    expect(screen.getByTestId('frame')).toHaveClass('is-pressed');
  });

  it('gives the press to the closest claimant, so a marked frame inside a button does not steal it', () => {
    mount(<button type="button" data-testid="card"><span data-testid="frame" data-press-surface><span data-testid="cover" /></span></button>);

    fireEvent.pointerDown(screen.getByTestId('cover'));
    // 认领是"最近的匹配优先"：按钮自己的按压反馈不能被里面的框抢走，所以别把
    // `data-press-surface` 写进按钮内部（阅读器概览那个封面框外面没有按钮，才敢写）。
    expect(screen.getByTestId('frame')).toHaveClass('is-pressed');
    expect(screen.getByTestId('card')).not.toHaveClass('is-pressed');
  });
});
