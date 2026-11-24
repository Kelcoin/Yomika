/** Aggressive image decoding strategy with Intersection Observer.
 * Predecodes images before they enter viewport for instant rendering.
 * iOS-tuned: 1.5x viewport lookahead, staggered decode to avoid jank. */

import { decodeImageElementStrict } from './decodeImage';

interface DecodeTask {
  img: HTMLImageElement;
  priority: number;
  timestamp: number;
}

const VIEWPORT_LOOKAHEAD = 1.5; // Decode images 1.5 viewports ahead
const DECODE_BATCH_SIZE = 3; // Decode 3 images per batch
const DECODE_BATCH_DELAY = 32; // 32ms between batches (~2 frames)
const PRIORITY_VISIBLE = 1000;
const PRIORITY_NEAR = 500;
const PRIORITY_FAR = 100;

export class AggressiveImageDecoder {
  private observer: IntersectionObserver | null = null;
  private pendingQueue: DecodeTask[] = [];
  private decodingSet = new Set<HTMLImageElement>();
  private decodedSet = new WeakSet<HTMLImageElement>();
  private batchTimer: number | undefined;
  private isProcessing = false;
  private rootElement: HTMLElement;

  constructor(root: HTMLElement) {
    this.rootElement = root;
    this.initObserver();
  }

  private initObserver(): void {
    // Three thresholds: visible, near (1 viewport), far (1.5 viewports)
    this.observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const img = entry.target as HTMLImageElement;

          if (!img.complete || !img.naturalWidth) continue;
          if (this.decodedSet.has(img)) continue;

          const priority = entry.isIntersecting
            ? PRIORITY_VISIBLE
            : entry.intersectionRatio > 0.1
            ? PRIORITY_NEAR
            : PRIORITY_FAR;

          this.scheduleDecoding(img, priority);
        }
      },
      {
        root: this.rootElement,
        rootMargin: `${Math.round(window.innerHeight * VIEWPORT_LOOKAHEAD)}px`,
        threshold: [0, 0.1, 0.5, 1],
      }
    );
  }

  /** Observe an image element for aggressive predecoding */
  observe(img: HTMLImageElement): void {
    if (!this.observer) return;

    // Immediately decode if already complete and in viewport
    if (img.complete && img.naturalWidth) {
      const rect = img.getBoundingClientRect();
      const inViewport = rect.top < window.innerHeight && rect.bottom > 0;

      if (inViewport && !this.decodedSet.has(img)) {
        this.scheduleDecoding(img, PRIORITY_VISIBLE);
      }
    }

    this.observer.observe(img);
  }

  /** Stop observing an image */
  unobserve(img: HTMLImageElement): void {
    this.observer?.unobserve(img);

    // Remove from queue if pending
    const index = this.pendingQueue.findIndex(task => task.img === img);
    if (index >= 0) this.pendingQueue.splice(index, 1);
  }

  private scheduleDecoding(img: HTMLImageElement, priority: number): void {
    // Skip if already decoding or decoded
    if (this.decodingSet.has(img) || this.decodedSet.has(img)) return;

    // Update priority if already queued
    const existing = this.pendingQueue.find(task => task.img === img);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      this.sortQueue();
      return;
    }

    this.pendingQueue.push({
      img,
      priority,
      timestamp: performance.now(),
    });

    this.sortQueue();
    this.startBatchProcessing();
  }

  private sortQueue(): void {
    // Sort by priority (high first), then by timestamp (old first)
    this.pendingQueue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.timestamp - b.timestamp;
    });
  }

  private startBatchProcessing(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.processBatch();
  }

  private processBatch = async (): Promise<void> => {
    if (this.pendingQueue.length === 0) {
      this.isProcessing = false;
      return;
    }

    // Take top priority batch
    const batch = this.pendingQueue.splice(0, DECODE_BATCH_SIZE);

    // Decode batch in parallel
    const decodePromises = batch.map(async task => {
      this.decodingSet.add(task.img);

      try {
        await decodeImageElementStrict(task.img);
        this.decodedSet.add(task.img);
      } catch (err) {
        // Decode failure is non-fatal, image will show when loaded
        console.debug('Image decode failed:', err);
      } finally {
        this.decodingSet.delete(task.img);
      }
    });

    await Promise.all(decodePromises);

    // Schedule next batch with delay to avoid blocking
    if (this.pendingQueue.length > 0) {
      this.batchTimer = window.setTimeout(this.processBatch, DECODE_BATCH_DELAY);
    } else {
      this.isProcessing = false;
    }
  };

  /** Force decode a specific image immediately (high priority) */
  async decodeNow(img: HTMLImageElement): Promise<void> {
    if (this.decodedSet.has(img)) return;

    this.decodingSet.add(img);
    try {
      await decodeImageElementStrict(img);
      this.decodedSet.add(img);

      // Remove from queue if pending
      const index = this.pendingQueue.findIndex(task => task.img === img);
      if (index >= 0) this.pendingQueue.splice(index, 1);
    } finally {
      this.decodingSet.delete(img);
    }
  }

  /** Clear all pending tasks */
  clear(): void {
    this.pendingQueue = [];
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    this.isProcessing = false;
  }

  /** Clean up resources */
  dispose(): void {
    this.clear();
    this.observer?.disconnect();
    this.observer = null;
    this.decodingSet.clear();
  }

  /** Get current queue stats */
  getStats(): { pending: number; decoding: number } {
    return {
      pending: this.pendingQueue.length,
      decoding: this.decodingSet.size,
    };
  }
}

/** Create an aggressive image decoder for a scroll container */
export function createImageDecoder(root: HTMLElement): AggressiveImageDecoder {
  return new AggressiveImageDecoder(root);
}
