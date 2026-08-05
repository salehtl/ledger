/**
 * Display formatting for the review deck — **a placeholder with an owner**.
 *
 * Task 18 ports v1's `frontend/src/lib/{money,format}.ts` into `app/src/lib/`
 * as the app's money formatting, rewritten for `bigint`. That work is in
 * flight in another session; writing a second `app/src/lib/money.ts` here would
 * be two forks of one thing, and the plan is explicit that a later "let's
 * dedupe these" must produce a design decision rather than a silent regression.
 *
 * So this file is scoped to the review screen, is the only formatting it does,
 * and every component takes the formatter as a **prop** with these as the
 * defaults. When `app/src/lib/money.ts` lands, the screen passes its formatter
 * in and this file is deleted — one import, not twenty call sites.
 *
 * Both functions are `bigint`- and string-only. There is no `Number()` here and
 * there must not be: `Number("") === 0` and a float amount is a wrong amount.
 */

/**
 * Minor units to a grouped decimal string.
 *
 * The grouping is done on the digit string rather than through `Intl`, which
 * Hermes ships without on some builds, and through `toLocaleString`, which
 * takes a `number`.
 */
export function formatMinor(minor: bigint, exponent = 2): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString(10).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const frac = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  let grouped = "";
  let i = 0;
  for (const ch of whole) {
    if (i > 0 && (whole.length - i) % 3 === 0) grouped += ",";
    grouped += ch;
    i++;
  }
  return `${negative ? "-" : ""}${grouped}${frac}`;
}

/** An amount with its currency, as a card shows it. */
export function formatMoney(minor: bigint, currency: string, exponent = 2): string {
  return currency === "" ? formatMinor(minor, exponent) : `${currency} ${formatMinor(minor, exponent)}`;
}

const MONTHS: Record<string, string> = {
  "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr", "05": "May", "06": "Jun",
  "07": "Jul", "08": "Aug", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
};

/**
 * `2026-06-05T09:00:00.000Z` → `5 Jun 2026`.
 *
 * Read off the canonical string rather than through `new Date(...)`. The string
 * is already canonical UTC by the time it reaches a `Txn` (`replay.ts` refuses
 * anything it cannot canonicalise), so a `Date` would add a parser, a timezone
 * and a class of bug this app has already paid for once: the expanded-year
 * `toISOString` form that used to crash the fold.
 */
export function formatDay(rfc3339: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(rfc3339);
  if (m === null) return rfc3339;
  const month = MONTHS[m[2] ?? ""];
  if (month === undefined) return rfc3339;
  // The day's leading zero is stripped with a string operation rather than
  // `Number()`: nothing in this app converts a digit string through `Number`,
  // and a rule with an exception for "but this one isn't money" is a rule that
  // gets applied by eye.
  const day = (m[3] ?? "").replace(/^0/, "");
  return `${day} ${month} ${m[1]}`;
}
