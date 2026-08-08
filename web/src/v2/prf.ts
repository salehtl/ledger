/**
 * Unlocking the account's keys with a passkey — Face ID, Touch ID or a security
 * key — instead of typing twelve words.
 *
 * # What this is
 *
 * A WebAuthn authenticator can compute a PRF: a 32-byte HMAC over a fixed salt,
 * under a secret it holds for one credential and never reveals. That output
 * seals a SECOND copy of the same key material the recovery phrase seals
 * (`client/src/crypto/prf.ts`), stored per credential in `user_key_wraps`. A
 * device that gets the output opens the wrap and holds the account's keys.
 *
 * # What it is not
 *
 * It is not a replacement for the recovery phrase, and no string in this product
 * may suggest it is. A PRF secret belongs to one authenticator: a passkey
 * deleted from a keychain takes it away, a security key can be lost or reset,
 * and an operating system can rotate a credential without asking. The server
 * holds nothing that would help — deliberately, because holding it would mean
 * the operator could open the account.
 *
 * So every function here degrades to the phrase and never to a locked account.
 * A browser with no PRF, an authenticator that refuses, an empty wrap list, a
 * wrap that no longer opens: all of them return "no" and leave the phrase path
 * exactly as it was.
 *
 * # Enrolment needs the recovery phrase, and that is not a wart
 *
 * A wrap has to be built from the raw key bytes, and after `installAccountKeys`
 * those bytes are gone: the DEK is a non-extractable `CryptoKey` and the
 * recovery seed was never stored at all. The only way to get them back on a
 * device that is already set up is to unwrap the published blob — with the
 * phrase. So turning this on asks for the phrase once, which also means nobody
 * can enable it on a stolen, already-unlocked phone.
 *
 * # Two prompts, once, at enrolment
 *
 * `create()` does not return a PRF output on Safari or iOS — it reports only
 * whether the extension is `enabled` — so enrolment creates the credential and
 * then immediately asserts with it to obtain the output. That is two biometric
 * prompts in a row, and the copy says so before it starts.
 *
 * # Feature detection is "try it and degrade"
 *
 * `getClientCapabilities()` is worth asking and is not an answer:
 * implementations disagree, and the ground truth is `prf.enabled` after a real
 * ceremony on a real authenticator. Nothing here promises PRF in advance.
 */

import { webPlatform } from "@ledger/client/platform.web";
import { unwrapAccountKeys, zero, type AccountKeys } from "@ledger/client/crypto/keys";
import { PRF_EVAL_SALT, PRF_WRAP_VERSION, unwrapPrfKeys, wrapPrfKeys } from "@ledger/client/crypto/prf";

import { addPasskey } from "./passkeyAdd";
import { classifyPasskeyFailure, PasskeyError } from "./session";
import {
  adoptAccountKeys,
  deleteKeyWrap,
  putKeyWrap,
  readKeyWraps,
  type KeyVault,
  type KeysIO,
  type PublishedKeys,
  type StoredKeys,
} from "./keys";

export interface PrfDeps {
  /** `handle.client` — read for its bearer token only. */
  client: { sessionToken: string | null };
  server?: string;
  fetch?: typeof fetch;
  credentials?: CredentialsContainer;
}

/** What a caller may believe BEFORE a ceremony has run. Never more than this. */
export type PrfAvailability =
  /** This browser has no WebAuthn, so there is nothing to try. */
  | "unsupported"
  /**
   * WebAuthn is here and whether PRF works is unknown until an authenticator
   * answers. This is the honest answer for almost every browser.
   */
  | "unknown";

/**
 * Whether it is worth offering to try.
 *
 * `getClientCapabilities` is consulted when it exists and is treated as a
 * NEGATIVE signal only: a browser that says it has no PRF extension is believed,
 * a browser that says it has one is still only "unknown", because the extension
 * being implemented says nothing about the authenticator the user will pick.
 */
export async function prfAvailability(deps: Pick<PrfDeps, "credentials"> = {}): Promise<PrfAvailability> {
  const credentials = deps.credentials ?? (typeof navigator === "undefined" ? undefined : navigator.credentials);
  if (credentials === undefined || typeof credentials.create !== "function" || typeof credentials.get !== "function") {
    return "unsupported";
  }
  const pk = (globalThis as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Record<string, boolean>> } })
    .PublicKeyCredential;
  if (pk !== undefined && typeof pk.getClientCapabilities === "function") {
    try {
      const caps = await pk.getClientCapabilities();
      if (caps["extension:prf"] === false) return "unsupported";
    } catch {
      // A capability query that throws tells us nothing, which is what
      // "unknown" already says.
    }
  }
  return "unknown";
}

/** A PRF ceremony that produced no unlock. Every kind of it ends at the recovery phrase. */
export type PrfFailureKind =
  /** This browser or this authenticator does not do PRF. Trying again will not change it. */
  | "no_prf"
  /** The prompt was dismissed. Nothing changed. */
  | "cancelled"
  /** The account has no wrap for the credential that answered. */
  | "no_wrap"
  /** A wrap that no longer opens — an authenticator whose PRF secret changed. */
  | "wrap_dead"
  /** Anything else: offline, a server refusal, a browser fault. */
  | "unavailable";

export class PrfError extends Error {
  readonly prfKind: PrfFailureKind;
  constructor(kind: PrfFailureKind, message: string, cause?: unknown) {
    super(message);
    this.name = "PrfError";
    this.prfKind = kind;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export function isPrfError(err: unknown): err is PrfError {
  return typeof err === "object" && err !== null && typeof (err as { prfKind?: unknown }).prfKind === "string";
}

/**
 * Adds a passkey that can unlock this account, and stores the wrap it opens.
 *
 * Order, and why: the phrase is spent first (a wrong phrase must not leave a
 * new passkey behind), then the credential is created, then it is asserted for
 * the PRF output, then the wrap is uploaded.
 *
 * `prf.enabled === false` after `create()` is a REFUSAL, not a silent skip: the
 * passkey exists and works for signing in, and the caller is told plainly that
 * it will not unlock anything so the person is not left believing it does.
 *
 * The raw key bytes are destroyed on every exit, including the failures.
 */
export async function enrolPrfUnlock(args: {
  deps: PrfDeps;
  published: PublishedKeys;
  /** The account's recovery phrase. The only way to reach the raw key bytes on a set-up device. */
  phrase: string;
}): Promise<{ credentialId: Uint8Array }> {
  const keys = await unwrapAccountKeys(args.phrase, args.published.wrapped, webPlatform);
  try {
    let created: PublicKeyCredential | null = null;
    const credentialId = await addPasskey({
      client: args.deps.client,
      ...(args.deps.server === undefined ? {} : { server: args.deps.server }),
      ...(args.deps.fetch === undefined ? {} : { fetch: args.deps.fetch }),
      // The PRF extension is added HERE, on the client, and never taken from
      // the server's options: `publicKeyCreationOptions` spreads the server's
      // JSON verbatim, so a server-sent `prf.eval.first` would arrive as a
      // string and be refused as a non-BufferSource. go-webauthn has no PRF
      // awareness at all and needs none — it passes extensions through.
      credentials: withCreateExtensions(args.deps, { prf: {} }, (cred) => {
        created = cred;
      }),
    });

    if (created === null) throw new PrfError("unavailable", "the browser returned no credential");
    if (extensionOf(created)?.enabled !== true) {
      throw new PrfError(
        "no_prf",
        "this passkey was added and can sign you in, but it cannot unlock ledger on this device",
      );
    }

    const rawId = webPlatform.fromBase64(credentialId);
    // The second prompt. Safari and iOS never return a PRF output from
    // `create()`, so the output has to come from an assertion — and it must be
    // THIS credential's, which is what `allowCredentials` pins.
    const output = await evaluatePrf(args.deps, [rawId]);
    if (output === null || !sameBytes(output.credentialId, rawId)) {
      throw new PrfError("no_prf", "this authenticator did not return an unlock secret");
    }

    const wrapped = await wrapPrfKeys(output.prf, keys, webPlatform);
    zero(output.prf);
    await putKeyWrap(ioOf(args.deps), { credentialId: rawId, wrapped, wrapVersion: PRF_WRAP_VERSION });
    return { credentialId: rawId };
  } finally {
    zero(keys.ingestPriv);
    zero(keys.dek);
    zero(keys.recoverySeed);
  }
}

/**
 * Unlocks this device's keys with a passkey, or reports why it could not.
 *
 * Returns `null` when the account has no wraps at all — the ordinary state, and
 * not a failure worth a message. Every other refusal is a {@link PrfError} whose
 * caller is expected to fall back to the phrase screen rather than to stop.
 *
 * A wrap whose credential answered but whose blob will not open is DELETED: the
 * authenticator's PRF secret changed, so that row can never open anything again,
 * and leaving it there would offer the same broken unlock forever. Nothing is
 * lost by removing it — the phrase opens the same keys.
 */
export async function unlockWithPrf(args: {
  deps: PrfDeps;
  accountId: string;
  published: PublishedKeys;
  vault: KeyVault;
  authorize?: (sign: (msg: Uint8Array) => Uint8Array) => Promise<void>;
}): Promise<StoredKeys | null> {
  const io = ioOf(args.deps);
  const wraps = await readKeyWraps(io);
  if (wraps.length === 0) return null;

  const output = await evaluatePrf(
    args.deps,
    wraps.map((w) => w.credentialId),
  );
  if (output === null) throw new PrfError("no_prf", "this authenticator did not return an unlock secret");

  const wrap = wraps.find((w) => sameBytes(w.credentialId, output.credentialId));
  if (wrap === undefined) {
    zero(output.prf);
    throw new PrfError("no_wrap", "that passkey does not unlock this account");
  }

  let keys: AccountKeys;
  try {
    keys = await unwrapPrfKeys(output.prf, wrap.wrapped, webPlatform);
  } catch (err) {
    // Dead, not wrong: this credential answered, and its secret no longer opens
    // its own wrap. Deleting it costs nothing and stops the app offering an
    // unlock that cannot work.
    await deleteKeyWrap(io, wrap.credentialId).catch(() => undefined);
    throw new PrfError("wrap_dead", "this passkey no longer unlocks ledger, so it has been removed", err);
  } finally {
    zero(output.prf);
  }

  return adoptAccountKeys({
    accountId: args.accountId,
    keys,
    published: args.published,
    vault: args.vault,
    ...(args.authorize === undefined ? {} : { authorize: args.authorize }),
  });
}

/** Removes one credential's wrap. The passkey itself is untouched and still signs in. */
export async function forgetPrfUnlock(deps: PrfDeps, credentialId: Uint8Array): Promise<void> {
  await deleteKeyWrap(ioOf(deps), credentialId);
}

/** The wraps this account holds, so a settings screen can say what is enrolled. */
export async function listPrfUnlocks(deps: PrfDeps): Promise<{ credentialId: Uint8Array }[]> {
  return (await readKeyWraps(ioOf(deps))).map((w) => ({ credentialId: w.credentialId }));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function ioOf(deps: PrfDeps): KeysIO {
  return {
    sessionToken: deps.client.sessionToken,
    ...(deps.server === undefined ? {} : { server: deps.server }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  };
}

interface PrfExtensionResults {
  enabled?: boolean;
  results?: { first?: unknown };
}

function extensionOf(cred: PublicKeyCredential): PrfExtensionResults | undefined {
  if (typeof cred.getClientExtensionResults !== "function") return undefined;
  return (cred.getClientExtensionResults() as unknown as { prf?: PrfExtensionResults }).prf;
}

/**
 * Runs an assertion for the PRF output alone, and returns the credential that
 * answered with it.
 *
 * No challenge from the server, and no response sent to one: this ceremony
 * establishes nothing and proves nothing to anybody. It exists to make an
 * authenticator compute a value locally. The challenge is fresh random bytes
 * because the API requires one; nothing verifies it, and nothing should read
 * this as authentication.
 */
async function evaluatePrf(
  deps: PrfDeps,
  allow: readonly Uint8Array[],
): Promise<{ credentialId: Uint8Array; prf: Uint8Array } | null> {
  const credentials = deps.credentials ?? (typeof navigator === "undefined" ? undefined : navigator.credentials);
  if (credentials === undefined || typeof credentials.get !== "function") {
    throw new PrfError("no_prf", "this browser does not support passkeys");
  }
  let cred: PublicKeyCredential | null;
  try {
    cred = (await credentials.get({
      publicKey: {
        challenge: bufferOf(webPlatform.randomBytes(32)),
        userVerification: "required",
        allowCredentials: allow.map((id) => ({ type: "public-key" as const, id: bufferOf(id) })),
        extensions: { prf: { eval: { first: bufferOf(PRF_EVAL_SALT) } } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
  } catch (err) {
    const failure = classifyPasskeyFailure(err);
    throw new PrfError(failure.passkeyKind === "cancelled" ? "cancelled" : "unavailable", failure.message, err);
  }
  if (cred === null) throw new PrfError("cancelled", "no passkey answered");

  const first = extensionOf(cred)?.results?.first;
  if (first === undefined || first === null) return null;
  return { credentialId: bytesOf(cred.rawId), prf: bytesOf(first) };
}

/**
 * A `CredentialsContainer` that adds `extensions` to a `create()` and reports
 * the credential it produced.
 *
 * A wrapper rather than a parameter on {@link addPasskey}: the add ceremony's
 * base64url conventions, its two routes and its failure taxonomy are exactly
 * what this needs to reuse, and PRF is the only caller that wants an extension.
 * Widening that function's signature would put a WebAuthn extension into a
 * module whose subject is enrolling a second passkey.
 */
function withCreateExtensions(
  deps: PrfDeps,
  extensions: Record<string, unknown>,
  onCreated: (cred: PublicKeyCredential) => void,
): CredentialsContainer {
  const inner = deps.credentials ?? (typeof navigator === "undefined" ? undefined : navigator.credentials);
  if (inner === undefined || typeof inner.create !== "function") {
    throw new PasskeyError("unsupported", "this browser does not support passkeys");
  }
  return {
    ...inner,
    create: async (options?: CredentialCreationOptions) => {
      const publicKey = {
        ...(options?.publicKey as object),
        extensions,
      } as unknown as PublicKeyCredentialCreationOptions;
      const cred = await inner.create({ ...options, publicKey });
      if (cred !== null) onCreated(cred as PublicKeyCredential);
      return cred;
    },
    get: inner.get.bind(inner),
    preventSilentAccess: inner.preventSilentAccess?.bind(inner) ?? (async () => undefined),
    store: inner.store?.bind(inner) ?? (async (c: Credential) => c),
  } as CredentialsContainer;
}

function bufferOf(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(b);
  return out;
}

function bytesOf(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new PrfError("unavailable", "the authenticator returned something that is not bytes");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
