import { YomikaMark } from './YomikaMark';
import { WindowGlyph, useWindowControls, useWindowDrag, useWindowMaximized } from './WindowControls';

/** The Windows title bar, drawn by the app: a themed strip with the brand
 * mark, a full-width drag surface, and the three window controls. The native
 * decorations are off on Windows (decorations(false) in lib.rs); macOS keeps
 * its own traffic lights and never mounts this bar.
 *
 * The drag and maximize gestures live in `useWindowDrag` because the reader —
 * a full-bleed screen that covers this bar — needs exactly the same two. The
 * control cluster still stops propagation: a press on a button owns the press,
 * so only the empty title surface starts a move. */
export function TitleBar() {
  const api = useWindowControls();
  const maximized = useWindowMaximized(api);
  const drag = useWindowDrag();

  return (
    <header className="titlebar" {...drag}>
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
