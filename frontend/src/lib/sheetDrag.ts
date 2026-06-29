// Pure drag-to-dismiss geometry for a bottom sheet. Framework-free so the
// damping curve and the dismissal rule are unit-tested without rendering.

/** Drag-down distance (px) that dismisses on release. */
export const SHEET_DISMISS_DISTANCE = 120;
/** Flick velocity (px/ms) that dismisses regardless of distance. */
export const SHEET_DISMISS_VELOCITY = 0.11;

/**
 * Resolve raw vertical drag into the sheet's visible offset. Downward (dy > 0)
 * moves 1:1. Dragging up past rest gets rubber-band damping — the further you
 * push, the less it moves — instead of an invisible wall.
 */
export function sheetOffset(dy: number): number {
  if (dy >= 0) return dy;
  return -Math.sqrt(-dy) * 6;
}

/** Should the sheet dismiss on release? A long drag down OR a quick flick down. */
export function shouldDismiss(dy: number, elapsedMs: number): boolean {
  if (dy <= 0) return false;
  const velocity = dy / Math.max(1, elapsedMs);
  return dy >= SHEET_DISMISS_DISTANCE || velocity >= SHEET_DISMISS_VELOCITY;
}
