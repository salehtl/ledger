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
 * # A halt is a boot state of its own — and being offline is NOT one
 *
 * `SyncEngine` reports a hard stop as `{ halted: true }` DATA and throws
 * everything else after publishing `phase: "halted"`. That "everything else"
 * includes a **transport failure**, which is why the phase is not the
 * classifier: round 1 of this task shipped a wall telling a user with no
 * network that their records had failed an integrity check and that reopening
 * the app would not clear it. Both halves were false.
 *
 * `halt.ts` splits the throw before anything renders. A genuine integrity
 * failure becomes {@link BootState} `halted`, carrying the {@link Halt} the
 * library's own `surface()` classified — the violation CLASS and its written
 * copy, not this app's paraphrase of an exception string. A transport failure
 * sets `offline` and boot **carries on**: the projection is local, fully
 * readable, and showing it is the honest answer.
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
import type { Halt } from "@ledger/client/invariants/surface";
import type { State } from "@ledger/client/replay/state";
import type { SecretStore } from "@ledger/client/store/store";

import { enrollmentFailureCopy, type EnrollmentCopy } from "./enrollment";
import {
  classifySyncFailure,
  haltFromViolations,
  httpShape,
  mayWipeLocalData,
  sessionAnswerOf,
  HALT_WITHOUT_REASON,
} from "./halt";
import {
  declaredBanksOf,
  firstMailAt,
  loadLocalRecord,
  onboardingComplete,
  resumeFacts,
  saveLocalRecord,
  type OnboardingFacts,
} from "./onboarding";
import { isEnrollmentError, type EnrollmentKind, type V2Handle } from "./session";

export type BootState =
  | { step: "opening" }
  | { step: "signed_out" }
  /**
   * Signed in, and this device is not able to author. Neither fatal nor a lie.
   */
  /**
   * `kind` rides alongside the copy because one of the seven is not a dead end
   * any more: `rejected` is what a SECOND device gets, and the wall for it
   * carries the enrolment request another device can approve. The copy alone
   * cannot be switched on — it is prose.
   */
  | { step: "unenrolled"; kind: EnrollmentKind; copy: EnrollmentCopy }
  /**
   * Signed in, enrolled, and this device could not fetch the account's
   * configuration — so it does not know whether setup has already happened.
   *
   * It exists because the alternative is worse than a wall. Setup lives in the
   * op log now (banks, the budget split, the categories, the home currency), so
   * an offline device that has not synced reads an account with none of it. Sent
   * to onboarding, it would ask a user with a working account to choose their
   * bank and set up mail forwarding again — which looks exactly like their
   * records having been thrown away, and is the most damaging thing this UI can
   * imply. Saying "ledger could not reach the server" and offering a retry is
   * both honest and recoverable.
   */
  | { step: "config_unavailable"; userId: string }
  /**
   * `offline` records that the launch sync could not reach the server. The app
   * still opens, on the local projection, because that is the honest answer —
   * see the header.
   */
  | { step: "onboarding"; userId: string; facts: OnboardingFacts; offline: boolean }
  | { step: "ready"; userId: string; facts: OnboardingFacts; offline: boolean }
  | { step: "halted"; halt: Halt }
  | { step: "fatal"; error: Error };

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
  /** The folded log, read after the sync. `banks` is the declared set. */
  state(): Pick<State, "txns" | "homeCurrency" | "banks">;
  /** `GET /api/v1/address`, which mints on first read. */
  address(): Promise<string | null>;
  /**
   * Whether this device holds the account's at-rest keys — `v2/keys.ts`'s
   * `keyStatus`, reduced to the one bit the milestone table needs.
   *
   * Measured at every boot rather than remembered, and a device that cannot
   * ANSWER (the server did not reply) reports `false`, which routes to the
   * recovery step. That is the safe direction and it is also the honest one:
   * "this device is not set up to read your data yet" is true of an offline
   * device with no keys, and the step it lands on says exactly that. The other
   * direction would let a device proceed to author ops it could not later
   * protect.
   */
  keysReady(): Promise<boolean>;
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
    if (isEnrollmentError(error)) {
      return { step: "unenrolled", kind: error.enrollmentKind, copy: enrollmentFailureCopy(error) };
    }
    return fatal(error);
  }

  // 2. THE LAUNCH SYNC.
  //
  //    `SyncEngine` rethrows a TRANSPORT failure with the same `phase:
  //    "halted"` it uses for a chain break, so the phase cannot be the
  //    classifier: round 1 of this task shipped a wall telling an offline user
  //    their records had failed an integrity check. `classifySyncFailure`
  //    splits the two, and a sync this device simply could not perform does not
  //    stop the app — the projection is local and readable.
  let result: SyncResult;
  let offline = false;
  try {
    result = await deps.sync();
  } catch (error) {
    const forced = await classify(deps, error);
    if (forced !== null) return forced;
    const failure = classifySyncFailure(error, deps.haltReason());
    if (failure.kind === "halt") return { step: "halted", halt: failure.halt };
    offline = true;
    result = { pulled: 0, applied: 0, violations: [], halted: false };
  }
  if (result.halted) {
    return {
      step: "halted",
      halt: haltFromViolations(result.violations, deps.haltReason() ?? HALT_WITHOUT_REASON),
    };
  }

  // 3. THE FACTS.
  try {
    const folded = deps.state();
    const facts = resumeFacts({
      hasSession: true,
      accountId: userId,
      keysReady: await keysReadyOrFalse(deps),
      banks: declaredBanksOf(folded),
      inboundAddress: await addressOrNull(deps),
      firstMailConfirmedAt: firstMailAt(folded),
      homeCurrency: folded.homeCurrency,
      local: loadLocalRecord(deps.secrets),
    });
    // Re-persisted so a freshly minted address survives to the next boot; every
    // other field round-trips unchanged from what was just loaded.
    saveLocalRecord(deps.secrets, facts);

    if (onboardingComplete(facts)) return { step: "ready", userId, facts, offline };
    // Incomplete AND out of touch with the server: this device cannot tell an
    // account that is not set up from one whose setup it failed to fetch, and
    // guessing the first is the damaging guess. See `BootState`.
    if (offline) return { step: "config_unavailable", userId };
    return { step: "onboarding", userId, facts, offline };
  } catch (error) {
    const forced = await classify(deps, error);
    if (forced !== null) return forced;
    return fatal(error);
  }
}

/**
 * The address, or null when it could not be read for a reason that is about the
 * connection rather than about the account.
 */
async function addressOrNull(deps: BootDeps): Promise<string | null> {
  try {
    return await deps.address();
  } catch (error) {
    if (sessionAnswerOf(error) !== null) throw error;
    return null;
  }
}

/**
 * Whether this device holds the account's keys, with a failure reading as "no".
 *
 * A session answer (`401`/`410`) still travels, exactly as `addressOrNull` lets
 * it: that is a fact about the account rather than about the connection, and
 * swallowing it here would hide a deleted account behind a recovery screen.
 */
async function keysReadyOrFalse(deps: BootDeps): Promise<boolean> {
  try {
    return await deps.keysReady();
  } catch (error) {
    if (sessionAnswerOf(error) !== null) throw error;
    return false;
  }
}

function fatal(error: unknown): BootState {
  return { step: "fatal", error: error instanceof Error ? error : new Error(String(error)) };
}

/** The two failures about the ACCOUNT rather than about one call. */
async function classify(deps: BootDeps, error: unknown): Promise<BootState | null> {
  if (mayWipeLocalData(error)) {
    try {
      await deps.wipe();
    } catch (failed) {
      // A wipe that did not complete must NOT report `signed_out`. That would
      // land the browser on a clean-looking sign-in over a database that still
      // holds the deleted account's log under the same fixed name, and the next
      // sign-in would open it. Say so instead, and stay put.
      return {
        step: "fatal",
        error: new Error(
          `this account was deleted, and ledger could not finish removing its data from this browser: ` +
            `${failed instanceof Error ? failed.message : String(failed)}`,
        ),
      };
    }
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
  keysReady: () => Promise<boolean>;
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
    keysReady: args.keysReady,
    secrets: args.secrets,
    wipe: args.wipe,
    clearSession: () => {
      void args.handle.signOut();
    },
  };
}
