/**
 * Dates and the small strings a transaction screen prints.
 *
 * # This is a rewrite of `frontend/src/lib/format.ts`, and the money half is gone
 *
 * v1's `format.ts` mixed date labels with `dirhamsToFils` / `filsToDirhams` /
 * `fractionToPercent`. All four of those are `number` arithmetic and all four
 * now live in `money.ts` as `bigint` (or, for the percentage pair, nowhere —
 * Task 21 owns budget percentages and will need its own rounding rule). What is
 * left here is text.
 *
 * # No `Date` is constructed for a value, anywhere
 *
 * `client/src/replay/state.ts` explains what that cost the fold: a
 * `new Date(ms).toISOString().slice(0, 10)` inside `fingerprint` could crash the
 * whole replay on one legal timestamp, and it made a frozen cross-executor value
 * depend on a `Date` round trip. The UI is not the fold — a wrong label is not a
 * wrong number — but the *day* a row is filed under has to be the day the fold
 * filed it under, or a list groups by one rule and duplicate detection by
 * another. So every day here comes from `utcDay(parseInstantMs(iso))`, the same
 * two functions the engine uses.
 *
 * The consequence worth stating: **days are UTC days**, not the device's local
 * days. A purchase at 02:00 Gulf time files under the previous UTC day. That is
 * the fold's rule and this follows it rather than inventing a second one; a
 * later task that wants local days has to change both together, which is exactly
 * the coupling this comment exists to make visible.
 */

import { parseInstantMs, canonicalTime } from "@ledger/client/wire/op.ts";
import { utcDay } from "@ledger/client/replay/state.ts";
import type { ParseTier, Txn } from "@ledger/client/replay/state.ts";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Canonical form: what `canonicalTime` produces, and the only shape {@link withDay} splices. */
const CANONICAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/** A `YYYY-MM-DD` draft, syntactically. Realness is checked by {@link isDayDraft}. */
const DAY_DRAFT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The UTC calendar day of a wire timestamp, `YYYY-MM-DD`, or `""` when the
 * string is not one.
 *
 * The empty string rather than a throw: this runs inside a list row, and one
 * unreadable `posted_at` must not take the screen down with it.
 */
export function dayKey(iso: string): string {
  const ms = instantOrNull(iso);
  return ms === null ? "" : utcDay(ms);
}

/** `Jul 10`, or `Jul 10, 2025` outside `todayIso`'s year. Echoes the input if unreadable. */
export function shortDate(iso: string, todayIso: string): string {
  const day = dayKey(iso);
  if (day === "") return iso;
  const label = `${monthShort(day)} ${Number(day.slice(8, 10))}`;
  return day.slice(0, 4) === dayKey(todayIso).slice(0, 4) ? label : `${label}, ${day.slice(0, 4)}`;
}

/** `Today` / `Yesterday` / {@link shortDate}. The section header of a grouped list. */
export function dayLabel(iso: string, todayIso: string): string {
  const day = dayKey(iso);
  const today = dayKey(todayIso);
  if (day === "" || today === "") return shortDate(iso, todayIso);
  if (day === today) return "Today";
  const todayMs = instantOrNull(todayIso);
  // Arithmetic on the instant, not on the string: "the day before the 1st" is a
  // month-length question and a leap-year question, and both are already solved
  // exactly once, in `utcDay`.
  if (todayMs !== null && day === utcDay(todayMs - 86_400_000)) return "Yesterday";
  return shortDate(iso, todayIso);
}

/** `10 July 2026`. The detail screen's date. */
export function longDate(iso: string): string {
  const day = dayKey(iso);
  if (day === "") return iso;
  const month = MONTHS_LONG[Number(day.slice(5, 7)) - 1] ?? day.slice(5, 7);
  return `${Number(day.slice(8, 10))} ${month} ${day.slice(0, 4)}`;
}

/** `HH:MM`, UTC, or `""`. */
export function timeOfDay(iso: string): string {
  const ms = instantOrNull(iso);
  if (ms === null) return "";
  const inDay = ((ms % 86_400_000) + 86_400_000) % 86_400_000;
  const minutes = Math.floor(inDay / 60_000);
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** Whether a draft is a complete, real calendar day. `2026-02-30` is not one. */
export function isDayDraft(draft: string): boolean {
  if (!DAY_DRAFT.test(draft)) return false;
  // Round-tripped through the engine's own parser rather than through a
  // days-in-month table written a second time here. `Date.parse` would accept
  // 2026-02-30 and answer March 2.
  return instantOrNull(`${draft}T00:00:00.000Z`) !== null;
}

/**
 * `base` moved to `day`, keeping its time of day.
 *
 * Editing a date must not silently discard the clock — two transactions on the
 * same day sort by it — so this splices rather than rebuilding at midnight. The
 * splice is only safe on a canonical string, which is what the projection holds
 * (`posted_at` is stored through `instant()`), so a non-canonical base is a
 * throw rather than a best effort. The result is re-validated through
 * `canonicalTime`, so an impossible day cannot leave here as a timestamp.
 */
export function withDay(base: string, day: string): string {
  const m = CANONICAL.exec(base);
  if (m === null) throw new Error(`withDay needs a canonical UTC timestamp, got ${JSON.stringify(base)}`);
  if (!isDayDraft(day)) throw new Error(`withDay needs a real YYYY-MM-DD day, got ${JSON.stringify(day)}`);
  return canonicalTime(`${day}T${base.slice(11)}`);
}

/**
 * Who wrote the row (spec §3.3(b)).
 *
 * The distinction is required in the UI, and it is a *writer* fact rather than a
 * payload one: the ingest writer's chain proves the blob was stored intact and
 * proves nothing about whether the operator's server was honest about what it
 * ingested. A user-authored row was authored on a device the user holds.
 */
export function provenanceLabel(provenance: Txn["provenance"]): string {
  return provenance === "ingest" ? "From your inbox" : "Entered on a device";
}

/**
 * The one-paragraph explanation of the provenance marker.
 *
 * Task 18 Step 4 asks for a small permanent marker on every ingest row and the
 * explanation "once, in Settings". Settings is Task 27, so this lives here — one
 * exported string — and both screens print the same words rather than two people
 * writing this paragraph twice and disagreeing about what the chain proves.
 */
export const PROVENANCE_EXPLAINER =
  "Rows marked as coming from your inbox were written by the server that receives your forwarded mail. " +
  "Its signature proves the record reached you unaltered — it does not prove the server read the email correctly, " +
  "or that it wrote down everything it received. Rows you entered or corrected on a device were signed by that device.";

/**
 * Which tier produced the row.
 *
 * `tier === "none"` does **not** mean unparsed — it is also every op a client
 * authors — so the flag decides the copy and the tier alone never does.
 */
export function tierLabel(tier: ParseTier, unparsed: boolean): string {
  if (unparsed) return "Nothing could be read";
  switch (tier) {
    case "template":
      return "Bank template";
    case "heuristic":
      return "Read by pattern";
    case "none":
      return "Entered by hand";
  }
}

/**
 * A `parse_error` token as a sentence.
 *
 * The set is the pipeline's to define and it defines none yet — `txnPayload` in
 * `pipeline.go` has no such field, so every op in existence reads null. Rather
 * than invent an enumeration a Go writer would then fail to match, this prints
 * the known tokens nicely and de-snakes anything else. An unknown reason still
 * reaches the user, which is the whole point of retaining it.
 */
export function parseErrorCopy(token: string | null): string {
  if (token === null || token === "") return "";
  const known: Record<string, string> = {
    no_amount: "No amount",
    no_merchant: "No merchant",
    no_date: "No date",
    no_template: "No template matched",
  };
  const hit = known[token];
  if (hit !== undefined) return hit;
  const words = token.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function monthShort(day: string): string {
  return MONTHS_SHORT[Number(day.slice(5, 7)) - 1] ?? day.slice(5, 7);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** `parseInstantMs`, with its throw turned into a `null` for display paths. */
function instantOrNull(iso: string): number | null {
  try {
    return parseInstantMs(iso);
  } catch {
    return null;
  }
}
