/**
 * The inbound address on the wire: read it, and rotate it.
 *
 * # One fetch, not two
 *
 * `AppRuntime.onboardingFacts()` used to perform its own `GET /api/v1/address`
 * inline. That read is now {@link addressSource}`.current()` and the runtime
 * calls it, so the app has exactly one place that knows the endpoint, one place
 * that decodes the response and one place that classifies its errors. A second
 * copy is not a style problem here: the two would drift on the error shape, and
 * the error shape is what decides whether a device wipes itself.
 *
 * # The error shape IS the behaviour
 *
 * `bootstrap.classify` keys the local wipe on `410 account_deleted` and the
 * sign-out on a bare `401`, and it reads `status` **and** `code` off the thrown
 * error (`auth/session.ts`'s `mayWipeLocalData`). The inline fetch threw
 * `{status, code: ""}` - a hard-coded empty code - so a `410 account_deleted`
 * from this endpoint classified as neither, and a launch on a device whose
 * account had been deleted elsewhere ended at "Ledger could not safely open
 * this account" with every local row still on disk. This module throws
 * {@link ApiError}, which carries the server's own code, so that path resolves.
 *
 * # Rotation is the three-factor path, and factor 3 is signed here
 *
 * `POST /api/v1/address/challenge` then IdP re-authentication carrying that
 * exact nonce, then an Ed25519 signature by this device's enrolled key over
 * {@link rotationMessage}, then `POST /api/v1/address/rotate`. The account
 * deletion path in `deletion.ts` is the same shape and the same three factors;
 * spec 3.4 puts them in one class deliberately.
 */

import { ApiError, NetworkError } from "@ledger/client/net/client.ts";
import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import type { SecretStore } from "@ledger/client/store/store.ts";

import type { IdpAuthenticator } from "../auth/idp.ts";
import { SECRET_WRITER_ID } from "../auth/keys.ts";
import { decodeAddress, type AddressRecord } from "../lib/address.ts";
import { fromBase64, toBase64, utf8Encode } from "../platform/bytes.ts";
import { ed25519Sign } from "../platform/signing.ts";

// ---------------------------------------------------------------------------
// The signed statement
// ---------------------------------------------------------------------------

const NUL = String.fromCharCode(0);
const ROTATION_DOMAIN = utf8Encode(`ledger-v2-address-rotation${NUL}`);

/**
 * The exact bytes `addresses.RotationMessage` builds, and nothing else:
 *
 *   "ledger-v2-address-rotation" NUL nonce NUL userID NUL localPart
 *
 * Go exports its half "to stop the two drifting silently"; this is the other
 * half, and `address.test.ts` pins it against the byte sequence spelled out in
 * that comment.
 *
 * `localPart` is the local part of the address being **retired**, which is what
 * binds a captured signature to one specific cutover.
 */
export function rotationMessage(nonce: Uint8Array, userId: string, localPart: string): Uint8Array {
  if (nonce.length !== 32) throw new Error(`rotation nonce is ${nonce.length} bytes, want 32`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("user id is not a UUID");
  }
  if (localPart === "" || localPart.includes("@")) throw new Error("local part is not a bare local part");
  const id = utf8Encode(userId.toLowerCase());
  const local = utf8Encode(localPart);
  const out = new Uint8Array(ROTATION_DOMAIN.length + nonce.length + 1 + id.length + 1 + local.length);
  let o = 0;
  out.set(ROTATION_DOMAIN, o); o += ROTATION_DOMAIN.length;
  out.set(nonce, o); o += nonce.length;
  out[o] = 0; o += 1;
  out.set(id, o); o += id.length;
  out[o] = 0; o += 1;
  out.set(local, o);
  return out;
}

/**
 * The local part of an address.
 *
 * `lastIndexOf` rather than a split: the local part of an inbound address is
 * base32 and contains no `@`, so the last one is the separator, and a name that
 * somehow contained one would otherwise be silently truncated into a signature
 * over the wrong statement.
 */
export function localPartOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) throw new Error(`address ${JSON.stringify(address)} has no local part`);
  return address.slice(0, at);
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

export type AddressFetch = (request: Request) => Promise<Response>;

export interface AddressSourceOptions {
  server: string;
  token: () => string | null;
  fetch?: AddressFetch;
}

export interface AddressSource {
  /** `GET /api/v1/address`. Mints on first read, server-side. */
  current(): Promise<AddressRecord>;
}

async function call(opts: AddressSourceOptions, method: string, path: string, body?: unknown): Promise<unknown> {
  const token = opts.token();
  if (token === null || token.trim() === "") throw new Error("not signed in");
  const doFetch = opts.fetch ?? ((request: Request) => fetch(request));
  let response: Response;
  try {
    response = await doFetch(new Request(new URL(path, opts.server), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  } catch (cause) {
    throw new NetworkError(`address request failed: ${method} ${path}`, cause);
  }
  const doc = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof doc["error"] === "string" ? doc["error"] : "http_error",
      typeof doc["detail"] === "string" ? doc["detail"] : "",
      `address request failed: ${response.status}`,
    );
  }
  return doc;
}

export function addressSource(opts: AddressSourceOptions): AddressSource {
  return {
    async current() {
      return decodeAddress(await call(opts, "GET", "/api/v1/address"));
    },
  };
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export interface RotateAddressOptions extends AddressSourceOptions {
  /** The account the session names. The signature binds it. */
  userId: () => string | null;
  secrets: SecretStore;
  /** Factor 2: fresh IdP re-authentication carrying the server's own nonce. */
  authenticator: IdpAuthenticator;
  /** The address being retired. Read from the server when omitted. */
  currentAddress?: string;
}

/**
 * Runs the whole three-factor rotation and returns the NEW address record.
 *
 * Everything it returns comes from the server's answer - including
 * `rotates_from` and `grace_until`. Nothing here reconstructs a predecessor
 * chain from what it knew a moment ago: `Predecessor` is one hop server-side
 * (`addresses.go:291`), and a client that stitched successive answers together
 * would present a deadline for an address whose real deadline it never saw.
 */
export async function rotateAddress(opts: RotateAddressOptions): Promise<AddressRecord> {
  const userId = opts.userId();
  if (userId === null || userId === "") throw new Error("address rotation requires a known account");
  const writerId = opts.secrets.get(SECRET_WRITER_ID);
  if (writerId === null || writerId === "") throw new Error("address rotation requires an enrolled device key");
  const seed = opts.secrets.get(`${SECRET_WRITER}${writerId}`);
  if (seed === null || seed === "") throw new Error("this device's signing key is unavailable");
  // The session is not a factor here beyond naming the account, but it is what
  // `call` attaches, so an absent one fails before any provider UI appears.
  if (opts.secrets.get(SECRET_SESSION) === null) throw new Error("not signed in");

  const retiring = opts.currentAddress ?? (await addressSource(opts).current()).address;
  const localPart = localPartOf(retiring);

  const challenge = await call(opts, "POST", "/api/v1/address/challenge", {}) as Record<string, unknown>;
  const nonceB64 = challenge["nonce"];
  if (typeof nonceB64 !== "string" || nonceB64 === "") throw new Error("address challenge returned no nonce");
  const nonce = fromBase64(nonceB64);
  if (nonce.length !== 32) throw new Error("address challenge nonce is not 32 bytes");

  // The provider is handed the server's spelling of the nonce verbatim. The
  // server re-encodes the decoded bytes canonically before comparing, so a
  // round trip through this client cannot change what it checks.
  const credential = await opts.authenticator.authenticate(nonceB64);
  const sig = toBase64(ed25519Sign(fromBase64(seed), rotationMessage(nonce, userId, localPart)));

  return decodeAddress(await call(opts, "POST", "/api/v1/address/rotate", {
    idp: opts.authenticator.idp,
    id_token: credential.idToken,
    nonce: nonceB64,
    sig,
  }));
}

/**
 * What to say when a rotation fails, keyed on the server's own code.
 *
 * `403 rotation_rejected` is the ONE rejection the endpoint emits and it is
 * deliberately undifferentiated - a stale nonce, an unenrolled key and a token
 * naming another account are byte-identical. The copy therefore lists what to
 * try rather than pretending to know which one happened, and it says plainly
 * that nothing changed, because the failure mode a user fears here is a
 * half-rotation.
 */
export function rotationFailureCopy(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0;
  const code = error instanceof ApiError ? error.code : "";
  if (status === 403 || code === "rotation_rejected") {
    return "Your address was not changed. ledger could not confirm both the sign-in and this device's key. Sign in again and retry; if it keeps failing, this device's key may need re-enrolling.";
  }
  if (status === 429) return "Your address was not changed. Too many attempts, wait a minute and try again.";
  if (status === 409 || code === "no_address") return "There is no address to change yet. Finish setting up your inbound address first.";
  if (status === 503) return "Your address was not changed. The sign-in provider is unavailable right now.";
  if (status === 401) return "Your sign-in expired before anything changed. Your address is unchanged. Sign in again and retry.";
  return "Your address was not changed.";
}
