import { useEffect, useState } from 'react';
import { YomikaMark } from './YomikaMark';

type WindowApi = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  startDragging: () => Promise<void>;
};

function tauriInvoke(command: string): Promise<void> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, payload?: unknown) => Promise<void> } }).__TAURI_INTERNALS__;
  if (!internals) return Promise.reject(new Error('not in tauri'));
  return internals.invoke(command);
}

/** The Windows title bar, drawn by the app: a themed strip with the brand
 * mark, a full-width drag surface, and the three window controls. The native
 * decorations are off on Windows (decorations(false) in lib.rs); macOS keeps
 * its own traffic lights and never mounts this bar. The maximize button
 * toggles — its label covers both meanings because the undecorated window's
 * maximized state cannot be queried reliably. */
export function TitleBar() {
  const [api] = useState<WindowApi | undefined>(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return undefined;
    return {
      minimize: () => tauriInvoke('plugin:window|minimize'),
      toggleMaximize: () => tauriInvoke('plugin:window|toggle_maximize'),
      close: () => tauriInvoke('plugin:window|close'),
      startDragging: () => tauriInvoke('drag_start'),
    };
  });

  const onMouseDown = (event: React.MouseEvent) => {
    // Only the bare surface drags — buttons stop propagation on their own.
    if (event.button === 0) void api?.startDragging().catch(() => {});
  };

  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onMouseDown={onMouseDown}
      onDoubleClick={() => { void api?.toggleMaximize().catch(() => {}); }}
    >
      <span className="titlebar-mark" data-drag-region="true">
        <YomikaMark size={18} />
      </span>
      <span className="titlebar-name" data-drag-region="true">Yomika</span>
      <div className="titlebar-controls">
        <button className="titlebar-control" type="button" aria-label="最小化" title="最小化" onClick={(event) => { event.stopPropagation(); void api?.minimize().catch(() => {}); }}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button className="titlebar-control" type="button" aria-label="最大化或还原" title="最大化或还原" onClick={(event) => { event.stopPropagation(); void api?.toggleMaximize().catch(() => {}); }}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
        </button>
        <button className="titlebar-control is-close" type="button" aria-label="关闭" title="关闭" onClick={(event) => { event.stopPropagation(); void api?.close().catch(() => {}); }}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1" /><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
      </div>
    </header>
  );
}
