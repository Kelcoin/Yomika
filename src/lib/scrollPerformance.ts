/** Scroll performance monitoring for 60fps stability tracking.
 * Monitors frame timing during scroll events to detect jank and report metrics.
 * iOS-tuned: 16.67ms budget per frame, 3-frame rolling average for stability. */

export interface ScrollMetrics {
  /** Average FPS over the measurement window */
  averageFps: number;
  /** Percentage of frames that hit 60fps (< 16.67ms) */
  smoothFrames: number;
  /** Worst frame time in the window (ms) */
  worstFrame: number;
  /** Total frames measured */
  frameCount: number;
  /** Whether performance is acceptable (>90% smooth frames) */
  isSmooth: boolean;
}

interface FrameSample {
  timestamp: number;
  delta: number;
}

const FRAME_BUDGET_MS = 16.67; // 60fps
const SAMPLE_WINDOW_SIZE = 180; // 3 seconds at 60fps
const SMOOTH_THRESHOLD = 0.90; // 90% frames must hit budget

export class ScrollPerformanceMonitor {
  private samples: FrameSample[] = [];
  private lastTimestamp = 0;
  private rafId = 0;
  private isTracking = false;
  private scrollTimeout: number | undefined;
  private onMetricsUpdate: ((metrics: ScrollMetrics) => void) | undefined;

  constructor(onMetricsUpdate?: (metrics: ScrollMetrics) => void) {
    this.onMetricsUpdate = onMetricsUpdate;
  }

  /** Start monitoring scroll performance on the given element */
  observe(element: HTMLElement): () => void {
    const handleScroll = () => {
      if (!this.isTracking) {
        this.startTracking();
      }
      // Reset idle timer - keep tracking for 300ms after last scroll event
      if (this.scrollTimeout !== undefined) clearTimeout(this.scrollTimeout);
      this.scrollTimeout = window.setTimeout(() => this.stopTracking(), 300);
    };

    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', handleScroll);
      this.stopTracking();
    };
  }

  private startTracking(): void {
    if (this.isTracking) return;
    this.isTracking = true;
    this.lastTimestamp = performance.now();
    this.samples = [];
    this.measure();
  }

  private stopTracking(): void {
    if (!this.isTracking) return;
    this.isTracking = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.scrollTimeout !== undefined) {
      clearTimeout(this.scrollTimeout);
      this.scrollTimeout = undefined;
    }
    // Report final metrics
    if (this.samples.length > 0) {
      this.onMetricsUpdate?.(this.computeMetrics());
    }
  }

  private measure = (): void => {
    if (!this.isTracking) return;

    const now = performance.now();
    const delta = this.lastTimestamp > 0 ? now - this.lastTimestamp : 0;

    if (delta > 0) {
      this.samples.push({ timestamp: now, delta });
      // Keep only the most recent samples (rolling window)
      if (this.samples.length > SAMPLE_WINDOW_SIZE) {
        this.samples.shift();
      }
    }

    this.lastTimestamp = now;
    this.rafId = requestAnimationFrame(this.measure);
  };

  private computeMetrics(): ScrollMetrics {
    if (this.samples.length === 0) {
      return { averageFps: 60, smoothFrames: 1, worstFrame: 0, frameCount: 0, isSmooth: true };
    }

    const totalDelta = this.samples.reduce((sum, s) => sum + s.delta, 0);
    const avgDelta = totalDelta / this.samples.length;
    const averageFps = 1000 / avgDelta;

    const smoothCount = this.samples.filter(s => s.delta <= FRAME_BUDGET_MS).length;
    const smoothFrames = smoothCount / this.samples.length;

    const worstFrame = Math.max(...this.samples.map(s => s.delta));

    return {
      averageFps: Math.round(averageFps * 10) / 10,
      smoothFrames: Math.round(smoothFrames * 1000) / 1000,
      worstFrame: Math.round(worstFrame * 10) / 10,
      frameCount: this.samples.length,
      isSmooth: smoothFrames >= SMOOTH_THRESHOLD,
    };
  }

  /** Get current metrics snapshot */
  getMetrics(): ScrollMetrics {
    return this.computeMetrics();
  }

  /** Clear all collected samples */
  reset(): void {
    this.samples = [];
    this.lastTimestamp = 0;
  }

  /** Clean up resources */
  dispose(): void {
    this.stopTracking();
    this.onMetricsUpdate = undefined;
  }
}

/** Create a performance monitor with optional live metrics callback */
export function createScrollMonitor(onMetrics?: (metrics: ScrollMetrics) => void): ScrollPerformanceMonitor {
  return new ScrollPerformanceMonitor(onMetrics);
}
