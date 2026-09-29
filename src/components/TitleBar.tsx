import { YomikaMark } from './YomikaMark';
import { WindowGlyph, useWindowControls, useWindowMaximized } from './WindowControls';

/** The Windows title bar, drawn by the app: a themed strip with the brand
 * mark, a full-width drag surface, and the three window controls. The native
 * decorations are off on Windows (decorations(false) in lib.rs); macOS keeps
 * its own traffic lights and never mounts this bar.
 *
 * Dragging and double-click-to-maximize belong to Tauri's own drag-region
 * script. `deep` includes the mark's SVG descendants; the controls explicitly
 * opt out. A React onDoubleClick used to live here as well, and the two fought:
 * a double click that started on a control button bubbled to the header and
 * toggle-maximized after the button's own action, so 最小化 looked like it
 * needed two presses (down, restore, down again) and 最大化 flipped twice. */
export function TitleBar() {
  const api = useWindowControls();
  const maximized = useWindowMaximized(api);

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <span className="titlebar-mark">
        <YomikaMark size={18} />
      </span>
      <span className="titlebar-name">Yomika</span>
      {/* 按钮区显式退出拖拽区域（Tauri 的拖拽脚本认这个属性），并拦住 mousedown
          与双击：落在标题栏上的手势处理不该盖过按钮本身的一次点击，否则表现
          就是「有时要点两下」。 */}
      <div
        className="titlebar-controls"
        data-tauri-drag-region="false"
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <button className="titlebar-control" type="button" aria-label="最小化" title="最小化" onClick={() => { void api?.minimize().catch(() => {}); }}>
          <WindowGlyph kind="minimize" />
        </button>
        <button className="titlebar-control" type="button" aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} onClick={() => { void api?.toggleMaximize().catch(() => {}); }}>
          <WindowGlyph kind={maximized ? 'restore' : 'maximize'} />
        </button>
        <button className="titlebar-control is-close" type="button" aria-label="关闭" title="关闭" onClick={() => { void api?.close().catch(() => {}); }}>
          <WindowGlyph kind="close" />
        </button>
      </div>
    </header>
  );
}
