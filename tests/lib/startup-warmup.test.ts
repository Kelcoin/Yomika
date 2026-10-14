import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleStartupWarmup } from '../../src/app/startupWarmup';

afterEach(() => vi.useRealTimers());
describe('bounded startup warming', () => {
  it('yields the first frame and waits for each task before spacing the next', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const order: number[] = [];
    const stop = scheduleStartupWarmup([
      () => new Promise<void>(resolve => { order.push(1); finish = resolve; }),
      async () => { order.push(2); },
    ]);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(499);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(order).toEqual([1]);
    finish();
    await vi.advanceTimersByTimeAsync(149);
    expect(order).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual([1, 2]);
    stop();
  });
  it('isolates failures and cancellation, including StrictMode setup replay', async () => {
    vi.useFakeTimers();
    const order: number[] = [];
    const tasks = [async () => { order.push(1); throw Error('offline'); }, async () => { order.push(2); }];
    const stopFirst = scheduleStartupWarmup(tasks);
    stopFirst();
    const stop = scheduleStartupWarmup(tasks);
    await vi.advanceTimersByTimeAsync(650);
    expect(order).toEqual([1, 2]);
    stop();
    const stopCancelled = scheduleStartupWarmup([async () => { order.push(3); }]);
    stopCancelled();
    await vi.runAllTimersAsync();
    expect(order).toEqual([1, 2]);
  });
});
