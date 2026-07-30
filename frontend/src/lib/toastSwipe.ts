/** Horizontal travel past which a release dismisses, regardless of speed. */
export const TOAST_DISMISS_PX = 80;
/** px/s past which a release dismisses regardless of distance (a flick). */
export const TOAST_FLICK_VELOCITY = 500;

/**
 * Should a released toast swipe dismiss?
 *
 * Velocity comes from the pointer, not from elapsed time: Framer reports a
 * signed px/s reading sampled over the last few frames, which is what makes
 * a fast 20px flick feel like a dismissal and a slow 20px nudge feel like a
 * misfire. Velocity only counts when it points the same way as the drag —
 * flicking back toward centre means the user changed their mind.
 */
export function shouldDismissToast(offsetX: number, velocityX: number): boolean {
  if (Math.abs(offsetX) >= TOAST_DISMISS_PX) return true;
  const sameDirection = offsetX === 0 || Math.sign(velocityX) === Math.sign(offsetX);
  return sameDirection && Math.abs(velocityX) >= TOAST_FLICK_VELOCITY;
}

/** Horizontal distance a dismissed toast flies before it is gone. */
export const TOAST_EXIT_PX = 400;

/**
 * Where a released toast should exit to: 0 for a toast that was not swiped
 * away (it fades and drops in place), otherwise the full fly-out distance in
 * the direction the hand was travelling. Split out of the component so the
 * direction rule — the whole point of the fix — has a regressable test; a
 * Framer drag cannot be driven meaningfully in jsdom.
 */
export function toastExitX(offsetX: number, velocityX: number): number {
  if (!shouldDismissToast(offsetX, velocityX)) return 0;
  return (offsetX || velocityX) > 0 ? TOAST_EXIT_PX : -TOAST_EXIT_PX;
}
