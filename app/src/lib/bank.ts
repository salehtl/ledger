/**
 * The bank-name grammar, on the client, in the same shape the server enforces.
 *
 * # Why this file exists
 *
 * It did not, and the two halves disagreed. `samples/source.ts` accepted any
 * non-control string of <= 64 **code points**; `internal/v2/admin/waitlist.go`
 * accepts `^[a-z0-9]([a-z0-9 &.'-]{0,62}[a-z0-9])?$` with the length measured
 * in **bytes**. So `Mashreq (UAE)` — parentheses are not in the grammar — was
 * sent, refused with a `400`, caught by a bare `catch`, and shown as
 * "Could not add that bank. Try again." A user typing a perfectly real bank
 * name was told to retry something that could never succeed, on a step that
 * gated the rest of onboarding.
 *
 * # Which side moved, and why it was this one
 *
 * The server's grammar is not an accident to be widened away. `00012_waitlist.sql`
 * states the reasoning at length and repeats the grammar as a CHECK constraint,
 * so the accepted set is enforced in two places on purpose: this is the one
 * column in v2 holding free user-authored text outside the op log and
 * quarantine, and a narrow grammar is what stops a demand counter becoming a
 * suggestion box or a place a pasted transaction line lands. The migration even
 * records the consequence explicitly ("a bank name written in Arabic is
 * REFUSED, not stored"). Widening it would mean a migration against a live
 * CHECK, a second grammar to keep in sync, and re-opening the paste hole
 * `amountRe` exists to close — to buy nothing except accepting punctuation the
 * operator does not need in order to answer "write which parser next".
 *
 * So the client mirrors the server, and the two are held together by a shared
 * fixture (`internal/v2/admin/testdata/bank_names.json`) that
 * `bank.test.ts` and `internal/v2/admin/waitlist_test.go` both drive. A change
 * to either grammar that is not made to both fails one of those suites.
 *
 * # The one residual, stated rather than discovered
 *
 * Go's `strings.ToLower` is Unicode's SIMPLE case mapping; JavaScript's
 * `toLowerCase` is the FULL one. They differ for a handful of code points whose
 * simple lowercase is ASCII but whose full lowercase is not — realistically
 * only U+0130 (Turkish dotted capital I), which Go folds to `i` and JavaScript
 * folds to `i` + U+0307. So `İstanbul Bank` is accepted by the server and
 * refused here. Carrying a case-folding table to close that is not worth it,
 * and the direction is the safe one: the client is STRICTER, so the failure is
 * an instantly-correctable message with the rule on it rather than a `400` the
 * user cannot see or act on. `bank.test.ts` pins it so it stays a known
 * residual instead of becoming a surprise. The dangerous direction — client
 * accepts, server refuses, user stranded — is what this module closes.
 *
 * # And the grammar is never a dead end
 *
 * Two things, neither optional. The refusal names what IS allowed, so the fix
 * is one edit away instead of a guess. And `BankScreen` keeps a way past the
 * step that does not involve satisfying this function at all — the waitlist is
 * a demand counter, and a demand counter must never decide whether a user can
 * use the app they were invited to.
 */

/**
 * Exactly Go's `unicode.IsSpace`, which is what `strings.Fields` splits on:
 * the Latin-1 set (including U+0085 NEL and U+00A0 NBSP) plus Unicode
 * White_Space. `\s` in JavaScript is NOT the same set — it misses U+0085 and
 * adds U+FEFF — and a whitespace character one side collapses and the other
 * does not is a name that normalizes differently on each.
 */
const GO_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

/** The Go half: `admin.maxBankName`. Measured in BYTES, not code points. */
export const MAX_BANK_NAME_BYTES = 64;

/** The Go half: `admin.bankRe`. */
const BANK_RE = /^[a-z0-9]([a-z0-9 &.'-]{0,62}[a-z0-9])?$/;

/** The Go half: `admin.amountRe` — a decimal amount is a paste, not a name. */
const AMOUNT_RE = /[0-9]\.[0-9]/;

/**
 * What the user is allowed to type. Rendered on the bank step whether or not
 * anything has been refused yet, because a rule a user only meets by breaking
 * it is a rule shown too late.
 */
export const BANK_NAME_RULE =
  "Letters, digits, spaces and & . ' - only, up to 64 characters. Write \"Mashreq\", not \"Mashreq (UAE)\".";

export type BankName =
  | { ok: true; bank: string }
  | { ok: false; reason: string };

/**
 * Folds a typed bank name to its stored form, or says why it cannot be.
 *
 * A mirror of `admin.NormalizeBank`, step for step and in the same order:
 * lower-case, collapse whitespace, then empty / byte-length / decimal-amount /
 * shape. Sending the folded form is deliberate — the server folds again and
 * folding an already-folded name is a no-op, so what the client validated is
 * byte-for-byte what the server stores.
 */
export function normalizeBankName(raw: string): BankName {
  // `strings.Join(strings.Fields(raw), " ")`, spelled out: split on the Go
  // whitespace set, drop the empty pieces, rejoin with one space. NOT
  // `.trim()`, which trims the JavaScript whitespace set — that set contains
  // U+FEFF and Go's does not, so a name with a leading byte-order mark would
  // normalize differently on each side.
  const bank = raw.split(GO_SPACE).filter((part) => part !== "").join(" ").toLowerCase();
  if (bank === "") return { ok: false, reason: "Type the name of your bank first." };
  const bytes = new TextEncoder().encode(bank).length;
  if (bytes > MAX_BANK_NAME_BYTES) {
    // Bytes, not characters: a name in a non-Latin script passes a 64-CODE-POINT
    // check and fails the server's byte check, which is one of the two halves of
    // the disagreement this module closes.
    return { ok: false, reason: `That is too long for a bank name (${String(bytes)} bytes of ${String(MAX_BANK_NAME_BYTES)}). ${BANK_NAME_RULE}` };
  }
  if (AMOUNT_RE.test(bank)) {
    return { ok: false, reason: `A bank name does not contain an amount — this looks like a pasted transaction line. ${BANK_NAME_RULE}` };
  }
  if (!BANK_RE.test(bank)) {
    return { ok: false, reason: `That is not a name this list can store. ${BANK_NAME_RULE}` };
  }
  return { ok: true, bank };
}
