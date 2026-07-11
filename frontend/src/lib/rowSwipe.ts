// Pure horizontal-swipe geometry for a list row (iOS-mail-style full-swipe
// commit). Framework-free so the axis lock, rubber-banding, and commit rule are
// unit-tested without a pointer. A row exposes up to two actions: a leading one
// (revealed by dragging right, dx > 0) and a trailing one (dragging left).

export type RowSwipeAction = "lead" | "trail";

/** Movement (px) before the gesture commits to an axis. */
export const ROW_ENGAGE_SLOP = 8;
/** Release past this offset (px) fires the action; short of it, the row springs back. */
export const ROW_COMMIT = 88;
/** Offset (px) the row tracks the finger 1:1; beyond it, rubber-band resistance. */
export const ROW_MAX_TRAVEL = 112;

/** Which of a row's actions currently exist. */
export interface RowActions {
  lead: boolean;
  trail: boolean;
}

function resist(over: number): number {
  return Math.sqrt(Math.max(0, over)) * 5;
}

/**
 * Decide the gesture axis once movement clears the slop. Returns "h" for a
 * horizontal swipe (we drive the row), "v" for a vertical one (leave it to the
 * scroller), or null while the gesture is still too small to call.
 */
export function swipeAxis(dx: number, dy: number, slop: number = ROW_ENGAGE_SLOP): "h" | "v" | null {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return null;
  return Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
}

/** The action a horizontal delta points at, or null if that direction has none. */
export function swipeTarget(dx: number, actions: RowActions): RowSwipeAction | null {
  if (dx > 0) return actions.lead ? "lead" : null;
  if (dx < 0) return actions.trail ? "trail" : null;
  return null;
}

/**
 * Visible row offset for a raw finger delta. Tracks 1:1 up to ROW_MAX_TRAVEL
 * toward a real action, then rubber-bands. A direction with no action never
 * opens fully — it only rubber-bands from rest, so the block is felt, not walled.
 */
export function swipeOffset(dx: number, actions: RowActions): number {
  const sign = dx < 0 ? -1 : 1;
  const mag = Math.abs(dx);
  if (!swipeTarget(dx, actions)) return sign * resist(mag);
  if (mag <= ROW_MAX_TRAVEL) return dx;
  return sign * (ROW_MAX_TRAVEL + resist(mag - ROW_MAX_TRAVEL));
}

/** The action to fire on release, or null to spring back (short of commit / no action). */
export function swipeCommits(dx: number, actions: RowActions): RowSwipeAction | null {
  const target = swipeTarget(dx, actions);
  return target && Math.abs(dx) >= ROW_COMMIT ? target : null;
}

/** 0–1 progress toward the commit threshold, for tinting the revealed action. */
export function swipeProgress(dx: number): number {
  return Math.min(1, Math.abs(dx) / ROW_COMMIT);
}
