import { useEffect, useState } from 'react';

export type WindowApi = {
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
      minimize: () => tauriInvoke('plugin:window|minimize', { label: WINDOW_LABEL }),
      toggleMaximize: () => tauriInvoke('plugin:window|toggle_maximize', { label: WINDOW_LABEL }),
      close: () => tauriInvoke('plugin:window|close', { label: WINDOW_LABEL }),
      isMaximized: () => tauriInvoke<boolean>('plugin:window|is_maximized', { label: WINDOW_LABEL }),
    };
  });
  return api;
}

/** Tracks the maximized flag, so the caption buttons can draw 最大化 or 还原.
 * A maximize/restore always fires a window resize, which is the refresh hook. */
export function useWindowMaximized(api: WindowApi | undefined): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!api) return undefined;
    let active = true;
    const refresh = () => {
      void api.isMaximized().then((value) => { if (active) setMaximized(Boolean(value)); }).catch(() => { /* the window may be closing */ });
    };
    refresh();
    window.addEventListener('resize', refresh);
    return () => { active = false; window.removeEventListener('resize', refresh); };
  }, [api]);
  return maximized;
}

/** The caption glyphs, drawn in the project's own rounded stroke language
 * (lucide ratios: 2/24 stroke, round caps) rather than the hairline Segoe
 * shapes that clashed with every other icon in the app. */
export function WindowGlyph({ kind }: { kind: 'minimize' | 'maximize' | 'restore' | 'close' }) {
  if (kind === 'minimize') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
        <path d="M5 12h14" />
      </svg>
    );
  }
  if (kind === 'restore') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5.5" y="9" width="10" height="10" rx="2.5" />
        <path d="M9.5 5.5h6a2.5 2.5 0 0 1 2.5 2.5v6" />
      </svg>
    );
  }
  if (kind === 'close') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
        <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}
