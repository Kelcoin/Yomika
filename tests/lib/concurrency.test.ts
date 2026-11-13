import { describe, expect, it, vi } from 'vitest';

import { createSemaphore } from '../../src/lib/concurrency';

describe('semaphore', () => {
  it('removes aborted waiters and reserves handed-off slots against new arrivals', async () => {
    const gate = createSemaphore(1);
    let finish!: () => void;
    const first = gate.run(() => new Promise<void>(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const cancelledTask = vi.fn(async () => undefined);
    const cancelled = gate.run(cancelledTask, { signal: controller.signal });
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
    const started: number[] = [];
    let finishSecond!: () => void;
    const second = gate.run(() => {
      started.push(2);
      return new Promise<void>(resolve => { finishSecond = resolve; });
    });
    finish();
    await first;
    const third = gate.run(async () => { started.push(3); });
    expect(gate.active).toBe(1);
    expect(started).toEqual([2]);
    finishSecond();
    await Promise.all([second, third]);
    expect(started).toEqual([2, 3]);
    expect(cancelledTask).not.toHaveBeenCalled();
    expect(gate.active).toBe(0);
  });

  it('runs no more than the limit at once and drains in order', async () => {
    const gate = createSemaphore(2);
    const started: number[] = [];
    const release: Array<() => void> = [];
    const task = (id: number) => gate.run(() => {
      started.push(id);
      return new Promise<number>((resolve) => release.push(() => resolve(id)));
    });

    const all = Promise.all([task(1), task(2), task(3), task(4)]);
    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    expect(gate.active).toBe(2);

    release.shift()!();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    release.shift()!();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]));
    while (release.length) release.shift()!();

    expect(await all).toEqual([1, 2, 3, 4]);
    expect(gate.active).toBe(0);
  });

  it('releases its slot when a task throws', async () => {
    const gate = createSemaphore(1);

    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gate.active).toBe(0);
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });

  it('treats a nonsensical limit as one', async () => {
    const gate = createSemaphore(0);
    const started: number[] = [];
    const release: Array<() => void> = [];
    const task = (id: number) => gate.run(() => {
      started.push(id);
      return new Promise<void>((resolve) => release.push(resolve));
    });

    void task(1);
    void task(2);
    await vi.waitFor(() => expect(started).toEqual([1]));
    while (release.length) release.shift()!();
  });
});
