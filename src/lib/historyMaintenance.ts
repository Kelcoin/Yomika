/** 历史自动清理的排程。
 *
 * 策略本身在原生侧（已读完留 90 天、没读完留 365 天），这里只决定什么时候去问一次，
 * 参照 Readoshi 的 `historyMaintenance.js`：启动后隔几秒先跑一次，之后每 6 小时一次，
 * 只在应用可见时执行，并用「上次检查时刻」把重复触发挡掉。
 */
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
  // 仓库层在真清掉记录时会喊一声「本地写入」（清理写下的墓碑值得推一次），
  // 所以这里只管问一次。
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
