// TEMPORARY — this whole file is deleted by Task 4.
//
// lib/motion.ts was rewritten (Task 1) onto the new Framer Motion
// seconds/Transition token API and dropped its old CSS-transition-string
// helpers. Five call sites still drive sheets and drill-in pages with plain
// inline `style.transition` strings rather than Framer's `m.*`/
// AnimatePresence: `components/ui/Dialog.tsx`, `components/ui/Dialog.test.tsx`,
// `screens/settings/SettingsPage.tsx`, `hooks/useSheetDrag.ts` and
// `hooks/useEdgeBack.ts`. Task 4 replaces all of that with Framer's `drag`
// prop + AnimatePresence and deletes this file along with useSheetDrag.ts/
// useEdgeBack.ts.
//
// Until then, this is the SINGLE copy of the pre-Task-1 implementation
// (values unchanged from the deleted `lib/motion.ts`) so the five consumers
// share one definition instead of each carrying a silently-divergible copy.

/** Bottom-sheet slide-in duration (ms). Matches the drawer feel; <=300ms. */
const SHEET_ENTER_MS = 300;
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

/** Drill-in pages slide on the same drawer curve and timing as sheets. */
export const pageTransition = sheetTransition;
