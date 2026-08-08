/**
 * The bank-name grammar, on the client, in the same shape the server enforces —
 * ported from `app/src/lib/bank.ts`.
 *
 * # Why the client carries a copy at all
 *
 * `internal/v2/admin/waitlist.go` accepts `^[a-z0-9]([a-z0-9 &.'-]{0,62}[a-z0-9])?$`
 * with the length measured in **bytes**, and `00012_waitlist.sql` repeats it as
 * a CHECK constraint. The grammar is narrow on purpose: this is the one column
 * in v2 holding free user-authored text outside the op log and quarantine, and a
 * narrow grammar is what stops a demand counter becoming a suggestion box or a
 * place a pasted transaction line lands.
 *
 * The native port learned what happens without a mirror: `Mashreq (UAE)` —
 * parentheses are not in the grammar — was sent, refused with a `400`, caught by
 * a bare `catch`, and shown as "Try again." A user typing a real bank name was
 * told to retry something that could never succeed, on a step that gated the
 * rest of onboarding. So the refusal is produced HERE, with the rule attached.
 *
 * # The one residual, stated rather than discovered
 *
 * Go's `strings.ToLower` is Unicode's SIMPLE case mapping; JavaScript's
 * `toLowerCase` is the FULL one. They differ for a handful of code points whose
 * simple lowercase is ASCII but whose full lowercase is not — realistically only
 * U+0130 (Turkish dotted capital I). So `İstanbul Bank` is accepted by the
 * server and refused here. The direction is the safe one: the client is
 * STRICTER, so the failure is an instantly-correctable message with the rule on
 * it rather than a `400` the user cannot see or act on.
 *
 * # And the grammar is never a dead end
 *
 * `Bank.tsx` keeps a way past the step that does not involve satisfying this
 * function at all. The waitlist is a demand counter, and a demand counter must
 * never decide whether a user can use the app they were invited to.
 */

/**
 * Exactly Go's `unicode.IsSpace`, which is what `strings.Fields` splits on: the
 * Latin-1 set (including U+0085 NEL and U+00A0 NBSP) plus Unicode White_Space.
 * `\s` in JavaScript is NOT the same set — it misses U+0085 and adds U+FEFF —
 * and a whitespace character one side collapses and the other does not is a name
 * that normalizes differently on each.
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
 * anything has been refused yet, because a rule a user only meets by breaking it
 * is a rule shown too late.
 */
export const BANK_NAME_RULE =
  "Letters, digits, spaces and & . ' - only, up to 64 characters. Write “Mashreq”, not “Mashreq (UAE)”.";

/**
 * The bank declared by the one exit that names no bank at all.
 *
 * `stepFor` gates `banks_declared` on the declared set being non-empty, so
 * without a sentinel a user whose bank name the grammar cannot represent —
 * Arabic, an en dash, a Turkish dotted I — could not leave the bank step except
 * by claiming a bank they do not have. The value matches the one
 * `admin.NormalizeBank`'s refusal message names.
 *
 * A bank that merely lacks a parser is NOT this: the waitlist path declares the
 * name the user typed, because it is a real bank they really use and Settings
 * has to be able to show and remove it.
 */
export const WAITLIST_BANK = "other";

export type BankName = { ok: true; bank: string } | { ok: false; reason: string };

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
  // `strings.Join(strings.Fields(raw), " ")`, spelled out. NOT `.trim()`, which
  // trims the JavaScript whitespace set — that set contains U+FEFF and Go's does
  // not, so a name with a leading byte-order mark would normalize differently on
  // each side.
  const bank = raw
    .split(GO_SPACE)
    .filter((part) => part !== "")
    .join(" ")
    .toLowerCase();
  if (bank === "") return { ok: false, reason: "Type the name of your bank first." };
  const bytes = new TextEncoder().encode(bank).length;
  if (bytes > MAX_BANK_NAME_BYTES) {
    // Bytes, not characters: a name in a non-Latin script passes a 64-CODE-POINT
    // check and fails the server's byte check.
    return {
      ok: false,
      reason: `That is too long for a bank name (${String(bytes)} bytes of ${String(MAX_BANK_NAME_BYTES)}). ${BANK_NAME_RULE}`,
    };
  }
  if (AMOUNT_RE.test(bank)) {
    return {
      ok: false,
      reason: `A bank name does not contain an amount — this looks like a pasted transaction line. ${BANK_NAME_RULE}`,
    };
  }
  if (!BANK_RE.test(bank)) {
    return { ok: false, reason: `That is not a name this list can store. ${BANK_NAME_RULE}` };
  }
  return { ok: true, bank };
}

/**
 * Display names for the bank ids `GET /api/v1/templates` reports.
 *
 * A LOOKUP, not the list. The supported set comes from the server (a template
 * shipped after this build was made must still appear), and an id with no entry
 * here renders as the id itself rather than being hidden — a bank the server can
 * read but the picker will not show is worse than an ugly label.
 */
const BANK_DISPLAY_NAMES: Record<string, string> = {
  dib: "Dubai Islamic Bank",
  enbd: "Emirates NBD",
  adcb: "Abu Dhabi Commercial Bank",
  fab: "First Abu Dhabi Bank",
  mashreq: "Mashreq",
  rakbank: "RAKBANK",
};

export function bankDisplayName(id: string): string {
  return BANK_DISPLAY_NAMES[id.trim().toLowerCase()] ?? id;
}
