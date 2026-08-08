/**
 * What each passkey failure says, in one place.
 *
 * Two screens run a passkey ceremony now — `screens/onboarding/Welcome.tsx`
 * (register / sign in / add the second one) and the Settings passkey row (add
 * another, later). They must not paraphrase each other: the distinction every
 * arm below draws is whether pressing again could plausibly help, which is the
 * same distinction `BootGate`'s walls make, and a second hand-written copy of it
 * drifts on exactly the arms nobody tests — `cancelled` and `offline`.
 *
 * Every arm is a true sentence about what happened. None of them apologises for
 * a dismissed prompt: deciding not to create a credential is not an error.
 */

import type { PasskeyFailureKind } from "./session";

export function passkeyFailureCopy(kind: PasskeyFailureKind): { title: string; body: string } {
  switch (kind) {
    case "unsupported":
      return {
        title: "This browser cannot use passkeys",
        body: "ledger signs you in with a passkey, and this browser does not support them. A current Safari, Chrome, Edge or Firefox will work.",
      };
    case "cancelled":
      return {
        title: "The passkey prompt was closed",
        body: "Nothing was sent and nothing was created. Press the button again when you are ready.",
      };
    case "rejected":
      return {
        title: "That passkey was not accepted",
        body: "The signature did not check out, or this account does not know that passkey. To get into an existing account, use the device that holds its passkey.",
      };
    case "rate_limited":
      return {
        title: "Too many attempts just now",
        body: "The server is asking for a pause. Wait a minute and try again — nothing is wrong with your passkey.",
      };
    case "offline":
      return {
        title: "ledger could not reach the server",
        body: "There was no answer, which is almost always the connection. Nothing was created, so trying again is safe.",
      };
    case "not_invited":
    case "unavailable":
      return {
        title: "That did not go through",
        body: "The server refused the request. Nothing was created on this device, so trying again is safe.",
      };
  }
}
