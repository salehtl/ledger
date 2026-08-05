/**
 * Money, in `bigint` minor units.
 *
 * # This is a REWRITE of `frontend/src/lib/money.ts`, not a port of it
 *
 * v1's money helpers are `number`-based: `formatFils` divides by 100 and hands
 * the result to `toLocaleString`, `dirhamsToFils` is `Math.round(x * 100)`, and
 * `parseAmountToFils` recombines two `Number()` calls. Every one of those is a
 * float operation, and Task 18's step for this file says the "adapt only the
 * money type" framing understates the change — `bigint` has no fractional
 * division, so each site needs an explicit rounding rule rather than an implicit
 * IEEE one.
 *
 * The two rules, stated once and tested against their counterparts:
 *
 *   - **Rounding is half-up, above zero only**, and it is the same expression
 *     `client/src/replay/fx.ts`'s `convert` uses (`+ half`, then truncate).
 *     `money.test.ts` checks the two against each other rather than checking
 *     each against a hand-written expectation, because "the app rounds the same
 *     way everywhere" is only true if something compares them.
 *   - **Division that cannot be exact names its absorber.** {@link divideEvenly}
 *     floors and gives the remainder to the last part, so a split always sums
 *     back to its parent — which `I8_split_sum` and `replay.ts`'s `precheck`
 *     both require, and which a "divide and hope" implementation satisfies for
 *     three-way splits of round numbers and for nothing else.
 *
 * # Why the formatting is hand-rolled
 *
 * `toLocaleString` is the v1 implementation and it is unavailable here in the
 * form we need: it is a `Number` method, and `BigInt.prototype.toLocaleString`
 * depends on Hermes' Intl build. Grouping three digits at a time is four lines
 * of string work; routing money through a float to get commas is not a trade
 * worth making.
 *
 * # No `Number()` anywhere in this file
 *
 * Not on the parse path, not on the format path, not on the validation path.
 * The one `number` here is a part COUNT, which is not money.
 */

/**
 * Minor digits per major unit. **Pinned at 2 for the beta**, deliberately, and
 * this is the place a currency table would go if one is ever needed.
 *
 * Every currency in the corpus (AED, USD, EUR, GBP) has two. ISO 4217 does not
 * agree universally — JPY has none, KWD and BHD have three — but nothing else in
 * the system carries an exponent either: `internal/v2/heuristic`'s `amount()`
 * removes the decimal point and reads the digits as minor units, and
 * `rate_micro` converts minor units to minor units, so an exponent that existed
 * only in this file would disagree with the parser that produced the number. If
 * a three-digit currency is ever admitted, it changes the *pipeline* first.
 */
export const MINOR_DIGITS = 2;

/** `10 ** MINOR_DIGITS`, as the `bigint` every division here is against. */
export const MINOR_SCALE = 100n;

/**
 * The largest amount a client may author: `int64` max.
 *
 * Money is `int64` minor units on the Go side (`internal/v2/oplog/op.go`), and
 * §3.5 requires the two executors to agree. A `bigint` has no such ceiling, so
 * without this check a user could type an amount that folds fine on this device
 * and overflows the other executor — a divergence authored by the UI. It is
 * refused at entry, where a person can retype it, rather than discovered later.
 */
export const MAX_MINOR = 9_223_372_036_854_775_807n;

/** Half a minor unit's worth of the discarded tail, for half-up rounding. */
const ROUND_UP_FROM = 5;

/** Where a signed amount points. `"none"` is a row with no direction at all. */
export type Flow = "in" | "out" | "none";

/** What a draft string means. `"empty"` is NOT zero — see {@link parseAmountDraft}. */
export type AmountDraft =
  | { kind: "empty" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; minor: bigint; rounded: boolean };

/**
 * Accounting-style magnitude with grouping and a fixed fraction:
 * `1,234.56`, `0.05`, `−1,234.56`.
 *
 * Negatives print with U+2212 MINUS SIGN rather than a hyphen, and a value of
 * zero prints as `0.00` however it was reached — there is no `-0n` in `bigint`,
 * and this must not manufacture the string form of one either. A remainder that
 * came out at exactly zero showing as `−0.00` is the float-era artefact this
 * whole file exists to leave behind.
 */
export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / MINOR_SCALE;
  const frac = abs % MINOR_SCALE;
  const body = `${group(whole.toString(10))}.${frac.toString(10).padStart(MINOR_DIGITS, "0")}`;
  return negative ? `−${body}` : body;
}

/** `AED 1,234.56` — the currency code, never a symbol. */
export function formatMoney(minor: bigint, currency: string): string {
  return currency === "" ? formatMinor(minor) : `${currency} ${formatMinor(minor)}`;
}

/**
 * A transaction amount with its direction on the glyph.
 *
 * The sign carries the direction so the row stays legible without colour — v1's
 * rule, and the reason `flowAmount` existed there. The third case is new in v2:
 * `direction === ""` is Task 7's unparsed shape, where the amount is `0n`
 * because nothing was extracted, and printing `−0.00` for it would state that a
 * zero-dirham purchase happened. It prints an em dash instead.
 */
export function signedAmount(direction: "debit" | "credit" | "", minor: bigint): { text: string; flow: Flow } {
  if (direction === "") return { text: "—", flow: "none" };
  const magnitude = formatMinor(minor < 0n ? -minor : minor);
  return direction === "credit" ? { text: `+${magnitude}`, flow: "in" } : { text: `−${magnitude}`, flow: "out" };
}

/**
 * What a user is typing, cleaned up enough to keep in a `TextInput` — and no
 * further.
 *
 * It never converts to a number and never rejects a partial entry: `""`, `"12."`
 * and `"0."` are all legitimate things to be holding mid-keystroke, and an input
 * that will not stay empty is v1's springback bug. {@link parseAmountDraft} is
 * the one that decides what the text means, once, on commit.
 *
 * ## The comma
 *
 * A comma is a grouping separator in the locale this beta ships to and a decimal
 * separator on some numeric keypads, and the two cannot both be assumed. The
 * rule, which is what the tests pin:
 *
 *   - if the text already contains a `.`, every comma is **grouping**;
 *   - a single comma followed by exactly three digits is **grouping**
 *     (`1,234`);
 *   - any other single comma is a **decimal point** and is rewritten as one
 *     (`12,5` → `12.5`).
 */
export function sanitizeAmountDraft(raw: string): string {
  let kept = "";
  for (const ch of raw) {
    if ((ch >= "0" && ch <= "9") || ch === "." || ch === ",") kept += ch;
  }
  const dot = kept.indexOf(".");
  if (dot >= 0) {
    // Grouping commas survive; a second decimal point does not.
    return kept.slice(0, dot + 1) + kept.slice(dot + 1).replace(/\./g, "");
  }
  const commas = kept.split(",").length - 1;
  if (commas === 1 && !/,\d{3}$/.test(kept)) return kept.replace(",", ".");
  return kept;
}

/**
 * The `bigint` minor-unit value a draft means, or why it does not mean one.
 *
 * **`""` is `{kind: "empty"}`, never `0n`.** `Number("") === 0` is the exact
 * defect v1's harness found by clearing every field on every screen and checking
 * it stayed clear, and the only structural fix is a parse that can say "no
 * number yet".
 *
 * Excess fraction digits are rounded **half-up** — the same rule and the same
 * arithmetic shape as `convert` in `client/src/replay/fx.ts` — and the result
 * says so, so a screen can show the user what its number will become instead of
 * quietly changing it. Half-up by adding-then-truncating is correct only above
 * zero, which holds here because amounts are positive by invariant and a leading
 * `-` is refused outright.
 */
export function parseAmountDraft(text: string): AmountDraft {
  let digits = "";
  for (const ch of text) {
    // Grouping separators and every flavour of space are noise; anything else
    // that is not a digit or the decimal point is a refusal, not a strip, so
    // "1e3" and "12abc" cannot silently become 1000 and 12.
    if (ch === "," || ch === " " || ch === " " || ch === " ") continue;
    if ((ch >= "0" && ch <= "9") || ch === ".") digits += ch;
    else return { kind: "invalid", reason: `${JSON.stringify(ch)} is not part of an amount` };
  }
  if (digits === "" || digits === ".") return { kind: "empty" };
  const dot = digits.indexOf(".");
  if (dot !== digits.lastIndexOf(".")) return { kind: "invalid", reason: "more than one decimal point" };

  const whole = dot < 0 ? digits : digits.slice(0, dot);
  const fraction = dot < 0 ? "" : digits.slice(dot + 1);
  const kept = fraction.slice(0, MINOR_DIGITS).padEnd(MINOR_DIGITS, "0");
  const dropped = fraction.slice(MINOR_DIGITS);

  let minor = (whole === "" ? 0n : BigInt(whole)) * MINOR_SCALE + BigInt(kept);
  // Half-up: the discarded tail is ≥ half a minor unit exactly when its first
  // digit is ≥ 5. Everything after that first digit only matters for whether a
  // change happened at all.
  const roundsUp = (dropped.codePointAt(0) ?? 0) - 48 >= ROUND_UP_FROM;
  if (roundsUp) minor += 1n;
  if (minor > MAX_MINOR) {
    return { kind: "invalid", reason: "larger than any amount this ledger can hold" };
  }
  return { kind: "ok", minor, rounded: /[1-9]/.test(dropped) };
}

/**
 * The text an amount field is prefilled with: `15000n` → `"150"`, `3950n` →
 * `"39.50"`.
 *
 * A bare `.00` is dropped because a field that opens on `150.00` makes the user
 * delete three characters to type `1500`. Every other fraction is kept in full,
 * so `{@link parseAmountDraft}(draftFromMinor(x)).minor === x` for every
 * non-negative `x` — pinned as a round trip rather than assumed.
 */
export function draftFromMinor(minor: bigint): string {
  const abs = minor < 0n ? -minor : minor;
  const whole = (abs / MINOR_SCALE).toString(10);
  const frac = abs % MINOR_SCALE;
  return frac === 0n ? whole : `${whole}.${frac.toString(10).padStart(MINOR_DIGITS, "0")}`;
}

/** Σ, in `bigint`. One place, so no caller reaches for `reduce` with a `0`. */
export function sumMinor(parts: readonly bigint[]): bigint {
  let total = 0n;
  for (const p of parts) total += p;
  return total;
}

/**
 * `total` divided `n` ways in minor units, **with the last part absorbing the
 * remainder**, so the parts always sum back to `total` exactly.
 *
 * That property is not cosmetic: `replay.ts`'s `precheck` refuses a `txn_split`
 * whose parts do not sum to the parent, and the refusal consumes no version, so
 * a split that is off by one fil is an op that lands, does nothing, and reports
 * `split_sum` in the anomaly list. The absorber is named here rather than left
 * to whichever line the UI happens to compute last.
 *
 * A parent too small to divide yields zero-valued parts (`2n` three ways is
 * `[0n, 0n, 2n]`). That is the honest answer, and it is the caller's job to
 * refuse it — split parts go through `positiveMoney` on decode.
 */
export function divideEvenly(total: bigint, n: number): bigint[] {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`divideEvenly needs a positive integer part count, got ${n}`);
  if (total < 0n) throw new Error(`divideEvenly needs a non-negative total, got ${total}`);
  const base = total / BigInt(n); // truncation is floor here: total ≥ 0
  const parts = new Array<bigint>(n).fill(base);
  parts[n - 1] = total - base * BigInt(n - 1);
  return parts;
}

/** What is still unallocated: `total − Σparts`. Negative means the parts overshoot. */
export function remainderAfter(total: bigint, parts: readonly bigint[]): bigint {
  return total - sumMinor(parts);
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
