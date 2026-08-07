/**
 * Boot, sign-up, sign-in, and the device-writer enrolment that both of them
 * must end with.
 *
 * This is the piece that ties the three browser adapters together:
 * `webPlatform` (the host primitives), `openBrowserDriver` (sql.js over
 * IndexedDB) and `Client` (the protocol). Nothing here reimplements the
 * protocol — {@link Client} still owns `/api/v1/writers/*` and every sync
 * route. What this file adds is the one surface `Client` deliberately does not
 * wrap, because a WebAuthn ceremony is two round trips with server-side state
 * in the middle and does not fit `login(idp, idToken)`'s signature.
 *
 * # Sign-in is USERNAME-LESS
 *
 * There is no email field, no username field, and no account picker in this
 * module, because there is nowhere to put one: `internal/v2/auth/passkey.go`
 * requires resident/discoverable credentials, so the authenticator returns the
 * account's user handle inside the signed assertion. The server learns whose
 * account is being signed into from bytes it verified, rather than from
 * anything the page typed. Adding a username field would not just be redundant,
 * it would be a field the server ignores.
 *
 * # The two halves of "signing in", and why both must land
 *
 * A session names the ACCOUNT. It does not make this device able to author
 * anything: that needs a writer enrolled on the roster with an Ed25519 key this
 * device holds. `Client.writerId` — read by every write path — throws
 * `"this device is not set up to make changes yet"` until that has happened.
 * Commit `8365532` fixed exactly that regression on the native client, so
 * {@link V2Handle.signUp} and {@link V2Handle.signIn} both end by calling
 * {@link ensureDeviceWriter}, and enrolment failures get their OWN error kind
 * ({@link EnrollmentError}) rather than being reported as a sign-in failure —
 * a user told "sign-in failed" after a successful sign-in has been told
 * something false.
 *
 * # base64url is not base64
 *
 * The server sends go-webauthn's own `protocol.CredentialCreation` /
 * `CredentialAssertion`, whose binary fields are `protocol.URLEncodedBase64`:
 * the **URL-safe** alphabet (`-`/`_`), unpadded. `webPlatform.toBase64` /
 * `fromBase64` are the **standard** alphabet (`+`/`/`), padded, and
 * `fromBase64` refuses anything else strictly — feeding it a base64url string
 * throws rather than silently decoding the wrong bytes. So the conversion is
 * explicit and one-directional in each place: {@link toBase64Url} /
 * {@link fromBase64Url} wrap those two helpers rather than being a second
 * hand-rolled codec. `enroll`'s own `pubkey`/`sig`/`nonce` stay STANDARD
 * base64, because that is what `internal/v2/api` uses for every binary field
 * of its own; the base64url only ever appears inside a WebAuthn payload.
 *
 * # How this module reaches `setPlatform` without breaking the bundle
 *
 * `setPlatform` comes from `@ledger/client/platform.registry` — a module with
 * no imports at all, holding the registry `platform.ts` used to hold and now
 * re-exports. That split exists because `platform.ts` statically imports
 * `node:zlib`/`node:crypto` for `bunPlatform`, and Vite externalizes a `node:`
 * builtin and then fails the build with `"gzipSync" is not exported by
 * "__vite-browser-external"`.
 *
 * The registry alone was not enough: nine modules under `client/src`
 * (`store/store.ts`, `net/client.ts`, `invariants/check.ts`,
 * `wire/{blob,chain,op}.ts`, `replay/audit.ts`, `norm/mime.ts`,
 * `diag/structure.ts`) also imported `../platform`, so ANY path to
 * `sqliteStore` or `Client` dragged it in — this module, and Task 3's
 * `store-conformance.test.ts` before it. They now import the registry too, and
 * a build with this module reachable from `main.tsx` produces a bundle with no
 * `node:` builtin and no `__vite-browser-external` in it.
 *
 * That repoint took the transitive `setPlatform(bunPlatform)` away from every
 * host process, so the install is now explicit where a program starts:
 * `cli/main.ts`, `store/open.ts`, and the host-only `store/file.ts` /
 * `store/driver.ts` (which is how the child programs `outbox.test.ts` and
 * `engine.test.ts` spawn get one), plus `client/test/preload.ts` for `bun test`.
 * The rule that falls out of it, and the one to keep: AN ENTRYPOINT INSTALLS
 * ITS PLATFORM. `app/src/platform/index.ts` does it for Hermes, `initV2` does
 * it here, and `client/`'s three host doors do it for Bun.
 *
 * # Where the secrets go
 *
 * `sqliteStore` requires a `SecretStore` and puts the session token and every
 * writer's private seed there instead of in the database. On a phone that is
 * the Keychain. A browser has no Keychain, so {@link webSecretStore} uses
 * `localStorage` — which is not a security boundary, and is not claimed to be
 * one. What it buys is the property the store's contract is actually about:
 * those two values never enter the SQLite bytes that get exported to IndexedDB
 * (and, in Phase 3, backed up). The key naming is
 * `client/src/store/sqlite.ts`'s `SECRET_SESSION` / `SECRET_WRITER`, imported
 * rather than re-spelled, and `writer_id` matches `app/src/auth/keys.ts`'s
 * {@link SECRET_WRITER_ID} — so a future native client and this PWA agree on
 * what a device's writer identity is called.
 */

import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";
import { ApiError, Client, NetworkError } from "@ledger/client/net/client";
import { SECRET_SESSION, SECRET_WRITER, sqliteStore } from "@ledger/client/store/sqlite";
import type { ClientState, SecretStore, Store } from "@ledger/client/store/store";
import type { Writer } from "@ledger/client/invariants/check";

import { openBrowserDriver } from "./db/driver";

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

const BASE64URL_STRICT = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url, as every binary field of a WebAuthn payload is. */
export function toBase64Url(b: Uint8Array): string {
  return webPlatform.toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The inverse, strictly.
 *
 * Three rejections, all of which a lenient decoder would turn into plausible
 * wrong bytes: the standard alphabet (`+`/`/`), explicit padding (`=` is never
 * emitted by `URLEncodedBase64` and its presence means this is not the encoding
 * we think it is), and a length ≡ 1 mod 4, which no base64 string can have.
 */
export function fromBase64Url(s: string): Uint8Array {
  if (!BASE64URL_STRICT.test(s) || s.length % 4 === 1) {
    throw new TypeError(`not unpadded base64url: ${JSON.stringify(s)}`);
  }
  const standard = s.replace(/-/g, "+").replace(/_/g, "/");
  return webPlatform.fromBase64(standard + "=".repeat((4 - (standard.length % 4)) % 4));
}

/**
 * Base64url (a WebAuthn field, and a JWK `x`) and standard base64 (this API's
 * own binary fields) compared as bytes — ported from
 * `app/src/auth/enrollment.ts`.
 */
function keyFingerprint(value: string): string {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return webPlatform.toHex(webPlatform.fromBase64(standard + "=".repeat((4 - (standard.length % 4)) % 4)));
}

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(b);
  return out;
}

function bufferToBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError("expected an ArrayBuffer from the authenticator");
}

// ---------------------------------------------------------------------------
// WebAuthn payload shaping
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asObject(v: unknown, what: string): Json {
  if (typeof v !== "object" || v === null) throw new TypeError(`${what} is not an object`);
  return v as Json;
}

function descriptors(v: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((raw) => {
    const d = asObject(raw, "a credential descriptor");
    return { ...d, id: toArrayBuffer(fromBase64Url(String(d["id"]))) } as unknown as PublicKeyCredentialDescriptor;
  });
}

/**
 * `protocol.CredentialCreation` → what `navigator.credentials.create` wants.
 *
 * Every field except the three binary ones is passed through UNTOUCHED. The
 * server marshals go-webauthn's structure verbatim precisely so the browser
 * consumes it verbatim; reshaping it here would be a second encoder to keep in
 * step with a specification neither side owns.
 */
export function publicKeyCreationOptions(raw: unknown): PublicKeyCredentialCreationOptions {
  const pk = asObject(asObject(raw, "creation options")["publicKey"], "creation options.publicKey");
  const user = asObject(pk["user"], "creation options.publicKey.user");
  const exclude = descriptors(pk["excludeCredentials"]);
  return {
    ...pk,
    challenge: toArrayBuffer(fromBase64Url(String(pk["challenge"]))),
    user: { ...user, id: toArrayBuffer(fromBase64Url(String(user["id"]))) },
    ...(exclude === undefined ? {} : { excludeCredentials: exclude }),
  } as unknown as PublicKeyCredentialCreationOptions;
}

/** `protocol.CredentialAssertion` → what `navigator.credentials.get` wants. */
export function publicKeyRequestOptions(raw: unknown): PublicKeyCredentialRequestOptions {
  const pk = asObject(asObject(raw, "assertion options")["publicKey"], "assertion options.publicKey");
  const allow = descriptors(pk["allowCredentials"]);
  return {
    ...pk,
    challenge: toArrayBuffer(fromBase64Url(String(pk["challenge"]))),
    ...(allow === undefined ? {} : { allowCredentials: allow }),
  } as unknown as PublicKeyCredentialRequestOptions;
}

/**
 * A registration credential as `protocol.ParseCredentialCreationResponseBytes`
 * reads it: `id`, `rawId`, `type`, `clientExtensionResults`, and a `response`
 * of `clientDataJSON` + `attestationObject`.
 *
 * `transports` is included when the authenticator reports them — go-webauthn
 * stores them on the credential, and they are what lets a later ceremony hint
 * "this one is on a security key" rather than making the user guess.
 */
export function encodeRegistrationCredential(cred: PublicKeyCredential): Json {
  const response = cred.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : undefined;
  return {
    id: cred.id,
    rawId: toBase64Url(bufferToBytes(cred.rawId)),
    type: cred.type,
    ...(typeof cred.authenticatorAttachment === "string" && cred.authenticatorAttachment !== ""
      ? { authenticatorAttachment: cred.authenticatorAttachment }
      : {}),
    clientExtensionResults: extensionResults(cred),
    response: {
      clientDataJSON: toBase64Url(bufferToBytes(response.clientDataJSON)),
      attestationObject: toBase64Url(bufferToBytes(response.attestationObject)),
      ...(transports === undefined || transports.length === 0 ? {} : { transports }),
    },
  };
}

/**
 * An assertion as `protocol.ParseCredentialRequestResponseBytes` reads it.
 *
 * `userHandle` is the whole mechanism of a username-less sign-in — it is what
 * `ValidateDiscoverableLogin` resolves the account from — so it is carried
 * whenever the authenticator returned one, and omitted rather than sent as an
 * empty string when it did not.
 */
export function encodeAssertionCredential(cred: PublicKeyCredential): Json {
  const response = cred.response as AuthenticatorAssertionResponse;
  const handle = response.userHandle;
  return {
    id: cred.id,
    rawId: toBase64Url(bufferToBytes(cred.rawId)),
    type: cred.type,
    ...(typeof cred.authenticatorAttachment === "string" && cred.authenticatorAttachment !== ""
      ? { authenticatorAttachment: cred.authenticatorAttachment }
      : {}),
    clientExtensionResults: extensionResults(cred),
    response: {
      clientDataJSON: toBase64Url(bufferToBytes(response.clientDataJSON)),
      authenticatorData: toBase64Url(bufferToBytes(response.authenticatorData)),
      signature: toBase64Url(bufferToBytes(response.signature)),
      ...(handle === null || handle === undefined ? {} : { userHandle: toBase64Url(bufferToBytes(handle)) }),
    },
  };
}

function extensionResults(cred: PublicKeyCredential): Json {
  return typeof cred.getClientExtensionResults === "function"
    ? (cred.getClientExtensionResults() as unknown as Json)
    : {};
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type PasskeyFailureKind =
  /** This browser has no WebAuthn at all. Retrying will never help. */
  | "unsupported"
  /** The system prompt was dismissed. Nothing was sent. */
  | "cancelled"
  /** `403 not_invited` — the deployment's policy, not the credential's fault. */
  | "not_invited"
  /** The one 401: expired, replayed, unknown credential, bad signature. */
  | "rejected"
  | "rate_limited"
  /** No HTTP answer at all. */
  | "offline"
  | "unavailable";

/**
 * A passkey ceremony that did not establish a session.
 *
 * Matched STRUCTURALLY by {@link isPasskeyError}, for the reason
 * `app/src/auth/session.ts` gives: a bundler that ends up with two copies of a
 * module makes `instanceof` fail silently, and in the wrong direction.
 * `status`/`code` are copied off the cause so a caller can still see the
 * server's own answer.
 */
export class PasskeyError extends Error {
  readonly passkeyKind: PasskeyFailureKind;
  readonly status?: number;
  readonly code?: string;

  constructor(kind: PasskeyFailureKind, message: string, cause?: unknown) {
    super(message);
    this.name = "PasskeyError";
    this.passkeyKind = kind;
    const http = httpShape(cause);
    if (http !== null) {
      this.status = http.status;
      this.code = http.code;
    }
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export function isPasskeyError(err: unknown): err is PasskeyError {
  return typeof err === "object" && err !== null && typeof (err as { passkeyKind?: unknown }).passkeyKind === "string";
}

function httpShape(err: unknown): { status: number; code: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e.status !== "number") return null;
  return { status: e.status, code: typeof e.code === "string" ? e.code : "" };
}

/** Puts a ceremony failure into one of the buckets a screen knows how to say. */
export function classifyPasskeyFailure(err: unknown): PasskeyError {
  if (isPasskeyError(err)) return err;
  // The two names a browser uses when the user dismissed the sheet, the
  // authenticator refused, or the ceremony timed out. `NotAllowedError` is
  // deliberately not read as a rejection: the spec makes it the catch-all
  // precisely so a page cannot tell those apart, and calling it "rejected"
  // would put a security-sounding sentence in front of somebody who simply
  // tapped Cancel.
  const name = typeof err === "object" && err !== null ? String((err as { name?: unknown }).name ?? "") : "";
  if (name === "NotAllowedError" || name === "AbortError") {
    return new PasskeyError("cancelled", "the passkey prompt was dismissed", err);
  }
  if (err instanceof NetworkError) return new PasskeyError("offline", err.message, err);
  const http = httpShape(err);
  if (http === null) {
    const detail = err instanceof Error ? err.message : String(err);
    return new PasskeyError(/network|fetch|timeout|connect/i.test(detail) ? "offline" : "unavailable", detail, err);
  }
  const detail = err instanceof Error ? err.message : `${http.status} ${http.code}`;
  if (http.status === 403 && http.code === "not_invited") return new PasskeyError("not_invited", detail, err);
  if (http.status === 401) return new PasskeyError("rejected", detail, err);
  if (http.status === 429) return new PasskeyError("rate_limited", detail, err);
  return new PasskeyError("unavailable", detail, err);
}

export type EnrollmentKind = "offline" | "unavailable" | "rate_limited" | "rejected" | "revoked" | "key_lost";

/**
 * A failure of ENROLMENT, as opposed to of the session — ported from
 * `app/src/auth/enrollment.ts`. Its own class because the two halves of
 * "signing in" fail differently, and the session half already succeeded.
 */
export class EnrollmentError extends Error {
  readonly enrollmentKind: EnrollmentKind;
  readonly status?: number;
  readonly code?: string;

  constructor(kind: EnrollmentKind, message: string, cause?: unknown) {
    super(message);
    this.name = "EnrollmentError";
    this.enrollmentKind = kind;
    const http = httpShape(cause);
    if (http !== null) {
      this.status = http.status;
      this.code = http.code;
    }
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export function isEnrollmentError(err: unknown): err is EnrollmentError {
  return (
    typeof err === "object" && err !== null && typeof (err as { enrollmentKind?: unknown }).enrollmentKind === "string"
  );
}

/** `401`/`410` are the session's business and travel unwrapped. */
function isSessionFailure(err: unknown): boolean {
  const http = httpShape(err);
  return http !== null && (http.status === 401 || http.status === 410);
}

function classifyEnrollment(err: unknown): EnrollmentError {
  const http = httpShape(err);
  if (http === null) {
    const detail = err instanceof Error ? err.message : String(err);
    return err instanceof NetworkError || /network|fetch|timeout|connect/i.test(detail)
      ? new EnrollmentError("offline", detail, err)
      : new EnrollmentError("unavailable", detail, err);
  }
  if (http.status === 429) return new EnrollmentError("rate_limited", `${http.status} ${http.code}`, err);
  if (http.status === 403) return new EnrollmentError("rejected", `${http.status} ${http.code}`, err);
  return new EnrollmentError("unavailable", `${http.status} ${http.code}`, err);
}

// ---------------------------------------------------------------------------
// The browser secret store
// ---------------------------------------------------------------------------

/** This install's writer id. Not secret; kept beside the key it names. */
export const SECRET_WRITER_ID = "writer_id";

/**
 * A {@link SecretStore} over `localStorage`, namespaced by the driver name so
 * two databases in one origin cannot read each other's session.
 *
 * Falls back to a module-scoped `Map` when `localStorage` is unavailable or
 * throws (Safari private browsing, a storage-disabled embed) — the same shape,
 * and the same honesty, as the driver's IndexedDB fallback: an ephemeral
 * session is better than an unopenable app, and nothing here pretends the
 * fallback persists.
 */
const memorySecrets = new Map<string, string>();

export function webSecretStore(namespace: string): SecretStore {
  const prefix = `ledger-v2:${namespace}:`;
  const usable = ((): boolean => {
    try {
      const probe = `${prefix}__probe`;
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  })();
  return {
    get(name: string): string | null {
      if (!usable) return memorySecrets.get(prefix + name) ?? null;
      try {
        return localStorage.getItem(prefix + name);
      } catch {
        return memorySecrets.get(prefix + name) ?? null;
      }
    },
    set(name: string, value: string | null): void {
      try {
        if (!usable) throw new Error("localStorage unusable");
        if (value === null) localStorage.removeItem(prefix + name);
        else localStorage.setItem(prefix + name, value);
      } catch {
        if (value === null) memorySecrets.delete(prefix + name);
        else memorySecrets.set(prefix + name, value);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Device-writer enrolment (ported from app/src/auth/{keys,enrollment}.ts)
// ---------------------------------------------------------------------------

/** Mirrors `writers_writer_id_charset` and `auth.validWriterID`. */
export function isValidWriterId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(id);
}

/**
 * This install's writer id, minted once and kept forever.
 *
 * Written BEFORE it is returned: an id used to enrol and then lost to a killed
 * tab is a writer the server knows and this device can never sign for again. A
 * stored id that no longer satisfies the charset is a REFUSAL, not a re-mint —
 * re-minting silently abandons an enrolled writer.
 */
export function ensureWriterId(secrets: SecretStore, mint: () => string): string {
  const held = secrets.get(SECRET_WRITER_ID);
  if (held !== null && held !== "") {
    if (!isValidWriterId(held)) {
      throw new Error(
        `the stored writer id ${JSON.stringify(held.slice(0, 80))} is not a legal writer id; ` +
          `the server would refuse it, and re-minting one would abandon an enrolled writer`,
      );
    }
    return held;
  }
  const minted = mint();
  if (!isValidWriterId(minted)) throw new Error(`minted writer id ${JSON.stringify(minted)} is not a legal writer id`);
  secrets.set(SECRET_WRITER_ID, minted);
  return minted;
}

type RosterEntry = Writer & { pubkey?: string };

export interface EnrollmentDeps {
  secrets: SecretStore;
  /** `Store.load()` — the persisted client state, not the folded projection. */
  state: () => Pick<ClientState, "writerId" | "writers">;
  client: {
    roster(): Promise<readonly RosterEntry[]>;
    enroll(writerId: string): Promise<void>;
    useWriter(writerId: string): void;
  };
  mint: () => string;
}

export type EnrollmentStatus = "already" | "adopted" | "enrolled";

/**
 * Makes sure this device can author, and returns what it had to do.
 *
 * Guarded three deep, and none of the guards is derived from the thing it
 * checks: the id is minted once and persisted, the fast path is "already
 * selected AND holding the seed" (no network call, which is what makes calling
 * this after every sign-in free), and when the fast path misses it is the
 * SERVER'S roster that decides — closing the window where a tab died between
 * the server's 204 and `Client.enroll`'s commit, which re-registering would
 * turn into a permanent 403.
 */
export async function ensureDeviceWriter(
  deps: EnrollmentDeps,
): Promise<{ status: EnrollmentStatus; writerId: string }> {
  const writerId = ensureWriterId(deps.secrets, deps.mint);

  const st = deps.state();
  const local = st.writers.get(writerId);
  const seed = deps.secrets.get(`${SECRET_WRITER}${writerId}`);
  const holdsKey = local !== undefined && seed !== null && seed !== "";
  if (st.writerId === writerId && holdsKey) return { status: "already", writerId };

  let roster: readonly RosterEntry[];
  try {
    roster = await deps.client.roster();
  } catch (error) {
    if (isSessionFailure(error)) throw error;
    throw classifyEnrollment(error);
  }

  const entry = roster.find((w) => w.writer_id === writerId);
  if (entry !== undefined) {
    if (entry.revoked_at !== null) {
      throw new EnrollmentError("revoked", `writer ${writerId} is revoked on the server`);
    }
    if (local === undefined) {
      throw new EnrollmentError("key_lost", `the server knows writer ${writerId} and this device holds no key for it`);
    }
    if (entry.pubkey !== undefined && entry.pubkey !== "" && keyFingerprint(entry.pubkey) !== keyFingerprint(local.x)) {
      throw new EnrollmentError(
        "key_lost",
        `writer ${writerId} is enrolled with a different public key than this device holds`,
      );
    }
    deps.client.useWriter(writerId);
    return { status: "adopted", writerId };
  }

  try {
    await deps.client.enroll(writerId);
  } catch (error) {
    if (isSessionFailure(error)) throw error;
    throw classifyEnrollment(error);
  }
  return { status: "enrolled", writerId };
}

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

type BrowserDriver = Awaited<ReturnType<typeof openBrowserDriver>>;

export interface V2Handle {
  /**
   * The protocol client. A GETTER, because signing in rebuilds it: the session
   * is persisted through the {@link Store} and a `Client` reads its state once,
   * in its constructor, so the instance that ran the ceremony would otherwise
   * keep answering `userId === null` afterwards.
   */
  readonly client: Client;
  readonly driver: BrowserDriver;
  /** Whether this device holds a session token. */
  signedIn(): boolean;
  /** Creates an account against an unredeemed invite code, then enrols. */
  signUp(inviteCode: string): Promise<void>;
  /** Username-less discoverable sign-in, then enrols. */
  signIn(): Promise<void>;
  /**
   * Makes sure this device can author, and does nothing when it already can.
   *
   * {@link signUp} and {@link signIn} both end by calling this, so on the happy
   * path nobody else has to. It is exposed because the happy path is not the
   * only one: `ceremony` persists the session (`adoptSession`) BEFORE it
   * enrols, so a network drop in between leaves a device with
   * `signedIn() === true` and no writer — a state in which every write throws
   * `"this device is not set up to make changes yet"` and which nothing else
   * repairs. That is commit `8365532`'s regression one step removed, and the
   * repair is the same one `app/src/app/bootstrap.ts` performs: call this at
   * every boot, before the first sync and before anything that could author.
   *
   * Free on the already-enrolled path — {@link ensureDeviceWriter}'s fast path
   * makes no network call — which is what makes an unconditional call at every
   * launch the right shape. The alternative, "enrol only when signing in",
   * leaves every device that signed in before this existed permanently unable
   * to write.
   *
   * Throws {@link EnrollmentError}, except for `401`/`410`, which are the
   * session's business and travel unwrapped.
   */
  enrol(): Promise<void>;
  signOut(): Promise<void>;
  close(): void;
}

export interface InitV2Options {
  /** The IndexedDB database name AND the secret-store namespace. */
  name?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to `navigator.credentials`. */
  credentials?: CredentialsContainer;
  /** Injected for tests; defaults to {@link webSecretStore} over `name`. */
  secrets?: SecretStore;
}

interface SessionResponse {
  session_token: string;
  user_id: string;
}

interface BeginResponse {
  ceremony_id: string;
  options: unknown;
}

/**
 * One call at boot.
 *
 * `setPlatform(webPlatform)` runs FIRST and unconditionally: every module under
 * `client/src` reaches the host through that registry, and the driver's very
 * first `sqliteStore` call can already touch it. It is idempotent — the
 * registry is a single mutable slot — so a second `initV2` (a test, a second
 * profile) re-installs the same object rather than racing.
 */
export async function initV2(server: string, opts: InitV2Options = {}): Promise<V2Handle> {
  setPlatform(webPlatform);

  const name = opts.name ?? "ledger";
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const secrets = opts.secrets ?? webSecretStore(name);
  const driver = await openBrowserDriver(name);
  const store: Store = sqliteStore(driver, { secrets, server });

  const build = (): Client => new Client({ store, server, fetch: doFetch });
  let client = build();

  const credentials = (): CredentialsContainer => {
    const c = opts.credentials ?? (typeof navigator === "undefined" ? undefined : navigator.credentials);
    if (c === undefined || typeof c.create !== "function" || typeof c.get !== "function") {
      throw new PasskeyError("unsupported", "this browser does not support passkeys");
    }
    return c;
  };

  /**
   * The passkey ceremony transport.
   *
   * Deliberately NOT a second protocol client: `Client` wraps every route it
   * owns and these six are not among them (a ceremony does not fit
   * `login(idp, idToken)`). The error taxonomy is `Client`'s own —
   * {@link ApiError} and {@link NetworkError} — so `classifyPasskeyFailure`
   * reads the same shapes whether the failure came from here or from `enroll`.
   */
  const post = async <T,>(path: string, body: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${server}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new NetworkError(`POST ${path}: ${err instanceof Error ? err.message : String(err)}`, err);
    }
    const text = await res.text();
    if (!res.ok) {
      let code = "";
      let detail = "";
      try {
        const e = JSON.parse(text) as { error?: string; detail?: string };
        code = e.error ?? "";
        detail = e.detail ?? "";
      } catch {
        detail = text.slice(0, 200);
      }
      throw new ApiError(res.status, code, detail, `POST ${path}: ${res.status} ${code}`);
    }
    if (res.status === 204 || text === "") return undefined as T;
    return JSON.parse(text) as T;
  };

  /**
   * Persists the session the way `Client.login` does — the same two fields,
   * committed through the same {@link Store} — and carries `login`'s refusal to
   * bind one profile to a second account: two accounts in one database would
   * mix their cursors and pinned heads, and I4 would then fail on every row of
   * whichever one lost.
   */
  const adoptSession = (out: SessionResponse): void => {
    const st = store.load();
    if (st.userId !== null && st.userId !== out.user_id) {
      throw new Error(
        `this device is bound to user ${st.userId} and the server returned ${out.user_id}; ` +
          `sign out before signing in as a different account`,
      );
    }
    st.userId = out.user_id;
    st.sessionToken = out.session_token;
    store.save(st);
    client = build();
  };

  /**
   * The load-bearing half. Both sign-in paths end here, and an enrolment
   * failure is raised as an {@link EnrollmentError} — never swallowed, because
   * a session without a writer is an app whose every write throws.
   */
  const enrolThisDevice = async (): Promise<void> => {
    await ensureDeviceWriter({
      secrets,
      state: () => store.load(),
      client: {
        roster: () => client.roster(),
        enroll: (writerId) => client.enroll(writerId),
        useWriter: (writerId) => {
          client.useWriter(writerId);
        },
      },
      mint: () => `web-${webPlatform.randomUUID()}`,
    });
  };

  const ceremony = async (
    beginPath: string,
    beginBody: unknown,
    run: (options: unknown, credentials: CredentialsContainer) => Promise<Json>,
    finishPath: string,
  ): Promise<void> => {
    let out: SessionResponse;
    try {
      const c = credentials();
      const begin = await post<BeginResponse>(beginPath, beginBody);
      const credential = await run(begin.options, c);
      out = await post<SessionResponse>(finishPath, { ceremony_id: begin.ceremony_id, credential });
    } catch (err) {
      throw classifyPasskeyFailure(err);
    }
    adoptSession(out);
    await enrolThisDevice();
  };

  return {
    get client(): Client {
      return client;
    },
    driver,

    signedIn(): boolean {
      // An empty string counts as absent: a `SecretStore` may clear by writing
      // one where its backing store has no synchronous delete.
      const token = secrets.get(SECRET_SESSION);
      return token !== null && token !== "";
    },

    async signUp(inviteCode: string): Promise<void> {
      await ceremony(
        "/api/v1/auth/passkey/register/begin",
        { invite_code: inviteCode },
        async (options, c) => {
          const cred = await c.create({ publicKey: publicKeyCreationOptions(options) });
          if (cred === null) throw new PasskeyError("cancelled", "no credential was created");
          return encodeRegistrationCredential(cred as PublicKeyCredential);
        },
        "/api/v1/auth/passkey/register/finish",
      );
    },

    async signIn(): Promise<void> {
      // The begin body is `{}` and carries nothing at all — no email, no
      // username, no account hint. See this module's doc.
      await ceremony(
        "/api/v1/auth/passkey/login/begin",
        {},
        async (options, c) => {
          const cred = await c.get({ publicKey: publicKeyRequestOptions(options) });
          if (cred === null) throw new PasskeyError("cancelled", "no credential was returned");
          return encodeAssertionCredential(cred as PublicKeyCredential);
        },
        "/api/v1/auth/passkey/login/finish",
      );
    },

    enrol: enrolThisDevice,

    async signOut(): Promise<void> {
      // The bearer token and NOTHING else. This is not the account-deleted
      // wipe: the op log, the projection and the writer key all stay, so
      // signing back in on this device does not have to re-enrol or re-sync.
      const st = store.load();
      st.sessionToken = null;
      store.save(st);
      client = build();
      await driver.flush();
    },

    close(): void {
      driver.close();
    },
  };
}
