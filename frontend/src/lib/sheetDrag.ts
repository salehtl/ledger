// Pure drag-to-dismiss decision for a bottom sheet. Framework-free so the
// dismissal rule is unit-tested without rendering — a Framer drag cannot be
// driven meaningfully in jsdom, so the rule has to live somewhere it can be.
//
// The damping curve that used to live here (`sheetOffset`) is gone: Framer's
// `dragElastic` owns the rubber-band now, asymmetrically, so there is nothing
// left for us to compute per pointermove.

/** Downward travel past which a release dismisses the sheet. */
export const SHEET_DISMISS_PX = 110;
/** px/s past which a downward release dismisses regardless of distance. */
export const SHEET_FLICK_VELOCITY = 550;

/**
 * Should a released sheet drag dismiss?
 *
 * Sheets only dismiss downward — an upward drag is rubber-banding, never a
 * gesture. Velocity is Framer's signed px/s reading and only counts when it
 * agrees with the drag direction, so flicking back up after dragging down
 * cancels rather than confirms.
 */
export function shouldDismissSheet(offsetY: number, velocityY: number): boolean {
  if (offsetY <= 0) return false;
  if (offsetY >= SHEET_DISMISS_PX) return true;
  return velocityY >= SHEET_FLICK_VELOCITY;
}
