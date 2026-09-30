/** 托盘右键菜单的两条条目。
 *
 * 它是主窗之外的第二个文档（`tray-menu.html`），所以只挂菜单本身、不挂应用外壳。
 * 三个动作都走 `tray_menu_*` 命令，不用窗口插件——那样得再给这个窗口开一份 capability，
 * 而这几件事本来就只有原生那侧知道该怎么做（见 `src-tauri/src/tray_menu.rs`）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';

/** 与 `tray_menu.rs` 的 `tray_menu_choose` 一一对应。 */
type TrayAction = 'show' | 'quit';

export const TRAY_ITEMS: ReadonlyArray<{ action: TrayAction; label: string; danger?: boolean }> = [
  { action: 'show', label: '打开' },
  { action: 'quit', label: '退出', danger: true },
];

const TrayMenuStateSchema = z.object({ theme: z.string() });

export function TrayMenu() {
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const applyTheme = useCallback(async () => {
    const result = await invokeCommand('tray_menu_state', {}, TrayMenuStateSchema);
    if (!result.ok) return;
    const { theme } = result.value;
    // 主窗是按 data-theme 上色的（system 时交给 prefers-color-scheme）。独立窗口跟着走，
    // 才不会和主窗一个亮一个暗。
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, []);

  useEffect(() => {
    void applyTheme().finally(() => setReady(true));
    // 窗口是常驻的，每次再弹出来都可能赶上主窗刚改过主题。
    const onVisibility = () => { if (document.visibilityState === 'visible') void applyTheme(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [applyTheme]);

  const focusItem = useCallback((index: number) => {
    const items = root.current?.querySelectorAll<HTMLButtonElement>('.tray-menu-item');
    if (!items?.length) return;
    items[(index + items.length) % items.length]?.focus();
  }, []);

  useEffect(() => {
    if (!ready) return;
    // 焦点落在第一条上：Esc 与方向键才有地方可去，而且窗口失焦也就自动收起了。
    focusItem(0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void invokeCommand('tray_menu_dismiss', {}, VoidResponseSchema);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.tray-menu-item') ?? [])];
        const current = items.findIndex((item) => item === document.activeElement);
        focusItem(current + (event.key === 'ArrowDown' ? 1 : -1));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focusItem, ready]);

  return (
    <div className="tray-menu" role="menu" ref={root}>
      {TRAY_ITEMS.map((item) => (
        <button
          className={`tray-menu-item${item.danger ? ' is-danger' : ''}`}
          key={item.action}
          role="menuitem"
          type="button"
          onClick={() => { void invokeCommand('tray_menu_choose', { action: item.action }, VoidResponseSchema); }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
