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

/** Movement (px) a touch may wander before the gesture's axis is judged. */
export const AXIS_SLOP = 8;

export type PullIntent = "claim" | "reject" | "undecided";

/**
 * Axis lock: judge a gesture once it leaves the slop zone. Only a clearly
 * downward drag (more vertical than horizontal) is claimed as a pull; a
 * horizontal or upward drag is rejected for the rest of the touch so PTR never
 * fights row swipes, deck flicks, or scrolling. Ties reject — when in doubt,
 * the gesture belongs to whatever the finger is on, not to PTR.
 */
export function pullIntent(dx: number, dy: number, slop = AXIS_SLOP): PullIntent {
  const ax = Math.abs(dx);
  if (ax > slop && ax >= dy) return "reject";
  if (dy < -slop) return "reject";
  if (dy > slop && dy > ax) return "claim";
  return "undecided";
}
