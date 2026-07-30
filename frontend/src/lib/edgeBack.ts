// Pure edge-swipe-back decisions for full-screen drill-in pages. Framework-free
// so the activation zone and the commit rule are unit-tested without rendering.
// Horizontal sibling of lib/sheetDrag.ts.
//
// `edgeBackOffset` (the leftward clamp) is gone with the hand-rolled hook:
// Framer's asymmetric `dragElastic` clamps that side now.

/** A back drag must START within this many px of the left screen edge. */
export const EDGE_ZONE_PX = 24;
/** px/s past which a rightward release pops the page regardless of distance. */
export const EDGE_FLICK_VELOCITY = 550;

/** Did the drag start close enough to the left edge to be a back gesture? */
export function inEdgeZone(startX: number): boolean {
  return startX <= EDGE_ZONE_PX;
}

/**
 * Should a released edge-swipe pop the page? Rightward only — the same
 * direction rule as the sheet, for the same reason. A third of the screen is
 * the commit distance, the same fraction iOS uses.
 */
export function shouldGoBack(offsetX: number, velocityX: number, width: number): boolean {
  if (offsetX <= 0) return false;
  if (offsetX >= width / 3) return true;
  return velocityX >= EDGE_FLICK_VELOCITY;
}
