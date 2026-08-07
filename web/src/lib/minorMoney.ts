/**
 * Money display for the v2 projection: `bigint` minor units, never `number`.
 *
 * # Why this exists next to `lib/money.ts` rather than replacing it
 *
 * `lib/money.ts` is v1's, and it is `number`-based all the way down —
 * `formatFils` divides by 100 and hands the result to `toLocaleString`. Every
 * screen still reading the v1 HTTP API uses it, and those screens are retired
 * by Task 10 rather than converted here.
 *
 * The projection stores amounts as TEXT precisely because a JS `number` cannot
 * hold an `int64` (`client/src/replay/projection.ts`), and `Txn.amount_minor`
 * is a `bigint` for the same reason. So the v2 screens format from `bigint`,
 * and there is no `Number()` in this file: not on the format path, not on the
 * grouping path.
 *
 * This is a port of the *display* half of `app/src/lib/money.ts` — the same
 * functions, the same output, so the two clients print an amount identically.
 * The parse/arithmetic half (`parseAmountDraft`, `divideEvenly`) belongs with
 * the op authors and lands with the write paths, not with a read-only screen.
 */

/** Minor digits per major unit. Pinned at 2 for the beta — see the app port. */
const MINOR_DIGITS = 2;
const MINOR_SCALE = 100n;

/** Where a signed amount points. `"none"` is a row with no direction at all. */
export type MinorFlow = "in" | "out" | "none";

/**
 * Accounting-style magnitude with grouping and a fixed fraction:
 * `1,234.56`, `0.05`, `−1,234.56`.
 *
 * Negatives print with U+2212 MINUS SIGN, and zero prints as `0.00` however it
 * was reached — there is no `-0n`, and this must not manufacture the string
 * form of one either.
 */
export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / MINOR_SCALE;
  const frac = abs % MINOR_SCALE;
  const body = `${group(whole.toString(10))}.${frac.toString(10).padStart(MINOR_DIGITS, "0")}`;
  return negative ? `−${body}` : body;
}

/** `AED 1,234.56` — the currency code, never a symbol. Bare when unknown. */
export function formatMoney(minor: bigint, currency: string): string {
  return currency === "" ? formatMinor(minor) : `${currency} ${formatMinor(minor)}`;
}

/**
 * A transaction amount with its direction on the glyph, so the row stays
 * legible without colour — v1's rule, kept.
 *
 * `direction === ""` is an unparsed row: the amount is `0n` because nothing was
 * extracted, and printing `−0.00` would state that a zero-dirham purchase
 * happened. It prints an em dash instead.
 */
export function signedMinor(direction: "debit" | "credit" | "", minor: bigint): { text: string; flow: MinorFlow } {
  if (direction === "") return { text: "—", flow: "none" };
  const magnitude = formatMinor(minor < 0n ? -minor : minor);
  return direction === "credit" ? { text: `+${magnitude}`, flow: "in" } : { text: `−${magnitude}`, flow: "out" };
}

/** Three digits at a time, from the right. No `Intl`, no `Number`. */
function group(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}
