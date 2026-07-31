// Pure horizontal-swipe commit rule for a list row (iOS-mail-style full-swipe
// commit). Framework-free so the commit decision is unit-tested without a
// pointer. A row exposes up to two actions: a leading one (revealed by
// dragging right) and a trailing one (dragging left).
//
// Axis detection and elastic clamping used to live here (`swipeAxis`,
// `swipeOffset`) but are gone: Framer's `dragDirectionLock` and `dragElastic`
// do both natively on the `drag="x"` element, so there is nothing left here
// to compute per pointermove.

import { flicked, FLICK_MIN_PX } from "./gesture";

export type RowSwipeAction = "lead" | "trail";

/** Release past this offset (px) fires the action; short of it, the row springs back. */
export const ROW_COMMIT = 88;
/** px/s past which a release commits regardless of distance. */
export const ROW_FLICK_VELOCITY = 500;

/** Which of a row's actions currently exist. */
export interface RowActions {
  lead: boolean;
  trail: boolean;
}

/**
 * Which action, if any, a released row swipe commits.
 *
 * Axis detection and elastic clamping used to live here; Framer's
 * `dragDirectionLock` and `dragElastic` do both natively, so this is now
 * purely the commit decision. The flick clause is `lib/gesture.ts`'s `flicked`
 * — direction agreement (flicking back cancels) plus the distance floor that
 * keeps a shivered tap on a row from archiving a transaction.
 *
 * Note this predicate decides *what* a horizontal release commits, not
 * *whether* the release was horizontal at all. That is the caller's job:
 * `info.offset` is raw pointer travel and is unaffected by
 * `dragDirectionLock`, so `SwipeableRow` gates this call on the axis Framer
 * actually locked (see its `onDirectionLock`).
 */
export function swipeCommits(
  offsetX: number,
  velocityX: number,
  actions: RowActions,
): RowSwipeAction | null {
  const committed =
    Math.abs(offsetX) >= ROW_COMMIT ||
    flicked(offsetX, velocityX, FLICK_MIN_PX, ROW_FLICK_VELOCITY);
  if (!committed) return null;
  if (offsetX > 0) return actions.lead ? "lead" : null;
  return actions.trail ? "trail" : null;
}

/** 0–1 progress toward the commit threshold, for tinting the revealed action. */
export function swipeProgress(dx: number): number {
  return Math.min(1, Math.abs(dx) / ROW_COMMIT);
}
