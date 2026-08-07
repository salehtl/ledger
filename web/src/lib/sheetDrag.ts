// Pure drag-to-dismiss decision for a bottom sheet. Framework-free so the
// dismissal rule is unit-tested without rendering — a Framer drag cannot be
// driven meaningfully in jsdom, so the rule has to live somewhere it can be.
//
// The damping curve that used to live here (`sheetOffset`) is gone: Framer's
// `dragElastic` owns the rubber-band now, asymmetrically, so there is nothing
// left for us to compute per pointermove.

import { flicked, FLICK_MIN_PX } from "./gesture";

/** Downward travel past which a release dismisses the sheet. */
export const SHEET_DISMISS_PX = 110;
/** px/s past which a downward release dismisses regardless of distance. */
export const SHEET_FLICK_VELOCITY = 550;

/**
 * Should a released sheet drag dismiss?
 *
 * Sheets only dismiss downward — an upward drag is rubber-banding, never a
 * gesture — so the direction check comes first and the rest of the function
 * only ever sees a positive offset. Velocity is Framer's signed px/s reading
 * and, via `flicked`, only counts when it agrees with the drag direction and
 * the drag actually travelled: flicking back up after dragging down cancels
 * rather than confirms, and a shivered tap on the handle (reported at
 * ~600px/s on five pixels) is not a dismissal. See `lib/gesture.ts`.
 *
 * Direction agreement is already implied here by `offsetY > 0` plus a positive
 * velocity; `flicked` re-derives it rather than the call site checking twice.
 */
export function shouldDismissSheet(offsetY: number, velocityY: number): boolean {
  if (offsetY <= 0) return false;
  if (offsetY >= SHEET_DISMISS_PX) return true;
  return flicked(offsetY, velocityY, FLICK_MIN_PX, SHEET_FLICK_VELOCITY);
}
