/**
 * The `dev:<subject>` identity, and nothing that decides whether it is allowed.
 *
 * # What this is for
 *
 * `ledgerd serve --dev-auth` installs `auth.NewDevVerifier` for BOTH providers
 * and accepts `dev:<subject>` as an identity (`internal/v2/auth/dev.go`,
 * `internal/v2/api/api.go`). That server capability had no caller in `app/` at
 * all — nothing under `app/src` referenced it — which is this project's
 * "written, tested green, never wired" shape with the wiring missing on the
 * client side. It exists because the operator's Apple ID is behind a hardware
 * security key that an iOS simulator cannot present, so Sign in with Apple is
 * unusable in the one environment anybody here can render this app in.
 *
 * # This module holds NO gate
 *
 * The gate is `__DEV__`, and it lives at the single call site in
 * `SignInScreen.tsx` where it can be constant-folded out of a production
 * bundle. Putting a `devAuthEnabled()` function here would defeat exactly that:
 * a function call cannot be folded, so the strings below would ship. Nothing in
 * the production module graph imports this file — `DevSignInPanel.tsx` is its
 * only importer and that module is itself loaded through the folded `require`.
 * `dev-signin-report.md` records the export-and-grep that measures it.
 *
 * # The grammar is the server's, mirrored and pinned
 *
 * `devVerifier.Verify` accepts `"dev:"` + a non-empty subject and refuses a
 * subject containing `"|"`, because `auth.SubjectHash` joins `(idp, subject)`
 * with `"|"` and is only injective while neither half contains it. Both rules
 * are re-stated here so a mistyped subject is refused on the glass with a
 * sentence about the subject, instead of earning a `401` that the sign-in
 * screen's taxonomy renders as "That sign-in expired" — copy that would send a
 * developer looking for an expiry that never happened. `devAuth.test.ts` reads
 * `internal/v2/auth/dev.go` and fails if either rule drifts, so this is a
 * measured mirror rather than a remembered one.
 */

/** The whole grammar of a dev token, spelled as `internal/v2/auth/dev.go` spells it. */
export const DEV_TOKEN_PREFIX = "dev:";

/**
 * A string that appears in every file of the dev sign-in path and nowhere else,
 * so "is any of this in the production bundle" is one `grep` rather than a
 * judgement about which of several strings was distinctive enough.
 */
export const DEV_SIGN_IN_MARKER = "LEDGER_DEV_SIGN_IN";

/**
 * The subject a developer gets if they type nothing.
 *
 * It is a **default rather than a constant** on purpose. A single hard-coded
 * subject is one account, and AGENT-RULES' own lesson is that a fixture with
 * one of something cannot tell "correct scoping" from "no scoping": the invite
 * gate, the second-device case and every per-account partition in this app are
 * only exercisable if a simulator can be two different people. Typing a
 * different subject is the whole cost of that, and the field is prefilled so
 * the common case is still one tap.
 */
export const DEV_SUBJECT_DEFAULT = "simulator";

/**
 * Longest subject this screen will send. The server caps the whole token at
 * 16 KiB and does not cap the subject; this is a UI bound, so a pasted essay
 * is refused with a sentence instead of becoming an account id.
 */
export const DEV_SUBJECT_MAX = 64;

/**
 * The subject as it would be sent: surrounding whitespace removed.
 *
 * Trimming matters more here than it looks. The server treats `"alice "` and
 * `"alice"` as two different subjects and therefore two different accounts, so
 * a trailing space typed on a phone keyboard would silently create a second
 * ledger that looks like the first one.
 */
export function normalizeDevSubject(raw: string): string {
  return raw.trim();
}

/**
 * Why this subject cannot be used, or `null` if it can.
 *
 * Returns a sentence rather than a boolean because every caller needs the
 * sentence, and a boolean plus a lookup table is two places to keep in step.
 */
export function devSubjectProblem(raw: string): string | null {
  const subject = normalizeDevSubject(raw);
  if (subject === "") return "Type a developer subject — it becomes the account this sign-in creates.";
  if (subject.includes("|")) {
    return 'A developer subject may not contain "|". The server refuses it, because that character separates the provider from the subject when an account id is derived.';
  }
  if (subject.length > DEV_SUBJECT_MAX) {
    return `A developer subject is at most ${DEV_SUBJECT_MAX} characters; this one is ${subject.length}.`;
  }
  return null;
}

/** Raised by {@link devIdToken} rather than returning a token nothing accepts. */
export class DevSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevSubjectError";
  }
}

/**
 * `subject` → the ID token `--dev-auth` accepts.
 *
 * The result travels through the ordinary `POST /api/v1/auth/exchange` path as
 * the `id_token`, with the ordinary `idp` and the ordinary invite handling —
 * see `SignInScreen.tsx`. There is no second exchange, no second endpoint and
 * no skipped check on either side.
 */
export function devIdToken(raw: string): string {
  const problem = devSubjectProblem(raw);
  if (problem !== null) throw new DevSubjectError(problem);
  return DEV_TOKEN_PREFIX + normalizeDevSubject(raw);
}
