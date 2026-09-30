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

  it('offers one row per action, with the danger tone on quit', async () => {
    setInvokeAdapterForTests(adapter());
    render(<TrayMenu />);
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['打开', '退出']);
    expect(items[1]).toHaveClass('is-danger');
    expect(items[0]).not.toHaveClass('is-danger');
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

  it('dismisses on Escape and walks the rows with the arrow keys', async () => {
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command) => {
      commands.push(command);
      return command === 'tray_menu_state' ? { ok: true, value: { theme: 'dark' } } : { ok: true, value: null };
    });
    render(<TrayMenu />);
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    // 弹出来的那一刻焦点在第一条上：否则 Esc 与方向键都没有落点。
    await waitFor(() => expect(items[0]).toHaveFocus());

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
