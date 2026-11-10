import { useEffect, useRef, useState, type RefObject } from 'react';

/** Gesture textures are bounded; the original remains the source of truth and
 * returns immediately after the gesture/settle window. No change to inference. */
export function readerGestureTextureSize(width: number, height: number) {
  if (!Number.isFinite(width * height) || width <= 0 || height <= 0 || width * height <= 12_000_000) return undefined;
  const scale = Math.min(1, 3072 / Math.max(width, height), Math.sqrt(4_000_000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

// Prepare at most one large bitmap at a time, outside input handlers. Cancelled
// pages never start a decode, and every finished bitmap is explicitly released.
let preparation = Promise.resolve();
export function useReaderGestureTexture(image: RefObject<HTMLImageElement>, source: string, enabled = true) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [readyFor, setReadyFor] = useState<string>();
  useEffect(() => {
    setReadyFor(undefined);
    const element = image.current;
    if (!enabled || !element || typeof createImageBitmap !== 'function') return;
    let cancelled = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: number | undefined;
    const run = () => {
      if (queued || cancelled || !element.complete || element.naturalWidth === 0) return;
      const size = readerGestureTextureSize(element.naturalWidth, element.naturalHeight);
      if (!size) return;
      queued = true;
      const prepare = async (): Promise<void> => {
        if (cancelled) return;
        // Finishing another page's decode must not start new work under a finger.
        if (element.closest('[data-image-interaction="true"]')) {
          timer = setTimeout(() => { preparation = preparation.then(prepare, prepare); }, 120);
          return;
        }
        const target = canvas.current;
        if (!target) return;
        let bitmap: ImageBitmap | undefined;
        try {
          bitmap = await createImageBitmap(element, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' });
          if (cancelled) return;
          const context = target.getContext('2d', { alpha: false });
          if (!context) return;
          target.width = size.width;
          target.height = size.height;
          context.drawImage(bitmap, 0, 0);
          setReadyFor(source);
        } catch {
          // Optional acceleration: the decoded original still works.
        } finally { bitmap?.close(); }
      };
      const schedule = () => { preparation = preparation.then(prepare, prepare); };
      if ('requestIdleCallback' in window) idle = window.requestIdleCallback(schedule, { timeout: 2000 });
      else timer = setTimeout(schedule, 300);
    };
    element.addEventListener('load', run);
    run();
    return () => {
      cancelled = true;
      element.removeEventListener('load', run);
      if (timer !== undefined) clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      // Release backing memory after unmount/source changes.
      const target = canvas.current;
      if (target) { target.width = 0; target.height = 0; }
    };
  }, [image, source, enabled]);
  return { canvas, ready: enabled && readyFor === source && (canvas.current?.width ?? 0) > 0 };
}
