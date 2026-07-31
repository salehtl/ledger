// Pure edge-swipe-back decisions for full-screen drill-in pages. Framework-free
// so the activation zone and the commit rule are unit-tested without rendering.
// Horizontal sibling of lib/sheetDrag.ts.
//
// `edgeBackOffset` (the leftward clamp) is gone with the hand-rolled hook:
// Framer's asymmetric `dragElastic` clamps that side now.

import { flicked, FLICK_MIN_PX } from "./gesture";

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
 *
 * The flick clause goes through `lib/gesture.ts`'s `flicked`, so it carries the
 * same distance floor as every other surface. That matters here despite the
 * edge zone: a tap landing in the leftmost 24px of a drill-in page is ordinary
 * (it is where a back chevron sits), and without the floor a shivered one was
 * reported at flick speed and popped the page.
 */
export function shouldGoBack(offsetX: number, velocityX: number, width: number): boolean {
  if (offsetX <= 0) return false;
  if (offsetX >= width / 3) return true;
  return flicked(offsetX, velocityX, FLICK_MIN_PX, EDGE_FLICK_VELOCITY);
}
