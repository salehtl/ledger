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
 * This is a port of the *display* half of `app/src/lib/money.ts` (the retired
 * Expo client, removed 2026-08-10 and preserved at tag `app-expo-final`) — the
 * same functions, the same output, so the two clients printed an amount
 * identically.
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

/**
 * What a money field's text means: nothing yet, an exact amount, or a refusal.
 *
 * Three states rather than `bigint | null`, because "the field is empty" and
 * "what is in the field is not an amount" are different things to say to the
 * person typing, and a single `null` collapses them into one silence.
 */
export type MinorDraft =
  | { state: "empty" }
  | { state: "amount"; minor: bigint }
  | { state: "refused"; reason: string };

/**
 * Major-unit text as `bigint` minor units — the parse half of this module.
 *
 * # Why this is not `NumberField`
 *
 * `NumberField` (`components/ui/Field.tsx`) commits a `number` and clamps it on
 * blur. Both are right for a percentage and wrong for money: `Number` corrupts
 * past 2^53, and a clamp REWRITES what the user typed without telling them —
 * with `allowDecimal={false}` a typed `33.3` arrives as `333` and is then pulled
 * to the field's maximum. A budget the user typed and a budget that was saved
 * must be the same number, so this parses to a `bigint` and, where it cannot,
 * REFUSES IN WORDS. There is no rounding, no clamping and no `Number` on the
 * path — the fraction is padded as text and the whole is multiplied in `bigint`.
 *
 * `""` is `empty`, not zero: an empty field is "I am not setting a total",
 * which is what an account that never answers looks like, while `0` is a total
 * a person can genuinely state.
 *
 * A trailing separator (`12.`) is a real mid-keystroke state and reads as the
 * digits typed so far — `12.00`. That is what the text says; nothing is invented.
 */
export function parseMinorDraft(text: string): MinorDraft {
  const t = text.trim();
  if (t === "") return { state: "empty" };
  if (t.startsWith("-") || t.startsWith("−")) {
    return { state: "refused", reason: "A budget is what you plan to spend, so it cannot be negative." };
  }
  const tooPrecise = /^[0-9]+\.[0-9]{3,}$/.test(t);
  if (tooPrecise) {
    // No corrected amount in the words, deliberately: printing the rounded
    // version is the silent rewrite this whole function exists to refuse.
    return { state: "refused", reason: "Amounts go to two decimal places — that is more precision than ledger holds." };
  }
  const m = /^([0-9]+)(?:\.([0-9]{0,2}))?$/.exec(t);
  if (m === null) {
    return { state: "refused", reason: "That is not an amount — digits and up to two decimals, like 12000 or 8500.50." };
  }
  const frac = (m[2] ?? "").padEnd(MINOR_DIGITS, "0");
  return { state: "amount", minor: BigInt(m[1] as string) * MINOR_SCALE + BigInt(frac) };
}

/**
 * A stored amount as the TEXT a money field opens on — `12000.00`, never
 * `12,000.00`.
 *
 * Ungrouped on purpose: this is the inverse of {@link parseMinorDraft}, which
 * refuses a comma, so a grouped string would seed a field with something the
 * same screen then calls unreadable. {@link formatMinor} is for display and this
 * is for editing, and they are different jobs.
 */
export function minorToDraft(minor: bigint | null): string {
  if (minor === null) return "";
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const body = `${(abs / MINOR_SCALE).toString(10)}.${(abs % MINOR_SCALE).toString(10).padStart(MINOR_DIGITS, "0")}`;
  return negative ? `-${body}` : body;
}

/**
 * The sentence under a monthly-total field, said while typing rather than after
 * saving — the same rule `splitAdvice` follows, and for the same reason: the
 * user learns what will be stored before they commit to it.
 *
 * Pure and exported so the words are testable without a DOM.
 */
export function monthlyTotalAdvice(text: string, currency: string | null): string {
  const draft = parseMinorDraft(text);
  if (draft.state === "empty") return "No monthly total — ledger will just show what you spend.";
  if (draft.state === "refused") return draft.reason;
  return `${formatMoney(draft.minor, currency ?? "")} a month.`;
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
