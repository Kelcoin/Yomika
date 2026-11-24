import { afterEach, describe, expect, it } from 'vitest';

import { installKeyboardAvoidance } from '../../src/lib/keyboardAvoidance';

/** 一个能 dispatch resize/scroll 的 visualViewport 假件。 */
class FakeViewport extends EventTarget {
  height = 800;
  width = 400;
  offsetTop = 0;

  resize(height: number, width = this.width) {
    this.height = height;
    this.width = width;
    this.dispatchEvent(new Event('resize'));
  }
}

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-keyboard');
  document.documentElement.style.removeProperty('--keyboard-inset');
  document.documentElement.style.removeProperty('--viewport-height');
});

/** 页面 + 两个浮层：只有焦点所在的那一块该被抬起。 */
function buildScene() {
  document.body.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'workspace';
  const focused = document.createElement('div');
  focused.className = 'settings-choice-panel';
  const input = document.createElement('input');
  focused.append(input);
  const other = document.createElement('div');
  other.className = 'dialog-content';
  other.append(document.createElement('input'));
  document.body.append(page, focused, other);
  focused.getBoundingClientRect = () => rect(200, 560);
  other.getBoundingClientRect = () => rect(20, 700);
  return { page, focused, other, input };
}

describe('keyboard avoidance', () => {
  it('freezes the viewport height and lifts only the focused panel on iOS', () => {
    const scene = buildScene();
    const viewport = new FakeViewport();
    cleanups.push(installKeyboardAvoidance({ viewport, ios: () => true }));

    scene.input.focus();
    viewport.resize(400);

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--keyboard-inset')).toBe('400px');
    expect(root.dataset.keyboard).toBe('open');
    /* dvh 会跟着键盘缩短；钉住之后按它定高的壳层不再重排。 */
    expect(root.style.getPropertyValue('--viewport-height')).toBe('800px');
    /* 键盘上沿 400，面板下沿 560，留 12：抬起 172（不越过头顶的 200 - 12）。 */
    expect(scene.focused.style.getPropertyValue('--keyboard-lift')).toBe('172px');
    expect(scene.focused.hasAttribute('data-keyboard-lifted')).toBe(true);
    /* 页面本身与没焦点的那一层一动不动。 */
    expect(scene.page.hasAttribute('data-keyboard-lifted')).toBe(false);
    expect(scene.other.hasAttribute('data-keyboard-lifted')).toBe(false);
    expect(scene.other.style.getPropertyValue('--keyboard-lift')).toBe('');
  });

  it('caps the lift so the panel title cannot leave the screen', () => {
    const scene = buildScene();
    scene.focused.getBoundingClientRect = () => rect(20, 700);
    const viewport = new FakeViewport();
    cleanups.push(installKeyboardAvoidance({ viewport, ios: () => true }));

    scene.input.focus();
    viewport.resize(400);

    expect(scene.focused.style.getPropertyValue('--keyboard-lift')).toBe('8px');
  });

  it('follows the focus to another panel while the keyboard stays open', () => {
    const scene = buildScene();
    scene.other.getBoundingClientRect = () => rect(200, 620);
    const viewport = new FakeViewport();
    cleanups.push(installKeyboardAvoidance({ viewport, ios: () => true }));

    scene.input.focus();
    viewport.resize(400);
    expect(scene.focused.hasAttribute('data-keyboard-lifted')).toBe(true);

    const otherInput = scene.other.querySelector('input')!;
    otherInput.focus();

    expect(scene.focused.hasAttribute('data-keyboard-lifted')).toBe(false);
    expect(scene.focused.style.getPropertyValue('--keyboard-lift')).toBe('');
    expect(scene.other.style.getPropertyValue('--keyboard-lift')).toBe('188px');
  });

  it('puts everything back when the keyboard closes', () => {
    const scene = buildScene();
    const viewport = new FakeViewport();
    cleanups.push(installKeyboardAvoidance({ viewport, ios: () => true }));

    scene.input.focus();
    viewport.resize(400);
    viewport.resize(800);

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--keyboard-inset')).toBe('0px');
    expect(root.dataset.keyboard).toBeUndefined();
    expect(root.style.getPropertyValue('--viewport-height')).toBe('');
    expect(scene.focused.hasAttribute('data-keyboard-lifted')).toBe(false);
    expect(scene.focused.style.getPropertyValue('--keyboard-lift')).toBe('');
  });

  it('keeps the Android behaviour: inset only, no freeze and no lift', () => {
    const scene = buildScene();
    const viewport = new FakeViewport();
    cleanups.push(installKeyboardAvoidance({ viewport, ios: () => false }));

    scene.input.focus();
    viewport.resize(400);

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--keyboard-inset')).toBe('400px');
    expect(root.dataset.keyboard).toBe('open');
    expect(root.style.getPropertyValue('--viewport-height')).toBe('');
    expect(scene.focused.hasAttribute('data-keyboard-lifted')).toBe(false);
  });
});
