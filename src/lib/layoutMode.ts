/** Layout mode describes the device shell, not the current orientation or input
 * accessory. A tablet with a mouse is still mobile; a touchscreen PC is not. */
export const COMPACT_WIDTH_QUERY = '(max-width: 900px)';
export const DEVICE_LAYOUT_EVENT = 'yomika-device-layout-change';

let nativeMobile: boolean | undefined;

export function isMobileDevice(): boolean {
  if (nativeMobile !== undefined) return nativeMobile;
  return document.documentElement.dataset.nativeMobile === 'true'
    || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function isCompactLayout(): boolean {
  return isMobileDevice() || (window.matchMedia?.(COMPACT_WIDTH_QUERY).matches ?? false);
}

export function syncLayoutMode(): void {
  document.documentElement.dataset.layout = isCompactLayout() ? 'compact' : 'desktop';
}

/** Native capabilities are authoritative if the WebView presents a desktop UA. */
export function setLayoutPlatform(platform: string): void {
  if (platform === 'browser') return;
  nativeMobile = platform === 'android' || platform === 'ios';
  syncLayoutMode();
  window.dispatchEvent(new Event(DEVICE_LAYOUT_EVENT));
}

export function initializeLayoutMode(): () => void {
  syncLayoutMode();
  const media = window.matchMedia?.(COMPACT_WIDTH_QUERY);
  media?.addEventListener('change', syncLayoutMode);
  return () => media?.removeEventListener('change', syncLayoutMode);
}
