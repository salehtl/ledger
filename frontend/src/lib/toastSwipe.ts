import { SHEET_DISMISS_VELOCITY } from "./sheetDrag";

/** Horizontal drag distance (px) that dismisses a toast on release. */
export const TOAST_DISMISS_DISTANCE = 80;

/** Dismiss on a long horizontal drag (either direction) or a quick flick. */
export function shouldDismissToast(dx: number, elapsedMs: number): boolean {
  const dist = Math.abs(dx);
  const velocity = dist / Math.max(1, elapsedMs);
  return dist >= TOAST_DISMISS_DISTANCE || velocity >= SHEET_DISMISS_VELOCITY;
}
