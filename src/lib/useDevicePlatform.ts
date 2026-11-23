import { useSyncExternalStore } from 'react';
import { DEVICE_LAYOUT_EVENT } from './layoutMode';

function subscribe(update: () => void) {
  window.addEventListener(DEVICE_LAYOUT_EVENT, update);
  return () => window.removeEventListener(DEVICE_LAYOUT_EVENT, update);
}

export function useDevicePlatform(): string | undefined {
  return useSyncExternalStore(subscribe, () => document.documentElement.dataset.nativePlatform);
}
