/**
 * "3 minutes ago", for the one place the app prints an elapsed time.
 *
 * Pure and unit-tested here rather than inline in Settings, following `lib/`'s
 * convention: the interesting behaviour is entirely in the boundaries (a sync
 * that finished half a second ago must not read "0 minutes ago", and a clock
 * that has stepped backwards must not read "-2 minutes ago"), and none of that
 * needs a render to check.
 *
 * Deliberately coarse. There is no "3 minutes and 12 seconds", because the
 * question this answers is *is my ledger moving*, and a figure precise enough to
 * change while you look at it invites you to watch it instead.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function sinceLabel(then: number, now: number): string {
  // A negative elapsed time is a clock that moved, not a sync in the future.
  // Reporting "just now" is the only honest thing available: the alternative is
  // arithmetic about a duration that did not happen.
  const ms = Math.max(0, now - then);
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour");
  return plural(Math.floor(ms / DAY), "day");
}

function plural(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? "" : "s"} ago`;
}
