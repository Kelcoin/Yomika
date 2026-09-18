import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import {
  MIN_INTERVAL_MS,
  PERIODIC_MS,
  RESUME_STALE_MS,
  RETRY_MS,
  STARTUP_DELAY_MS,
  WRITE_DEBOUNCE_MS,
  autoSyncStatus,
  resetAutoSyncForTests,
  setAutoSyncEnabled,
  startAutoSync,
  stopAutoSync,
  syncNow,
} from '../../src/lib/autoSync';
import { notifyLocalWrite, resetLocalWriteForTests } from '../../src/lib/localWrite';
import { invalidateRouteCache, readRouteCache, writeRouteCache } from '../../src/lib/routeCache';

const account = {
  id: 'dav-1',
  label: 'NAS',
  baseUrl: 'https://dav.example.com/Yomika',
  username: 'reader',
  credentialRef: 'ref-a',
  syncScope: '[]',
  status: 'ok',
  lastProbeAt: null,
  lastSyncAt: null,
  lastErrorCode: null,
  createdAt: '2026-09-01 00:00:00',
  updatedAt: '2026-09-01 00:00:00',
};

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

let syncCalls: number;
let syncResult: { ok: true; value: number } | { ok: false; error: { code: string; message: string; retryable: boolean } };
let accounts: unknown[];

beforeEach(() => {
  vi.useFakeTimers();
  syncCalls = 0;
  syncResult = { ok: true, value: 0 };
  accounts = [account];
  setInvokeAdapterForTests(async (command) => {
    if (command === 'list_sync_accounts') return { ok: true, value: accounts };
    if (command === 'list_servers') return { ok: true, value: [{ id: 'server-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a', enabled: true }] };
    if (command === 'sync_remote_scope') { syncCalls += 1; return syncResult; }
    return { ok: false, error: { code: 'UNKNOWN', message: `unexpected ${command}`, retryable: false } };
  });
  setVisibility('visible');
  setAutoSyncEnabled(true);
  invalidateRouteCache();
});

afterEach(() => {
  resetAutoSyncForTests();
  resetLocalWriteForTests();
  resetInvokeAdapterForTests();
  vi.useRealTimers();
});

describe('auto sync triggers', () => {
  it('syncs once shortly after startup', async () => {
    startAutoSync();
    expect(syncCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 50);
    expect(syncCalls).toBe(1);
  });

  it('collapses a burst of local writes into one sync after the reader pauses', async () => {
    startAutoSync();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 50);
    const afterStartup = syncCalls;

    // 越过最小间隔，否则写入触发会被节流挡下（那正是它该做的事）。
    vi.setSystemTime(Date.now() + MIN_INTERVAL_MS + 1_000);
    notifyLocalWrite();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 1_000);
    notifyLocalWrite();
    notifyLocalWrite();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS + 50);
    expect(syncCalls).toBe(afterStartup + 1);
  });

  it('sends immediately when the app goes to the background, throttling or not', async () => {
    startAutoSync();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 50);
    const afterStartup = syncCalls;

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls).toBe(afterStartup + 1);
  });

  it('only catches up on return when the last sync is stale', async () => {
    startAutoSync();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 50);
    const afterStartup = syncCalls;

    // 刚刚同步过：回到前台不补。
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(0);
    const afterHidden = syncCalls;
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls).toBe(afterHidden);

    // 隔了足够久：回到前台补一次。
    vi.setSystemTime(Date.now() + RESUME_STALE_MS + 1_000);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(0);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls).toBeGreaterThan(afterHidden);
    expect(afterStartup).toBeLessThanOrEqual(syncCalls);
  });

  it('syncs when the network comes back', async () => {
    startAutoSync();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 50);
    const afterStartup = syncCalls;

    vi.setSystemTime(Date.now() + MIN_INTERVAL_MS + 1_000);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls).toBe(afterStartup + 1);
  });

  it('retries two minutes after a failure', async () => {
    syncResult = { ok: false, error: { code: 'NETWORK', message: '断网', retryable: true } };
    startAutoSync();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 50);
    expect(syncCalls).toBe(1);
    expect(autoSyncStatus().error).toBe('断网');

    syncResult = { ok: true, value: 2 };
    await vi.advanceTimersByTimeAsync(RETRY_MS + 50);
    expect(syncCalls).toBe(2);
    expect(autoSyncStatus().error).toBeUndefined();
  });

  it('keeps the periodic sweep while the app is visible', async () => {
    startAutoSync();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 50);
    const afterStartup = syncCalls;

    await vi.advanceTimersByTimeAsync(PERIODIC_MS + 100);
    expect(syncCalls).toBe(afterStartup + 1);

    // 不可见时不巡检。
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(0);
    const hiddenCalls = syncCalls;
    await vi.advanceTimersByTimeAsync(PERIODIC_MS + 100);
    expect(syncCalls).toBe(hiddenCalls);
  });

  it('does nothing while the preference is off', async () => {
    setAutoSyncEnabled(false);
    startAutoSync();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + PERIODIC_MS + 100);
    notifyLocalWrite();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS + 100);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(100);
    expect(syncCalls).toBe(0);
  });

  it('drops the route snapshots and announces the change after a pull', async () => {
    writeRouteCache('home:shelf', { archives: [] });
    const completed = vi.fn();
    window.addEventListener('yomika:sync-completed', completed);

    syncResult = { ok: true, value: 4 };
    await syncNow('manual');
    expect(completed).toHaveBeenCalledTimes(1);
    // 快照被清掉：下一次读取会重新取，界面上就是刚同步回来的数据。
    expect(readRouteCache('home:shelf')).toBeUndefined();
    window.removeEventListener('yomika:sync-completed', completed);
  });

  it('leaves the snapshots alone when nothing changed', async () => {
    writeRouteCache('home:shelf', { archives: [] });
    const completed = vi.fn();
    window.addEventListener('yomika:sync-completed', completed);

    syncResult = { ok: true, value: 0 };
    await syncNow('manual');
    expect(completed).not.toHaveBeenCalled();
    expect(readRouteCache('home:shelf')).toEqual({ archives: [] });
    window.removeEventListener('yomika:sync-completed', completed);
  });

  it('stops cleanly', async () => {
    const stop = startAutoSync();
    stop();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + PERIODIC_MS + 100);
    expect(syncCalls).toBe(0);
    stopAutoSync();
  });
});
