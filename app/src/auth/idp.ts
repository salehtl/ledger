/**
 * The identity-provider layer, with every decision in it kept **pure**.
 *
 * `app/src/auth/native.ts` is the only file in this directory that imports a
 * native module. Everything that can be got wrong — which scopes are asked
 * for, what a nonce is, what shape the provider's `nonce` claim comes back in,
 * how a Google client id becomes a redirect URI — lives here, where `bun test`
 * runs it on this box. That split is the same one `src/platform/` already
 * makes, and for the same reason: there is no Mac, no simulator and no device
 * here, so anything that can only be exercised on a phone is a thing that
 * ships unexercised.
 *
 * # The nonce, which is the point of this file
 *
 * `POST /api/v1/auth/exchange` binds **no** nonce today, deliberately and with
 * the reasoning written out at `internal/v2/api/sync.go`'s `handleExchange`:
 * a nonce the *caller* chose, compared against a value the *caller* supplied,
 * is not a check. Binding it needs server-side state created before the token
 * existed, and sign-in has no such store (the address-rotation and
 * account-deletion paths do, and they use it).
 *
 * The client passes one anyway, so the day that store lands the server can
 * begin enforcing without a client change. That makes the *encoding* of the
 * nonce a compatibility surface right now even though nothing checks it yet:
 * `newNonce` produces exactly the shape `POST /api/v1/address/challenge`
 * already hands out — standard base64 of 32 random bytes — so the same
 * `authenticate(idp, nonce)` call serves a locally minted sign-in nonce and a
 * server-issued re-authentication challenge with no second code path.
 *
 * There is deliberately no `serverNonceSource()` helper here. The re-auth
 * screens (address rotation, account deletion) do not exist yet, and a helper
 * written for a caller that does not exist is the "written, tested green,
 * never wired" defect this project has paid for six times. The seam those
 * screens need is the `nonce` **parameter** below, which already exists.
 *
 * # Apple hashes the nonce and Google does not — and the server compares raw
 *
 * See {@link expectedNonceClaim}. This is the one place in the client that
 * knows the two providers disagree, and {@link APPLE_REAUTH_GAP} records what
 * that costs on the re-auth paths as of this commit.
 */

import { sha256 } from "../platform/hash.ts";
import { fromBase64, toBase64, toHex, utf8Decode, utf8Encode } from "../platform/bytes.ts";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * The two provider ids, spelled exactly as the server spells them
 * (`internal/v2/auth/idp.go:70-71`). `handleExchange` answers `400 bad_request`
 * — not a 401 — for a provider it does not know, precisely so a spelling
 * mistake here does not send a client into a re-authentication loop against a
 * provider that will never be accepted. It would still be a shipped bug, so
 * the literals are pinned by a test rather than trusted.
 */
export const IDP_APPLE = "apple";
export const IDP_GOOGLE = "google";

export type Idp = typeof IDP_APPLE | typeof IDP_GOOGLE;

/**
 * Identity scopes only, per spec §3.8.
 *
 * **No Gmail data scope, ever.** A scope like
 * `https://www.googleapis.com/auth/gmail.readonly` is "restricted" in Google's
 * classification, which drags the project into OAuth verification and a CASA
 * security assessment — a months-long process for an app whose entire mail
 * path is inbound SMTP and needs no API access to anyone's mailbox. The
 * product reads mail because the user *forwards* it, not because it holds a
 * token to their account, and that is a design property worth protecting with
 * a test.
 *
 * Apple's equivalent is not a scope string in the token request — the native
 * flow takes `AppleAuthenticationScope.FULL_NAME | EMAIL` — so the OIDC
 * spelling here is what a Services-ID web leg would send and what the shape
 * test measures. `native.ts` maps it to the native enum.
 */
export const SCOPES: Readonly<Record<Idp, readonly string[]>> = {
  [IDP_APPLE]: ["openid", "email", "name"],
  [IDP_GOOGLE]: ["openid", "email", "profile"],
};

// ---------------------------------------------------------------------------
// Nonces
// ---------------------------------------------------------------------------

/** How many random bytes a nonce carries. Matches `auth.Writers.Challenge`. */
export const NONCE_BYTES = 32;

/**
 * A fresh nonce, in the encoding the server's challenge endpoints already use:
 * **standard base64 of 32 random bytes**.
 *
 * The encoding is not cosmetic. `handleAddressRotate` canonicalises the nonce
 * it was given (`base64.StdEncoding.EncodeToString(decoded)`) and passes that
 * exact string as `VerifyOpts.Nonce`, so the string a provider is asked to
 * echo has to be that spelling and not, say, base64url or hex. Minting
 * sign-in's nonce the same way means one code path serves both.
 */
export function newNonce(randomBytes: (n: number) => Uint8Array): string {
  const b = randomBytes(NONCE_BYTES);
  if (b.length !== NONCE_BYTES) {
    throw new Error(`nonce source returned ${b.length} bytes, and a nonce is ${NONCE_BYTES}`);
  }
  return toBase64(b);
}

/** The shape a provider's `nonce` claim came back in. */
export type NonceShape = "raw" | "sha256hex" | "other";

/**
 * What the ID token's `nonce` claim will contain, given the nonce we sent.
 *
 * **Apple hashes it; Google does not.** For native Sign in with Apple the
 * claim is the lower-case hex SHA-256 of the value handed to
 * `AppleAuthentication.signInAsync({ nonce })`; Google echoes the `nonce`
 * authorize parameter verbatim.
 *
 * # The server agrees, and this is the shape both sides implement
 *
 * This used to be a live defect and is recorded here because the shape of the
 * agreement is the thing worth keeping. `internal/v2/auth/idp.go` compared
 * `opts.Nonce` against the claim with **no per-provider branch** while
 * `api/addresses.go` bound the raw challenge, so an Apple re-authentication
 * presented `hex(sha256(C))` where the server expected `C` and could never
 * match — no client can produce a raw nonce whose SHA-256 is a value someone
 * else chose. Apple accounts could not rotate an inbound address at all.
 *
 * **The client was not the place to fix it and did not try.** Relaxing this
 * check to make a client test pass is the failure mode the plan names
 * explicitly (Task 13 Step 2). The fix is `auth.nonceClaimFor` on the server:
 * one branch, inside the verifier, keyed on the provider the verifier was
 * CONSTRUCTED for and never on anything in the token — `hex(sha256(issued))`
 * for Apple, `issued` for Google, and deliberately not "either", which would
 * let a Google token satisfy an Apple challenge.
 *
 * The two implementations are checked against each other by pinning the same
 * published SHA-256 vector on both sides: `"abc"` →
 * `ba7816bf…f20015ad`, asserted below and in
 * `internal/v2/auth/idp_test.go`'s `TestNonceClaimIsComparedPerProvider`.
 * {@link APPLE_REAUTH_GAP} states the rule in a form a test can assert.
 */
export function expectedNonceClaim(idp: Idp, nonce: string): string {
  return idp === IDP_APPLE ? toHex(sha256(utf8Encode(nonce))) : nonce;
}

/**
 * The per-provider rule above, as a value, so a test can pin it.
 *
 * It is deliberately no longer phrased as a limitation a screen would render:
 * the server hashes per provider now, so a string telling a user that Apple
 * cannot rotate an address would be a lie shipped in the UI. The name is kept
 * because it is what the fix is filed under on both sides.
 */
export const APPLE_REAUTH_GAP =
  "Apple's nonce claim is the SHA-256 of what it was given and Google's is the value itself, " +
  "so the server compares a re-authentication challenge per provider (auth.nonceClaimFor): " +
  "hex(SHA-256(challenge)) for Apple, the challenge for Google, and never either-or";

/**
 * Which of the two shapes a claim is, **measured** rather than assumed.
 *
 * This exists because the client cannot run on a phone here. If Apple's native
 * flow ever embeds the value verbatim instead of hashing it — the two readings
 * of Apple's documentation that circulate differ on exactly this — then
 * `"raw"` comes back for Apple and the first device log says so in one word.
 * Guessing wrong in silence is what this function is for.
 */
export function observedNonceShape(nonce: string, claim: unknown): NonceShape {
  if (typeof claim !== "string") return "other";
  if (claim === nonce) return "raw";
  if (claim === toHex(sha256(utf8Encode(nonce)))) return "sha256hex";
  return "other";
}

// ---------------------------------------------------------------------------
// ID tokens
// ---------------------------------------------------------------------------

/**
 * The cap `internal/v2/auth/idp.go`'s `maxIDTokenBytes` uses (16 KiB). Real
 * Apple and Google tokens are ~1 KB. Mirrored rather than invented so a token
 * this client is willing to look at is a token the server is willing to look
 * at.
 */
export const MAX_ID_TOKEN_BYTES = 16 << 10;

/** The token was not a compact JWS this client is willing to look at. */
export class IdTokenShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdTokenShapeError";
  }
}

/** The provider's `nonce` claim is not the one we asked for. */
export class NonceMismatchError extends Error {
  constructor(
    readonly idp: Idp,
    readonly shape: NonceShape,
    message: string,
  ) {
    super(message);
    this.name = "NonceMismatchError";
  }
}

/**
 * The payload of a compact JWS, decoded **without verifying anything**.
 *
 * # This is not verification and must never be used as if it were
 *
 * There is no signature check here, no issuer check, no audience check and no
 * expiry check. `internal/v2/auth` does all of that against Apple's and
 * Google's published key sets, and it is the only thing entitled to say who a
 * token belongs to. Two uses are legitimate for an unverified read:
 *
 *  - comparing the `nonce` claim against a nonce **this process generated**,
 *    which is a check on our own bookkeeping and not on the token; and
 *  - showing the signed-in address on screen after the server has already
 *    accepted the token.
 *
 * Nothing else. In particular a `sub` read here may not be used to key
 * anything, ever.
 *
 * The bounds are the reason this is hand-written rather than a two-line split:
 * an ID token is attacker-supplied the moment anything other than the provider
 * SDK can reach this function, so the size cap, the segment count and the
 * base64url charset are all checked before `JSON.parse` sees a byte.
 */
export function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  if (idToken.length > MAX_ID_TOKEN_BYTES) {
    throw new IdTokenShapeError(`id token is ${idToken.length} bytes, cap is ${MAX_ID_TOKEN_BYTES}`);
  }
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new IdTokenShapeError(`id token has ${parts.length} segments, a compact JWS has 3`);
  }
  const payload = parts[1] as string;
  if (payload === "" || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new IdTokenShapeError("id token payload is not unpadded base64url");
  }
  let json: string;
  try {
    json = utf8Decode(base64urlDecode(payload));
  } catch (e) {
    throw new IdTokenShapeError(`id token payload does not decode: ${String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new IdTokenShapeError("id token payload is not JSON");
  }
  // `typeof null === "object"`, and an array is an object too. Both would sail
  // through a bare typeof check and then read `claims.nonce` as `undefined`,
  // which `observedNonceShape` would report as `"other"` — a mismatch blamed
  // on the provider instead of on the parse.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IdTokenShapeError("id token payload is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Unpadded base64url → bytes, via the strict standard-base64 decoder. */
function base64urlDecode(s: string): Uint8Array {
  const std = s.replaceAll("-", "+").replaceAll("_", "/");
  const rem = std.length % 4;
  if (rem === 1) throw new IdTokenShapeError("base64url segment has an impossible length");
  return fromBase64(rem === 0 ? std : std + "=".repeat(4 - rem));
}

/**
 * Decodes the token and checks that its `nonce` claim is the one we asked for,
 * in the shape that provider uses.
 *
 * The mismatch is raised **here**, on the device, rather than being left to
 * come back as an opaque 401 from the exchange: a nonce mismatch means the
 * response belongs to a different authorize call than the one this screen
 * started, which is the one local failure that a user pressing the button
 * again will genuinely fix.
 */
export function checkNonceClaim(idp: Idp, nonce: string, idToken: string): Record<string, unknown> {
  const claims = decodeIdTokenClaims(idToken);
  const got = claims["nonce"];
  const want = expectedNonceClaim(idp, nonce);
  if (got !== want) {
    const shape = observedNonceShape(nonce, got);
    throw new NonceMismatchError(
      idp,
      shape,
      `${idp}: the id token's nonce claim is not the nonce this sign-in issued ` +
        `(observed shape: ${shape}; expected ${idp === IDP_APPLE ? "sha256hex" : "raw"})`,
    );
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Google's iOS client id — deliberately absent
// ---------------------------------------------------------------------------

/**
 * The Google iOS OAuth client id, **deliberately `null`**.
 *
 * `docs/superpowers/NEEDS-SALEH.md` §1b: the client id is portal work nobody
 * here can do, and its *reversed* form has to be registered as a
 * `CFBundleURLTypes` scheme in `app.json` or the browser has nothing to come
 * back to. A plausible-looking placeholder in either place builds, installs,
 * launches and passes every test — and fails at the single moment a user taps
 * "Sign in with Google". So both are absent, and `idp.test.ts` asserts they
 * are absent *together*: filling one without the other fails a test on this
 * box rather than a tap on a phone.
 *
 * When it arrives it looks like `123456-abcdef.apps.googleusercontent.com`.
 */
export const GOOGLE_IOS_CLIENT_ID: string | null = null;

/** Google's iOS OAuth endpoints. Pinned rather than discovered at runtime. */
export const GOOGLE_DISCOVERY = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
} as const;

const GOOGLE_CLIENT_SUFFIX = ".apps.googleusercontent.com";

/** Google is not configured in this build. Raised early, never at tap time. */
export class GoogleNotConfiguredError extends Error {
  constructor() {
    super(
      "this build has no Google iOS OAuth client id: create one bound to the app's bundle " +
        "identifier, set GOOGLE_IOS_CLIENT_ID in app/src/auth/idp.ts, and add its reversed form " +
        "to app.json as a CFBundleURLTypes scheme (NEEDS-SALEH.md §1b)",
    );
  }
}

/**
 * `123-abc.apps.googleusercontent.com` → `com.googleusercontent.apps.123-abc`.
 *
 * Google's iOS clients redirect to a custom scheme that is the client id with
 * its two halves swapped. Deriving it rather than storing it separately means
 * the URL scheme in `app.json` and the client id here cannot drift into
 * disagreeing — which is a failure that only shows up as a browser that never
 * returns.
 */
export function reversedClientId(clientId: string): string {
  if (!clientId.endsWith(GOOGLE_CLIENT_SUFFIX) || clientId.length === GOOGLE_CLIENT_SUFFIX.length) {
    throw new Error(`${JSON.stringify(clientId)} is not a Google client id (expected …${GOOGLE_CLIENT_SUFFIX})`);
  }
  return `com.googleusercontent.apps.${clientId.slice(0, -GOOGLE_CLIENT_SUFFIX.length)}`;
}

/**
 * The redirect URI for a Google iOS client: the reversed client id as a
 * scheme, one slash, a path. Google's own documented form for installed apps.
 */
export function googleRedirectUri(clientId: string): string {
  return `${reversedClientId(clientId)}:/oauth2redirect`;
}

/**
 * Google's configuration, or `null` when this build has none.
 *
 * Callers branch on `null` **before** rendering a button, so an unconfigured
 * build says so on the screen instead of throwing under the user's thumb.
 */
export function googleConfig(): { clientId: string; redirectUri: string; scopes: readonly string[] } | null {
  const id = GOOGLE_IOS_CLIENT_ID;
  if (id === null) return null;
  return { clientId: id, redirectUri: googleRedirectUri(id), scopes: SCOPES[IDP_GOOGLE] };
}

// ---------------------------------------------------------------------------
// The authenticator seam
// ---------------------------------------------------------------------------

/** What a provider hands back once the user has approved. */
export interface IdpCredential {
  idToken: string;
  /** Present on a first sign-in only, and never trusted for anything. */
  email: string | null;
}

/**
 * One provider's native flow, behind a seam.
 *
 * The `nonce` is a **parameter** rather than something the implementation
 * mints, which is the whole compatibility story: sign-in passes a locally
 * minted one today, and the re-auth screens will pass the server's challenge
 * unchanged when they exist. Neither the implementations nor this interface
 * change on that day.
 */
export interface IdpAuthenticator {
  readonly idp: Idp;
  /** `null` when the provider is unusable on this device or in this build. */
  isAvailable(): Promise<boolean>;
  authenticate(nonce: string): Promise<IdpCredential>;
}

/** The user dismissed the provider's sheet. Not an error to show as one. */
export class UserCancelledError extends Error {
  constructor(readonly idp: Idp) {
    super(`${idp}: sign-in was cancelled`);
    this.name = "UserCancelledError";
  }
}

/** A completed provider round trip, with the nonce it was bound to. */
export interface SignedInIdentity {
  idp: Idp;
  idToken: string;
  nonce: string;
  email: string | null;
}

/**
 * Runs one provider's flow and checks the nonce came back bound.
 *
 * The email is taken from the **credential** when the provider gave one and
 * from the token's claims otherwise, because Apple returns the address exactly
 * once — on the very first authorization for an App ID — and returns `null`
 * every time after. A screen that only read the credential would show an
 * address on first launch and nothing on the second, which reads as data loss.
 */
export async function runIdpFlow(auth: IdpAuthenticator, nonce: string): Promise<SignedInIdentity> {
  const cred = await auth.authenticate(nonce);
  const claims = checkNonceClaim(auth.idp, nonce, cred.idToken);
  const claimed = claims["email"];
  return {
    idp: auth.idp,
    idToken: cred.idToken,
    nonce,
    email: cred.email ?? (typeof claimed === "string" ? claimed : null),
  };
}
