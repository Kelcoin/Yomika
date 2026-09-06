/** Files dropped onto the window.
 *
 * The webview handles drag and drop natively (Tauri's `dragDropEnabled` default),
 * so HTML5 `dragover`/`drop` events never reach the page — a dropzone built on
 * them silently does nothing. This is the only way to see a dropped file, and it
 * is also the only way to get its filesystem path, which is what the native
 * uploader takes.
 */
export type DroppedPathsListener = (paths: string[]) => void;

export interface FileDropHandlers {
  onDrop: DroppedPathsListener;
  /** The pointer is over the window carrying files. */
  onEnter?: (() => void) | undefined;
  /** The drag left the window or was cancelled. */
  onLeave?: (() => void) | undefined;
}

type Subscriber = (handlers: FileDropHandlers) => () => void;

let testSubscriber: Subscriber | undefined;

export function setFileDropForTests(subscriber: Subscriber): void {
  testSubscriber = subscriber;
}

export function resetFileDropForTests(): void {
  testSubscriber = undefined;
}

/** Subscribes to window file drops. Returns an unsubscribe function; calling it
 * before the native listener has attached still cancels it. */
export function onFileDrop(handlers: FileDropHandlers): () => void {
  if (testSubscriber) return testSubscriber(handlers);
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return () => {};
  let cancelled = false;
  const attaching = (async () => {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    return getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type === 'drop') handlers.onDrop(event.payload.paths);
      else if (event.payload.type === 'enter') handlers.onEnter?.();
      else if (event.payload.type === 'leave') handlers.onLeave?.();
    });
  })().catch(() => undefined);
  return () => {
    cancelled = true;
    void attaching.then((unlisten) => unlisten?.());
  };
}
