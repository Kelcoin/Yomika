import { listen } from '@tauri-apps/api/event';
import { applyCustomCss } from '../lib/customCss';
import { upgradeCssThemePreset } from '../lib/cssThemePresets';
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

/** 没有危险色：两条都是普通动作，"退出"也不比"打开"更该被画红（用户指定的）。 */
export const TRAY_ITEMS: ReadonlyArray<{ action: TrayAction; label: string }> = [
  { action: 'show', label: '打开' },
  { action: 'quit', label: '退出' },
];

const TrayMenuStateSchema = z.object({ theme: z.string(), customCss: z.string().default('') });

export function TrayMenu() {
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const themeRequest = useRef(0);
  const applyTheme = useCallback(async () => {
    const generation = ++themeRequest.current;
    const result = await invokeCommand('tray_menu_state', {}, TrayMenuStateSchema);
    if (generation !== themeRequest.current) return;
    setReady(true);
    if (!result.ok) return;
    const { theme, customCss } = result.value;
    applyCustomCss(upgradeCssThemePreset(customCss));
    // 主窗是按 data-theme 上色的（system 时交给 prefers-color-scheme）。独立窗口跟着走，
    // 才不会和主窗一个亮一个暗。
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, []);

  useEffect(() => {
    void applyTheme();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen('tray-menu-opening', () => { setReady(false); void applyTheme(); }).then((stop) => {
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => undefined);
    // 窗口是常驻的，每次再弹出来都可能赶上主窗刚改过主题。
    const onVisibility = () => { if (document.visibilityState === 'visible') void applyTheme(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { disposed = true; unlisten?.(); themeRequest.current += 1; document.removeEventListener('visibilitychange', onVisibility); };
  }, [applyTheme]);

  const focusItem = useCallback((index: number) => {
    const items = root.current?.querySelectorAll<HTMLButtonElement>('.tray-menu-item');
    if (!items?.length) return;
    items[(index + items.length) % items.length]?.focus();
  }, []);

  useEffect(() => {
    if (!ready) return;
    // 焦点**不**落在第一条上。程序化聚焦会被浏览器算成键盘操作（`:focus-visible` 命中），
    // 于是"打开"那一行一直带着一块悬停底色，鼠标移开也不消失——用户报的"打开选项 hover
    // 效果常驻"。焦点交给真的按键：菜单挂上时什么也不高亮，和系统菜单一致。
    //
    // Esc 与方向键都挂在 document 上，没有落点也收得到；第一次按下时向下取第一条、向上
    // 取最后一条，之后在两条之间绕圈。
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
        const down = event.key === 'ArrowDown';
        if (current === -1) focusItem(down ? 0 : items.length - 1);
        else focusItem(current + (down ? 1 : -1));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focusItem, ready]);

  return (
    <div className="tray-menu" data-ready={ready} role="menu" ref={root}>
      {TRAY_ITEMS.map((item) => (
        <button
          className="tray-menu-item"
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
