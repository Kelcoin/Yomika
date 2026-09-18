/** 自动同步：什么时候自己去同步一次。
 *
 * 触发点参考 Readoshi 的做法（`src/lib/history.js`、`src/lib/historyMaintenance.js`、
 * `PwaStatus`）：写入后合并成一次（不是每翻一页推一次）、启动后巡检、回到前台补一次、
 * 切到后台立刻送一次、网络恢复、失败两分钟后重试、外加一个长间隔的定时巡检。手动按钮
 * 仍然走设置页那一份，这里只管没人盯着的时候。
 *
 * 频率上比 Readoshi 保守：远端是一份完整文档（GET + 条件 PUT 都是整份），所以写入后
 * 的合并窗口是 30 秒、两次自动同步之间至少隔 60 秒——翻页风暴不该变成每秒一次的传输。
 */
import { pickServer } from '../domain/server';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSyncRepository } from '../repositories/nativeSyncRepository';
import { onLocalWrite } from './localWrite';
import { invalidateRouteCache } from './routeCache';

/** 写入之后：这段时间没有新写入才动身，把一串连续写入合并成一次。 */
export const WRITE_DEBOUNCE_MS = 30_000;
/** 启动之后：先让界面就绪，再补一次。 */
export const STARTUP_DELAY_MS = 5_000;
/** 回到前台：距上次同步超过这个时间才补。 */
export const RESUME_STALE_MS = 5 * 60_000;
/** 定时巡检：只在应用可见时走。 */
export const PERIODIC_MS = 30 * 60_000;
/** 失败之后的第一次重试（Readoshi 的 HISTORY_SYNC_RETRY_MS）。 */
export const RETRY_MS = 2 * 60_000;
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
  enabled = value;
}

function clearTimer(timer: number | undefined): undefined {
  if (timer !== undefined) window.clearTimeout(timer);
  return undefined;
}

function schedule(delay: number, reason: AutoSyncReason): void {
  if (!enabled) return;
  if (reason === 'write') {
    writeTimer = clearTimer(writeTimer);
    writeTimer = window.setTimeout(() => { writeTimer = undefined; void syncNow('write'); }, delay);
    return;
  }
  startupTimer = clearTimer(startupTimer);
  startupTimer = window.setTimeout(() => { startupTimer = undefined; void syncNow(reason); }, delay);
}

/** 本地写入了会被同步的数据：合并成一次推送，不跟着每一次写入跑。 */
function onWrite(): void {
  if (!started) return;
  dirty = true;
  schedule(WRITE_DEBOUNCE_MS, 'write');
}

function throttled(reason: AutoSyncReason): boolean {
  // 切到后台与手动同步不受限：一个是不想丢掉刚读到的位置，一个是用户明确按了。
  if (reason === 'hidden' || reason === 'manual') return false;
  return lastAt !== undefined && Date.now() - lastAt < MIN_INTERVAL_MS;
}

/** 同步一次（如果账户与服务器都在、开关开着、又没被节流挡住）。 */
export async function syncNow(reason: AutoSyncReason = 'manual'): Promise<number | undefined> {
  if (running || !enabled) return undefined;
  if (throttled(reason)) {
    // 被挡下时把「有东西要推」留到下一次巡检，别把它弄丢。
    if (dirty) schedule(WRITE_DEBOUNCE_MS, 'write');
    return undefined;
  }
  running = true;
  publish({ running: true, lastReason: reason });
  try {
    const [accountResult, serverResult] = await Promise.all([
      syncRepository.listAccounts(),
      libraryRepository.listServers(),
    ]);
    if (!accountResult.ok || !serverResult.ok) return undefined;
    // 两套账户只生效一套：自动同步跟着生效的那套走。
    const account = accountResult.value.find((entry) => entry.active) ?? accountResult.value[0];
    const server = pickServer(serverResult.value, null);
    if (!account || !server) return undefined;
    const result = await syncRepository.syncRemoteScope(account.id, server.scopeId);
    if (!result.ok) {
      publish({ error: result.error.message });
      retryTimer = clearTimer(retryTimer);
      retryTimer = window.setTimeout(() => { retryTimer = undefined; void syncNow('write'); }, RETRY_MS);
      return undefined;
    }
    lastAt = Date.now();
    dirty = false;
    publish({ error: undefined, lastAt });
    publishSyncApplied(reason, result.value);
    return result.value;
  } finally {
    running = false;
    publish({ running: false });
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
    // 离开/最小化：把刚读到的位置尽快送出去，这一下不等节流。
    void syncNow('hidden');
    return;
  }
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
  lastAt = undefined;
  status = { running: false };
  listeners.clear();
}
