import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import {
  INTERVAL_MS,
  STARTUP_DELAY_MS,
  resetHistoryMaintenanceForTests,
  runHistoryMaintenance,
  startHistoryMaintenance,
} from '../../src/lib/historyMaintenance';
import { onLocalWrite, resetLocalWriteForTests } from '../../src/lib/localWrite';

let prunes = 0;
let pruned = 0;

beforeEach(() => {
  vi.useFakeTimers();
  prunes = 0;
  pruned = 0;
  setInvokeAdapterForTests(async (command) => {
    if (command === 'prune_history') { prunes += 1; return { ok: true, value: pruned }; }
    if (command === 'list_sync_accounts') return { ok: true, value: [] };
    if (command === 'list_servers') return { ok: true, value: [] };
    return { ok: false, error: { code: 'UNKNOWN', message: `unexpected ${command}`, retryable: false } };
  });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  resetHistoryMaintenanceForTests();
  resetLocalWriteForTests();
  resetInvokeAdapterForTests();
  vi.useRealTimers();
});

describe('history maintenance', () => {
  it('runs once shortly after startup and then on a long interval', async () => {
    startHistoryMaintenance();
    expect(prunes).toBe(0);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 50);
    expect(prunes).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 50);
    expect(prunes).toBe(2);
  });

  it('shares one run between concurrent callers', async () => {
    const first = runHistoryMaintenance();
    const second = runHistoryMaintenance();
    await Promise.all([first, second]);
    expect(prunes).toBe(1);
  });

  it('asks for a sync once something was actually pruned', async () => {
    let writes = 0;
    const stop = onLocalWrite(() => { writes += 1; });
    pruned = 3;
    await runHistoryMaintenance();
    expect(writes).toBe(1);
    pruned = 0;
    await runHistoryMaintenance();
    expect(writes).toBe(1);
    stop();
  });

  it('skips the sweep while the app is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    startHistoryMaintenance();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + INTERVAL_MS + 100);
    expect(prunes).toBe(0);
  });
});
