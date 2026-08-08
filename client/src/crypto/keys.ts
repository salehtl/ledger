/**
 * The account's key material, and the blob that wraps it under the recovery
 * phrase.
 *
 * # What an account holds
 *
 * Three keys, minted once, on the device, at onboarding:
 *
 *   - **An X25519 ingest keypair.** The PUBLIC half is published to the server,
 *     which seals incoming bank mail to it (Phase 3 Task 2, in `encv2.go`'s
 *     envelope). The private half is what makes that mail readable, and the
 *     server never sees it.
 *   - **An AES-256-GCM data key (the DEK).** Client-authored op blobs are sealed
 *     under it (Task 3). It is symmetric because the client holds it: there is
 *     no need for a per-record ephemeral when the writer and the reader are the
 *     same key holder.
 *   - **An Ed25519 recovery authorizer.** Its public half is published, and
 *     `auth.Writers.Register` accepts its signature as an alternative to a
 *     signature by an already-enrolled device. See below.
 *
 * The first two are separate because they answer to different parties. The
 * server must be able to write to the account without being able to read it,
 * which is what an asymmetric ingest key buys; the client's own writes have no
 * such requirement and would pay 32 bytes per record for nothing.
 *
 * # The recovery authorizer, and the dead end it removes
 *
 * Task 1's first round proved that a browser with cleared site data recovers its
 * keys from the phrase and can READ again. It could not WRITE: the device
 * writer's Ed25519 identity key lived in the database that was cleared, the
 * account's one TOFU self-approval was spent by the original device, and
 * `Writers.Register` accepts only a signature by an already-enrolled device. A
 * one-device user who cleared their browser was therefore permanently
 * read-only — with their recovery phrase in their hand.
 *
 * The fix is this key, and the shape of it matters:
 *
 *   - **It is still a cryptographic proof of possession, not a session token.**
 *     The server holds only the public half and cannot mint a signature under
 *     it; a stolen session is exactly as useless as it was before.
 *   - **It does not reopen the TOFU bootstrap.** `hadDevice`'s
 *     one-self-signature-ever rule is untouched. This is an ADDITIONAL
 *     authorised signer, not a second chance at the first one.
 *   - **It is derived from the phrase and is never stored.** Unlike the other
 *     two it does not become a `CryptoKey` handle in IndexedDB: it is needed for
 *     the few milliseconds of one enrolment and nowhere else, so keeping it
 *     would be custody of a capability with no reason to persist. A device that
 *     needs it again unwraps the blob again.
 *   - **Its use is visible.** The enrolment it authorises is written to
 *     key_history as `recovery_registered`, a distinct event from `registered`,
 *     so a peer device auditing the log — and the cross-device comparison code,
 *     which hashes the event string — sees that a recovery happened.
 *
 * The window to add it was narrow and is the reason it is here rather than in a
 * later task: publication is write-once by design (409, no DELETE, no rotation
 * path), so the moment any account publishes a key set, adding a key to the body
 * is unreachable without building a re-keying path Phase 3 deliberately does not
 * have. No account had published when this landed.
 *
 * **This module does not seal anything but the keys themselves.** Task 1 changes
 * no data path — at the end of it the system still stores plaintext and simply
 * has keys and a working recovery phrase.
 *
 * # The wrapped blob
 *
 *     [1B version][1B kdf][4B m KiB, BE][1B t][1B p][16B salt][12B nonce][sealed]
 *
 * `sealed` is AES-256-GCM over
 * `[1B key set version][32B x25519 private][32B DEK][32B ed25519 recovery seed]`,
 * 97 bytes plus a 16-byte tag, under a key Argon2id derives from the phrase.
 * 149 bytes in total, and it is what the server stores.
 *
 * **The whole header is the AEAD's associated data**, not a prefix it merely
 * sits in front of. The parameters are the reason: an attacker holding the blob
 * who could rewrite `m` from 64 MiB down to 8 KiB would turn a memory-hard
 * derivation into a trivially searchable one and the wrap would still open. With
 * the header authenticated, editing a single parameter byte makes the blob
 * refuse to open at all. (This is the same argument `blob.go` makes for binding
 * the cleartext header rather than the embedded AAD alone, and it costs the same
 * here: nothing.)
 *
 * The **public** key is not in the blob. It is derived from the private half on
 * unwrap, so there is no way for the two to disagree — a stored public key that
 * had been tampered with would be a key the client believed the server was
 * sealing to and was not.
 *
 * # Argon2id, and these parameters
 *
 * The phrase carries 128 bits from `randomBytes`, and against that a KDF's work
 * factor is arithmetically irrelevant: nobody searches 2^128 whatever it costs
 * per guess. So the honest reason for a memory-hard KDF here is **not** password
 * stretching. It is that the wrapped blob is offline-attackable by anyone who
 * gets a copy of the database, forever, and the assumption it rests on —
 * "our 128 bits really were 128 bits" — is exactly the assumption that has
 * failed in real products, through a seeded RNG, a truncated draw or a platform
 * bug. Argon2id is what turns "the entropy was actually 40 bits" from
 * catastrophic into merely bad, and it costs one second, once.
 *
 * m = 64 MiB, t = 3, p = 1 exceeds every configuration OWASP recommends. p = 1
 * because the implementation is single-threaded JavaScript, so lanes buy no wall
 * clock and only cost it. Measured with the shipped build: ~0.9 s in Chromium
 * and ~1.1 s in Bun on the development machine, which puts a mid-range phone at
 * a few seconds — paid twice in the life of an account, on a screen that says
 * what it is doing.
 *
 * HKDF was the alternative the plan named. It is the *correct* KDF for a
 * high-entropy secret and it is what this would use if the phrase's entropy were
 * beyond question. It is not: see the paragraph above.
 *
 * The Argon2id password is the **normalized phrase's UTF-8 bytes**, not BIP-39's
 * PBKDF2 seed. BIP-39's seed derivation exists to serve BIP-32 wallets and adds
 * 2048 PBKDF2 rounds that are worth nothing next to Argon2id; taking the words
 * directly means there is one derivation to state and one to get right.
 *
 * # Everything here takes its platform as an argument
 *
 * The seam, never a host primitive: `platform.aead.ts` and `platform.argon2.ts`
 * carry the two primitives WebCrypto and `node:crypto` could not both provide
 * synchronously, and passing the seam in is what lets `keys.test.ts` check that
 * a blob wrapped by one host opens on the other in a single expression.
 */

import type { Platform } from "../platform";
import { AES_NONCE_BYTES, AES_TAG_BYTES } from "../platform.aead";
import { PhraseError, normalizePhrase, validatePhrase } from "./phrase";

/** The envelope version. Bumped only by a format change, never by a parameter change. */
export const ACCOUNT_KEY_VERSION = 1;

/**
 * The version byte inside the sealed body, so the key SET can grow
 * independently of the envelope.
 *
 * **Version 1 is not accepted, and there is nothing to migrate.** It carried
 * two keys and no recovery authorizer, and it existed for the length of one
 * unreleased commit — no account ever published one, which is exactly why the
 * authorizer could be added at all (publication is write-once). Reading a shape
 * nothing ever wrote would be untested code on the recovery path, so a body
 * that is not version 2 is refused by name.
 */
export const KEY_SET_VERSION = 2;

/** The only KDF identifier this build writes or accepts. */
export const KDF_ARGON2ID = 1;

const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** `[version][kdf][m:4][t][p][salt:16][nonce:12]`. */
export const WRAPPED_HEADER_BYTES = 1 + 1 + 4 + 1 + 1 + SALT_BYTES + AES_NONCE_BYTES;

/** `[key set version][x25519 private][dek][ed25519 recovery seed]`. */
const BODY_BYTES = 1 + KEY_BYTES + KEY_BYTES + KEY_BYTES;

/**
 * What the server's column admits. Generous against the 149 bytes this build
 * writes — 117 before the recovery authorizer joined the key set — so a later
 * key set fits, and finite so a malformed upload is refused at the edge rather
 * than stored.
 */
export const MAX_WRAPPED_BYTES = 4096;

/**
 * The shipped KDF cost. See the header for why these numbers and not others;
 * `keys.test.ts` pins them so a change is a deliberate edit rather than a drift.
 */
export const WRAP_KDF_PARAMS = { t: 3, m: 65536, p: 1 } as const;

/**
 * The largest memory cost this build will ATTEMPT, in KiB. A blob is
 * attacker-influenced: without a ceiling, a rewritten `m` of 4 GiB is a tab that
 * allocates until the browser kills it, which is a denial of service dressed as
 * a recovery attempt. 1 GiB is far above anything this product will ever write
 * and far below anything that hangs a phone silently.
 */
const MAX_KDF_MEMORY_KIB = 1024 * 1024;

/**
 * The AEAD's domain separator. Not stored — it is a constant of this format —
 * but it is the first thing in the associated data, so a blob from this
 * envelope can never be opened as, or mistaken for, one from another.
 *
 * Written as `\x00` rather than as a literal NUL: git classifies a file
 * containing one as binary and prints no diff for it, which has hidden whole
 * modules from review on this branch before.
 */
const WRAP_DOMAIN = "ledger-v2-account-keys\x00";

/** The account's keys, unwrapped. The private halves are raw bytes HERE and nowhere else — see `web/src/v2/keys.ts`. */
export interface AccountKeys {
  /** X25519, 32 bytes. Never leaves the device except inside a wrapped blob. */
  ingestPriv: Uint8Array;
  /** X25519, 32 bytes. Published. Derived from `ingestPriv`, never stored beside it. */
  ingestPub: Uint8Array;
  /** AES-256-GCM, 32 bytes. */
  dek: Uint8Array;
  /**
   * Ed25519 seed, 32 bytes — the recovery authorizer's private half.
   *
   * **Never stored on the device.** It lives for the duration of one enrolment
   * and is zeroed; a device that needs it again unwraps the blob again. See the
   * module header.
   */
  recoverySeed: Uint8Array;
  /** Ed25519 public, 32 bytes. Published. Derived from `recoverySeed`, never carried beside it. */
  recoveryPub: Uint8Array;
}

/** A blob that will not open, in any of the ways that is possible. */
export class WrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrapError";
  }
}

/** Mints an account's keys. Pure but for the platform's randomness. */
export function generateAccountKeys(p: Platform): AccountKeys {
  const { priv, pub } = p.x25519GenerateKey();
  const recovery = p.ed25519GenerateKey();
  return {
    ingestPriv: priv,
    ingestPub: pub,
    dek: p.randomBytes(KEY_BYTES),
    recoverySeed: recovery.priv,
    recoveryPub: recovery.pub,
  };
}

/** Overridable KDF cost, for tests that do not care what it cost. */
export interface WrapOptions {
  t?: number;
  m?: number;
  p?: number;
}

/**
 * Wraps `keys` under `phrase`.
 *
 * The phrase is VALIDATED first, and a phrase that is not one this product
 * produced is refused rather than wrapped under: a blob keyed by a mistyped
 * phrase is a blob nobody can ever open, and it would be written to the server
 * looking exactly like a good one.
 */
export async function wrapAccountKeys(
  phrase: string,
  keys: AccountKeys,
  p: Platform,
  opts: WrapOptions = {},
): Promise<Uint8Array> {
  const verdict = validatePhrase(phrase, p);
  if (!verdict.ok) throw new PhraseError(verdict.message);
  if (keys.ingestPriv.length !== KEY_BYTES || keys.dek.length !== KEY_BYTES || keys.recoverySeed.length !== KEY_BYTES) {
    throw new WrapError(`account keys must be ${KEY_BYTES} bytes each`);
  }

  const t = opts.t ?? WRAP_KDF_PARAMS.t;
  const m = opts.m ?? WRAP_KDF_PARAMS.m;
  const lanes = opts.p ?? WRAP_KDF_PARAMS.p;
  const salt = p.randomBytes(SALT_BYTES);
  const nonce = p.randomBytes(AES_NONCE_BYTES);

  const header = encodeHeader({ version: ACCOUNT_KEY_VERSION, kdf: KDF_ARGON2ID, t, m, p: lanes }, salt, nonce);
  const wrapKey = deriveWrapKey(verdict.phrase, salt, { t, m, p: lanes }, p);

  const body = new Uint8Array(BODY_BYTES);
  body[0] = KEY_SET_VERSION;
  body.set(keys.ingestPriv, 1);
  body.set(keys.dek, 1 + KEY_BYTES);
  body.set(keys.recoverySeed, 1 + KEY_BYTES * 2);

  const sealed = await p.aesGcmSeal(wrapKey, nonce, aadFor(header, p), body);
  zero(body);
  zero(wrapKey);

  const out = new Uint8Array(header.length + sealed.length);
  out.set(header, 0);
  out.set(sealed, header.length);
  return out;
}

/**
 * Opens a wrapped blob, or throws a {@link WrapError}.
 *
 * The phrase is NOT validated first here, and that asymmetry with
 * {@link wrapAccountKeys} is deliberate: a recovering user's phrase is checked
 * by the screen before it gets this far (`validatePhrase` names the wrong word,
 * which this cannot), and a blob that refuses a well-formed phrase is a
 * different fact from a phrase that is malformed. Both surface as a refusal,
 * neither as wrong key material.
 */
export async function unwrapAccountKeys(phrase: string, blob: Uint8Array, p: Platform): Promise<AccountKeys> {
  const params = wrappedBlobParams(blob);
  const salt = blob.subarray(8, 8 + SALT_BYTES);
  const nonce = blob.subarray(8 + SALT_BYTES, WRAPPED_HEADER_BYTES);
  const sealed = blob.subarray(WRAPPED_HEADER_BYTES);
  if (sealed.length !== BODY_BYTES + AES_TAG_BYTES) {
    throw new WrapError(
      `a wrapped key blob's sealed part is ${BODY_BYTES + AES_TAG_BYTES} bytes, and this one is ${sealed.length}`,
    );
  }

  const wrapKey = deriveWrapKey(normalizePhrase(phrase), salt, params, p);
  let body: Uint8Array;
  try {
    body = await p.aesGcmOpen(wrapKey, nonce, aadFor(blob.subarray(0, WRAPPED_HEADER_BYTES), p), sealed);
  } catch {
    // One message for every way this can fail — a wrong phrase, a corrupted
    // blob, a rewritten header. They are the same fact to the caller, and
    // telling them apart would be an oracle over the phrase.
    throw new WrapError("that recovery phrase does not open these keys");
  } finally {
    zero(wrapKey);
  }

  if (body.length !== BODY_BYTES || body[0] !== KEY_SET_VERSION) {
    zero(body);
    throw new WrapError(`this blob holds key set version ${body[0]}, which this build does not know how to use`);
  }
  const ingestPriv = body.slice(1, 1 + KEY_BYTES);
  const dek = body.slice(1 + KEY_BYTES, 1 + KEY_BYTES * 2);
  const recoverySeed = body.slice(1 + KEY_BYTES * 2);
  zero(body);
  // Both public halves are DERIVED, never carried: see the header. A stored
  // public key that had been tampered with would be a key the client believed
  // something else was using and it was not.
  return {
    ingestPriv,
    ingestPub: p.x25519PublicKey(ingestPriv),
    dek,
    recoverySeed,
    recoveryPub: p.ed25519PublicKey(recoverySeed),
  };
}

/** The declared envelope version, KDF and cost — readable without the phrase, because the server and the UI both need them. */
export function wrappedBlobParams(blob: Uint8Array): {
  version: number;
  kdf: number;
  t: number;
  m: number;
  p: number;
} {
  if (blob.length < WRAPPED_HEADER_BYTES) {
    throw new WrapError(`a wrapped key blob is at least ${WRAPPED_HEADER_BYTES} bytes, and this one is ${blob.length}`);
  }
  if (blob.length > MAX_WRAPPED_BYTES) {
    throw new WrapError(`a wrapped key blob is at most ${MAX_WRAPPED_BYTES} bytes, and this one is ${blob.length}`);
  }
  const version = blob[0]!;
  if (version !== ACCOUNT_KEY_VERSION) {
    // Named rather than tolerated: an unknown newer version is the one case
    // where guessing is worse than stopping, which is the rule the sync
    // protocol's hard stop already follows.
    throw new WrapError(`this wrapped key blob is version ${version}, and this build only knows version ${ACCOUNT_KEY_VERSION}`);
  }
  const kdf = blob[1]!;
  if (kdf !== KDF_ARGON2ID) {
    throw new WrapError(`this wrapped key blob names key derivation function ${kdf}, which this build does not have`);
  }
  const m = (blob[2]! << 24) | (blob[3]! << 16) | (blob[4]! << 8) | blob[5]!;
  const t = blob[6]!;
  const p = blob[7]!;
  if (m <= 0 || m > MAX_KDF_MEMORY_KIB) {
    throw new WrapError(`this wrapped key blob asks for ${m} KiB of memory, which this build refuses to allocate`);
  }
  if (t <= 0 || p <= 0) throw new WrapError("this wrapped key blob declares a key derivation cost of zero");
  return { version, kdf, t, m, p };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function encodeHeader(
  h: { version: number; kdf: number; t: number; m: number; p: number },
  salt: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  if (h.m > 0xffffffff || h.t > 0xff || h.p > 0xff) throw new WrapError("key derivation cost does not fit the envelope");
  const out = new Uint8Array(WRAPPED_HEADER_BYTES);
  out[0] = h.version;
  out[1] = h.kdf;
  out[2] = (h.m >>> 24) & 0xff;
  out[3] = (h.m >>> 16) & 0xff;
  out[4] = (h.m >>> 8) & 0xff;
  out[5] = h.m & 0xff;
  out[6] = h.t;
  out[7] = h.p;
  out.set(salt, 8);
  out.set(nonce, 8 + SALT_BYTES);
  return out;
}

/** Domain separator || header. See the module header for why the header is authenticated. */
function aadFor(header: Uint8Array, p: Platform): Uint8Array {
  const domain = p.utf8Encode(WRAP_DOMAIN);
  const out = new Uint8Array(domain.length + header.length);
  out.set(domain, 0);
  out.set(header, domain.length);
  return out;
}

function deriveWrapKey(
  normalizedPhrase: string,
  salt: Uint8Array,
  cost: { t: number; m: number; p: number },
  p: Platform,
): Uint8Array {
  return p.argon2id(p.utf8Encode(normalizedPhrase), salt, { t: cost.t, m: cost.m, p: cost.p, dkLen: KEY_BYTES });
}

/**
 * Overwrites a buffer that held key material.
 *
 * It is not a guarantee — a JavaScript engine may have copied the bytes during a
 * GC move and nothing here can reach that copy — and it is still worth doing:
 * it bounds how long the live buffer holds a key, which is what a heap snapshot
 * taken from a devtools session actually sees.
 */
export function zero(b: Uint8Array): void {
  b.fill(0);
}
