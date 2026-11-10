/** Legacy manual maintenance adapter. History no longer expires by age.
 * The application no longer starts this scheduler. */
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';

export const STARTUP_DELAY_MS = 5_000;
export const INTERVAL_MS = 6 * 60 * 60 * 1000;

const repository = new NativeLibraryRepository();

let started = false;
let inFlight: Promise<number> | undefined;
let startupTimer: number | undefined;
let intervalTimer: number | undefined;

/** 清一次历史；返回清掉的条数。并发调用共享同一次执行。 */
export function runHistoryMaintenance(): Promise<number> {
  if (inFlight) return inFlight;
  inFlight = repository.pruneHistory()
    .then((result) => (result.ok ? result.value : 0))
    .finally(() => { inFlight = undefined; });
  return inFlight;
}

export function startHistoryMaintenance(): () => void {
  if (started) return stopHistoryMaintenance;
  started = true;
  startupTimer = window.setTimeout(() => {
    startupTimer = undefined;
    if (document.visibilityState === 'visible') void runHistoryMaintenance();
  }, STARTUP_DELAY_MS);
  intervalTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void runHistoryMaintenance();
  }, INTERVAL_MS);
  return stopHistoryMaintenance;
}

export function stopHistoryMaintenance(): void {
  started = false;
  if (startupTimer !== undefined) window.clearTimeout(startupTimer);
  if (intervalTimer !== undefined) window.clearInterval(intervalTimer);
  startupTimer = undefined;
  intervalTimer = undefined;
}

export function resetHistoryMaintenanceForTests(): void {
  stopHistoryMaintenance();
  inFlight = undefined;
}
