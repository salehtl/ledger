/**
 * Every native-module binding in `src/auth/`, in one file.
 *
 * The split is the same one `src/platform/` makes: `idp.ts`, `session.ts` and
 * `keys.ts` are pure and run under `bun test` on this box; this file imports
 * `expo-secure-store`, `expo-apple-authentication` and `expo-auth-session` and
 * therefore cannot. So it holds **glue only** — no branch, no encoding, no
 * policy. Every decision it needs was made and tested next door.
 *
 * # None of this file has been executed
 *
 * There is no Mac, no simulator, no Apple Developer account and no device on
 * this box (`NEEDS-SALEH.md` §1). What holds it up is `bun run typecheck`
 * against the pinned SDK 54 declarations, plus two source-reading tests in
 * `keys.test.ts` that assert the Keychain class and the key escaping are
 * actually applied here rather than merely chosen next door. That is a real
 * check on the two things most likely to be silently wrong, and it is not the
 * same as having run it. Treat the rest as unproven until a device does.
 */

import * as AppleAuthentication from "expo-apple-authentication";
import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";

import { platform } from "@ledger/client/platform.ts";
import type { SecretStore } from "@ledger/client/store/store.ts";

import {
  GOOGLE_DISCOVERY,
  IDP_APPLE,
  IDP_GOOGLE,
  SCOPES,
  UserCancelledError,
  googleConfig,
  newNonce,
  type IdpAuthenticator,
  type IdpCredential,
} from "./idp.ts";
import { KEYCHAIN_ACCESSIBILITY, keychainKeyFor } from "./keys.ts";
import type { ExchangeBackend } from "./session.ts";

// ---------------------------------------------------------------------------
// The Keychain
// ---------------------------------------------------------------------------

/**
 * The one place the accessibility class is applied.
 *
 * `KEYCHAIN_ACCESSIBILITY` names it; this resolves it. `keys.test.ts` reads
 * this file as text and fails if any other `SecureStore.<CONSTANT>` appears —
 * a class chosen in a doc comment and not applied at the call site is the
 * "written, tested green, never wired" shape, and the Keychain's default is
 * `WHEN_UNLOCKED`, which is iCloud-backed and therefore exactly what spec §3.4
 * forbids for the device identity key.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore[KEYCHAIN_ACCESSIBILITY],
};

/**
 * `SecretStore` over the iOS Keychain.
 *
 * `client/src/store/open.ts` names this function in its doc:
 * `sqliteStore(expoDriver("ledger.db"), { secrets: keychainSecretStore() })`.
 *
 * # Two things the contract forces
 *
 * **Synchronous.** `Store.save()` is synchronous all the way down —
 * `Client.commit()` calls it from four call sites and widening it to a promise
 * ripples through every method of a class Phase 1 spent four review rounds
 * hardening (plan Decision 3). `expo-secure-store` has had synchronous
 * `getItem`/`setItem` since SDK 51, so this is satisfiable; it has **no**
 * synchronous delete, which is the next paragraph.
 *
 * **Clearing writes an empty string.** `SecretStore.set(name, null)` must
 * remove a value and the only synchronous primitive available is a write, so
 * the value is overwritten with `""` — which destroys the old secret, since
 * the Keychain item is updated in place — and `get` maps `""` back to `null`.
 * Neither a session token nor a base64url key seed can legitimately be empty,
 * so the mapping is unambiguous. {@link purgeAsync} does the real deletion for
 * the paths that can await, and `session.ts`'s `hasSession` knows about the
 * empty string rather than assuming a clear leaves nothing behind.
 */
export function keychainSecretStore(): SecretStore {
  return {
    get(name: string): string | null {
      const key = keychainKeyFor(name);
      const got = SecureStore.getItem(key, OPTIONS);
      return got === null || got === "" ? null : got;
    },
    set(name: string, value: string | null): void {
      const key = keychainKeyFor(name);
      SecureStore.setItem(key, value ?? "", OPTIONS);
    },
  };
}

/**
 * Really removes the given `SecretStore` names.
 *
 * For sign-out and for the `410 account_deleted` wipe, both of which can
 * await. Use `keys.ts`'s `keychainNames(writerIds)` to build the list — there
 * is no "delete everything" here, because the Keychain has no enumeration this
 * app is entitled to and a hard-coded list would be a second source of truth
 * for what a device holds.
 */
export async function purgeAsync(names: readonly string[]): Promise<void> {
  for (const name of names) {
    const key = keychainKeyFor(name);
    await SecureStore.deleteItemAsync(key, OPTIONS);
  }
}

// ---------------------------------------------------------------------------
// Apple
// ---------------------------------------------------------------------------

/**
 * `ERR_REQUEST_CANCELED` is what `expo-apple-authentication` throws when the
 * user dismisses the sheet. It is not a failure and must not be reported as
 * one — a red "sign-in failed" for a deliberate dismissal is how a first-run
 * screen teaches somebody the app is broken.
 */
function isAppleCancellation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ERR_REQUEST_CANCELED";
}

/**
 * Native Sign in with Apple.
 *
 * Native rather than a web leg through `expo-auth-session`: it is the flow the
 * App Store expects for an iOS app offering third-party sign-in, it needs no
 * Services ID and no web redirect, and it is the only one that can offer
 * Apple's private relay address properly.
 *
 * **The nonce goes in raw.** Apple's ID token carries `SHA-256(nonce)` in its
 * `nonce` claim, so what is stored and compared is the raw value and
 * `expectedNonceClaim` does the hashing — see `idp.ts`, which also records
 * what that costs on the re-authentication paths.
 */
export function appleAuthenticator(): IdpAuthenticator {
  return {
    idp: IDP_APPLE,
    isAvailable: () => AppleAuthentication.isAvailableAsync(),
    async authenticate(nonce: string): Promise<IdpCredential> {
      let credential: AppleAuthentication.AppleAuthenticationCredential;
      try {
        credential = await AppleAuthentication.signInAsync({
          requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
          ],
          nonce,
        });
      } catch (e) {
        if (isAppleCancellation(e)) throw new UserCancelledError(IDP_APPLE);
        throw e;
      }
      if (credential.identityToken === null) {
        // Apple returns the credential without a token in some failure modes.
        // Sending "" to the exchange would earn a 401 and read to the user as
        // a rejected Apple account.
        throw new Error("Apple returned no identity token");
      }
      return { idToken: credential.identityToken, email: credential.email };
    },
  };
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

/**
 * Google, via the authorization-code flow with PKCE.
 *
 * Code + PKCE rather than the implicit `id_token` response: it is what Google
 * documents for installed apps, it needs no client secret (an iOS client has
 * none, and one shipped in a bundle would not be a secret anyway), and PKCE
 * binds the code to this request.
 *
 * The `nonce` rides on the **authorize** request as an extra parameter and
 * comes back verbatim in the `id_token` the token endpoint returns.
 *
 * Returns `null` when this build has no client id, so a caller can render a
 * disabled button with an explanation instead of throwing under a thumb. See
 * `idp.ts`'s `GOOGLE_IOS_CLIENT_ID` for why it is absent.
 */
export function googleAuthenticator(): IdpAuthenticator | null {
  const config = googleConfig();
  if (config === null) return null;
  return {
    idp: IDP_GOOGLE,
    isAvailable: async () => true,
    async authenticate(nonce: string): Promise<IdpCredential> {
      const request = new AuthSession.AuthRequest({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        scopes: [...SCOPES[IDP_GOOGLE]],
        responseType: AuthSession.ResponseType.Code,
        usePKCE: true,
        extraParams: { nonce },
      });
      const result = await request.promptAsync(GOOGLE_DISCOVERY);
      if (result.type === "cancel" || result.type === "dismiss") throw new UserCancelledError(IDP_GOOGLE);
      if (result.type !== "success") {
        throw new Error(`Google sign-in did not complete (${result.type})`);
      }
      const code = result.params["code"];
      if (code === undefined || request.codeVerifier === undefined) {
        throw new Error("Google returned no authorization code");
      }
      const token = await AuthSession.exchangeCodeAsync(
        {
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          code,
          extraParams: { code_verifier: request.codeVerifier },
        },
        GOOGLE_DISCOVERY,
      );
      if (token.idToken === undefined) throw new Error("Google returned no id token");
      // Google's credential carries no email field of its own; the claim in
      // the token is the only source, and `runIdpFlow` reads it.
      return { idToken: token.idToken, email: null };
    },
  };
}

// ---------------------------------------------------------------------------
// What the screen is given
// ---------------------------------------------------------------------------

export interface SignInDeps {
  apple: IdpAuthenticator;
  /** `null` while this build has no Google client id (NEEDS-SALEH §1b). */
  google: IdpAuthenticator | null;
  /** `null` until a `Client` exists to talk to — see below. */
  backend: ExchangeBackend | null;
  secrets: SecretStore;
  newNonce: () => string;
}

/**
 * The real dependencies, for the navigator to hand to the sign-in screen.
 *
 * **`backend` is `null` on purpose.** Constructing a `Client` needs a `Store`
 * (exists), a database (`src/db/driver.ts`, exists), a `SecretStore` (this
 * file) — and a **server base URL**, which exists nowhere in this app: plan
 * step P3 has not run, nothing is listening on `:8444`, and the tailnet
 * hostname is deliberately not recorded in this repo. Nothing in `app/`
 * instantiates a `Client` today; Task 8 landed its sync engine in
 * `client/src/net/engine.ts` and stopped at the same line. Writing a client
 * against a URL nobody has is the "written, tested green, never wired" defect
 * with an extra step, so it is not written. The screen renders an explicit
 * "no server configured" state instead of failing under a thumb — the same
 * treatment the missing Google client id gets, for the same reason.
 *
 * When the URL exists: build the `Client` once, alongside the single database
 * handle `openLedgerDatabase` hands out, and pass it here. `Client.login`
 * already satisfies {@link ExchangeBackend}; `session.test.ts` asserts that at
 * compile time. The device's writer id comes from `keys.ts`'s
 * `ensureWriterId(keychainSecretStore(), ulid)` and enrolment is
 * `Client.enroll(writerId)` — challenge, `registrationMessage`, strict base64,
 * all already implemented and tested in `client/src/net/client.ts`. Do not
 * write a second one.
 */
export function deviceSignInDeps(
  input: ExchangeBackend | null | { backend: ExchangeBackend; secrets: SecretStore } = null,
): SignInDeps {
  const backend = input !== null && typeof input === "object" && "backend" in input ? input.backend : input;
  const secrets = input !== null && typeof input === "object" && "secrets" in input ? input.secrets : keychainSecretStore();
  return {
    apple: appleAuthenticator(),
    google: googleAuthenticator(),
    backend,
    secrets,
    // One RNG for the whole app: `src/platform/index.ts` installs it over
    // `expo-crypto` before anything else runs, and `ulid`'s own detection was
    // pointed at it for exactly this reason.
    newNonce: () => newNonce((n) => platform().randomBytes(n)),
  };
}
