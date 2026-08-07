/**
 * Telling "this device could not reach the server" apart from "this device does
 * not trust what the server sent".
 *
 * # Why this module exists
 *
 * `SyncEngine.run` publishes `phase: "halted"` and rethrows for EVERYTHING that
 * is not a `HardStopError` — a chain break, an `UnknownNewerVersionError`, and
 * a **transport failure**, which it names in the same sentence. Round 1 of this
 * task's review found the consequence: a PWA cold-launched with no network got
 * a non-dismissable wall saying the integrity check had not passed and that
 * reopening the app would not clear it. Both halves of that were false, and it
 * is the worst thing to say wrongly — the projection is local and fully
 * readable offline, so the honest answer is "offline, showing local data".
 *
 * So the phase is not the classifier. This module is, and it splits the throw
 * in two before anything renders:
 *
 *  - **Unreachable** — this device could not get a working answer. Matched by
 *    NAME, never by class: `session.ts` records why (`instanceof` fails
 *    silently when a bundler ends up with two copies of a module), and
 *    `surface()` upstream duck-types for the same reason.
 *  - **Everything else** — handed to {@link surface}, the library's own
 *    classifier, which names the violation CLASS and supplies the copy.
 *
 * # "Unreachable" is wider than "no TCP", and it has to be
 *
 * Round 2 of the review found the first cut too narrow. It matched only the
 * cases where no HTTP answer arrived at all, which leaves two everyday
 * failures being reported as integrity verdicts:
 *
 *  - **`5xx`** — the server restarting, a proxy, a Tailscale hiccup. It
 *    answered, so no transport error is raised, but "come back in a moment" is
 *    not a statement about anybody's records.
 *  - **`ProtocolError`** — the shape a **captive portal** takes. Hotel and
 *    airport wifi answers `200` with an HTML login page, `JSON.parse` fails in
 *    `Client`, and the app told the user their data had failed a safety check.
 *    That is the single most likely real-world trigger of a false integrity
 *    alarm and it is now firmly on this side of the line.
 *
 * `4xx` is deliberately NOT here (beyond the `401`/`410` that `boot.ts`
 * intercepts as session answers, before this is reached). A `400` from our own
 * API is a bug in this app, and `uncertified`'s copy — "this is a bug in the
 * app rather than in your data" — says exactly that. `429` was considered and
 * left out: nothing on the sync path is rate-limited today, so admitting it
 * would widen the "not an integrity failure" set, which is the dangerous
 * direction, for a case that cannot currently occur.
 *
 * # The words are the library's, not this app's
 *
 * `surface()` maps a stop to one of six {@link HaltKind}s and each has written
 * copy that ends by saying what is still true, because the thing a person needs
 * first from a full-screen stop is whether their money is gone. An unrecognised
 * error lands on `uncertified` — "ledger couldn't finish checking your data …
 * try again" — which is honest about an unknown, where this task's first
 * hand-written wall claimed tampering. Nothing here rewords any of it.
 *
 * # Transport failures are not sticky, integrity failures are
 *
 * The distinction the second round-1 critical turned on: an offline blip must
 * never overwrite (or outlive) anything, whereas a genuine halt sets
 * `SyncEngine.haltReason` and every later sync returns halted until `resume()`
 * clears it. {@link classifySyncFailure} therefore takes the engine's
 * `haltReason` and refuses to call anything "offline" while one is in force,
 * however the current attempt happened to fail.
 */

import { VIOLATION_CHECK_FAILED, type Violation } from "@ledger/client/invariants/check";
import { surface, type Halt } from "@ledger/client/invariants/surface";

/** The words used when a halt arrives with no violation attached to it. */
export const HALT_WITHOUT_REASON = "syncing stopped because this device's records did not check out";

export type SyncFailure =
  /** No answer from the server. The app stays usable on local data. */
  | { kind: "offline"; detail: string }
  /** The records did not check out. Full-screen, non-dismissable. */
  | { kind: "halt"; halt: Halt };

/**
 * The three ways a browser says "there was no HTTP answer".
 *
 * Chrome/Edge: `Failed to fetch`. Safari: `Load failed`. Firefox: `NetworkError
 * when attempting to fetch resource`. Matched on the message only for a
 * `TypeError`, which is the one thing `fetch` is specified to reject with for a
 * network failure — a broader match would swallow real bugs.
 */
const FETCH_REJECTION = /failed to fetch|load failed|network ?error|networkrequestfailed/i;

/**
 * Whether this device failed to get a working answer out of the server.
 *
 * Every arm is matched by NAME or by a numeric `status`, never by `instanceof`.
 * The dangerous direction is a genuine integrity failure slipping in here and
 * being shown as a network problem, so the set is enumerated rather than
 * inferred, and none of `HardStopError`, `ChainBreakError`,
 * `UnknownNewerVersionError`, `SyncHaltedError`, `ReplayOrderError`,
 * `ProjectionCancelled`, `AuditAbandoned` or the `wire`/`norm` decode errors
 * carries a `status` or one of these names.
 */
export function isUnreachable(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const e = error as { name?: unknown; message?: unknown; status?: unknown };
  const name = typeof e.name === "string" ? e.name : "";

  // 1. No HTTP answer at all: `Client`'s own wrapper, plus the two names a
  //    cancelled or timed-out request arrives under.
  if (name === "NetworkError" || name === "AbortError" || name === "TimeoutError") return true;

  // 2. An answer that is not this protocol — which is the shape a CAPTIVE
  //    PORTAL takes: hotel wifi replies 200 with an HTML login page and
  //    `JSON.parse` fails inside `Client`. `HardStopError` is the only other
  //    thing that could plausibly be confused with this, and it is a different
  //    name carrying `violations`.
  if (name === "ProtocolError") return true;

  // 3. A server that is up enough to answer and not up enough to serve: 502
  //    behind a proxy, 503 restarting, 504 on a Tailscale hiccup. `ApiError`
  //    carries the status; `401`/`410` never reach here, because `boot.ts`
  //    intercepts them as session answers first.
  if (typeof e.status === "number" && e.status >= 500 && e.status <= 599) return true;

  // 4. The `TypeError` a raw `fetch` rejects with. Message-matched, and ONLY
  //    for a TypeError, so an ordinary bug that happens to be one ("x.map is
  //    not a function") is not filed as a network problem.
  if (name !== "TypeError") return false;
  return FETCH_REJECTION.test(typeof e.message === "string" ? e.message : "");
}

/**
 * What a failed sync actually was.
 *
 * `haltReason` is the engine's own flag and wins outright: once a halt is in
 * force `SyncEngine` refuses the next sync with a `SyncHaltedError`, and
 * reporting that refusal as "offline" would put the app back on screen over
 * data the engine has stopped standing behind.
 */
export function classifySyncFailure(
  error: unknown,
  haltReason: string | null = null,
  violations: readonly Violation[] = [],
): SyncFailure {
  if (haltReason === null && isUnreachable(error)) {
    return { kind: "offline", detail: messageOf(error) };
  }
  return { kind: "halt", halt: haltOf(violations, error) };
}

/** A halt from the violations a `SyncResult` carried. */
export function haltFromViolations(violations: readonly Violation[], reason: string): Halt {
  return violations.length > 0 ? haltOf(violations, undefined) : haltFromReason(reason);
}

/**
 * A halt for a reason with no violation behind it — an explicit
 * `SyncEngine.halt(reason)`, or a `SyncResult` that came back halted with an
 * empty list. Routed through {@link surface} rather than hand-written so the
 * copy is the same copy.
 */
export function haltFromReason(reason: string): Halt {
  return haltOf([{ id: "sync_failed", severity: "hard_stop", kind: VIOLATION_CHECK_FAILED, detail: reason }], undefined);
}

function haltOf(violations: readonly Violation[], error: unknown): Halt {
  const got = surface({ violations, ...(error === undefined ? {} : { error }) }).halt;
  // `surface` is total over any non-empty input, and `fromError` synthesises a
  // hard stop for any error it does not recognise, so this is unreachable in
  // practice. It is here because the alternative to an unreachable fallback is a
  // stop with no screen, which is the one outcome this whole path exists to
  // prevent.
  return got ?? haltFromReason("a sync stopped without saying why");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
