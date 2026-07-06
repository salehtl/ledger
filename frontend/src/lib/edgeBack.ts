// Pure edge-swipe-back geometry for full-screen drill-in pages. Framework-free
// so the activation zone and the commit rule are unit-tested without rendering.
// Horizontal sibling of lib/sheetDrag.ts.

/** A back drag must START within this many px of the left screen edge. */
export const EDGE_ZONE_PX = 24;
/** Fraction of the viewport width that commits the back navigation. */
export const BACK_COMMIT_FRACTION = 1 / 3;
/** Flick velocity (px/ms) that commits regardless of distance. */
export const BACK_COMMIT_VELOCITY = 0.11;

/** Did the drag start close enough to the left edge to be a back gesture? */
export function inEdgeZone(startX: number): boolean {
  return startX <= EDGE_ZONE_PX;
}

/**
 * Resolve raw horizontal drag into the page's visible offset. Rightward
 * (dx > 0) moves 1:1; leftward is clamped to rest — there is nothing to
 * the left to reveal.
 */
export function edgeBackOffset(dx: number): number {
  return Math.max(0, dx);
}

/** Should the page pop on release? A long drag right OR a quick flick right. */
export function shouldGoBack(dx: number, elapsedMs: number, viewportWidth: number): boolean {
  if (dx <= 0) return false;
  const velocity = dx / Math.max(1, elapsedMs);
  return dx >= viewportWidth * BACK_COMMIT_FRACTION || velocity >= BACK_COMMIT_VELOCITY;
}
