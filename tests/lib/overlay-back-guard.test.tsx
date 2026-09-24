import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useOverlayBackGuard } from '../../src/lib/overlayBackGuard';

/* jsdom 的历史只是近似：`back()` 偶尔补 `popstate`、有时不补（它不把 `pushState` 的条目
 * 当可往返的站）。所以这里直接发那个事件——设备上按返回，最终到达页面的就是它。 */

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

/** 按一次返回。
 *
 * 先空转两拍：浮层自己关掉时会调 `history.back()` 把自己的守卫吃掉，jsdom 为它发的那个
 * `popstate` 也是异步的——要是抢在它前面发这一下，两次返回会撞在一起。等它落地之后，
 * 再发用户真正按的那一下。 */
async function pressBack() {
  await settle();
  await settle();
  act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
  await settle();
}

describe('overlay back guard', () => {
  it('marks the history entry while open and takes the mark back when closed', async () => {
    const { unmount } = render(<Layer name="menu" />);
    // 守卫条目：URL 不变（路由不动），能看见的是状态里那枚标记。
    expect((window.history.state as { yomikaOverlay?: number } | null)?.yomikaOverlay).toBe(1);
    unmount();
    // 卸载时守卫得自己吃掉（`history.back()`），否则下一次返回会先弹掉这条没人认领的记录。
    await settle();
    await settle();
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

  it('does not close the layer below when one is closed by its own button', async () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<Layer name="menu" onClose={first} />);
    render(<Layer name="dialog" onClose={second} />);

    // 点浮层自己的关闭按钮：关掉的是它自己，下面那层不动。
    const closeButtons = screen.getAllByRole('button', { name: '自己关' });
    expect(closeButtons).toHaveLength(2);
    await act(async () => { closeButtons[1]!.click(); });
    await settle();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(screen.getByTestId('menu')).toBeInTheDocument();
    // 自己关掉那一层还会 `history.back()` 把自己的守卫吃掉；jsdom 的历史不保证真的回退
    // （实测：连着几次 pushState 之后 back() 可能什么都不发），所以那一步没有断言——
    // 设备上它是浏览器自己的同文档遍历，一定会发。
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
