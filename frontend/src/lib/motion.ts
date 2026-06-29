// Pure motion helpers. The easing CURVES live in styles/app.css as CSS custom
// properties (`var(--ease-*)`), referenced directly inside inline-style strings
// so there's one source of truth for them. These numbers exist only for JS that
// must coordinate timing — e.g. play an exit transition, then unmount.

/** Bottom-sheet slide-in duration (ms). Matches the drawer feel; <=300ms. */
export const SHEET_ENTER_MS = 300;
/** Bottom-sheet slide-out duration (ms). Exit is snappier than enter. */
export const SHEET_EXIT_MS = 240;

/**
 * Transition for a bottom sheet's `transform`. Under reduced motion we drop the
 * transform transition entirely (the sheet appears/leaves without sliding);
 * opacity/scrim still fade via scrimTransition() to aid comprehension.
 */
export function sheetTransition(reduced: boolean): string {
  return reduced ? "none" : `transform ${SHEET_ENTER_MS}ms var(--ease-drawer)`;
}

/** Transition for the backdrop scrim's opacity. Kept under reduced motion. */
export function scrimTransition(): string {
  return "opacity 200ms var(--ease-out)";
}
