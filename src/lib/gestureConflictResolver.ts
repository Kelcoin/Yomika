/** Gesture conflict resolution for reader zoom vs system gestures.
 * iOS-tuned: edge zones, diagonal detection, velocity thresholds.
 * Prioritizes system back gesture over reader zoom at left edge. */

export interface GestureZone {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface TouchState {
  id: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startTime: number;
  velocity: number;
}

const SYSTEM_EDGE_WIDTH = 24; // iOS back gesture zone
const VERTICAL_SCROLL_BIAS = 1.3; // Favor scroll over zoom when mostly vertical
const PINCH_MIN_DISTANCE = 32; // Minimum spread to recognize as pinch
const VELOCITY_THRESHOLD = 0.8; // px/ms - fast swipe indicates navigation intent
const DIAGONAL_TOLERANCE = 0.6; // cos(53°) - allow 53° deviation from horizontal/vertical

export type GestureIntent =
  | { type: 'system-back' }
  | { type: 'vertical-scroll' }
  | { type: 'horizontal-pan' }
  | { type: 'pinch-zoom'; center: { x: number; y: number } }
  | { type: 'tap'; x: number; y: number }
  | { type: 'unknown' };

export class GestureConflictResolver {
  private touches = new Map<number, TouchState>();
  private gestureIntent: GestureIntent = { type: 'unknown' };
  private locked = false;
  private bounds: GestureZone = { left: 0, right: 0, top: 0, bottom: 0 };

  constructor(private readonly canvas: HTMLElement) {
    this.updateBounds();
  }

  updateBounds(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.bounds = {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    };
  }

  /** Handle touch start - initialize tracking */
  handleTouchStart(event: TouchEvent): GestureIntent | null {
    // Reset on first touch
    if (this.touches.size === 0) {
      this.gestureIntent = { type: 'unknown' };
      this.locked = false;
    }

    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i]!;
      this.touches.set(touch.identifier, {
        id: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        currentX: touch.clientX,
        currentY: touch.clientY,
        startTime: performance.now(),
        velocity: 0,
      });
    }

    // Single touch in system edge = potential back gesture
    if (this.touches.size === 1) {
      const touch = Array.from(this.touches.values())[0]!;
      if (this.isInSystemEdge(touch.startX, touch.startY)) {
        return { type: 'system-back' };
      }
    }

    return null;
  }

  /** Handle touch move - determine intent */
  handleTouchMove(event: TouchEvent): GestureIntent {
    if (this.locked) return this.gestureIntent;

    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i]!;
      const state = this.touches.get(touch.identifier);
      if (!state) continue;

      state.currentX = touch.clientX;
      state.currentY = touch.clientY;

      // Calculate velocity
      const dt = performance.now() - state.startTime;
      if (dt > 0) {
        const dx = touch.clientX - state.startX;
        state.velocity = Math.abs(dx) / dt;
      }
    }

    // Already determined
    if (this.gestureIntent.type !== 'unknown') {
      return this.gestureIntent;
    }

    const touchArray = Array.from(this.touches.values());

    // Single touch - pan or scroll
    if (touchArray.length === 1) {
      const touch = touchArray[0]!;
      const dx = touch.currentX - touch.startX;
      const dy = touch.currentY - touch.startY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < 8) return this.gestureIntent; // Too small to decide

      // Fast horizontal swipe from edge = system back
      if (this.isInSystemEdge(touch.startX, touch.startY) &&
          touch.velocity > VELOCITY_THRESHOLD &&
          dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.gestureIntent = { type: 'system-back' };
        this.locked = true;
        return this.gestureIntent;
      }

      // Check direction
      const angle = Math.abs(dx) / distance;

      if (angle < DIAGONAL_TOLERANCE) {
        // Mostly vertical
        this.gestureIntent = { type: 'vertical-scroll' };
      } else if (angle > (1 - DIAGONAL_TOLERANCE)) {
        // Mostly horizontal
        this.gestureIntent = { type: 'horizontal-pan' };
      } else {
        // Diagonal - favor scroll if more vertical
        this.gestureIntent = Math.abs(dy) > Math.abs(dx) * VERTICAL_SCROLL_BIAS
          ? { type: 'vertical-scroll' }
          : { type: 'horizontal-pan' };
      }

      this.locked = true;
      return this.gestureIntent;
    }

    // Two touches - pinch zoom
    if (touchArray.length === 2) {
      const [t1, t2] = touchArray;
      const startDistance = this.getDistance(
        t1!.startX, t1!.startY,
        t2!.startX, t2!.startY
      );
      const currentDistance = this.getDistance(
        t1!.currentX, t1!.currentY,
        t2!.currentX, t2!.currentY
      );

      if (startDistance > PINCH_MIN_DISTANCE &&
          Math.abs(currentDistance - startDistance) > 16) {
        const centerX = (t1!.currentX + t2!.currentX) / 2;
        const centerY = (t1!.currentY + t2!.currentY) / 2;
        this.gestureIntent = { type: 'pinch-zoom', center: { x: centerX, y: centerY } };
        this.locked = true;
      }
    }

    return this.gestureIntent;
  }

  /** Handle touch end - finalize or reset */
  handleTouchEnd(event: TouchEvent): GestureIntent {
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i]!;
      const state = this.touches.get(touch.identifier);

      if (state) {
        const dx = touch.clientX - state.startX;
        const dy = touch.clientY - state.startY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const duration = performance.now() - state.startTime;

        // Single tap detection
        if (distance < 10 && duration < 300 && this.touches.size === 1) {
          this.gestureIntent = { type: 'tap', x: touch.clientX, y: touch.clientY };
        }
      }

      this.touches.delete(touch.identifier);
    }

    // All touches ended - reset
    if (this.touches.size === 0) {
      const finalIntent = this.gestureIntent;
      this.gestureIntent = { type: 'unknown' };
      this.locked = false;
      return finalIntent;
    }

    return this.gestureIntent;
  }

  /** Handle touch cancel - clean reset */
  handleTouchCancel(event: TouchEvent): void {
    for (let i = 0; i < event.changedTouches.length; i++) {
      this.touches.delete(event.changedTouches[i]!.identifier);
    }

    if (this.touches.size === 0) {
      this.gestureIntent = { type: 'unknown' };
      this.locked = false;
    }
  }

  /** Get current gesture intent */
  getIntent(): GestureIntent {
    return this.gestureIntent;
  }

  /** Check if position is in system gesture edge */
  private isInSystemEdge(x: number, _y: number): boolean {
    // Left edge only (iOS back gesture)
    return x - this.bounds.left < SYSTEM_EDGE_WIDTH;
  }

  /** Calculate distance between two points */
  private getDistance(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Reset all state */
  reset(): void {
    this.touches.clear();
    this.gestureIntent = { type: 'unknown' };
    this.locked = false;
  }
}

/** Create a gesture resolver for the given canvas */
export function createGestureResolver(canvas: HTMLElement): GestureConflictResolver {
  return new GestureConflictResolver(canvas);
}
