/**
 * What a person is told when this device could not be registered as one that
 * may make changes. Ported from `app/src/auth/enrollment.ts`.
 *
 * Kept out of any screen because two surfaces render it — the boot gate's wall
 * and (Task 7) the sign-in banner — and because the honesty of each sentence is
 * the part worth testing. Nothing here names a CLI, a writer id, or an
 * endpoint.
 *
 * `rejected` is the one that has to be careful: the server answers every
 * registration refusal with the same bodyless `403`, so the copy may not claim
 * to know WHY, only what is true — that this device was not accepted and
 * pressing again will not change that.
 *
 * The wording says "this device" rather than the native port's "this phone":
 * the same account is reachable from a laptop here.
 */

import { isEnrollmentError, type EnrollmentKind } from "./session";

export interface EnrollmentCopy {
  title: string;
  body: string;
  /** Whether pressing the same button again could plausibly work. */
  retry: boolean;
}

export function enrollmentCopy(kind: EnrollmentKind): EnrollmentCopy {
  switch (kind) {
    case "offline":
      return {
        title: "ledger could not finish setting up this device",
        body:
          "You are signed in, but registering this device as one that can make changes needs a connection. " +
          "Nothing was lost. Try again when you are online.",
        retry: true,
      };
    case "unavailable":
      return {
        title: "ledger could not finish setting up this device",
        body:
          "You are signed in, but the server could not register this device as one that can make changes. " +
          "Nothing was lost. Try again in a moment.",
        retry: true,
      };
    case "rate_limited":
      return {
        title: "Too many attempts",
        body: "Setting this device up was tried too many times in a row. Wait a minute and try again.",
        retry: true,
      };
    case "rejected":
      return {
        title: "This device was not accepted",
        body:
          "You are signed in, but the server refused to register this device as one that can make changes, and it " +
          "does not say why. If another device is already set up on this account, adding a second one has to be " +
          "approved from that device — which this beta cannot do yet. Trying again will not change the answer.",
        retry: false,
      };
    case "revoked":
      return {
        title: "This device's access was withdrawn",
        body:
          "This device was set up on this account and then removed from it. It can still read what it already has, " +
          "but it cannot make changes, and signing in again will not restore it.",
        retry: false,
      };
    case "key_lost":
      return {
        title: "This device can no longer prove who it is",
        body:
          "This account already knows this device, but the private key that signed for it is gone from this " +
          "browser — clearing site data does not carry it. Nothing on the server was lost. This device cannot " +
          "make changes again until a device that still has its key can add it back, which this beta cannot do yet.",
        retry: false,
      };
  }
}

/** The copy for an error, whatever shape it arrived in. */
export function enrollmentFailureCopy(err: unknown): EnrollmentCopy {
  return enrollmentCopy(isEnrollmentError(err) ? err.enrollmentKind : "unavailable");
}
