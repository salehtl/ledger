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
 *  - **Transport** — matched by NAME, never by class. `session.ts` records why
 *    (`instanceof` fails silently when a bundler ends up with two copies of a
 *    module), and `surface()` upstream duck-types for the same reason. The set
 *    is `NetworkError`, an aborted request, and the `TypeError` a raw `fetch`
 *    rejects with, whose message is different in every engine — hence three
 *    spellings rather than Chrome's.
 *  - **Everything else** — handed to {@link surface}, the library's own
 *    classifier, which names the violation CLASS and supplies the copy.
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

export function isTransportFailure(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const e = error as { name?: unknown; message?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  // `Client`'s own wrapper, and the two names a cancelled or timed-out request
  // arrives under.
  if (name === "NetworkError" || name === "AbortError" || name === "TimeoutError") return true;
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
  if (haltReason === null && isTransportFailure(error)) {
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
