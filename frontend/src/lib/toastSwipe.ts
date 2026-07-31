import { flicked, FLICK_MIN_PX } from "./gesture";

/** Horizontal travel past which a release dismisses, regardless of speed. */
export const TOAST_DISMISS_PX = 80;
/** px/s past which a release dismisses regardless of distance (a flick). */
export const TOAST_FLICK_VELOCITY = 500;

/**
 * Should a released toast swipe dismiss?
 *
 * Velocity comes from the pointer, not from elapsed time: Framer reports a
 * signed px/s reading sampled over the last few frames, which is what makes
 * a fast 30px flick feel like a dismissal and a slow 30px nudge feel like a
 * misfire. The flick clause's three guards — floor, direction agreement and
 * speed — are `lib/gesture.ts`'s `flicked`, shared with the other four drag
 * surfaces; see that file for why the floor is not optional. It matters most
 * here, because the toast is the one surface whose accidental dismissal also
 * destroys the action it was offering: `SwipeDeck.undoCommit` is one-shot, so
 * a twitch-dismissed "Undo" toast leaves nothing to undo.
 */
export function shouldDismissToast(offsetX: number, velocityX: number): boolean {
  if (Math.abs(offsetX) >= TOAST_DISMISS_PX) return true;
  return flicked(offsetX, velocityX, FLICK_MIN_PX, TOAST_FLICK_VELOCITY);
}

/** Horizontal distance a dismissed toast flies before it is gone. */
export const TOAST_EXIT_PX = 400;

/**
 * Where a released toast should exit to: 0 for a toast that was not swiped
 * away (it fades and drops in place), otherwise the full fly-out distance in
 * the direction the hand was travelling. Split out of the component so the
 * direction rule — the whole point of the fix — has a regressable test that
 * does not depend on driving a pointer.
 *
 * The `|| velocityX` fallback is now belt-and-braces: `shouldDismissToast`'s
 * distance floor means a dismissal always carries a non-zero offset, so the
 * sign can always be read from it. Kept because it costs nothing and the two
 * rules are free to drift.
 */
export function toastExitX(offsetX: number, velocityX: number): number {
  if (!shouldDismissToast(offsetX, velocityX)) return 0;
  return (offsetX || velocityX) > 0 ? TOAST_EXIT_PX : -TOAST_EXIT_PX;
}
