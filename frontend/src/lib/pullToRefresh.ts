/** Resisted pull distance (px) needed to trigger a refresh. */
export const PULL_THRESHOLD = 64;
/** Maximum resisted pull distance (px); caps indicator travel. */
export const MAX_PULL = 96;
/** Rubber-band damping applied to raw finger travel. */
const RESISTANCE = 0.5;

/**
 * Convert raw downward finger travel (px) into a damped, capped pull distance.
 * Upward / non-positive travel yields 0.
 */
export function resist(rawDelta: number): number {
  if (rawDelta <= 0) return 0;
  return Math.min(MAX_PULL, rawDelta * RESISTANCE);
}

/** Whether releasing at this resisted distance should trigger a refresh. */
export function shouldTrigger(distance: number): boolean {
  return distance >= PULL_THRESHOLD;
}
