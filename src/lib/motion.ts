/** Rubber-band resistance: responsive near the edge, progressively firmer at
 * distance, with no hard stop in velocity. Units are CSS pixels. */
export function rubberBand(travel: number, limit = 80): number {
  const distance = Math.abs(travel);
  return Math.sign(travel) * limit * distance / (distance + limit / 0.55);
}

// iOS-optimized edge bounce: 3px claim (more responsive), 340ms settle (snappier), refined curve
export const EDGE_CLAIM_PX = 3;
export const EDGE_SETTLE_MS = 340;
export const EDGE_SETTLE_EASING = 'cubic-bezier(.24, 1, .32, 1)';
