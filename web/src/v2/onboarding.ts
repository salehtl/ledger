/**
 * The onboarding machine, ported from the retired Expo client's
 * `app/src/lib/onboarding.ts` (removed 2026-08-10, preserved at tag
 * `app-expo-final`).
 *
 * Pure, framework-free, and it is the thing the boot gate asks "is this device
 * set up yet?". Ported rather than imported: `app/` was already retired from
 * the gate (Task 0), its tests no longer ran, and shipping browser code out of
 * a tree nothing checks is how a module rots without anyone noticing. The tree
 * is gone now, which is the same argument reaching its conclusion.
 *
 * Task 7 brought over the second half it named: the currency vocabulary
 * (`COMMON_CURRENCIES`, `searchCurrencies`), the op authors (`homeCurrencyOps`,
 * the USD peg) and the confirmation copy now live HERE rather than in a screen,
 * because the split is machine-vs-screens and not two copies of the machine.
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
 * sits behind it.
 *
 * # What is device-local: the USER'S answers, never the ACCOUNT'S facts
 *
 * This module used to keep the chosen bank, a "the forward is set up" boolean
 * and a "finished" timestamp in {@link LocalOnboardingRecord}. A second device
 * has none of those, so a fully set-up account opened on a new phone re-ran the
 * bank step and then the ADDRESS step — which, to the person holding it, is
 * indistinguishable from their account having been lost. The fix over-rotated:
 * it derived everything, including two facts that are the user's answers to
 * questions, and a question answered from evidence un-answers itself the moment
 * the evidence is missing. The line that holds is:
 *
 *   - **The account's facts are derived.** Banks are `bank_declared` ops, folded
 *     into `State.banks` and read through {@link declaredBanksOf}; the home
 *     currency is log state; mail having arrived is a transaction in the log.
 *     The log syncs; a browser profile does not.
 *   - **The user's answers are recorded**, in {@link LocalOnboardingRecord},
 *     exactly as `skipped` always was: the forwarding declaration
 *     ({@link LocalOnboardingRecord.forwardingDeclared}) and when this device
 *     finished the walk ({@link LocalOnboardingRecord.finishedAt}). Deriving
 *     the declaration from mail arrival made the walk bounce every finished
 *     user back to "Send your bank mail here" until the world happened to
 *     respond (2026-08-09, the resume loop). Arrival stays a separate STATUS
 *     ({@link mailStatus}); it is evidence the forward works, never the only
 *     way the declaration can be true.
 *   - **Finished is also derivable**, and both doors open the app:
 *     {@link resumeFacts} sets {@link OnboardingFacts.setupSeen} when every
 *     ACCOUNT milestone behind it is already true, so a cold launch on a
 *     set-up account opens the app on a device with no record at all.
 *     Deliberately not every milestone: {@link OnboardingFacts.keysReady} is
 *     this device's access to the account, not evidence about its history, and
 *     conflating the two walked a locked device onto the finish screen — where
 *     the plan control then authored over the account's plan. See
 *     {@link accountSetupComplete}.
 *
 * # Onboarding proposes; it does not block
 *
 * Account creation is the only gate: an invite, a passkey, the key ceremony.
 * Every later step carries a real, always-enabled way past it
 * ({@link SKIPPABLE_STEPS}), and the check that mail actually arrives left the
 * table altogether — it waited on the user's bank sending an email, which waits
 * on the user spending money. It is a status now ({@link mailStatus}), and what
 * is still outstanding is a list ({@link remainingSetup}) rather than a wall.
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

import { convert } from "@ledger/client/replay/fx";
import type { State } from "@ledger/client/replay/state";
import type { SecretStore } from "@ledger/client/store/store";

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * Each name is a **milestone that is done**, so the position `address_issued`
 * means "an address exists and the next thing to do is forwarding".
 *
 * There is no bank step. The declared list never reaches parsing — templates
 * are selected by the message's verified domain — so which bank a user has is
 * something mail proves, not something the walk asks. Banks stay manageable in
 * Settings, and {@link OnboardingFacts.banks} is still read from the log.
 */
export const ONBOARDING_STEPS = [
  "signed_in",
  "invited",
  // Phase 3. It sits HERE, before anything else the account records, because
  // every fact the walk collects after it — the home currency, the budget —
  // becomes op-log content, and content authored before an account has keys is
  // content that would have to be re-sealed later. An account acquires its
  // keys before it acquires anything to protect.
  "keys_secured",
  "address_issued",
  "forwarding_configured",
  "home_currency_set",
  "done",
] as const;

type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * The steps a user may answer with "later", and the reason `first_mail_confirmed`
 * is not among them: **it is not a step any more.**
 *
 * # Why the first-mail check left the table
 *
 * It waited for a real bank alert, and a bank alert requires the user to spend
 * money. So the last thing between a new account and the product was an event
 * the user cannot cause on demand, may not cause for days, and should never be
 * nudged into causing. Two unrelated bugs turned that wait into a locked door on
 * the same day — a mail quota ate the provider's confirmation, and one predicate
 * refused the only message the step could proceed on.
 *
 * The FACT survives ({@link OnboardingFacts.firstMailConfirmedAt}, still read
 * from the log by {@link firstMailAt}); only its power to block is gone. It is
 * now a status the app reports — see {@link mailStatus} — and the surface that
 * reads it is Settings, at any time, rather than a screen the walk had to pass
 * through once.
 *
 * # Why the other three ARE skippable, and account creation is not
 *
 * Without keys there is no account to hold data, and the recovery phrase is
 * unrecoverable, so `invited` and `keys_secured` stay hard. Everything after
 * them is a task the user may do now, later or never: an account with no
 * address and no home currency is still a working budgeting app, because
 * transactions can be added by hand.
 *
 * Skipping is *not doing a thing*. Nothing here does a thing with less proof.
 */
export const SKIPPABLE_STEPS = [
  "address_issued",
  "forwarding_configured",
  "home_currency_set",
] as const;

export type SkippableStep = (typeof SKIPPABLE_STEPS)[number];

export function isSkippable(step: OnboardingStep): step is SkippableStep {
  return (SKIPPABLE_STEPS as readonly string[]).includes(step);
}

/**
 * `"signed_out"` is **not** a step: it is the absence of the machine. Sign-in
 * owns everything before the first milestone.
 */
export type OnboardingPosition = OnboardingStep | "signed_out";

/** Which surface a position puts on the glass. */
export type OnboardingScreen =
  | "sign_in"
  | "confirming"
  | "recovery"
  | "address"
  | "forwarding"
  | "home_currency"
  | "finish"
  | "product";

const SCREEN_FOR: Record<OnboardingPosition, OnboardingScreen> = {
  signed_out: "sign_in",
  // A session exists but no server has confirmed the account this launch. A
  // real state, not a formality: this is where a `410 account_deleted`
  // surfaces on a device that was signed in yesterday.
  signed_in: "confirming",
  invited: "recovery",
  // Straight to the address: there is no bank question. See ONBOARDING_STEPS.
  keys_secured: "address",
  address_issued: "forwarding",
  // The forwarding rule is the last thing about mail the walk asks for. What
  // used to follow it was a screen waiting for a bank email to arrive; see
  // {@link SKIPPABLE_STEPS} for why that wait is a status now.
  forwarding_configured: "home_currency",
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
  /**
   * This device holds the account's keys, and they are the ones the account
   * published (`v2/keys.ts`'s `keyStatus`).
   *
   * **Not device-local state that could be remembered.** It is re-derived at
   * every boot from what is actually in the key vault against what the server
   * actually published, because the two ways it can be false are different
   * screens: an account that has published nothing needs a phrase generated,
   * and an account that has published keys this browser does not hold needs one
   * typed in. A stored boolean could say "yes" for a browser whose site data was
   * cleared five minutes ago, which is precisely the case the recovery step
   * exists for.
   */
  keysReady: boolean;
  /**
   * The banks the user has declared, ACTIVE ONES ONLY, read from the folded log
   * (`bank_declared`) through {@link declaredBanksOf}. Several, editable later,
   * and never device-local: this is the fact whose old home in
   * {@link LocalOnboardingRecord} made a second device re-run setup.
   *
   * {@link WAITLIST_BANK} counts, deliberately — a user whose bank cannot be
   * read yet has still answered the question.
   */
  banks: readonly string[];
  /** The inbound address, minted server-side on first read. */
  inboundAddress: string | null;
  /**
   * The user said the forward is set up.
   *
   * A DECLARATION, and remembered as one — persisted in
   * {@link LocalOnboardingRecord.forwardingDeclared}, exactly as `skipped` is.
   * It is not evidence the forward works; {@link mailStatus} still reports
   * arrival separately, and {@link resumeFacts} still reads mail having
   * arrived as this being true on a device with no record. See the record
   * field for the resume loop that deriving it alone caused.
   */
  forwardingDeclared: boolean;
  /**
   * A genuine bank message has become a transaction.
   *
   * **No longer a milestone**, and that is the point: it is the only fact in
   * here the user cannot cause — it needs their bank to send an email, which
   * needs them to spend money. It is reported as a status ({@link mailStatus})
   * and it still demonstrates that a forward works, which is why
   * {@link resumeFacts} reads `forwardingDeclared` off it.
   */
  firstMailConfirmedAt: string | null;
  /**
   * The steps the user answered with "later".
   *
   * DEVICE-LOCAL, and the one fact in here that has to be. Every other fact is
   * evidence the account carries — an op in the log, an address on the server —
   * whereas a decision *not* to do something leaves no evidence anywhere. The
   * alternative to storing it is walking the user through the same skipped step
   * at every launch, which is the lockout this whole design removes.
   *
   * It never makes anything true. A skipped step's milestone is still unmet, so
   * `banks` is still empty and `homeCurrency` is still null — the skip only
   * stops {@link stepFor} treating the gap as a wall, and
   * {@link remainingSetup} still lists it as outstanding.
   */
  skipped: readonly SkippableStep[];
  /** **From the log.** Never from a device setting, never cached locally. */
  homeCurrency: string | null;
  /**
   * The user has seen the finish screen — the reason `done` is not simply "the
   * currency is set": the op is emitted the instant the picker is confirmed,
   * and without this the screen explaining what happens next would be skipped in
   * the same frame it appeared.
   *
   * In-memory within a session, and re-derived at boot: {@link resumeFacts} sets
   * it when every ACCOUNT milestone behind it is already met — see
   * {@link accountSetupComplete} for why {@link keysReady} is excluded — which
   * is what opens the app on a second device instead of a finish screen for a
   * setup that happened on another phone. The cost is that reloading between the
   * currency op and the button skips that screen once, on a device whose account
   * is by then set up.
   */
  setupSeen: boolean;
  /**
   * When "Open ledger" was tapped on this device, or null.
   *
   * Persisted in {@link LocalOnboardingRecord.finishedAt} — see that field for
   * why a finished device never re-enters the walk. OPTIONAL only so that a
   * facts object built before this field existed (two test fixtures encode
   * one) still type-checks as "never finished"; everything in this module sets
   * it explicitly.
   */
  finishedAt?: string | null;
}

export function emptyFacts(): OnboardingFacts {
  return {
    hasSession: false,
    accountId: null,
    keysReady: false,
    banks: [],
    inboundAddress: null,
    forwardingDeclared: false,
    firstMailConfirmedAt: null,
    homeCurrency: null,
    skipped: [],
    setupSeen: false,
    finishedAt: null,
  };
}

/** Each step, paired with the fact that makes it done. */
const MILESTONES: readonly (readonly [OnboardingStep, (f: OnboardingFacts) => boolean])[] = [
  ["signed_in", (f) => f.hasSession],
  ["invited", (f) => f.accountId !== null],
  ["keys_secured", (f) => f.keysReady],
  ["address_issued", (f) => f.inboundAddress !== null],
  ["forwarding_configured", (f) => f.forwardingDeclared],
  ["home_currency_set", (f) => f.homeCurrency !== null],
  ["done", (f) => f.setupSeen],
];

/** Whether the user has said "later" to this step. */
export function isSkipped(f: OnboardingFacts, step: OnboardingStep): boolean {
  return isSkippable(step) && f.skipped.includes(step);
}

/**
 * The longest unbroken prefix of milestones that are met **or skipped**.
 *
 * **A gap still stops the walk, and a skip is not a gap.** Taking the highest
 * true milestone instead would drop a reinstalled user into the product with no
 * forwarding rule and no bank — every fact behind the gap is still true, so the
 * state would look complete while the thing onboarding exists to arrange had
 * never happened. A skip is different in kind: it is the user having been asked
 * and having answered. The step is still outstanding ({@link remainingSetup}
 * lists it, Settings can still do it); it simply no longer stands in the way.
 *
 * **A device that finished the walk has answered every optional question.**
 * {@link OnboardingFacts.finishedAt} passes the SKIPPABLE steps only, so a
 * fact that regresses after "Open ledger" (an address fetch failing offline, a
 * milestone redefined) cannot drag a finished user back into onboarding — but
 * the hard gates (a session, an invite, the keys) still gate, which is what
 * keeps a wiped browser on the recovery step rather than in a product it
 * cannot decrypt.
 */
export function stepFor(f: OnboardingFacts): OnboardingPosition {
  const finished = f.finishedAt != null;
  let at: OnboardingPosition = "signed_out";
  for (const [step, done] of MILESTONES) {
    if (!done(f) && !isSkipped(f, step) && !(finished && isSkippable(step))) return at;
    at = step;
  }
  return at;
}

/** The boot gate's question, in one place so it cannot be re-derived wrongly. */
export function onboardingComplete(f: OnboardingFacts): boolean {
  return stepFor(f) === "done";
}

/**
 * Whether the ACCOUNT has been set up — every milestone met except the one that
 * is about this device's access rather than about the account's history.
 *
 * # `keysReady` is a gate, not a memory, and reading it as one destroyed data
 *
 * {@link OnboardingFacts.keysReady} answers "does this browser hold the
 * account's keys right now". It is false on every second device, after cleared
 * site data, after the WebKit `CryptoKey` loss, and whenever `GET
 * /api/v1/keys` fails — `boot`'s `keysReadyOrFalse` turns a failed read into
 * `false`, which is the right answer for a gate and no answer at all about
 * history.
 *
 * {@link resumeFacts} used to ask {@link stepFor} directly, and `stepFor` stops
 * at the FIRST unmet milestone. So one false `keysReady` made a fully set-up
 * account read as never set up: `setupSeen` stayed false, the walk correctly
 * showed the recovery step, and then — the instant the phrase was accepted —
 * dropped the user on the finish screen. The finish screen carries
 * `BudgetSplitStep`, whose "Save plan" authors a whole `budget_split_set`, and
 * `budget_split_set` REPLACES the plan. A monthly total set on another device
 * was wiped by a screen the user had no reason to think was destructive.
 *
 * So this asks the same table with the access gate held open. Everything else
 * is still required, and in the prefix order the table sets — an account with
 * nothing in its log still has to walk, keys or no keys.
 */
function accountSetupComplete(f: OnboardingFacts): boolean {
  // `setupSeen: false` as well as `keysReady: true`, so the answer is about the
  // milestones BEHIND `done` whatever the caller happens to hold.
  return stepFor({ ...f, keysReady: true, setupSeen: false }) === "home_currency_set";
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export type OnboardingEvent =
  | { type: "session"; hasSession: boolean }
  | { type: "account_confirmed"; accountId: string }
  | { type: "keys_secured" }
  | { type: "banks_declared"; banks: readonly string[] }
  | { type: "address_issued"; address: string }
  | { type: "forwarding_declared" }
  | { type: "first_mail_confirmed"; at: string }
  | { type: "home_currency_set"; currency: string }
  /** "Set this up later". One step per event; the screen says which. */
  | { type: "step_skipped"; step: SkippableStep }
  /** "Open ledger" was tapped. `at` is persisted; see the record's field. */
  | { type: "finished"; at: string }
  | { type: "signed_out" }
  | { type: "account_deleted" };

/**
 * ISO 4217 alpha-3, upper-cased — the same normalisation `replay.currencyOf`
 * applies. Returns null rather than a partial code: the draft the user is
 * typing is a `string` all the way to commit (v1's `Number("") === 0`
 * springback, one type over), and this is the single conversion point.
 */
function normalizeCurrency(draft: string): string | null {
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

    case "keys_secured":
      // One direction only. Nothing in the product un-secures keys: a device
      // that has them keeps them until the site data is cleared, and that is a
      // fresh boot rather than an event.
      return f.keysReady ? f : { ...f, keysReady: true };

    case "banks_declared": {
      // Same object when the set is unchanged, so a re-declaration is visibly a
      // no-op rather than a rewrite that lands on the same value.
      const next = [...new Set(e.banks)];
      const same = next.length === f.banks.length && next.every((b, i) => f.banks[i] === b);
      return same ? f : { ...f, banks: next };
    }

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

    case "step_skipped":
      // Same object when it is already skipped, and it never un-skips: the way
      // back to a skipped step is doing it, in Settings, not a second event.
      return f.skipped.includes(e.step) ? f : { ...f, skipped: [...f.skipped, e.step] };

    case "finished":
      // The first press is the finish time; a second press moves nothing.
      return f.finishedAt != null ? f : { ...f, setupSeen: true, finishedAt: e.at };

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

/**
 * The device-local half, persisted as JSON: the address hint and the USER'S
 * ANSWERS — the facts with no home in the account, because a log records what
 * was done and nothing anywhere records what was declined or declared.
 *
 * `bank` was here once and stays gone: it is the account's fact, in the log,
 * and a browser profile that remembered one overruled what a second device
 * could see. A record written by any earlier build still decodes — extra keys
 * are ignored, absent ones read as their zero — because the address hint in it
 * is what keeps an offline set-up device out of onboarding.
 */
export interface LocalOnboardingRecord {
  /** A resume hint, not a display value. See the header. */
  inboundAddress: string | null;
  /**
   * The steps this person said "later" to.
   *
   * The one fact with no home in the account: an op log records what was done,
   * and nothing anywhere records what was declined. Stored, a skipped step
   * stays skipped across a reload; unstored, every launch walks the user back
   * into the step they already answered, which is the door this design exists
   * to unlock.
   *
   * A second device does not inherit it, and that is correct rather than merely
   * tolerable — the second device is asked the question once, and can answer
   * "later" again in one tap.
   */
  skipped: readonly SkippableStep[];
  /**
   * The user said "I have set this up" on the forwarding screen.
   *
   * A DECLARATION, not a demonstration — mail arriving is still the only
   * evidence the rule works, and {@link mailStatus} still reports that
   * separately. But the declaration is the user's answer to a question, and a
   * question answered must stay answered: deriving this from mail arrival made
   * the walk bounce every finished user back to "Send your bank mail here"
   * until the world happened to respond (2026-08-09, the resume loop).
   */
  forwardingDeclared: boolean;
  /**
   * When "Open ledger" was tapped on this device, or null.
   *
   * Once set, this device NEVER re-enters the walk. The walk is a corridor for
   * account creation and first setup; everything after it is a task in
   * SetupStatus/Settings. Without this, any future fact that regresses (an
   * address fetch failing offline, a milestone redefined) silently drags a
   * finished user back into onboarding — the exact class of bug this field
   * retires. A second device does not inherit it and walks once; that is
   * correct, and mail already flowing means it walks straight through.
   */
  finishedAt: string | null;
}

export const LOCAL_RECORD_KEYS = ["inboundAddress", "skipped", "forwardingDeclared", "finishedAt"] as const;

export function encodeLocal(f: OnboardingFacts): LocalOnboardingRecord {
  return {
    inboundAddress: f.inboundAddress,
    skipped: f.skipped,
    forwardingDeclared: f.forwardingDeclared,
    finishedAt: f.finishedAt ?? null,
  };
}

/** Refuses a partially-readable record rather than half-applying it. */
export function decodeLocal(v: unknown): LocalOnboardingRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  // Absent reads as null rather than as a refusal: a record from before this
  // field existed is complete in every way that decides a step.
  const addr = r["inboundAddress"] ?? null;
  if (addr !== null && typeof addr !== "string") return null;
  // Unreadable skips read as NONE rather than as a refusal of the whole record.
  // The cost of dropping them is one more walk through steps that are all
  // skippable; the cost of refusing the record is the cached address, which is
  // what keeps an offline set-up device out of onboarding entirely.
  const raw = r["skipped"];
  const skipped = Array.isArray(raw) ? raw.filter((s): s is SkippableStep => typeof s === "string" && isSkippable(s as OnboardingStep)) : [];
  // Absent or unreadable reads as the zero, for the same reason as the skips:
  // a record from the previous build is complete in every way that decides a
  // step. The native-port build kept these two under the same names and the
  // same meanings, so its record's answers are honoured rather than dropped.
  const forwardingDeclared = r["forwardingDeclared"] === true;
  const finishedRaw = r["finishedAt"];
  const finishedAt = typeof finishedRaw === "string" ? finishedRaw : null;
  return { inboundAddress: addr, skipped, forwardingDeclared, finishedAt };
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
  /**
   * **Measured at this boot**, never read from `local`: it is the answer to
   * "does this browser hold the account's keys right now", and a cached one
   * would be wrong for exactly the browser the recovery step exists to serve.
   */
  keysReady: boolean;
  /** **From the log**, through {@link declaredBanksOf}. Active ones only. */
  banks: readonly string[];
  /** The server's answer, or null when it could not be asked. */
  inboundAddress: string | null;
  firstMailConfirmedAt: string | null;
  homeCurrency: string | null;
  local: LocalOnboardingRecord | null;
}): OnboardingFacts {
  const local = args.local;
  const base: OnboardingFacts = {
    hasSession: args.hasSession,
    accountId: args.accountId,
    keysReady: args.keysReady,
    banks: args.banks,
    inboundAddress: args.inboundAddress ?? local?.inboundAddress ?? null,
    // REMEMBERED first — the declaration is the user's answer, and it must
    // survive a reload (the 2026-08-09 resume loop). Mail in the log still
    // answers on a device with no record: it is evidence a forward works, and
    // evidence a second device has too.
    forwardingDeclared: local?.forwardingDeclared === true || args.firstMailConfirmedAt !== null,
    firstMailConfirmedAt: args.firstMailConfirmedAt,
    homeCurrency: args.homeCurrency,
    // Device-local facts with nowhere else to live. See
    // {@link LocalOnboardingRecord.skipped} and its `finishedAt`.
    skipped: local?.skipped ?? [],
    setupSeen: false,
    finishedAt: local?.finishedAt ?? null,
  };
  // "Finished" is the ACCOUNT's prerequisites being met — OR this device
  // having actually finished the walk, whatever has regressed since. The
  // first is asked through {@link accountSetupComplete} rather than by
  // re-listing the milestones, so this can never drift from the table — and
  // through that rather than through `stepFor` directly, because this device's
  // key access says nothing about whether the account was ever set up. See
  // that function for the data loss the difference caused.
  return accountSetupComplete(base) || base.finishedAt != null ? { ...base, setupSeen: true } : base;
}

/**
 * The banks the user has declared and not retired, read from the folded log.
 * The only sanctioned source — see this module's header.
 *
 * `State.banks` is keyed per bank with a boolean, so a retired one is `false`
 * rather than absent; the filter is what turns that into the live set, and the
 * Map's insertion order is the fold order, which is the order the user built.
 *
 * **Nothing in the trust path may call this.** Declared banks route the waitlist
 * and drive the UI; the sender allowlist is separate and the server's.
 */
export function declaredBanksOf(s: Pick<State, "banks">): string[] {
  return [...s.banks].filter(([, active]) => active).map(([bank]) => bank);
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

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

export interface CurrencyChoice {
  code: string;
  name: string;
}

/**
 * The picker's curated list, UAE-beta first. It is a convenience and not the
 * vocabulary: {@link searchCurrencies} offers any well-formed alpha-3 code, so
 * a beta user whose currency is missing is never stuck.
 */
const COMMON_CURRENCIES: readonly CurrencyChoice[] = [
  { code: "AED", name: "UAE dirham" },
  { code: "SAR", name: "Saudi riyal" },
  { code: "USD", name: "US dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "Pound sterling" },
  { code: "INR", name: "Indian rupee" },
  { code: "PKR", name: "Pakistani rupee" },
  { code: "EGP", name: "Egyptian pound" },
  { code: "PHP", name: "Philippine peso" },
  { code: "BDT", name: "Bangladeshi taka" },
  { code: "LKR", name: "Sri Lankan rupee" },
  { code: "JOD", name: "Jordanian dinar" },
  { code: "KWD", name: "Kuwaiti dinar" },
  { code: "QAR", name: "Qatari riyal" },
  { code: "OMR", name: "Omani rial" },
  { code: "BHD", name: "Bahraini dinar" },
  { code: "TRY", name: "Turkish lira" },
  { code: "CAD", name: "Canadian dollar" },
  { code: "AUD", name: "Australian dollar" },
  { code: "CHF", name: "Swiss franc" },
  { code: "JPY", name: "Japanese yen" },
  { code: "CNY", name: "Chinese yuan" },
];

export function searchCurrencies(query: string): CurrencyChoice[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...COMMON_CURRENCIES];
  const hits = COMMON_CURRENCIES.filter((c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
  if (hits.length > 0) return hits;
  const code = normalizeCurrency(query);
  return code === null ? [] : [{ code, name: "Currency code" }];
}

// ---------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------

/**
 * An op the picker asks the client to author. Deliberately not an `Op`: op ids
 * and timestamps are `Client.emitMany`'s to mint, and a pure module that minted
 * them would be a second, untested authoring path.
 */
export interface OpSpec {
  type: string;
  payload: unknown;
}

/**
 * The USD peg, fixed since 1997 and seeded as a real `rate_set` op rather than
 * as a schema default (spec §3.7). 1 USD = 3.6725 AED, in home-units-per-
 * foreign-unit micros.
 */
const USD_PEG_MICRO = 3_672_500n;

/**
 * The ops one confirmed pick emits, in the order they must be folded.
 *
 * The peg is seeded **only** for an AED home. For any other home currency it
 * would be wrong in two ways at once: the number is AED-denominated, and a USD
 * home would take `rate_set` for its own currency, which replay refuses as a
 * `rate_set_for_home_currency` anomaly.
 *
 * An unusable code produces no ops. {@link onboardingReducer} has already
 * refused it, so this is the second of two gates rather than the only one.
 */
export function homeCurrencyOps(currency: string): OpSpec[] {
  const ccy = normalizeCurrency(currency);
  if (ccy === null) return [];
  const ops: OpSpec[] = [{ type: "home_currency_set", payload: { currency: ccy } }];
  if (ccy === "AED") {
    // A decimal STRING: `parseMoney` refuses a JSON number outright, because
    // `JSON.parse` of one is a float64 and a rate that rounds re-values every
    // conversion made against it.
    ops.push({ type: "rate_set", payload: { currency: "USD", rate_micro: USD_PEG_MICRO.toString(10) } });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// What is still outstanding
// ---------------------------------------------------------------------------

/** One thing setup asked for that has not been done. */
export interface SetupTask {
  id: SkippableStep;
  /** What it is, in two or three words. */
  title: string;
  /** What does not work until it is done. Honest, not scolding. */
  detail: string;
}

/**
 * The words on a skip control and the price of pressing it.
 *
 * Each `consequence` is a sentence the code honours. None of them says a skipped
 * step is fine; each says what will not work, and where to finish it.
 */
export const SKIP_COPY: Record<SkippableStep, { action: string; consequence: string }> = {
  address_issued: {
    action: "Set this up later",
    consequence: "No mail will be filed until you do this. You can add transactions by hand in the meantime.",
  },
  forwarding_configured: {
    action: "Set this up later",
    consequence: "Nothing arrives until mail is sent to your address. Your address is in Settings when you want it.",
  },
  home_currency_set: {
    action: "Set this up later",
    consequence: "Totals stay in the currency each purchase was made in. Settings can set it once, later.",
  },
};

const TASK_COPY: Record<SkippableStep, { title: string; detail: string }> = {
  address_issued: { title: "Get your inbound address", detail: "The address your bank mail is sent to." },
  forwarding_configured: { title: "Send your bank mail here", detail: "Set it with your bank, or forward it." },
  home_currency_set: { title: "Set your home currency", detail: "Totals are kept in this one. It is set once." },
};

/**
 * Everything setup asked for that is still not done — **whether or not it was
 * skipped**, in the walk's own order.
 *
 * Deliberately derived from the milestone facts and not from `skipped`: a step
 * finished somewhere else (a bank declared in Settings, an address minted by a
 * boot read) drops off this list on its own, and a list that tracked the button
 * press instead would nag about work already done.
 */
export function remainingSetup(f: OnboardingFacts): SetupTask[] {
  const met: Record<SkippableStep, boolean> = {
    address_issued: f.inboundAddress !== null,
    forwarding_configured: f.forwardingDeclared,
    home_currency_set: f.homeCurrency !== null,
  };
  return SKIPPABLE_STEPS.filter((s) => !met[s]).map((s) => ({ id: s, ...TASK_COPY[s] }));
}

/**
 * Whether mail is actually reaching ledger — the thing that used to be a step.
 *
 * Three states, because "nothing has arrived" means two different things. With
 * no address there is nowhere for mail to arrive, and telling that user to wait
 * would be pointing at a pipe that was never laid.
 */
export type MailStatus = { kind: "arrived"; at: string } | { kind: "waiting" } | { kind: "no_route" };

export function mailStatus(f: Pick<OnboardingFacts, "inboundAddress" | "firstMailConfirmedAt">): MailStatus {
  if (f.firstMailConfirmedAt !== null) return { kind: "arrived", at: f.firstMailConfirmedAt };
  
  if (f.inboundAddress === null) return { kind: "no_route" };
  return { kind: "waiting" };
}

/**
 * The status line, in the words that replaced a waiting screen.
 *
 * `waiting` says what a user stuck there actually needs to know: that nothing is
 * expected of them, that the wait is on their bank, and that they do not have to
 * spend money to make setup finish — the app is already theirs.
 */
export const MAIL_STATUS_COPY = {
  waiting: {
    title: "Waiting for your first bank email",
    body:
      "Nothing to do. The next transaction email your bank sends becomes a transaction here. Add anything by " +
      "hand until then.",
  },
  arrived: { title: "Your bank mail is arriving", body: "Mail sent to your address is being filed." },
  no_route: {
    title: "No mail can arrive yet",
    body: "Your bank mail has nowhere to go until you set up an address. Until then, add transactions by hand.",
  },
} as const;

/**
 * The provider's confirmation, as a task rather than a gate.
 *
 * Gmail emails a code before it will forward anything. That message is signed by
 * the provider, so §3.2 makes it held rather than filed — which is why it is read
 * in place, from Held mail, and why the honest sentence about it not arriving
 * names the two real causes rather than blaming the user's mailbox.
 */
export const CONFIRMATION_TASK_COPY = {
  title: "Your provider may email you a code",
  body:
    "Some providers send a code before they will forward mail. It is held, not filed, because your provider " +
    "signed it — open it under Held mail and enter the code with your provider.",
  missing:
    "If no code has arrived, your provider may not send one, or the message may have been refused before it " +
    "reached ledger. Ask your provider to send it again. Nothing else in ledger is waiting on it.",
} as const;

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export interface ConfirmCopy {
  title: string;
  /** Said before the tap, in the words §3.7 requires. */
  consequence: string;
  /** What "home currency" actually does to their money, in one sentence. */
  meaning: string;
  acknowledgement: string;
  confirm: string;
  back: string;
}

/**
 * The words on the second step of the picker.
 *
 * §3.7 makes this one-shot with **no in-product way to change it afterward**,
 * and the only remedy is deleting the account. The copy says that, and it must
 * never say "you can change this later in settings" — the sentence a
 * well-meaning edit reaches for, and a lie. `Onboarding.test.tsx` asserts its
 * absence, because the copy is templated and a leak could hide in one arm.
 */
export function confirmCopy(currency: string): ConfirmCopy {
  const c = normalizeCurrency(currency) ?? currency.trim().toUpperCase();
  return {
    title: `Set ${c} as your home currency?`,
    consequence:
      `There is no way to change this once it is set. The only fix is to delete your account and start again, ` +
      `which erases everything ledger has recorded for you.`,
    meaning:
      `Every total and budget is kept in ${c}. A purchase in another currency is converted once, when it arrives, ` +
      `and that figure is then frozen.`,
    acknowledgement: `I understand ${c} is permanent.`,
    confirm: `Set ${c} as my home currency`,
    back: "Choose a different currency",
  };
}

/**
 * The peg, shown as arithmetic rather than as a claim — and shown for a second
 * reason: it is a rate the user **can** change, right next to a choice they
 * cannot, which is what makes the difference legible before the tap.
 */
export function pegIllustration(currency: string): string | null {
  if (normalizeCurrency(currency) !== "AED") return null;
  // Computed with the same `convert` the replay engine uses, not with a
  // hand-written product: an illustration that disagreed with the engine would
  // be teaching the user the wrong arithmetic.
  return `USD 100.00 is recorded as AED ${fixed2(convert(100_00n, USD_PEG_MICRO))}`;
}

function fixed2(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? "-" : ""}${(abs / 100n).toString(10)}.${(abs % 100n).toString(10).padStart(2, "0")}`;
}

/**
 * Why the message onboarding depends on is quarantined, said before the user can
 * read it as a fault.
 *
 * Plan Decision 7: a mail provider signs its forwarding confirmation with its own
 * domain, §3.2 forbids ever promoting a forwarder domain, so that message is one
 * the product will never trust. It is held and read in place.
 *
 * **It used to name Google.** That was accurate about Gmail and wrong about
 * everyone else, and it sat directly above a list that no longer knows or guesses
 * a provider — `couldBeConfirmation` deliberately cannot tell a provider's
 * confirmation from a bank's first direct alert, which is why the screen lists
 * every held message by its verified signing domain and lets the user open the
 * one they are waiting for. Copy that named one provider was the loudest
 * remaining claim the code no longer makes.
 *
 * Every sentence here is one the screen honours: it does list everything held
 * with the domain that signed it, only an authenticated message can be opened,
 * and reading one files nothing.
 */
export const QUARANTINE_HELD = {
  title: "Held mail is held on purpose",
  /**
   * What the user must know to act: mail is held, that is the rule working, and
   * held mail is listed below.
   */
  body:
    "ledger files mail only when it can prove it came from a bank. Everything held is listed below with the " +
    "domain that signed it. That is normal, not a fault.",
  /**
   * The mechanism, behind an `InfoTip`.
   *
   * Why a confirmation is held is an explanation, not a decision — a user who
   * never opens this tip still knows their mail is held, still sees it listed
   * and still gets the trust warning above the button. The one thing that moved
   * with it is "reading one does not file it", which is a reassurance about a
   * control the screen already labels ("Look for a confirmation code" versus
   * "This is my bank — file its mail").
   *
   * Names no provider, for the same reason {@link TRUST_ONLY_YOUR_BANK} does
   * not — `onboarding.test.ts` holds both to it.
   */
  why:
    "A forwarding confirmation is signed by your mail provider, not your bank, so it is held instead of filed. " +
    "You can open and read any message ledger could authenticate; reading one does not file it.",
} as const;

/**
 * What "the domain that signed it" means, behind an `InfoTip` beside the list.
 *
 * A definition, by the spec's own example. The screen still says every held
 * message is filed under the domain that signed it, and still refuses to trust
 * an unauthenticated one — this only explains the words.
 */
export const SIGNING_DOMAIN_TIP =
  "The domain that cryptographically signed the message, checked by ledger rather than read off the email. " +
  "It is the only thing about a held message ledger can prove by itself.";

/**
 * What "This is my bank — file its mail" actually asks for, said above the
 * buttons rather than discovered by pressing one.
 *
 * # This was deleted once, for a reason that was backwards
 *
 * The sentence "trusting Google here would mean trusting anything at all that
 * Google forwards" was removed when the held-mail list stopped naming a provider
 * and started offering the trust button on every row — on the grounds that the
 * screen no longer honoured a promise about one provider's confirmation. It was
 * the right objection to the wrong half of the sentence: the naming had to go,
 * the warning had to stay, because the per-row button is what makes it reachable.
 *
 * On a provider's own forwarding confirmation there is no inner origin — the
 * provider signed the whole thing — so `trustRequest` returns that provider's
 * domain in **outer** scope, i.e. "trust everything this provider relays to my
 * address". The server refuses that (`ErrForwarderDomain`, 409), and the operator
 * hit exactly that refusal on the live deployment. So this is a comprehension
 * problem rather than a hole, and a user who does not understand a refusal
 * presses again or concludes the product is broken.
 *
 * # Every clause is one the code honours
 *
 * The rows really are labelled with the verified signing domain (`trustBasis`);
 * outer-scope trust really does cover every future message from that domain; and
 * the refusal really is a list of known providers (`origin.ForwarderDomains`),
 * which is why the copy says "recognises" rather than promising it always
 * catches one. It names no provider, because it is true for all of them.
 */
export const TRUST_ONLY_YOUR_BANK = {
  title: "Press this only on mail from your bank",
  body:
    "Each message below is filed under the domain that signed it. Press it on your bank's mail and ledger files " +
    "the bank's alerts from now on. Press it on your mail provider's own confirmation and you trust everything " +
    "that provider relays to this address, not just your bank. ledger blocks that for the providers it " +
    "recognises, but the safe rule is: only your bank.",
} as const;

/**
 * The same step when there is no code to wait for: an iCloud forward, or an
 * address registered with the bank directly.
 *
 * Kept beside {@link QUARANTINE_HELD} because they are one screen's two
 * openings, and the difference between them must stay legible in one place. The
 * gate behind both is identical — a transaction in the log, via
 * {@link firstMailAt} — so neither may promise anything the other cannot.
 */
export const WAITING_FOR_FIRST_MAIL = {
  title: "Waiting for your first bank email",
  body:
    "There is no code to enter and nothing to wait here for. Mail ledger cannot prove came from a bank is held, " +
    "not filed. Anything held is listed below.",
} as const;

/**
 * The consequence of a passkey that lives on one device, said at the moment the
 * passkey is created and not in a settings screen nobody opens.
 *
 * **There is no account recovery, and there cannot be one.** The server holds
 * no password to reset, no recovery email and no second factor to fall back on;
 * an account is reachable only by a credential an authenticator holds. The
 * operator cannot restore access, so a user with one passkey on one lost device
 * has lost the account and everything in it. Spec Decision 10 refused a recovery
 * phrase that recovers nothing; this is the honest version of the same
 * conversation, and it is why {@link ADD_PASSKEY_COPY} offers a second one on
 * the same screen rather than filing it under "later".
 */
export const RECOVERY_WARNING = {
  title: "If you lose this passkey, the account is gone",
  body:
    "There is no password to reset and no recovery email. Nobody, including the person running this beta, can " +
    "let you back in. If your only passkey is on one device and that device is lost, wiped or replaced, the " +
    "account and everything in it cannot be reached again.",
  advice:
    "Save the passkey somewhere that outlives one phone: iCloud Keychain, a syncing password manager, or a " +
    "hardware key. Then add a second one below.",
} as const;

/**
 * The recovery-phrase step's words.
 *
 * # Every sentence here is one the code honours, and the ones it cannot make
 * true are absent
 *
 * This is a privacy claim made to someone who will sign a consent document, at
 * the moment they are deciding whether to trust us, so the spec (§"The decision
 * that overrides the request") sets a hard rule: **do not write "only you can
 * access it", "zero-access", or "we can't see it".** They are false. Bank mail
 * arrives over SMTP in plaintext — it must, the bank sends it that way — and the
 * server reads it in memory to extract the transaction before sealing it. There
 * is a window, on our machine, where the plaintext exists, and a live,
 * compromised server could log it.
 *
 * `onboarding.test.ts` asserts those phrasings are absent, so a later, kinder
 * edit cannot reintroduce them.
 *
 * What is written instead is stronger and survives scrutiny:
 *
 *   - encrypted before it is stored, with a key only this device holds;
 *   - a stolen disk, backup or subpoena of the database yields ciphertext;
 *   - **and** we do see each email for the moment it arrives, because the bank
 *     sends it unencrypted;
 *   - and losing the phrase and the devices loses the history, permanently.
 *
 * # There is no skip, and there is no quiz either
 *
 * The step cannot be deferred — see below. It also no longer asks the user to
 * type three of the words back: they are trusted to store the phrase the way
 * they wish, and a typed answer proved only that the words were on the previous
 * screen, never that they were saved anywhere durable. The warning is what
 * carries the weight, and it is untouched.
 *
 * The native design treated a phrase as a backstop because iCloud Keychain
 * syncs a device wrap key. A browser has no Keychain. If this browser's site
 * data is cleared and no phrase was written down, the account is unrecoverable —
 * not "hard to recover", unrecoverable, because nobody holds anything that could
 * restore it. That is the sentence, and it is why this step has no way past it.
 */
export const RECOVERY_PHRASE_COPY = {
  title: "Write down your recovery phrase",
  intro: "Twelve words, made on this device and sent nowhere. They are the key to everything ledger records for you.",
  whatItProtects:
    "Your transactions and the emails behind them are encrypted before they are stored, with a key only your " +
    "devices hold. A stolen disk, a stolen backup or a subpoena of our database yields ciphertext.",
  whatItDoesNot:
    "ledger does see each email as it arrives — your bank sends it unencrypted. We read the transaction out, seal " +
    "it, and drop the original. This phrase does not close that window.",
  noWayBack:
    "Clear this browser's data without these words and the account is gone. ledger holds no copy of this key. " +
    "There is nothing to reset and nobody to ask.",
  // Said next to the advice about WHERE to keep the words, because that is the
  // decision it changes. The phrase was a read capability when this screen was
  // first written; the recovery authorizer made it a write one, and a person
  // weighs "a screenshot in my photo library" differently once a finder could
  // author transactions into their financial log rather than only read it.
  alsoWrites: "Anyone with these words can also add a device that writes to your records, not just read them.",
  advice:
    "Write them on paper, or save them in a password manager. A screenshot is better than nothing and worse than " +
    "either.",
  // The one press on this screen, and the last of the ceremony. The four
  // strings that used to follow it — a "now type three of them back" title, its
  // intro, its wrong-word complaint and a "show me the words again" button —
  // are gone with the quiz they belonged to. The user is trusted to store the
  // words the way they wish; typing three back proved only that they were still
  // on the previous screen.
  recorded: "I have written these down",
  working: "Setting up encryption…",
  failed:
    "ledger could not finish setting up encryption. Nothing is lost and your phrase has not changed. Try again " +
    "when you are online.",
} as const;

/**
 * The other side of the same step: a browser that holds no keys for an account
 * that has them.
 *
 * This is what a reinstall, a cleared cache or a second device sees, and the
 * copy has to be calm about it — the account is fine, this browser simply has
 * nothing in it.
 */
export const RECOVERY_ENTRY_COPY = {
  /*
   * The first thing this screen says, and it exists because of a real report.
   *
   * The gate replaces the whole tree the instant a passkey sign-in succeeds, so
   * a user who then needs their phrase saw a bare wall and read it as "sign-in
   * is broken" — the sign-in had in fact worked perfectly. A screen that
   * follows a successful action has to say what happened before it says what is
   * still needed. Nothing here is a claim the code does not honour: the session
   * is live, and the phrase really is the only thing missing.
   */
  signedIn: "You're signed in. This browser needs your recovery phrase before it can show your records.",
  title: "Enter your recovery phrase",
  intro:
    "This browser holds no key for your account — normal after a reinstall, a new device or cleared site data. " +
    "Your records are safe and encrypted on the server. These twelve words make them readable again and let this " +
    "device write to them.",
  // The button on this screen enrols a writer. Saying only "readable" would be
  // true of what the phrase decrypts and false about what pressing it does.
  alsoWrites: "Anyone with these words can also add a device that writes to your records, not just read them.",
  noWayBack:
    "There is no way around this screen. ledger holds no copy of your key, so nobody can let you in without the " +
    "phrase — not the person running this beta, not with proof of who you are.",
  label: "Your twelve words",
  placeholder: "twelve words, separated by spaces",
  action: "Unlock my account",
  working: "Checking…",
  failed: "Those words did not open your account. It is usually a typo, or two words swapped.",
} as const;

export const ADD_PASSKEY_COPY = {
  title: "Add a second passkey",
  body:
    "A second passkey on another device — a phone, a laptop, a hardware key — is the only backup ledger can " +
    "offer. Either one signs you in on its own.",
  action: "Add another passkey",
  done: "Second passkey added.",
  skip: "Not now",
} as const;
