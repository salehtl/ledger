/**
 * What happens between opening the tab and seeing the app.
 *
 * A port of `app/src/app/bootstrap.ts`, which is the module that learned these
 * orderings the hard way. Framework-free and fully injectable, because the
 * interesting cases here are failures — an enrolment that could not finish, a
 * chain break, an account deleted on another device — and none of them is
 * reachable from a React test that has to stand up a real `Client` first.
 *
 * # The order is load-bearing: enrol, then sync, then read the facts
 *
 * **Enrolment first, before anything that could author.** The launch sync is
 * the first thing that reads `Client.writerId`, so a device with no writer
 * fails there with "no writer selected" — which the native app showed as an
 * unrecoverable open failure until this order was fixed.
 *
 * It is also the repair for a state this codebase can genuinely produce.
 * `session.ts`'s `ceremony` persists the session (`adoptSession`) and only then
 * enrols, so a network drop in between leaves a device with
 * `signedIn() === true` and no writer, in which every write throws "this device
 * is not set up to make changes yet". Nothing in `initV2` notices. Calling
 * {@link V2Handle.enrol} unconditionally at every boot repairs it, and costs
 * nothing when there is nothing to repair: `ensureDeviceWriter`'s fast path is
 * "already selected AND holding the seed", with no network call. The
 * alternative — "enrol only when signing in" — leaves every already-signed-in
 * device permanently unable to write.
 *
 * When the repair itself fails, the answer is {@link BootState} `unenrolled`
 * and **not** `fatal`: the account is fine, the data is fine, and the one
 * missing thing is recoverable by pressing something once there is a
 * connection. Routing it through `fatal` is what put "run `cli enroll
 * --writer`" on a phone.
 *
 * # Classify before you conclude
 *
 * `classify` runs on every failure and looks for the two that are about the
 * ACCOUNT rather than about one call: the account is gone (wipe, per
 * `mayWipeLocalData`'s 410-**and**-`account_deleted` rule) and the session is
 * not valid (sign out). It runs BEFORE the `isEnrollmentError` arm, never
 * after: a 401 or 410 raised while enrolling is still a session answer, and
 * `ensureDeviceWriter` lets both past unwrapped precisely so this order works.
 *
 * # A halt is a boot state of its own
 *
 * `SyncEngine` reports a hard stop as `{ halted: true }` DATA and throws
 * everything else — `ChainBreakError`, `UnknownNewerVersionError`, a transport
 * failure — after publishing `phase: "halted"`. Both land here as
 * {@link BootState} `halted`, because to the person holding the device they are
 * the same thing: the records did not check out and the app must not pretend to
 * be loading. `BootGate` renders it full-screen and non-dismissable.
 *
 * # The address read is allowed to fail
 *
 * The native port treats a failed `GET /api/v1/address` as fatal. A browser tab
 * opens offline as a matter of course, so here a failure falls back to the
 * address cached in the device-local record (see `onboarding.ts`'s header) and
 * boot carries on. Without that, one failed GET walks a fully set-up user back
 * to the address step — a far worse lie than a stale address string. A 401/410
 * from that same read is still classified, so the failure that matters is not
 * swallowed with the rest.
 */

import type { SyncResult } from "@ledger/client/net/engine";
import type { Violation } from "@ledger/client/invariants/check";
import type { State } from "@ledger/client/replay/state";
import type { SecretStore } from "@ledger/client/store/store";

import { enrollmentFailureCopy, type EnrollmentCopy } from "./enrollment";
import {
  firstMailAt,
  loadLocalRecord,
  onboardingComplete,
  resumeFacts,
  saveLocalRecord,
  type OnboardingFacts,
} from "./onboarding";
import { isEnrollmentError, type V2Handle } from "./session";

export type BootState =
  | { step: "opening" }
  | { step: "signed_out" }
  /**
   * Signed in, and this device is not able to author. Neither fatal nor a lie.
   */
  | { step: "unenrolled"; copy: EnrollmentCopy }
  | { step: "onboarding"; userId: string; facts: OnboardingFacts }
  | { step: "ready"; userId: string; facts: OnboardingFacts }
  | { step: "halted"; reason: string; violations: readonly Violation[] }
  | { step: "fatal"; error: Error };

/** The words used when a halt arrives with no reason attached to it. */
export const HALT_WITHOUT_REASON = "syncing stopped because this device's records did not check out";

export interface BootDeps {
  /** {@link V2Handle.signedIn}. */
  signedIn(): boolean;
  /** `Client.userId`. May throw; a throw is {@link BootState} `fatal`. */
  userId(): string;
  /** {@link V2Handle.enrol} — the repair. */
  enrol(): Promise<void>;
  /** The launch sync, through the coordinator. */
  sync(): Promise<SyncResult>;
  /** `SyncCoordinator.haltReason`. */
  haltReason(): string | null;
  /** The folded log, read after the sync. */
  state(): Pick<State, "txns" | "homeCurrency">;
  /** `GET /api/v1/address`, which mints on first read. */
  address(): Promise<string | null>;
  /** Where the device-local half of the onboarding facts lives. */
  secrets: SecretStore;
  /** Delete this account's local data. Only ever called for `410 account_deleted`. */
  wipe(): Promise<void>;
  /** Drop the bearer token and nothing else. */
  clearSession(): void;
}

/**
 * The whole of boot, as one value. **Never rejects** — every failure is one of
 * the {@link BootState} arms, because a rejected boot is a blank screen.
 */
export async function boot(deps: BootDeps): Promise<BootState> {
  if (!deps.signedIn()) return { step: "signed_out" };

  let userId: string;
  try {
    userId = deps.userId();
  } catch (error) {
    return fatal(error);
  }

  // 1. THE REPAIR. See this module's header — before the sync, and before
  //    anything else that could author.
  try {
    await deps.enrol();
  } catch (error) {
    const forced = await classify(deps, error);
    if (forced !== null) return forced;
    // AFTER classify, never before: an `EnrollmentError` carries its cause's
    // status, and reading that status here would file a session answer as an
    // enrolment problem.
    if (isEnrollmentError(error)) return { step: "unenrolled", copy: enrollmentFailureCopy(error) };
    return fatal(error);
  }

  // 2. THE LAUNCH SYNC. Its own catch, so that the one class of error whose
  //    right answer is `halted` rather than `fatal` is decided by WHERE it was
  //    raised rather than by a type test on the error. The set of things
  //    `SyncEngine` rethrows is open-ended on purpose (it names
  //    `UnknownNewerVersionError`, `ChainBreakError`, `ProtocolError` and
  //    "transport failures"), so an allow-list here would be a second copy of a
  //    list that lives somewhere else and would silently mis-file the next
  //    error added to it.
  let result: SyncResult;
  try {
    result = await deps.sync();
  } catch (error) {
    const forced = await classify(deps, error);
    if (forced !== null) return forced;
    return { step: "halted", reason: messageOf(error), violations: [] };
  }
  if (result.halted) {
    return { step: "halted", reason: deps.haltReason() ?? HALT_WITHOUT_REASON, violations: result.violations };
  }

  // 3. THE FACTS.
  try {
    const folded = deps.state();
    const facts = resumeFacts({
      hasSession: true,
      accountId: userId,
      inboundAddress: await addressOrNull(deps),
      firstMailConfirmedAt: firstMailAt(folded),
      homeCurrency: folded.homeCurrency,
      local: loadLocalRecord(deps.secrets),
    });
    // Re-persisted so a freshly minted address survives to the next boot; every
    // other field round-trips unchanged from what was just loaded.
    saveLocalRecord(deps.secrets, facts);

    return onboardingComplete(facts) ? { step: "ready", userId, facts } : { step: "onboarding", userId, facts };
  } catch (error) {
    const forced = await classify(deps, error);
    if (forced !== null) return forced;
    return fatal(error);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The address, or null when it could not be read for a reason that is about the
 * connection rather than about the account.
 */
async function addressOrNull(deps: BootDeps): Promise<string | null> {
  try {
    return await deps.address();
  } catch (error) {
    if (isSessionAnswer(error)) throw error;
    return null;
  }
}

function fatal(error: unknown): BootState {
  return { step: "fatal", error: error instanceof Error ? error : new Error(String(error)) };
}

function httpShape(err: unknown): { status: number; code: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e.status !== "number") return null;
  return { status: e.status, code: typeof e.code === "string" ? e.code : "" };
}

function isSessionAnswer(err: unknown): boolean {
  const http = httpShape(err);
  return http !== null && (http.status === 401 || mayWipeLocalData(err));
}

/**
 * `410` **and** `account_deleted`, both. Not `410` alone: a bare status check
 * would also fire on any future `410` this endpoint learns to send. Not the
 * code alone: a body is the part an intermediary can most easily rewrite, and a
 * proxy answering `401 {"error":"account_deleted"}` would otherwise be able to
 * wipe a device.
 */
export function mayWipeLocalData(err: unknown): boolean {
  const http = httpShape(err);
  return http !== null && http.status === 410 && http.code === "account_deleted";
}

/** The two failures about the ACCOUNT rather than about one call. */
async function classify(deps: BootDeps, error: unknown): Promise<BootState | null> {
  if (mayWipeLocalData(error)) {
    await deps.wipe();
    return { step: "signed_out" };
  }
  if (httpShape(error)?.status === 401) {
    deps.clearSession();
    return { step: "signed_out" };
  }
  return null;
}

/**
 * The `BootDeps` for a real handle and coordinator.
 *
 * Kept beside {@link boot} rather than in the component so that the wiring is
 * checked by the type system in one place, and so `BootGate` holds no policy.
 */
export function handleDeps(args: {
  handle: V2Handle;
  sync: () => Promise<SyncResult>;
  haltReason: () => string | null;
  secrets: SecretStore;
  address: () => Promise<string | null>;
  wipe: () => Promise<void>;
}): BootDeps {
  return {
    signedIn: () => args.handle.signedIn(),
    userId: () => args.handle.client.userId,
    enrol: () => args.handle.enrol(),
    sync: args.sync,
    haltReason: args.haltReason,
    state: () => args.handle.client.state(),
    address: args.address,
    secrets: args.secrets,
    wipe: args.wipe,
    clearSession: () => {
      void args.handle.signOut();
    },
  };
}
