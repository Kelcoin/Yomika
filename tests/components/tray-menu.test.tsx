import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TrayMenu } from '../../src/components/TrayMenu';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(() => {
  resetInvokeAdapterForTests();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

/** 托盘右键菜单是应用自己画的（系统菜单的宽度与悬停高亮都改不了，见
 * `src-tauri/src/tray_menu.rs`）。这个窗口只有两条条目，所以每条行为都值得盯住。 */
describe('tray menu', () => {
  const adapter = (theme = 'dark') => vi.fn(async (command: string) => {
    if (command === 'tray_menu_state') return { ok: true, value: { theme } };
    return { ok: true, value: null };
  });

  it('offers one row per action, with no danger tone on quit', async () => {
    setInvokeAdapterForTests(adapter());
    render(<TrayMenu />);
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['打开', '退出']);
    // 退出只是个普通动作：从前它带 `is-danger`，悬停是一块 error 色（用户要求改成一样的）。
    expect(items.map((item) => item.className)).toEqual(['tray-menu-item', 'tray-menu-item']);
  });

  it('follows the main window theme, including back to system', async () => {
    setInvokeAdapterForTests(adapter('light'));
    const view = render(<TrayMenu />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));

    // theme=system 时不能留下上一次的 data-theme：那会把亮色钉死在暗色系统上。
    view.unmount();
    setInvokeAdapterForTests(adapter('system'));
    render(<TrayMenu />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
  });

  it('chooses the action the row stands for', async () => {
    const calls: Array<{ command: string; action?: unknown }> = [];
    setInvokeAdapterForTests(async (command, args) => {
      calls.push({ command, action: (args as { action?: string } | undefined)?.action });
      return command === 'tray_menu_state' ? { ok: true, value: { theme: 'dark' } } : { ok: true, value: null };
    });
    render(<TrayMenu />);
    await userEvent.click(await screen.findByRole('menuitem', { name: '打开' }));
    expect(calls).toContainEqual({ command: 'tray_menu_choose', action: 'show' });
    await userEvent.click(screen.getByRole('menuitem', { name: '退出' }));
    expect(calls).toContainEqual({ command: 'tray_menu_choose', action: 'quit' });
    // 菜单自己的窗口由原生那侧收起，这里不该去调窗口插件。
    expect(calls.every((call) => call.command.startsWith('tray_menu_'))).toBe(true);
  });

  it('opens with nothing focused, then walks the rows with the arrow keys', async () => {
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command) => {
      commands.push(command);
      return command === 'tray_menu_state' ? { ok: true, value: { theme: 'dark' } } : { ok: true, value: null };
    });
    render(<TrayMenu />);
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    // 菜单弹出来时**不**预置焦点：程序化聚焦会被浏览器算成键盘操作，第一条就永远带着
    // 一圈高亮，鼠标移开也不消失（用户报的「打开选项 hover 常驻」）。
    await waitFor(() => expect(items[0]).not.toHaveFocus());
    expect(items[1]).not.toHaveFocus();

    // 没有落点时向下从第一条开始、向上从最后一条开始，和系统菜单一致。
    await userEvent.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    // 到最后一条再往下回到第一条，不会走出列表。
    await userEvent.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items[1]).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(commands).toContain('tray_menu_dismiss');
  });
});
