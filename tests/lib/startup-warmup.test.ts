import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleStartupWarmup } from '../../src/app/startupWarmup';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('bounded startup warming', () => {
  it('waits for first-frame fonts and pauses when the app is hidden', async () => {
    vi.useFakeTimers();
    let fontStatus = 'loading';
    let visibility = 'visible';
    const previousFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: { get status() { return fontStatus; } } });
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    const task = vi.fn(async () => {});
    const stop = scheduleStartupWarmup([task]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).not.toHaveBeenCalled();
    fontStatus = 'loaded';
    visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).not.toHaveBeenCalled();
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(350);
    expect(task).toHaveBeenCalledOnce();
    stop();
    if (previousFonts) Object.defineProperty(document, 'fonts', previousFonts);
    else Reflect.deleteProperty(document, 'fonts');
    visible.mockRestore();
  });
  it('waits until a held pointer and subsequent scroll activity have settled', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => {});
    const stop = scheduleStartupWarmup([task]);
    const down = new Event('pointerdown');
    Object.defineProperty(down, 'pointerId', { value: 1 });
    window.dispatchEvent(down);
    await vi.advanceTimersByTimeAsync(1200);
    expect(task).not.toHaveBeenCalled();
    const up = new Event('pointerup');
    Object.defineProperty(up, 'pointerId', { value: 1 });
    window.dispatchEvent(up);
    await vi.advanceTimersByTimeAsync(300);
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(300);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledOnce();
    stop();
  });
  it('uses idle budget, rechecks input, and cancels queued idle work', async () => {
    vi.useFakeTimers();
    let callback!: IdleRequestCallback;
    const request = vi.fn((cb: IdleRequestCallback) => { callback = cb; return 7; });
    const cancel = vi.fn();
    vi.stubGlobal('requestIdleCallback', request);
    vi.stubGlobal('cancelIdleCallback', cancel);
    const task = vi.fn(async () => {});
    const stop = scheduleStartupWarmup([task]);
    await vi.advanceTimersByTimeAsync(500);
    callback({ didTimeout: false, timeRemaining: () => 2 });
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    window.dispatchEvent(new Event('wheel'));
    callback({ didTimeout: true, timeRemaining: () => 0 });
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
    callback({ didTimeout: true, timeRemaining: () => 0 });
    expect(task).not.toHaveBeenCalled();
  });
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
