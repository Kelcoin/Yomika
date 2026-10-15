import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { longPressHandlers } from '../../src/lib/longPressMenu';

/** 长按这条路上有两件要一起验的事：450 毫秒之后菜单要出来，而且手指要**感觉到**它出来了
 *  （震动发在同一处——三个调用点共用 `longPressHandlers`）。 */

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function stubUserAgent(value: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
}

function Harness({ open }: { open: (at: { x: number; y: number }) => void }) {
  return <button type="button" {...longPressHandlers(open)}>卡片</button>;
}

/** jsdom 没有 `PointerEvent`，`fireEvent.pointerDown` 于是既带不上坐标、也带不上
 *  `pointerType`（读出来是 undefined）。这里自己造一个 `MouseEvent`（它**有** clientX /
 *  clientY）再补上 pointerType：手指与鼠标两条分支才都能验。 */
function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY: number; pointerType: string },
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX, clientY: init.clientY });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType });
  return event;
}

let originalUserAgent = '';
let calls: Array<{ command: string; args: Record<string, unknown> | undefined }>;

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  originalUserAgent = navigator.userAgent;
  stubUserAgent(ANDROID_UA);
  calls = [];
  setInvokeAdapterForTests(vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return { ok: true, value: null };
  }));
});

afterEach(() => {
  vi.useRealTimers();
  resetInvokeAdapterForTests();
  stubUserAgent(originalUserAgent);
});

describe('press and hold', () => {
  it('opens the menu where the finger went down, and buzzes once', async () => {
    const open = vi.fn();
    const card = render(<Harness open={open} />).getByRole('button', { name: '卡片' });

    fireEvent(card, pointer('pointerdown', { clientX: 12, clientY: 34, pointerType: 'touch' }));
    expect(open).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(450);
    await flush();

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ x: 12, y: 34 });
    expect(calls).toEqual([{ command: 'haptic_feedback', args: { kind: 'medium' } }]);
  });

  it('stays quiet when the finger drifts away before the hold lands', async () => {
    const open = vi.fn();
    const card = render(<Harness open={open} />).getByRole('button', { name: '卡片' });

    fireEvent(card, pointer('pointerdown', { clientX: 10, clientY: 10, pointerType: 'touch' }));
    fireEvent(card, pointer('pointermove', { clientX: 14, clientY: 46, pointerType: 'touch' }));
    await vi.advanceTimersByTimeAsync(450);
    await flush();

    expect(open).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('stays quiet when the finger lifts before the hold lands', async () => {
    const open = vi.fn();
    const card = render(<Harness open={open} />).getByRole('button', { name: '卡片' });

    fireEvent(card, pointer('pointerdown', { clientX: 10, clientY: 10, pointerType: 'touch' }));
    fireEvent(card, pointer('pointerup', { clientX: 10, clientY: 10, pointerType: 'touch' }));
    await vi.advanceTimersByTimeAsync(450);
    await flush();

    expect(open).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('swallows the click the release produces, so the menu is not navigated away', async () => {
    const open = vi.fn();
    const behind = vi.fn();
    const card = render(<div onClick={behind}><Harness open={open} /></div>).getByRole('button', { name: '卡片' });

    fireEvent(card, pointer('pointerdown', { clientX: 10, clientY: 10, pointerType: 'touch' }));
    await vi.advanceTimersByTimeAsync(450);
    await flush();
    fireEvent.click(card, { bubbles: true });

    expect(open).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();
  });

  it('leaves a mouse entirely alone: a right click is where the menu comes from', async () => {
    const open = vi.fn();
    const card = render(<Harness open={open} />).getByRole('button', { name: '卡片' });

    fireEvent(card, pointer('pointerdown', { clientX: 10, clientY: 10, pointerType: 'mouse' }));
    await vi.advanceTimersByTimeAsync(450);
    await flush();

    expect(open).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('sends nothing at all on a desktop-sized pointer even if a hold somehow lands', async () => {
    stubUserAgent(WINDOWS_UA);
    const open = vi.fn();
    const card = render(<Harness open={open} />).getByRole('button', { name: '卡片' });

    fireEvent(card, pointer('pointerdown', { clientX: 10, clientY: 10, pointerType: 'pen' }));
    await vi.advanceTimersByTimeAsync(450);
    await flush();

    expect(open).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });
});

it('does not open or activate a card after dragging', async () => {
  const open = vi.fn();
  const activate = vi.fn();
  const card = render(<div onClick={activate}><Harness open={open} /></div>).getByRole('button');
  fireEvent(card, pointer('pointerdown', { clientX: 10, clientY: 10, pointerType: 'touch' }));
  fireEvent(card, pointer('pointermove', { clientX: 10, clientY: 80, pointerType: 'touch' }));
  await vi.advanceTimersByTimeAsync(450);
  fireEvent(card, pointer('pointerup', { clientX: 10, clientY: 80, pointerType: 'touch' }));
  fireEvent.click(card);
  expect(open).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
});
