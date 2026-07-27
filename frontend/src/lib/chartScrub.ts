/** Pixels of travel before a chart touch is judged. Matches AXIS_SLOP in
 *  pullToRefresh.ts — the two gestures compete for the same finger, so they
 *  must make their minds up over the same distance or one wins by being
 *  twitchier rather than by being right. */
export const SCRUB_SLOP = 8;

export type ScrubIntent = "claim" | "reject" | "undecided";

/**
 * Axis lock for scrubbing a chart with a finger, the mirror image of
 * `pullIntent` in pullToRefresh.ts.
 *
 * The conflict this resolves: a chart sits inside a vertically scrolling page.
 * Reading the chart means dragging horizontally across it; scrolling past it
 * means dragging vertically over it. The browser cannot tell which you meant
 * from the first pixel, and whichever side guesses eagerly steals the other's
 * gesture — scrub wins and the page won't scroll, or scroll wins and the
 * detail box never appears.
 *
 * So judge nothing until the finger leaves the slop zone, then commit for the
 * rest of the touch. Only a clearly horizontal drag is claimed as a scrub; a
 * clearly vertical one is rejected outright so the page scrolls and
 * pull-to-refresh still works.
 *
 * **Ties reject.** When the two axes are equal the gesture goes to scrolling,
 * because scrolling is the page's default behaviour and the more costly one to
 * get wrong: a scrub you have to retry is a mild annoyance, a page that won't
 * scroll reads as broken. `pullIntent` breaks ties the same way and for the
 * same reason.
 */
export function scrubIntent(dx: number, dy: number, slop = SCRUB_SLOP): ScrubIntent {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay > slop && ay >= ax) return "reject";
  if (ax > slop && ax > ay) return "claim";
  return "undecided";
}
