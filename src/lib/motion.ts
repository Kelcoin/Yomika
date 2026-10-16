/** Rubber-band resistance: responsive near the edge, progressively firmer at
 * distance, with no hard stop in velocity. Units are CSS pixels. */
export function rubberBand(travel: number, limit = 80): number {
  const distance = Math.abs(travel);
  return Math.sign(travel) * limit * distance / (distance + limit / 0.55);
}

export const EDGE_CLAIM_PX = 4;
export const EDGE_SETTLE_MS = 360;
export const EDGE_SETTLE_EASING = 'cubic-bezier(.22, 1, .36, 1)';
