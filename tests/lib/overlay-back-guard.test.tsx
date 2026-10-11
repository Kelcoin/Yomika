import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOverlayBackGuard } from '../../src/lib/overlayBackGuard';

/* jsdom 的历史能真的在 `pushState` 压出来的站之间往返，但**落地是异步的**：`back()` 之后
 * 立刻读 `window.history.state` 还是旧的，隔一拍才换成上一格，`popstate` 也是那时才发。
 * 所以这里按设备上的样子走：`back()` 真遍历，再把那两拍空转掉。
 * （只手动发 `popstate` 而不移动历史是不行的：守卫现在按**落地那一格的层号**算该退几层。） */

beforeEach(() => {
  // jsdom 的历史在同一个文件里接着上一批用例往下长：先停到一格干净的页面格上，免得下面
  // 那格残留的层号被当成守卫。
  window.history.pushState({}, '');
});

/** 一层会自己关掉的浮层：关掉之后就从文档里消失，和菜单里那句 `setOpen(false)` 一样。 */
function Layer({ name, onClose }: { name: string; onClose?: (() => void) | undefined }) {
  const [open, setOpen] = useState(true);
  const close = () => { onClose?.(); setOpen(false); };
  useOverlayBackGuard(open, close);
  return open ? <p data-testid={name}><button type="button" onClick={close}>自己关</button></p> : null;
}

/** 拒绝关闭的那一层（正在忙的确认框：`busy` 期间不接受关闭）。 */
function StubbornLayer({ onClose }: { onClose: () => void }) {
  useOverlayBackGuard(true, onClose);
  return <p data-testid="stubborn" />;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** 把一次历史遍历走完：`back()` 要过两拍才落到下一格，落地的定时器（拒绝关闭的浮层补守卫）
 * 还排在它后面——所以是三拍，少一拍就会看到「还在原来那一格」的假象。 */
async function flushHistory() {
  for (let index = 0; index < 3; index += 1) await settle();
}

/** 按一次返回。
 *
 * 先空转：浮层自己关掉时会调 `history.back()` 把自己的守卫吃掉，那一次遍历也是异步的——要是
 * 抢在它前面按这一下，两次遍历会撞在一起。等它落地之后，再退用户真正按的那一格。 */
async function pressBack() {
  await flushHistory();
  act(() => { window.history.back(); });
  await flushHistory();
}

describe('overlay back guard', () => {
  it('marks the history entry while open and takes the mark back when closed', async () => {
    const { unmount } = render(<Layer name="menu" />);
    // 守卫条目：URL 不变（路由不动），能看见的是状态里那枚标记。
    expect((window.history.state as { yomikaOverlay?: number } | null)?.yomikaOverlay).toBe(1);
    unmount();
    // 卸载时守卫得自己吃掉（`history.back()`），否则下一次返回会先弹掉这条没人认领的记录。
    await flushHistory();
    expect((window.history.state as { yomikaOverlay?: number } | null)?.yomikaOverlay).toBeUndefined();
  });

  it('closes the open overlay on a back gesture', async () => {
    const onClose = vi.fn();
    render(<Layer name="menu" onClose={onClose} />);
    await pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
  });

  it('closes one layer at a time, the topmost first', async () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<Layer name="menu" onClose={first} />);
    render(<Layer name="dialog" onClose={second} />);

    await pressBack();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('menu')).toBeInTheDocument();

    await pressBack();
    expect(first).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
  });

  it('closes only one layer when the same gesture arrives twice', async () => {
    // 设备上同一次手势会被补发成两个 `popstate`（一个是延迟送达的）。退几层得看落地那一格的
    // 层号：按事件个数退就会一次关掉两层——用户报的「当前这一层和整个页面一起返回了」。
    const first = vi.fn();
    const second = vi.fn();
    render(<Layer name="menu" onClose={first} />);
    render(<Layer name="dialog" onClose={second} />);

    await flushHistory();
    act(() => { window.history.back(); });
    await flushHistory();
    // 补发的那一个：历史没有再动，落地层号还是 1，所以一层都不该再关。
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    await settle();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(screen.getByTestId('menu')).toBeInTheDocument();
  });

  it('does not close the layer below when one is closed by its own button', async () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<Layer name="menu" onClose={first} />);
    render(<Layer name="dialog" onClose={second} />);

    // 点浮层自己的关闭按钮：关掉的是它自己，下面那层不动。
    const closeButtons = screen.getAllByRole('button', { name: '自己关' });
    expect(closeButtons).toHaveLength(2);
    await act(async () => { closeButtons[1]!.click(); });
    await flushHistory();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(screen.getByTestId('menu')).toBeInTheDocument();
    // 自己关掉那一层会 `history.back()` 把自己的守卫吃掉，这会儿人应该站在下面那层的守卫
    // 上——层号跟着对齐，下一次返回仍然只关掉「menu」这一层。
    expect((window.history.state as { yomikaOverlay?: number } | null)?.yomikaOverlay).toBe(1);
    await pressBack();
    expect(first).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
  });

  it('leaves a layer that a real jump closed alone instead of rewinding the jump', async () => {
    // 确认框的主按钮会把用户送到别处（「去更新」→ 设置页），然后才关掉自己那一层。
    // 关掉它不能顺手 `history.back()`：那一下正好把刚跳过去的那一格退回来，看着就是
    // 「点了没反应」——用户报的就是这个。
    const back = vi.spyOn(window.history, 'back');
    window.history.replaceState({}, '', '/library');
    render(<Layer name="dialog" />);
    act(() => { window.history.pushState({}, '', '/settings?section=advanced'); });

    await act(async () => { screen.getByRole('button', { name: '自己关' }).click(); });
    await settle();

    expect(
      back,
      '跳转之后关掉这一层不能再退一格：那一下正好把刚跳过去的那页退回来',
    ).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}`).toBe('/settings?section=advanced');

    back.mockRestore();
    window.history.replaceState({}, '', '/');
  });

  it('keeps the guard when a layer refuses to close', async () => {
    const onClose = vi.fn();
    render(<StubbornLayer onClose={onClose} />);

    await pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    // 守卫补回来了：下一次返回还是落在它身上，而不是弹到页面上。
    expect((window.history.state as { yomikaOverlay?: number } | null)?.yomikaOverlay).toBe(1);
    await pressBack();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
