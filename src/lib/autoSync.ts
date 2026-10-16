/** Local-first synchronization: debounce bursts, bound continuous writes, and poll
 * visible clients sparingly. All automatic triggers share throttling and backoff. */
import { pickServer } from '../domain/server';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSyncRepository } from '../repositories/nativeSyncRepository';
import { onLocalWrite } from './localWrite';
import { invalidateRouteCache } from './routeCache';

/** 写入之后：这段时间没有新写入才动身，把一串连续写入合并成一次。 */
export const WRITE_DEBOUNCE_MS = 30_000;
/** Continuous reading must not postpone the upload indefinitely. */
export const WRITE_MAX_WAIT_MS = 2 * 60_000;
/** 启动之后：先让界面就绪，再补一次。 */
export const STARTUP_DELAY_MS = 5_000;
/** 回到前台：距上次同步超过这个时间才补。 */
export const RESUME_STALE_MS = 60_000;
/** 定时巡检：只在应用可见时走。 */
export const PERIODIC_MS = 5 * 60_000;
/** 失败之后的第一次重试（Readoshi 的 HISTORY_SYNC_RETRY_MS）。 */
export const RETRY_MS = 2 * 60_000;
export const MAX_RETRY_MS = 10 * 60_000;
/** Background flushes are urgent, but quick app switching must not cause a storm. */
export const HIDDEN_MIN_INTERVAL_MS = 15_000;
/** 任何两次自动同步之间的下限，写入触发和巡检一起受它约束。 */
export const MIN_INTERVAL_MS = 60_000;

/** 同步完成且确实动了数据以后派发：路由缓存与偏好据此重新读一遍。 */
export const SYNC_COMPLETED_EVENT = 'yomika:sync-completed';

export type AutoSyncReason = 'startup' | 'resume' | 'hidden' | 'write' | 'online' | 'timer' | 'manual';

export interface AutoSyncStatus {
  running: boolean;
  /** 本进程内最后一次成功的时刻（毫秒），未同步过则 undefined。 */
  lastAt?: number | undefined;
  lastReason?: AutoSyncReason | undefined;
  /** 最近一次失败的原因，成功后清空。 */
  error?: string | undefined;
}

const libraryRepository = new NativeLibraryRepository();
const syncRepository = new NativeSyncRepository();

let enabled = false;
let running = false;
let started = false;
let dirty = false;
let writeVersion = 0;
let dirtySince: number | undefined;
let lastWriteAt: number | undefined;
let lastAttemptAt: number | undefined;
let retryNotBefore = 0;
let failures = 0;
let pendingHidden = false;
let lastAt: number | undefined;
let status: AutoSyncStatus = { running: false };
const listeners = new Set<(status: AutoSyncStatus) => void>();
let writeTimer: number | undefined;
let retryTimer: number | undefined;
let startupTimer: number | undefined;
let periodicTimer: number | undefined;
let stopWriteListener: (() => void) | undefined;

function publish(next: Partial<AutoSyncStatus>): void {
  status = { ...status, ...next };
  for (const listener of listeners) listener(status);
}

export function subscribeAutoSync(listener: (status: AutoSyncStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => { listeners.delete(listener); };
}

export function autoSyncStatus(): AutoSyncStatus {
  return status;
}

/** 由偏好喂进来；关掉之后所有定时触发都不再动身（手动按钮不受影响）。 */
export function setAutoSyncEnabled(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  if (!value) {
    writeTimer = clearTimer(writeTimer);
    retryTimer = clearTimer(retryTimer);
    startupTimer = clearTimer(startupTimer);
  } else if (started) {
    schedule(STARTUP_DELAY_MS, 'startup');
  }
}

function clearTimer(timer: number | undefined): undefined {
  if (timer !== undefined) window.clearTimeout(timer);
  return undefined;
}

function schedule(delay: number, reason: AutoSyncReason): void {
  if (!enabled) return;
  startupTimer = clearTimer(startupTimer);
  startupTimer = window.setTimeout(() => { startupTimer = undefined; void syncNow(reason); }, delay);
}

/** Schedule exactly one trailing write, capped by the oldest outstanding write. */
function scheduleWrite(): void {
  if (!started || !enabled || !dirty) return;
  const now = Date.now();
  const due = pendingHidden ? now : Math.min((lastWriteAt ?? now) + WRITE_DEBOUNCE_MS, (dirtySince ?? now) + WRITE_MAX_WAIT_MS);
  const interval = pendingHidden ? HIDDEN_MIN_INTERVAL_MS : MIN_INTERVAL_MS;
  const lastRequest = Math.max(lastAttemptAt ?? -Infinity, lastAt ?? -Infinity);
  const at = Math.max(due, lastRequest + interval, retryNotBefore);
  writeTimer = clearTimer(writeTimer);
  writeTimer = window.setTimeout(() => {
    writeTimer = undefined;
    void syncNow(pendingHidden ? 'hidden' : 'write');
  }, Math.max(0, at - now));
}

function onWrite(): void {
  if (!started) return;
  dirty = true;
  writeVersion++;
  dirtySince ??= Date.now();
  lastWriteAt = Date.now();
  scheduleWrite();
}

function retryLater(message: string): void {
  publish({ error: message });
  failures++;
  retryNotBefore = Date.now() + Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.min(failures - 1, 4));
  retryTimer = clearTimer(retryTimer);
  if (started && enabled) retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    void syncNow('write');
  }, retryNotBefore - Date.now());
}

/** A completed request only acknowledges writes that existed when it began. */
export async function syncNow(reason: AutoSyncReason = 'manual'): Promise<number | undefined> {
  if (!enabled) return undefined;
  if (reason === 'hidden') pendingHidden = dirty;
  if (running) return undefined;
  if (reason !== 'manual') {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return undefined;
    const interval = reason === 'hidden' ? HIDDEN_MIN_INTERVAL_MS : MIN_INTERVAL_MS;
    const allowedAt = Math.max(Math.max(lastAttemptAt ?? -Infinity, lastAt ?? -Infinity) + interval, retryNotBefore);
    if (Date.now() < allowedAt) {
      if (dirty) scheduleWrite();
      return undefined;
    }
  }
  running = true;
  lastAttemptAt = Date.now();
  const version = writeVersion;
  pendingHidden = false;
  writeTimer = clearTimer(writeTimer);
  startupTimer = clearTimer(startupTimer);
  retryTimer = clearTimer(retryTimer);
  publish({ running: true, lastReason: reason });
  try {
    const [accountResult, serverResult] = await Promise.all([
      syncRepository.listAccounts(),
      libraryRepository.listServers(),
    ]);
    if (!accountResult.ok || !serverResult.ok) {
      retryLater(!accountResult.ok ? accountResult.error.message : !serverResult.ok ? serverResult.error.message : '同步配置读取失败');
      return undefined;
    }
    const account = accountResult.value.find((entry) => entry.active) ?? accountResult.value[0];
    const server = pickServer(serverResult.value, null);
    if (!account || !server) return undefined;
    const result = await syncRepository.syncRemoteScope(account.id, server.scopeId);
    if (!result.ok) {
      retryLater(result.error.message);
      return undefined;
    }
    lastAt = Date.now();
    dirty = writeVersion !== version;
    if (!dirty) { dirtySince = undefined; lastWriteAt = undefined; pendingHidden = false; }
    failures = 0;
    retryNotBefore = 0;
    retryTimer = clearTimer(retryTimer);
    publish({ error: undefined, lastAt });
    publishSyncApplied(reason, result.value);
    return result.value;
  } finally {
    running = false;
    publish({ running: false });
    // A write timer may have fired while the request was running. Always re-arm it.
    scheduleWrite();
  }
}

/** 同步真的动了数据：界面上的快照（首页、书架、历史…）与偏好都可能过期，
 * 一起重新读一遍。手动与自动两条路都走它。 */
export function publishSyncApplied(reason: AutoSyncReason, changes: number): void {
  if (changes <= 0 || typeof window === 'undefined') return;
  invalidateRouteCache();
  window.dispatchEvent(new CustomEvent(SYNC_COMPLETED_EVENT, { detail: { reason, changes } }));
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    // Only flush outstanding changes; the shorter cooldown still limits rapid app switching.
    if (dirty) void syncNow('hidden');
    return;
  }
  pendingHidden = false;
  if (dirty) scheduleWrite();
  const stale = lastAt === undefined || Date.now() - lastAt >= RESUME_STALE_MS;
  if (stale) void syncNow('resume');
}

function onOnline(): void {
  void syncNow('online');
}

/** 装上所有触发点；返回值摘掉它们。 */
export function startAutoSync(): () => void {
  if (started) return stopAutoSync;
  started = true;
  stopWriteListener = onLocalWrite(onWrite);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnline);
  schedule(STARTUP_DELAY_MS, 'startup');
  periodicTimer = window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    // 巡检带上「有东西要推」的意图：写入被节流挡下时就是靠它补上的。
    void syncNow(dirty ? 'write' : 'timer');
  }, PERIODIC_MS);
  return stopAutoSync;
}

export function stopAutoSync(): void {
  started = false;
  stopWriteListener?.();
  stopWriteListener = undefined;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('online', onOnline);
  writeTimer = clearTimer(writeTimer);
  retryTimer = clearTimer(retryTimer);
  startupTimer = clearTimer(startupTimer);
  if (periodicTimer !== undefined) window.clearInterval(periodicTimer);
  periodicTimer = undefined;
}

/** 测试用：把模块状态清干净。 */
export function resetAutoSyncForTests(): void {
  stopAutoSync();
  enabled = false;
  running = false;
  dirty = false;
  writeVersion = 0;
  dirtySince = undefined;
  lastWriteAt = undefined;
  lastAttemptAt = undefined;
  retryNotBefore = 0;
  failures = 0;
  pendingHidden = false;
  lastAt = undefined;
  status = { running: false };
  listeners.clear();
}
