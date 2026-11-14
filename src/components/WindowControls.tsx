import { SvgIcon } from './SvgIcon';
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';

export type WindowApi = {
  startDragging: () => Promise<void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
};

/** The window-plugin labels are per-window in Tauri 2; the official JS API
 * always sends one, so the raw invokes do too. */
const WINDOW_LABEL = 'main';

function tauriInvoke<T>(command: string, payload: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, payload?: unknown) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals) return Promise.reject(new Error('not in tauri'));
  return internals.invoke(command, payload);
}

export function useWindowControls(): WindowApi | undefined {
  const [api] = useState<WindowApi | undefined>(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return undefined;
    return {
      startDragging: () => tauriInvoke('plugin:window|start_dragging', { label: WINDOW_LABEL }),
      minimize: () => tauriInvoke('plugin:window|minimize', { label: WINDOW_LABEL }),
      toggleMaximize: () => tauriInvoke('plugin:window|toggle_maximize', { label: WINDOW_LABEL }),
      close: () => tauriInvoke('plugin:window|close', { label: WINDOW_LABEL }),
      isMaximized: () => tauriInvoke<boolean>('plugin:window|is_maximized', { label: WINDOW_LABEL }),
    };
  });
  return api;
}

/** 栏上的控件自己吃掉按下与双击：点在按钮或链接上不该同时是一次窗口手势。 */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, a, input, select, textarea') !== null;
}

/** The two gestures every window bar shares: a bare left-button press starts the
 * native move, and a double click toggles maximize. The shell's title bar used to
 * own them, but the reader is a full-bleed screen — the native decorations are
 * off on Windows and the reader covers the bar that has them, so its own bars
 * have to offer the same two gestures or that screen cannot be moved at all.
 *
 * `detail !== 1` is the first press of a double click, which is not a drag (that
 * is the "sometimes it takes two clicks" bug the shell bar already fixed). The
 * double click is consumed where it is handled: the reader also reads a double
 * click on the canvas as "back to the original scale", and a bar that maximized
 * the window *and* zoomed the page would do two things at once. */
export function useWindowDrag(): {
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
} {
  const api = useWindowControls();
  return {
    onMouseDown: (event) => {
      if (event.button !== 0 || event.detail !== 1) return;
      if (isControl(event.target)) return;
      void api?.startDragging().catch(() => { /* 窗口可能正在关闭 */ });
    },
    onDoubleClick: (event) => {
      if (event.button !== 0) return;
      if (isControl(event.target)) return;
      event.stopPropagation();
      void api?.toggleMaximize().catch(() => { /* 窗口可能正在关闭 */ });
    },
  };
}

/** Tracks the maximized flag, so the caption buttons can draw 最大化 or 还原.
 * A maximize/restore always fires a window resize, which is the refresh hook. */
export function useWindowMaximized(api: WindowApi | undefined): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!api) return undefined;
    let active = true;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void api.isMaximized().then((value) => { if (active) setMaximized(Boolean(value)); }).catch(() => { /* the window may be closing */ });
    };
    refresh();
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refresh, 100);
    };
    window.addEventListener('resize', onResize);
    return () => { active = false; clearTimeout(resizeTimer); window.removeEventListener('resize', onResize); };
  }, [api]);
  return maximized;
}

/** The caption glyphs, drawn in the project's own rounded stroke language
 * (lucide ratios: 1.75/24 stroke, round caps) rather than the hairline Segoe
 * shapes that clashed with every other icon in the app. */
export function WindowGlyph({ kind }: { kind: 'minimize' | 'maximize' | 'restore' | 'close' }) {
  if (kind === 'minimize') {
    return (
      <SvgIcon>
        <path d="M5 12h14" />
      </SvgIcon>
    );
  }
  if (kind === 'restore') {
    return (
      <SvgIcon>
        <rect x="5.5" y="9" width="10" height="10" rx="2.5" />
        <path d="M9.5 5.5h6a2.5 2.5 0 0 1 2.5 2.5v6" />
      </SvgIcon>
    );
  }
  if (kind === 'close') {
    return (
      <SvgIcon>
        <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
      </SvgIcon>
    );
  }
  return (
    <SvgIcon>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </SvgIcon>
  );
}
