/**
 * The onboarding machine, ported from `app/src/lib/onboarding.ts`.
 *
 * Pure, framework-free, and it is the thing the boot gate asks "is this device
 * set up yet?". Ported rather than imported: `app/` is retired from the gate
 * (Task 0), its tests no longer run, and shipping browser code out of a tree
 * nothing checks is how a module rots without anyone noticing.
 *
 * **This is the machine half only.** The currency vocabulary
 * (`COMMON_CURRENCIES`, `normalizeCurrency`'s pickers), the op authors
 * (`homeCurrencyOps`, the USD peg) and the confirmation copy stay in the native
 * file until Task 7 needs them, and when it does they belong in THIS file
 * rather than in a screen — the split is machine-vs-screens, not two copies of
 * the machine.
 *
 * # The step is DERIVED, never stored
 *
 * {@link stepFor} walks a table of milestones and returns the longest unbroken
 * prefix. Nothing persists a step number:
 *
 *   - A force-quit (or a closed tab) loses only memory. Every fact is read back
 *     from the secret store, the server or the op log, so a cold launch lands
 *     where the last one left off with no resume record to keep in step.
 *   - A stored cursor can disagree with reality, and the dangerous direction is
 *     a device that believes it has not set a home currency when the log says
 *     it has — which is a second `home_currency_set`, i.e. a permanent
 *     `home_currency_reset` anomaly no later op can repair.
 *
 * The prefix rule is deliberately strict: a gap is never skipped, however much
 * sits behind it. A cleared browser profile keeps the log and the server's
 * facts and loses the device-local half, so it re-runs the bank and forwarding
 * steps — cheap and repeatable — while walking *past* the currency step,
 * because that fact is in the log.
 *
 * # One deliberate divergence from the native port: the address is cached
 *
 * {@link LocalOnboardingRecord} carries `inboundAddress`, which the native
 * record does not. The native app reads `GET /api/v1/address` at launch and
 * treats a failure as fatal; a browser tab opens offline as a matter of course
 * (it is an installed PWA with a service worker), and without a cached copy one
 * failed GET walks a fully set-up user back to the address step — a much worse
 * lie than a stale address string. It is safe to cache because the only thing
 * this module asks of it is whether an address has EVER been issued, which is
 * monotonic; {@link resumeFacts} still prefers the server's answer whenever
 * there is one, and the address screen always renders a fresh read rather than
 * this.
 *
 * There is still deliberately **no** home-currency field: spec §3.7 makes the
 * home currency log state, and the cheapest way to keep a later refactor honest
 * is a record with nowhere to put one.
 */

import type { State } from "@ledger/client/replay/state";
import type { SecretStore } from "@ledger/client/store/store";

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * Each name is a **milestone that is done**, so the position `bank_picked`
 * means "a bank has been chosen and the next thing to do is the address".
 */
export const ONBOARDING_STEPS = [
  "signed_in",
  "invited",
  "bank_picked",
  "address_issued",
  "forwarding_configured",
  "first_mail_confirmed",
  "home_currency_set",
  "done",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * `"signed_out"` is **not** a step: it is the absence of the machine. Sign-in
 * owns everything before the first milestone.
 */
export type OnboardingPosition = OnboardingStep | "signed_out";

/** Which surface a position puts on the glass. */
export type OnboardingScreen =
  | "sign_in"
  | "confirming"
  | "bank"
  | "address"
  | "forwarding"
  | "verification"
  | "home_currency"
  | "finish"
  | "product";

const SCREEN_FOR: Record<OnboardingPosition, OnboardingScreen> = {
  signed_out: "sign_in",
  // A session exists but no server has confirmed the account this launch. A
  // real state, not a formality: this is where a `410 account_deleted`
  // surfaces on a device that was signed in yesterday.
  signed_in: "confirming",
  invited: "bank",
  bank_picked: "address",
  address_issued: "forwarding",
  forwarding_configured: "verification",
  first_mail_confirmed: "home_currency",
  home_currency_set: "finish",
  done: "product",
};

export function screenFor(p: OnboardingPosition): OnboardingScreen {
  return SCREEN_FOR[p];
}

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

export interface OnboardingFacts {
  /** A session token is in this device's secret store. */
  hasSession: boolean;
  /** The server answered with a user id, so the account exists and is invited. */
  accountId: string | null;
  /** The chosen bank, or the sentinel a waitlist entry uses. Device-local. */
  bank: string | null;
  /** The inbound address, minted server-side on first read. */
  inboundAddress: string | null;
  /**
   * The user said the forward is set up. Device-local, and it has to be: the
   * app cannot see a Gmail filter, and the only evidence that a forward works
   * is mail arriving, which is the *next* step rather than this one.
   */
  forwardingDeclared: boolean;
  /** A genuine bank message has been confirmed (spec §3.2 makes this a step). */
  firstMailConfirmedAt: string | null;
  /** **From the log.** Never from a device setting, never cached locally. */
  homeCurrency: string | null;
  /**
   * The user has seen the finish screen. Device-local, and the reason `done` is
   * not simply "the currency is set": the op is emitted the instant the picker
   * is confirmed, and without this the screen that explains what happens next
   * would be skipped in the same frame it appeared.
   */
  finishedAt: string | null;
}

export function emptyFacts(): OnboardingFacts {
  return {
    hasSession: false,
    accountId: null,
    bank: null,
    inboundAddress: null,
    forwardingDeclared: false,
    firstMailConfirmedAt: null,
    homeCurrency: null,
    finishedAt: null,
  };
}

/** Each step, paired with the fact that makes it done. */
const MILESTONES: readonly (readonly [OnboardingStep, (f: OnboardingFacts) => boolean])[] = [
  ["signed_in", (f) => f.hasSession],
  ["invited", (f) => f.accountId !== null],
  ["bank_picked", (f) => f.bank !== null],
  ["address_issued", (f) => f.inboundAddress !== null],
  ["forwarding_configured", (f) => f.forwardingDeclared],
  ["first_mail_confirmed", (f) => f.firstMailConfirmedAt !== null],
  ["home_currency_set", (f) => f.homeCurrency !== null],
  ["done", (f) => f.finishedAt !== null],
];

/**
 * The longest unbroken prefix of completed milestones.
 *
 * **A gap stops the walk.** Taking the highest true milestone instead would
 * drop a reinstalled user into the product with no forwarding rule and no
 * bank — every fact behind the gap is still true, so the state would look
 * complete while the thing onboarding exists to arrange had never happened.
 */
export function stepFor(f: OnboardingFacts): OnboardingPosition {
  let at: OnboardingPosition = "signed_out";
  for (const [step, done] of MILESTONES) {
    if (!done(f)) return at;
    at = step;
  }
  return at;
}

/** The boot gate's question, in one place so it cannot be re-derived wrongly. */
export function onboardingComplete(f: OnboardingFacts): boolean {
  return stepFor(f) === "done";
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export type OnboardingEvent =
  | { type: "session"; hasSession: boolean }
  | { type: "account_confirmed"; accountId: string }
  | { type: "bank_picked"; bank: string }
  | { type: "address_issued"; address: string }
  | { type: "forwarding_declared" }
  | { type: "first_mail_confirmed"; at: string }
  | { type: "home_currency_set"; currency: string }
  | { type: "finished"; at: string }
  | { type: "signed_out" }
  | { type: "account_deleted" };

/**
 * ISO 4217 alpha-3, upper-cased — the same normalisation `replay.currencyOf`
 * applies. Returns null rather than a partial code: the draft the user is
 * typing is a `string` all the way to commit (v1's `Number("") === 0`
 * springback, one type over), and this is the single conversion point.
 */
export function normalizeCurrency(draft: string): string | null {
  const s = draft.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

/**
 * Pure and total. Returns the **same object** when an event changes nothing, so
 * a refusal is visibly a no-op rather than a rewrite that lands on the same
 * value — which is what makes the home-currency refusal testable by identity.
 */
export function onboardingReducer(f: OnboardingFacts, e: OnboardingEvent): OnboardingFacts {
  switch (e.type) {
    case "session":
      return f.hasSession === e.hasSession ? f : { ...f, hasSession: e.hasSession };

    case "account_confirmed":
      return f.accountId === e.accountId ? f : { ...f, accountId: e.accountId };

    case "bank_picked":
      return f.bank === e.bank ? f : { ...f, bank: e.bank };

    case "address_issued":
      return f.inboundAddress === e.address ? f : { ...f, inboundAddress: e.address };

    case "forwarding_declared":
      return f.forwardingDeclared ? f : { ...f, forwardingDeclared: true };

    case "first_mail_confirmed":
      return f.firstMailConfirmedAt === null ? { ...f, firstMailConfirmedAt: e.at } : f;

    case "home_currency_set": {
      // THE refusal. One-shot, client-side, and ahead of the emit — a second op
      // reaching the log is a permanent `home_currency_reset` anomaly that no
      // later op can repair, so the cheap guard is the one that matters. An
      // unusable code is refused here too, rather than travelling onward and
      // quietly producing no ops while the machine advanced anyway.
      if (f.homeCurrency !== null) return f;
      const ccy = normalizeCurrency(e.currency);
      return ccy === null ? f : { ...f, homeCurrency: ccy };
    }

    case "finished":
      return f.finishedAt === null ? { ...f, finishedAt: e.at } : f;

    case "signed_out":
      // The log is not touched. Signing out drops a bearer token; it does not
      // un-set a home currency or un-confirm a bank email, and a machine that
      // pretended otherwise would re-run the picker after a sign-out.
      return { ...f, hasSession: false, accountId: null };

    case "account_deleted":
      // The only remedy the product offers for a wrong home currency, so it has
      // to actually clear it.
      return emptyFacts();
  }
}

// ---------------------------------------------------------------------------
// Resuming
// ---------------------------------------------------------------------------

/** The device-local half, persisted as JSON. See this module's header. */
export interface LocalOnboardingRecord {
  bank: string | null;
  forwardingDeclared: boolean;
  finishedAt: string | null;
  /** A resume hint, not a display value. See the header. */
  inboundAddress: string | null;
}

export const LOCAL_RECORD_KEYS = ["bank", "forwardingDeclared", "finishedAt", "inboundAddress"] as const;

export function encodeLocal(f: OnboardingFacts): LocalOnboardingRecord {
  return {
    bank: f.bank,
    forwardingDeclared: f.forwardingDeclared,
    finishedAt: f.finishedAt,
    inboundAddress: f.inboundAddress,
  };
}

/** Refuses a partially-readable record rather than half-applying it. */
export function decodeLocal(v: unknown): LocalOnboardingRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const bank = r["bank"];
  const fwd = r["forwardingDeclared"];
  const fin = r["finishedAt"];
  // Absent reads as null rather than as a refusal: this field was added after
  // the shape was first written, and a record from before it is complete in
  // every way that decides a step.
  const addr = r["inboundAddress"] ?? null;
  if (bank !== null && typeof bank !== "string") return null;
  if (typeof fwd !== "boolean") return null;
  if (fin !== null && typeof fin !== "string") return null;
  if (addr !== null && typeof addr !== "string") return null;
  return { bank: bank ?? null, forwardingDeclared: fwd, finishedAt: fin ?? null, inboundAddress: addr };
}

/**
 * Reassembles the facts on a cold launch.
 *
 * `homeCurrency` is a parameter of its own and is **not** read from `local`,
 * even if an older record happens to carry one: the log is the only authority.
 */
export function resumeFacts(args: {
  hasSession: boolean;
  accountId: string | null;
  /** The server's answer, or null when it could not be asked. */
  inboundAddress: string | null;
  firstMailConfirmedAt: string | null;
  homeCurrency: string | null;
  local: LocalOnboardingRecord | null;
}): OnboardingFacts {
  const local = args.local;
  return {
    hasSession: args.hasSession,
    accountId: args.accountId,
    bank: local?.bank ?? null,
    inboundAddress: args.inboundAddress ?? local?.inboundAddress ?? null,
    forwardingDeclared: local?.forwardingDeclared ?? false,
    firstMailConfirmedAt: args.firstMailConfirmedAt,
    homeCurrency: args.homeCurrency,
    finishedAt: local?.finishedAt ?? null,
  };
}

/** The home currency, read from the folded log. The only sanctioned source. */
export function homeCurrencyOf(s: Pick<State, "homeCurrency">): string | null {
  return s.homeCurrency;
}

/**
 * When the earliest transaction in the log was posted, or null for an empty
 * log. **This is the `first_mail_confirmed` fact**, read from the folded log
 * for the same reason the home currency is: it is the only thing on the device
 * that can say a genuine bank email actually became a transaction.
 *
 * It lives here rather than inside the boot code because two callers need it
 * and they must not disagree — the launch read, and the verification screen,
 * which re-reads it after a confirmation to decide whether that confirmation
 * actually produced anything. A screen that advanced the machine on "the
 * confirm call returned 200" would walk past a step that never happened.
 */
export function firstMailAt(s: Pick<State, "txns">): string | null {
  let earliest: string | null = null;
  for (const t of s.txns.values()) {
    if (earliest === null || t.posted_at.localeCompare(earliest) < 0) earliest = t.posted_at;
  }
  return earliest;
}

/**
 * Where the device-local half is kept.
 *
 * The {@link SecretStore} is the one durable key-value store the session layer
 * already has (`webSecretStore`, over `localStorage`). Nothing secret goes in
 * it — which is why the currency does not, and cannot: {@link
 * LocalOnboardingRecord} has no field for one.
 */
export const ONBOARDING_LOCAL_KEY = "onboarding_local";

export function loadLocalRecord(secrets: Pick<SecretStore, "get">): LocalOnboardingRecord | null {
  const raw = secrets.get(ONBOARDING_LOCAL_KEY);
  if (raw === null || raw === "") return null;
  try {
    return decodeLocal(JSON.parse(raw));
  } catch {
    // A record this build cannot read is a record it re-derives. Onboarding's
    // device-local steps are cheap to repeat; a half-read one is not.
    return null;
  }
}

export function saveLocalRecord(secrets: Pick<SecretStore, "set">, f: OnboardingFacts): void {
  secrets.set(ONBOARDING_LOCAL_KEY, JSON.stringify(encodeLocal(f)));
}
