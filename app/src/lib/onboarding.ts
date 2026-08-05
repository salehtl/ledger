/**
 * The onboarding machine, and the one decision this product cannot take back.
 *
 * Everything here is pure and runs under `bun test`. The screens in
 * `src/screens/onboarding/` render it and hold no policy of their own — the
 * same split `src/auth/` uses, and for the same reason: nothing in this repo
 * can run a React Native screen against a real device, so any decision left
 * inside a component is a decision nothing checks.
 *
 * # The step is DERIVED, never stored
 *
 * `stepFor` walks a table of milestones and returns the longest unbroken
 * prefix. Nothing persists a step number, and that is the whole design:
 *
 *   - A force-quit loses only memory. Every fact is read back from the
 *     Keychain, the server or the op log, so a cold launch lands exactly where
 *     the last one left off without a resume record to keep in step.
 *   - A stored cursor can disagree with reality. The dangerous direction is a
 *     device that believes it has not set a home currency when the log says it
 *     has — which is a second `home_currency_set`, i.e. a permanent
 *     `home_currency_reset` anomaly. Reading the fact from the log makes that
 *     unrepresentable rather than merely unlikely.
 *
 * The prefix rule is deliberately strict: a gap is never skipped, however much
 * sits behind it. A reinstall keeps the log and the server's facts and loses
 * the device-local half, so it re-runs the bank and forwarding steps — cheap,
 * repeatable, and it walks *past* the currency step because that fact is in the
 * log.
 *
 * # What each fact is made of, and what survives what
 *
 * | fact | source | survives force-quit | survives reinstall |
 * |---|---|---|---|
 * | `hasSession` | Keychain (`auth/session.ts`) | yes | no — a sign-in restores it |
 * | `accountId` | the exchange, i.e. the server | yes | yes, on the next sign-in |
 * | `bank` | device-local record | yes | **no** |
 * | `inboundAddress` | `GET /api/v1/address`, server-minted | yes | yes |
 * | `forwardingDeclared` | device-local record — nothing can observe a Gmail filter | yes | **no** |
 * | `firstMailConfirmedAt` | the log | yes | yes |
 * | `homeCurrency` | **the log** (`State.homeCurrency`) | yes | yes |
 * | `finishedAt` | device-local record | yes | **no** |
 *
 * {@link LocalOnboardingRecord} is the persisted half, and it has nowhere to
 * put a currency on purpose (spec §3.7: log state, never a device setting).
 */

import { HALT_NOT_VOUCHED_FOR, type Halt } from "@ledger/client/invariants/surface.ts";
import { convert } from "@ledger/client/replay/fx.ts";
import type { State } from "@ledger/client/replay/state.ts";
import type { SecretStore } from "@ledger/client/store/store.ts";

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * The plan's vocabulary, in the plan's order. Each name is a **milestone that
 * is done**, so the position `bank_picked` means "a bank has been chosen and
 * the next thing to do is the inbound address".
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
 * `"signed_out"` is **not** one of Task 14's states: it is the absence of the
 * machine. Sign-in is the app's initial route and owns everything before the
 * first milestone, so the shell renders nothing of its own there.
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
  // A session exists but no server has confirmed the account this launch. It is
  // a real state and not a formality: this is where a `410 account_deleted`
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
  /** A session token is in this device's Keychain. */
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
  /** A genuine bank message has been confirmed (§3.2 makes this a step). */
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
      // THE refusal (plan Task 14 Step 4). One-shot, client-side, and ahead of
      // the emit — a second op reaching the log is a permanent
      // `home_currency_reset` anomaly that no later op can repair, so the cheap
      // guard is the one that matters. An unusable code is refused here too,
      // rather than travelling to `homeCurrencyOps` and quietly producing no
      // ops while the machine advanced anyway.
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

/**
 * The device-local half, persisted as JSON.
 *
 * There is deliberately **no** home-currency field. Spec §3.7 makes the home
 * currency log state, and the cheapest way to keep a later refactor honest is a
 * record with nowhere to put one; `onboarding.test.ts` asserts the key set.
 */
export interface LocalOnboardingRecord {
  bank: string | null;
  forwardingDeclared: boolean;
  finishedAt: string | null;
}

export const LOCAL_RECORD_KEYS = ["bank", "forwardingDeclared", "finishedAt"] as const;

export function encodeLocal(f: OnboardingFacts): LocalOnboardingRecord {
  return { bank: f.bank, forwardingDeclared: f.forwardingDeclared, finishedAt: f.finishedAt };
}

/** Refuses a partially-readable record rather than half-applying it. */
export function decodeLocal(v: unknown): LocalOnboardingRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const bank = r["bank"];
  const fwd = r["forwardingDeclared"];
  const fin = r["finishedAt"];
  if (bank !== null && typeof bank !== "string") return null;
  if (typeof fwd !== "boolean") return null;
  if (fin !== null && typeof fin !== "string") return null;
  return { bank, forwardingDeclared: fwd, finishedAt: fin };
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
    inboundAddress: args.inboundAddress,
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
 * Where the device-local half is kept.
 *
 * The {@link SecretStore} is the one durable key-value store this app has:
 * `expo-secure-store`, already wired by `auth/native.ts`, synchronous, and
 * `..._THIS_DEVICE_ONLY` so nothing here rides an iCloud backup onto another
 * phone. Inventing a second persistence layer for three booleans-worth of
 * onboarding progress would be a native module nothing on this box can run.
 *
 * Nothing secret goes in it — which is why the currency does not, and cannot:
 * {@link LocalOnboardingRecord} has no field for one.
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
// The gate: a wait that is not a failure
// ---------------------------------------------------------------------------

export interface WaitCopy {
  title: string;
  body: string;
  action: string;
}

/**
 * A second device hard-stops until a checkpoint names it, and enrolment and
 * first checkpoint are **strictly ordered** — `escapableDuringPush` in
 * `client/src/invariants/surface.ts` documents the deadlock this ordering
 * avoids. It is correct behaviour, and the library's own copy for it
 * ("syncing has stopped") is written for somebody who has been using the app
 * for a year rather than for ninety seconds. During onboarding it gets these
 * words instead.
 */
export const AWAITING_VOUCH: WaitCopy = {
  title: "Waiting for your other device",
  body:
    "Your devices vouch for each other's records, and the one you already use has not confirmed this one yet. " +
    "That confirmation is written automatically the next time it syncs — it is not something to do here, and " +
    "nothing is wrong with this device. Everything you have set up is saved and will pick up where it left off.",
  action: "Open ledger on your other device and leave it on screen for a moment.",
};

export type OnboardingGate =
  | { kind: "clear" }
  | { kind: "awaiting_vouch"; copy: WaitCopy; halt: Halt }
  | { kind: "halted"; halt: Halt };

/**
 * Classifies the one hard stop `surface()` chose to show.
 *
 * Keyed on `halt.kind` and never on its words — the same rule `haltKindOf`
 * states, for the same reason. And it takes the **already-ranked** halt rather
 * than a violation list, so it cannot re-derive the ordering `surface()` owns:
 * `HALT_ORDER` puts `not_vouched_for` last precisely so that a co-occurring
 * withholding is the one shown, and a second classifier here could undo that.
 */
export function onboardingGate(h: Halt | null): OnboardingGate {
  if (h === null) return { kind: "clear" };
  if (h.kind === HALT_NOT_VOUCHED_FOR) return { kind: "awaiting_vouch", copy: AWAITING_VOUCH, halt: h };
  return { kind: "halted", halt: h };
}

/**
 * Gmail's confirmation email is held forever, by design (plan Decision 7): the
 * forwarder-domain rule refuses to promote `google.com`, so onboarding's happy
 * path routes through the quarantine lane and the first thing a new alpha sees
 * is a held message.
 *
 * Task 15 owns that screen and Task 17 owns the lane. This is the sentence they
 * both need, kept here so there is one wording and it is tested.
 */
export const QUARANTINE_HELD = {
  title: "Google's confirmation email is held on purpose",
  body:
    "Gmail sends its confirmation from Google, not from your bank. ledger only files mail it can prove came " +
    "from a bank, so anything forwarded by Google is held to one side instead — that is ledger working as " +
    "intended. The code you need is in the held message and you can read it there. It stays held afterwards: " +
    "trusting Google here would mean trusting anything at all that Google forwards.",
} as const;

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
export const COMMON_CURRENCIES: readonly CurrencyChoice[] = [
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

/**
 * ISO 4217 alpha-3, upper-cased — the same normalisation `replay.currencyOf`
 * applies, done here so the payload carries what the fold will key on. A
 * mismatch would put transactions in a currency bucket the user's `rate_set`
 * never reaches, invisibly.
 *
 * Returns null rather than a partial code: the draft the user is typing is a
 * `string` all the way to commit (v1's `Number("") === 0` springback, one type
 * over), and this is the single conversion point.
 */
export function normalizeCurrency(draft: string): string | null {
  const s = draft.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

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
 * and timestamps are `Client.emit`'s to mint, and a pure module that minted
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
export const USD_PEG_MICRO = 3_672_500n;

/**
 * The ops one confirmed pick emits, in the order they must be folded.
 *
 * The peg is seeded **only** for an AED home. For any other home currency it
 * would be wrong in two ways at once: the number is AED-denominated, and a USD
 * home would take `rate_set` for its own currency, which replay refuses as a
 * `rate_set_for_home_currency` anomaly.
 *
 * An unusable code produces no ops. The caller has already refused it
 * ({@link onboardingReducer}), so this is the second of two gates rather than
 * the only one.
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
// The confirmation, and the seam under it
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
 * The words on the second step.
 *
 * §3.7 makes this one-shot with **no in-product way to change it afterward**,
 * and the only remedy is deleting the account. The copy says that, and it must
 * never say "you can change this later in settings" — which is the sentence a
 * well-meaning edit reaches for and which would be a lie. `onboarding.test.ts`
 * asserts its absence across every currency, because the copy is templated and
 * a leak could hide in one arm.
 */
export function confirmCopy(currency: string): ConfirmCopy {
  const c = normalizeCurrency(currency) ?? currency.trim().toUpperCase();
  return {
    title: `Set ${c} as your home currency?`,
    consequence:
      `There is no way to change this once it is set. If ${c} turns out to be the wrong choice, the only way ` +
      `to fix it is to delete your account and start again, which deletes everything ledger has recorded for you.`,
    meaning:
      `Every total and every budget is kept in ${c}. A purchase in another currency is converted once, when it ` +
      `arrives, and that converted figure is frozen — so changing the base afterwards would silently re-value ` +
      `everything already recorded.`,
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
  const whole = abs / 100n;
  const cents = abs % 100n;
  return `${neg ? "-" : ""}${whole.toString(10)}.${cents.toString(10).padStart(2, "0")}`;
}

/**
 * Which rule this build applies to changing a home currency that is already
 * set.
 *
 * `"immutable"` is what spec §3.7 mandates and what ships. `"mutable_until_
 * frozen"` is `NEEDS-SALEH.md` §5 option (a) — allow a supersede for as long as
 * no transaction anywhere in the log carries a non-null `amount_home_minor`,
 * which is provably safe because no frozen value can change when none exists.
 *
 * Both branches are implemented and tested so that adopting (a) is a constant
 * and some copy on this side. **Flipping the constant alone is not enough:**
 * `replay.applyHomeCurrencySet` records a `home_currency_reset` anomaly for the
 * second op regardless of what the client believes, and Go's executor mirrors
 * it. The log-side change is one guard in each executor plus a conformance
 * vector; this constant is the client half, and `onboarding.test.ts` pins it to
 * `"immutable"` so nobody flips it without doing the other half.
 */
export type HomeCurrencyRule = "immutable" | "mutable_until_frozen";

export const HOME_CURRENCY_RULE: HomeCurrencyRule = "immutable";

export interface HomeCurrencyLock {
  changeable: boolean;
  reason: "unset" | "immutable" | "nothing_frozen_yet" | "frozen";
}

export function homeCurrencyLock(
  homeCurrency: string | null,
  frozenSnapshots: number,
  rule: HomeCurrencyRule = HOME_CURRENCY_RULE,
): HomeCurrencyLock {
  if (homeCurrency === null) return { changeable: true, reason: "unset" };
  if (rule === "immutable") return { changeable: false, reason: "immutable" };
  return frozenSnapshots === 0
    ? { changeable: true, reason: "nothing_frozen_yet" }
    : { changeable: false, reason: "frozen" };
}

/**
 * How many transactions carry a frozen FX snapshot.
 *
 * Counted from the rows themselves rather than inferred from
 * `State.pendingByCurrency`, which is maintained by the same code path that
 * freezes them — a count derived from it would agree with the thing it is
 * checking by construction. Only {@link homeCurrencyLock}'s non-default rule
 * consults it, so the full pass is not on any hot path today.
 */
export function countFrozenSnapshots(s: Pick<State, "txns">): number {
  let n = 0;
  for (const t of s.txns.values()) if (t.amount_home_minor !== null) n += 1;
  return n;
}
