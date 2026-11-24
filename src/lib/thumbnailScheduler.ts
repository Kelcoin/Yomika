/** One preview queue for a whole reading session.
 *
 * The panel unmounts every time it closes, so a queue owned by its effect died
 * with it: reopening started a fresh four while the old four were still in the
 * air, and a page that failed once was never asked again for the rest of the
 * visit. This queue outlives the panel — in-flight indexes and their slots are
 * shared across close/reopen, successes are remembered, and a page that leaves
 * the rendered window and comes back gets a fresh chance.
 *
 * Three states per page, kept apart on purpose: `loaded` (answered, never ask
 * again), `inFlight` (holding a slot), and `failures` (answered badly, with a
 * bounded backoff). An empty answer and a rejection are both failures, so both
 * release their slot; a page that keeps failing stops being retried until it
 * leaves the window and returns, so a permanent error cannot spin. */

export interface ThumbnailRange {
  /** The rows the grid keeps mounted, overscan included. */
  start: number;
  end: number;
  /** The rows the reader can actually see. Freed slots go here first. */
  visibleStart: number;
  visibleEnd: number;
}

export interface ThumbnailSchedulerOptions {
  load: (index: number) => Promise<string | undefined>;
  onLoaded: (index: number, url: string) => void;
  /** Slots shared by every request this reader has outstanding. */
  concurrency?: number;
  /** Attempts before a failing page waits for the window to return to it. */
  attempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** False once this queue no longer belongs to the reader on screen. */
  isLive?: () => boolean;
  now?: () => number;
}

/** Four at a time: enough to fill a phone's first rows without queueing a whole
 * archive, and the number the panel's own spinner was tuned against. */
export const THUMBNAIL_CONCURRENCY = 4;

interface Failure {
  count: number;
  /** No retry before this instant. */
  until: number;
}

function indices(from: number, to: number, centre: number): number[] {
  const order: number[] = [];
  for (let index = from; index < to; index += 1) order.push(index);
  // Centre-out: a jump lands on the rows the reader is looking at, not on the
  // buffer row above them.
  return order.sort((left, right) => Math.abs(left - centre) - Math.abs(right - centre) || left - right);
}

export class ThumbnailScheduler {
  private readonly load: (index: number) => Promise<string | undefined>;
  private readonly onLoaded: (index: number, url: string) => void;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly isLive: () => boolean;
  private readonly now: () => number;
  private readonly loaded = new Set<number>();
  private readonly inFlight = new Set<number>();
  private readonly failures = new Map<number, Failure>();
  /** Indexes of the previous rendered range: leaving it is what resets a page. */
  private rendered = new Set<number>();
  private window: ThumbnailRange = { start: 0, end: 0, visibleStart: 0, visibleEnd: 0 };
  private active = true;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor({ load, onLoaded, concurrency = THUMBNAIL_CONCURRENCY, attempts = 3, backoffMs = 250, maxBackoffMs = 4_000, isLive = () => true, now = () => Date.now() }: ThumbnailSchedulerOptions) {
    this.load = load;
    this.onLoaded = onLoaded;
    this.concurrency = Math.max(1, concurrency);
    this.maxAttempts = Math.max(1, attempts);
    this.backoffMs = Math.max(1, backoffMs);
    this.maxBackoffMs = Math.max(this.backoffMs, maxBackoffMs);
    this.isLive = isLive;
    this.now = now;
  }

  /** Remember a preview the reader already holds (a panel reopened on a cache). */
  markLoaded(index: number) {
    this.loaded.add(index);
    this.failures.delete(index);
  }

  /** Release settled previews; in-flight requests still own their slots. */
  forgetLoadedOutside(range?: ThumbnailRange) {
    for (const index of this.loaded) {
      if (!range || index < range.start || index >= range.end) this.loaded.delete(index);
    }
  }

  get outstanding() {
    return this.inFlight.size;
  }

  setRange(range: ThumbnailRange) {
    if (this.disposed) return;
    this.window = range;
    const next = new Set<number>();
    const from = Math.max(0, range.start);
    const to = Math.max(from, range.end);
    for (let index = from; index < to; index += 1) {
      next.add(index);
      // Back in the window after being out of it: the old failure described a
      // moment that has passed, so give the page one more go.
      if (!this.rendered.has(index)) this.failures.delete(index);
    }
    this.rendered = next;
    this.pump();
  }

  /** The panel closed: keep the slots, stop starting new work. */
  suspend() {
    this.active = false;
    this.clearTimer();
  }

  resume() {
    if (this.disposed) return;
    this.active = true;
    this.pump();
  }

  dispose() {
    this.disposed = true;
    this.active = false;
    this.clearTimer();
    this.inFlight.clear();
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private pump() {
    if (this.disposed || !this.active) return;
    this.clearTimer();
    const now = this.now();
    let soonest: number | undefined;
    for (const index of this.candidates()) {
      if (this.inFlight.size >= this.concurrency) return;
      if (this.inFlight.has(index) || this.loaded.has(index)) continue;
      const failure = this.failures.get(index);
      if (failure) {
        // Spent its attempts: wait for the window to leave and return instead
        // of retrying a permanent error on every scroll frame.
        if (failure.count >= this.maxAttempts) continue;
        if (failure.until > now) {
          const wait = failure.until - now;
          soonest = soonest === undefined ? wait : Math.min(soonest, wait);
          continue;
        }
      }
      this.start(index);
    }
    if (soonest !== undefined && this.inFlight.size < this.concurrency) {
      this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.max(16, soonest));
    }
  }

  private candidates(): number[] {
    const { start, end, visibleStart, visibleEnd } = this.window;
    const from = Math.max(0, start);
    const to = Math.max(from, end);
    const visibleFrom = Math.max(from, Math.min(to, visibleStart));
    const visibleTo = Math.max(visibleFrom, Math.min(to, visibleEnd));
    const centre = (visibleFrom + visibleTo - 1) / 2;
    const order = indices(visibleFrom, visibleTo, centre);
    const seen = new Set(order);
    for (const index of indices(from, to, centre)) {
      if (!seen.has(index)) order.push(index);
    }
    return order;
  }

  private start(index: number) {
    this.inFlight.add(index);
    void Promise.resolve()
      .then(() => this.load(index))
      .then((url) => {
        if (this.disposed || !this.isLive()) return;
        if (url) {
          this.loaded.add(index);
          this.failures.delete(index);
          this.onLoaded(index, url);
          return;
        }
        // An empty answer is a failed request that happened to resolve.
        this.fail(index);
      }, () => {
        if (!this.disposed && this.isLive()) this.fail(index);
      })
      .then(() => {
        this.inFlight.delete(index);
        this.pump();
      });
  }

  private fail(index: number) {
    const count = (this.failures.get(index)?.count ?? 0) + 1;
    const delay = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (count - 1));
    this.failures.set(index, { count, until: this.now() + delay });
  }
}
