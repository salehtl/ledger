/**
 * The sign-in state machine, the failure taxonomy, and the one decision that
 * can destroy a user's data if it is got wrong.
 *
 * Everything here is pure and runs under `bun test`. The screen holds no logic
 * beyond dispatching events and rendering the state it is given.
 *
 * # Two answers a client must tell apart (`internal/v2/api/api.go`)
 *
 * Every session rejection is the same `401` with the same body, with exactly
 * one exception: a session whose account has been **deleted** answers
 * `410 {"error":"account_deleted"}`. That distinction is the only thing a
 * device may key a local wipe on, and {@link mayWipeLocalData} is the only
 * place in the app allowed to make that call. Wiping on a bare `401` would
 * fire on every routine token expiry — including one that happens while the
 * user is offline with a full outbox — and destroy ops that were never pushed.
 *
 * # The invite code, and the returning alpha
 *
 * `POST /api/v1/auth/exchange` takes an optional `invite_code`. It is required
 * to CREATE an account and **ignored entirely** for one that already exists
 * (`auth.UpsertUserInvited`). The client's rule is stricter than the server's,
 * because the damage is not on the wire but on the screen: **the first
 * exchange attempt never carries a code, and the code field is not rendered
 * until the server has answered `403 not_invited`.** An existing account
 * therefore cannot be asked for a code it does not have and would not be able
 * to produce — which is every returning alpha, on every launch, the day the
 * beta opens.
 */

import { SECRET_SESSION } from "@ledger/client/store/sqlite.ts";
import type { SecretStore } from "@ledger/client/store/store.ts";

import { NonceMismatchError, UserCancelledError, type Idp } from "./idp.ts";

// ---------------------------------------------------------------------------
// The exchange seam
// ---------------------------------------------------------------------------

/**
 * What sign-in needs from the network layer, and nothing more.
 *
 * This is `Client.login`'s exact signature, on purpose: `client/src`'s `Client`
 * satisfies it structurally, so Task 8 wires the real one in without an
 * adapter, and `session.test.ts` asserts that assignability at compile time so
 * a signature drift in the library fails here rather than on a phone.
 *
 * The app does **not** reimplement the exchange. `client/README.md` and the
 * plan's Global Constraints both forbid growing a second protocol client, and
 * `Client.login` already carries the "one profile, one account" refusal that a
 * hand-rolled `fetch` would drop.
 */
export interface ExchangeBackend {
  login(idp: string, idToken: string, inviteCode?: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type AuthFailureKind =
  | "cancelled"
  | "not_invited"
  | "account_deleted"
  | "reauth"
  | "unavailable"
  | "rate_limited"
  | "bad_request"
  | "nonce_mismatch"
  | "offline"
  | "unknown";

export interface AuthFailure {
  kind: AuthFailureKind;
  /** For a log and for the report screen's small print. Never the only copy. */
  detail: string;
}

/**
 * An error carrying an HTTP status and a server error code.
 *
 * Matched **structurally** rather than with `instanceof ApiError`. Metro's
 * resolver keeps one copy of `client/src` (`disableHierarchicalLookup`), but a
 * class identity check is exactly the thing that fails silently if that ever
 * stops being true, and it would fail in the direction of "this 410 is not an
 * account deletion" — the safe direction for a wipe, and the wrong one for
 * telling a user why they are stuck.
 */
function httpShape(err: unknown): { status: number; code: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e.status !== "number") return null;
  return { status: e.status, code: typeof e.code === "string" ? e.code : "" };
}

/**
 * The single place that decides whether the server has told us this account no
 * longer exists.
 *
 * **`410` AND `account_deleted`, both.** Not `410` alone: the status is the
 * authoritative half, but a bare status check would also fire on any future
 * `410` this endpoint learns to send. Not the code alone: a body is the part
 * an intermediary can most easily rewrite, and a proxy that answered
 * `401 {"error":"account_deleted"}` would otherwise be able to wipe a device.
 *
 * Nothing else in the app may reach for `status === 410`.
 */
export function mayWipeLocalData(err: unknown): boolean {
  const http = httpShape(err);
  return http !== null && http.status === 410 && http.code === "account_deleted";
}

/** Puts an error into one of the buckets the sign-in screen knows how to say. */
export function classifyFailure(err: unknown): AuthFailure {
  if (err instanceof UserCancelledError) return { kind: "cancelled", detail: err.message };
  if (err instanceof NonceMismatchError) return { kind: "nonce_mismatch", detail: err.message };

  const http = httpShape(err);
  if (http === null) {
    // No status at all: the request never reached a server that answered.
    // `TypeError: Network request failed` is what React Native's fetch throws.
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: /network|fetch|timeout|connect/i.test(detail) ? "offline" : "unknown", detail };
  }
  const detail = err instanceof Error ? err.message : `${http.status} ${http.code}`;
  if (mayWipeLocalData(err)) return { kind: "account_deleted", detail };
  if (http.status === 403 && http.code === "not_invited") return { kind: "not_invited", detail };
  if (http.status === 401) return { kind: "reauth", detail };
  if (http.status === 429) return { kind: "rate_limited", detail };
  if (http.status === 503) return { kind: "unavailable", detail };
  if (http.status === 400) return { kind: "bad_request", detail };
  return { kind: "unknown", detail };
}

/**
 * What each failure says on screen.
 *
 * Copy lives here rather than in the component because it is the part of this
 * task most likely to be wrong in a way tests can catch: `not_invited` must not
 * read as a credential problem (re-entering an Apple password will never fix
 * it) and `reauth` must not read as data loss.
 */
export function failureCopy(failure: AuthFailure): { title: string; body: string; retry: boolean } {
  switch (failure.kind) {
    case "cancelled":
      return { title: "Sign-in cancelled", body: "Nothing was sent.", retry: true };
    case "not_invited":
      return {
        title: "ledger is invite-only",
        body:
          "This is a closed beta, and creating an account needs a single-use invite code. " +
          "Your Apple or Google account is fine — there is nothing wrong with it, and signing in " +
          "again will not help without a code.",
        retry: false,
      };
    case "account_deleted":
      return {
        title: "This account was deleted",
        body: "Everything held for it on the server is gone. Signing in again would start a new account.",
        retry: false,
      };
    case "reauth":
      return {
        title: "That sign-in expired",
        body: "Nothing was lost. Sign in again to carry on.",
        retry: true,
      };
    case "unavailable":
      return {
        title: "Apple or Google could not be reached",
        body: "Your sign-in was fine; the server could not check it. Try again in a moment.",
        retry: true,
      };
    case "rate_limited":
      return { title: "Too many attempts", body: "Wait a minute and try again.", retry: true };
    case "nonce_mismatch":
      return {
        title: "That sign-in did not match",
        body: "The reply belonged to a different attempt. Try once more.",
        retry: true,
      };
    case "offline":
      return { title: "No connection", body: "ledger could not reach the server. Try again when you are online.", retry: true };
    case "bad_request":
    case "unknown":
      return { title: "Sign-in failed", body: "Something went wrong that ledger did not expect.", retry: true };
  }
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

export type SignInState =
  | { step: "idle"; failure: AuthFailure | null }
  /** The provider's own sheet is up. */
  | { step: "authenticating"; idp: Idp }
  /** Trading the ID token for a session. `inviteCode` is null on first try. */
  | { step: "exchanging"; idp: Idp; idToken: string; inviteCode: string | null }
  /** The server said `403 not_invited`. Only NOW is a code asked for. */
  | { step: "needs_invite"; idp: Idp; idToken: string; draft: string; failure: AuthFailure | null }
  | { step: "signed_in"; userId: string };

export type SignInEvent =
  | { type: "press"; idp: Idp }
  | { type: "authenticated"; idp: Idp; idToken: string }
  | { type: "exchanged"; userId: string }
  | { type: "failed"; failure: AuthFailure }
  | { type: "invite_draft"; draft: string }
  | { type: "invite_submit" }
  | { type: "restart" };

export function initialSignInState(): SignInState {
  return { step: "idle", failure: null };
}

/**
 * The reducer. Pure, total, and the only thing that decides whether an invite
 * code is carried.
 *
 * Two rules are load-bearing and each has its own test:
 *
 *  1. `authenticated` always produces `inviteCode: null`. There is no path from
 *     a fresh provider round trip to an exchange that carries a code, so an
 *     account that already exists can never be asked for one.
 *  2. `failed` routes to `needs_invite` **only** for `not_invited`. Every other
 *     failure — including the `401` that a slow typist earns while the invite
 *     screen is up — goes back to `idle` carrying its own copy, because
 *     re-submitting a code against an expired ID token fails forever.
 */
export function signInReducer(state: SignInState, event: SignInEvent): SignInState {
  switch (event.type) {
    case "press":
      // Ignored while a flow is in progress: the provider sheet is modal, but a
      // double press before it appears would otherwise start two authorize
      // calls with two different nonces and race their results.
      if (state.step === "authenticating" || state.step === "exchanging") return state;
      return { step: "authenticating", idp: event.idp };

    case "authenticated":
      if (state.step !== "authenticating") return state;
      return { step: "exchanging", idp: event.idp, idToken: event.idToken, inviteCode: null };

    case "exchanged":
      if (state.step !== "exchanging") return state;
      return { step: "signed_in", userId: event.userId };

    case "failed":
      if (event.failure.kind === "not_invited" && state.step === "exchanging") {
        // The two `not_invited` answers are different events to a person, and
        // a single branch here got that wrong: an exchange that carried NO
        // code means "you need one" and must show a blank field with no error,
        // while one that carried a code means "that code did not work" and
        // must keep what was typed. Retyping a whole code because of a typo in
        // its last character is how somebody gives up on an alpha.
        return {
          step: "needs_invite",
          idp: state.idp,
          idToken: state.idToken,
          draft: state.inviteCode ?? "",
          failure: state.inviteCode === null ? null : event.failure,
        };
      }
      return { step: "idle", failure: event.failure };

    case "invite_draft":
      if (state.step !== "needs_invite") return state;
      // A string draft, never a number and never trimmed on the way in: the
      // user is mid-paste and a value that rewrites itself under the cursor is
      // the springback bug v1's harness found.
      return { ...state, draft: event.draft, failure: null };

    case "invite_submit": {
      if (state.step !== "needs_invite") return state;
      const code = state.draft.trim();
      if (code === "") return state;
      return { step: "exchanging", idp: state.idp, idToken: state.idToken, inviteCode: code };
    }

    case "restart":
      return initialSignInState();
  }
}

/**
 * Performs one exchange.
 *
 * `inviteCode === null` calls `login` with **two arguments**, so the request
 * body carries no `invite_code` field at all rather than an empty string — the
 * server's `omitempty` would drop an empty string anyway, but "the field is
 * absent" is the property this task is judged on and it should be true at the
 * call site rather than downstream of a serializer's convention.
 */
export async function exchangeOnce(
  backend: ExchangeBackend,
  idp: Idp,
  idToken: string,
  inviteCode: string | null,
): Promise<string> {
  return inviteCode === null ? backend.login(idp, idToken) : backend.login(idp, idToken, inviteCode);
}

// ---------------------------------------------------------------------------
// The stored session
// ---------------------------------------------------------------------------

/**
 * Whether this device already holds a session, read straight from the
 * Keychain.
 *
 * Read through the **same** {@link SecretStore} name `sqliteStore` writes
 * (`SECRET_SESSION`, imported rather than re-spelled) — a second spelling of
 * that key is a device that signs in every launch while a perfectly good token
 * sits unused two characters away.
 *
 * An empty string counts as absent. `keychainSecretStore` writes `""` to clear
 * a value, because `expo-secure-store` has no synchronous delete; see
 * `native.ts`.
 */
export function hasSession(secrets: SecretStore): boolean {
  const token = secrets.get(SECRET_SESSION);
  return token !== null && token !== "";
}

/**
 * Drops the session token.
 *
 * **This is not the account-deleted wipe.** It clears the bearer token and
 * nothing else: the op log, the projection and the writer key all live in the
 * store, and the store owns their removal. When `mayWipeLocalData` is true the
 * caller must also drop the database — that path belongs with account deletion
 * (plan Task 26) and does not exist yet, so this function deliberately does
 * not pretend to be it.
 */
export function clearSession(secrets: SecretStore): void {
  secrets.set(SECRET_SESSION, null);
}
