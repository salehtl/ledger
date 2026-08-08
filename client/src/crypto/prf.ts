/**
 * A second wrap of the SAME account keys, sealed under a WebAuthn PRF output —
 * what makes Face ID, Touch ID or a security key an alternative to typing
 * twelve words.
 *
 * # What this is, and what it is not
 *
 * It is a CONVENIENCE LAYER over `keys.ts`'s key set, never a replacement for
 * the recovery phrase. A PRF output belongs to one credential, not to a person:
 * a passkey deleted from a keychain takes its PRF secret with it, a security key
 * can be lost or reset, and an operating system can rotate a credential without
 * asking. The server holds nothing that would help in any of those cases —
 * deliberately, because holding it would mean the operator could open the
 * account. So the phrase stays mandatory and unconditional, and every wrap here
 * is disposable: losing one costs nothing but convenience.
 *
 * That also decides the direction the code has to fail in. A missing PRF, a
 * refused ceremony, an authenticator that returns nothing and a wrap that will
 * not open must all end at the phrase, never at a locked account.
 *
 * # The envelope
 *
 *     [1B version=1][1B kdf=2 (HKDF-SHA-256)][32B salt][12B nonce][sealed]
 *
 * `sealed` is AES-256-GCM over the identical 97-byte body `keys.ts` seals —
 * `[1B key set version][32B x25519 private][32B DEK][32B ed25519 recovery seed]`
 * — produced by the same {@link encodeKeyBody}, so the two wraps provably carry
 * the same bytes and a device that opened either has the same key set.
 *
 * It is a SIBLING of the phrase envelope and never an extension of it. The
 * published `wrapped_keys` column is write-once (`internal/v2/api/keys.go`
 * compares byte for byte and 409s on any difference, with no UPDATE and no
 * DELETE), so appending a second wrap to it is unreachable for any account that
 * has already published — and relaxing that comparison would reopen the
 * accidental-rekey hazard it exists to prevent. These blobs live in their own
 * table, keyed by credential.
 *
 * **The whole header is the AEAD's associated data**, on the same argument
 * `keys.ts` makes: a header a holder of the blob can rewrite is a header that
 * decides how the key is derived. Rewriting one byte of it makes the blob refuse
 * to open, which `prf.test.ts` checks rather than asserts.
 *
 * The domain separator differs from the phrase envelope's, so neither blob can
 * ever be opened as, or mistaken for, the other.
 *
 * # HKDF-SHA-256, not Argon2id
 *
 * The PRF output is a 32-byte HMAC computed inside the authenticator under a
 * secret it minted for one credential. It is uniform, it takes no user-chosen
 * input, and it offers no offline guessing space to an attacker who does not
 * hold the authenticator. Argon2id's justification in `keys.ts` — that the
 * phrase's 128 bits are an ASSUMPTION about a random number generator, and a
 * memory-hard KDF is what makes a wrong assumption survivable — does not
 * transfer to a secret the attacker cannot enumerate at all. At the shipped
 * parameters it would cost about a second of a person's time per unlock and
 * remove nothing from anybody's reach. HKDF is the right KDF for a high-entropy
 * secret, which is what `keys.ts`'s header itself says.
 *
 * Per-wrap randomness lives in the HKDF salt inside the blob, which is 32 fresh
 * random bytes per wrap.
 *
 * # Why the PRF evaluation salt is a compile-time constant
 *
 * {@link PRF_EVAL_SALT} is the input the authenticator evaluates its PRF over,
 * and it is the same 32 bytes for every account in this product. Per-account
 * would buy nothing — the PRF is already keyed by a per-credential secret, so
 * two accounts on one authenticator get different outputs from the same salt —
 * and it would cost the thing that matters: the salt would have to be fetched
 * from the server before the ceremony could start, so unlocking would need a
 * network round trip before the biometric prompt.
 */

import type { Platform } from "../platform";
import { AES_NONCE_BYTES, AES_TAG_BYTES } from "../platform.aead";
import { hkdfSha256 } from "./hkdf";
import { BODY_BYTES, MAX_WRAPPED_BYTES, WrapError, decodeKeyBody, encodeKeyBody, zero, type AccountKeys } from "./keys";

/** This envelope's version. Independent of the phrase envelope's, which it is a sibling of and not a successor to. */
export const PRF_WRAP_VERSION = 1;

/**
 * The KDF identifier this envelope writes. 2 rather than 1 so the two envelopes
 * can never agree about a blob by accident: 1 is `keys.ts`'s Argon2id.
 */
export const KDF_HKDF_SHA256 = 2;

/** The PRF output an authenticator returns for one credential and one salt. */
export const PRF_OUTPUT_BYTES = 32;

const SALT_BYTES = 32;
const KEY_BYTES = 32;

/** `[version][kdf][salt:32][nonce:12]`. */
export const PRF_HEADER_BYTES = 1 + 1 + SALT_BYTES + AES_NONCE_BYTES;

/** The whole blob: header, body and tag. */
export const PRF_WRAPPED_BYTES = PRF_HEADER_BYTES + BODY_BYTES + AES_TAG_BYTES;

/**
 * The AEAD's domain separator, distinct from the phrase envelope's. Written as
 * `\x00` rather than as a literal NUL: git classifies a file containing one as
 * binary and prints no diff for it.
 */
const PRF_WRAP_DOMAIN = "ledger-v2-account-keys-prf\x00";

/** HKDF's `info`. Names the derivation, so a future one cannot collide with this one. */
const PRF_HKDF_INFO = "ledger-v2-prf-wrap-v1";

/**
 * The salt handed to the authenticator's PRF — `prf.eval.first` — as a
 * compile-time constant. See the module header for why it is not per-account.
 *
 * Spelled out as bytes rather than encoded at runtime because it is a protocol
 * constant: a change to it invalidates every wrap in existence, and the diff
 * should look like what it is. It is the UTF-8 of `ledger-v2-prf-unlock-v1`,
 * zero padded to 32 bytes.
 */
export const PRF_EVAL_SALT: Uint8Array = new Uint8Array([
  0x6c, 0x65, 0x64, 0x67, 0x65, 0x72, 0x2d, 0x76, 0x32, 0x2d, 0x70, 0x72, 0x66, 0x2d, 0x75, 0x6e, 0x6c, 0x6f, 0x63,
  0x6b, 0x2d, 0x76, 0x31, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * Seals `keys` under a PRF output.
 *
 * The output is checked for length and nothing else: it is 32 bytes from an
 * authenticator, and there is no equivalent of `validatePhrase` to run over it.
 */
export async function wrapPrfKeys(prfOutput: Uint8Array, keys: AccountKeys, p: Platform): Promise<Uint8Array> {
  checkPrfOutput(prfOutput);
  if (keys.ingestPriv.length !== KEY_BYTES || keys.dek.length !== KEY_BYTES || keys.recoverySeed.length !== KEY_BYTES) {
    throw new WrapError(`account keys must be ${KEY_BYTES} bytes each`);
  }

  const salt = p.randomBytes(SALT_BYTES);
  const nonce = p.randomBytes(AES_NONCE_BYTES);
  const header = encodeHeader(salt, nonce);
  const wrapKey = deriveWrapKey(prfOutput, salt, p);
  const body = encodeKeyBody(keys);

  const sealed = await p.aesGcmSeal(wrapKey, nonce, aadFor(header, p), body);
  zero(body);
  zero(wrapKey);

  const out = new Uint8Array(header.length + sealed.length);
  out.set(header, 0);
  out.set(sealed, header.length);
  return out;
}

/**
 * Opens a PRF-wrapped blob, or throws a {@link WrapError}.
 *
 * Every way of failing — the wrong credential, an authenticator that rotated
 * its PRF secret, a corrupted blob, a rewritten header — is one refusal with
 * one message. They are the same fact to the caller, whose next move is the
 * recovery phrase in every one of those cases.
 */
export async function unwrapPrfKeys(prfOutput: Uint8Array, blob: Uint8Array, p: Platform): Promise<AccountKeys> {
  checkPrfOutput(prfOutput);
  prfWrappedBlobParams(blob);

  const salt = blob.subarray(2, 2 + SALT_BYTES);
  const nonce = blob.subarray(2 + SALT_BYTES, PRF_HEADER_BYTES);
  const sealed = blob.subarray(PRF_HEADER_BYTES);
  if (sealed.length !== BODY_BYTES + AES_TAG_BYTES) {
    throw new WrapError(
      `a PRF-wrapped key blob's sealed part is ${BODY_BYTES + AES_TAG_BYTES} bytes, and this one is ${sealed.length}`,
    );
  }

  const wrapKey = deriveWrapKey(prfOutput, salt, p);
  let body: Uint8Array;
  try {
    body = await p.aesGcmOpen(wrapKey, nonce, aadFor(blob.subarray(0, PRF_HEADER_BYTES), p), sealed);
  } catch {
    throw new WrapError("this device did not unlock these keys");
  } finally {
    zero(wrapKey);
  }
  return decodeKeyBody(body, p);
}

/** The declared version and KDF, readable without the PRF output. */
export function prfWrappedBlobParams(blob: Uint8Array): { version: number; kdf: number } {
  if (blob.length < PRF_HEADER_BYTES) {
    throw new WrapError(`a PRF-wrapped key blob is at least ${PRF_HEADER_BYTES} bytes, and this one is ${blob.length}`);
  }
  if (blob.length > MAX_WRAPPED_BYTES) {
    throw new WrapError(`a PRF-wrapped key blob is at most ${MAX_WRAPPED_BYTES} bytes, and this one is ${blob.length}`);
  }
  const version = blob[0]!;
  if (version !== PRF_WRAP_VERSION) {
    // Named rather than tolerated, the same rule the phrase envelope and the
    // sync protocol both follow: an unknown newer version is the one case where
    // guessing is worse than stopping.
    throw new WrapError(
      `this PRF-wrapped key blob is version ${version}, and this build only knows version ${PRF_WRAP_VERSION}`,
    );
  }
  const kdf = blob[1]!;
  if (kdf !== KDF_HKDF_SHA256) {
    throw new WrapError(`this PRF-wrapped key blob names key derivation function ${kdf}, which this build does not have`);
  }
  return { version, kdf };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function checkPrfOutput(prfOutput: Uint8Array): void {
  if (prfOutput.length !== PRF_OUTPUT_BYTES) {
    throw new WrapError(`a WebAuthn PRF output is ${PRF_OUTPUT_BYTES} bytes, and this one is ${prfOutput.length}`);
  }
}

function encodeHeader(salt: Uint8Array, nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(PRF_HEADER_BYTES);
  out[0] = PRF_WRAP_VERSION;
  out[1] = KDF_HKDF_SHA256;
  out.set(salt, 2);
  out.set(nonce, 2 + SALT_BYTES);
  return out;
}

/** Domain separator || header. See the module header for why the header is authenticated. */
function aadFor(header: Uint8Array, p: Platform): Uint8Array {
  const domain = p.utf8Encode(PRF_WRAP_DOMAIN);
  const out = new Uint8Array(domain.length + header.length);
  out.set(domain, 0);
  out.set(header, domain.length);
  return out;
}

function deriveWrapKey(prfOutput: Uint8Array, salt: Uint8Array, p: Platform): Uint8Array {
  return hkdfSha256(prfOutput, salt, p.utf8Encode(PRF_HKDF_INFO), KEY_BYTES, p);
}
