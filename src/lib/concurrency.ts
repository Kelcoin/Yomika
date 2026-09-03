/** Minimal FIFO semaphore.
 *
 * Cover requests fan out one per visible card, and LANraragi queues thumbnail
 * extraction as Minion jobs: dozens of parallel requests all wait behind that
 * queue, which is why covers took so long to appear. Cap how many run at once.
 */
export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly active: number;
}

export function createSemaphore(limit: number): Semaphore {
  const ceiling = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const waiting: Array<() => void> = [];
  let active = 0;

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= ceiling) await new Promise<void>((resolve) => { waiting.push(resolve); });
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    },
    get active() {
      return active;
    },
  };
}
