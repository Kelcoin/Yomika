/** Bounded semaphore, FIFO by default with optional live priorities/cancellation.
 *
 * Cover requests fan out one per visible card, and LANraragi queues thumbnail
 * extraction as Minion jobs: dozens of parallel requests all wait behind that
 * queue, which is why covers took so long to appear. Cap how many run at once.
 */
export interface Semaphore {
  run<T>(task: () => Promise<T>, options?: { signal?: AbortSignal; priority?: () => number }): Promise<T>;
  readonly active: number;
}

export function createSemaphore(limit: number): Semaphore {
  const ceiling = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const waiting: Array<{ start: () => void; priority: () => number }> = [];
  let active = 0;

  return {
    async run<T>(task: () => Promise<T>, options = {} as { signal?: AbortSignal; priority?: () => number }): Promise<T> {
      const { signal, priority = () => 0 } = options;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (active >= ceiling) await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const entry = { priority, start: () => { signal?.removeEventListener('abort', abort); resolve(); } };
        waiting.push(entry);
        signal?.addEventListener('abort', abort, { once: true });
      });
      else active += 1;
      try {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return await task();
      } finally {
        // Reserve the released slot for its waiter before resolving it. A new
        // caller must not steal the slot while the waiter resumes a microtask.
        if (waiting.length) {
          let best = 0;
          for (let i = 1; i < waiting.length; i += 1) {
            if (waiting[i]!.priority() > waiting[best]!.priority()) best = i;
          }
          waiting.splice(best, 1)[0]!.start();
        } else active -= 1;
      }
    },
    get active() {
      return active;
    },
  };
}
