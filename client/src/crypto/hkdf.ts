/**
 * HMAC-SHA-256 and HKDF-SHA-256 (RFC 2104, RFC 5869), over the platform's
 * `sha256`.
 *
 * # Why this exists next to Argon2id rather than instead of it
 *
 * `keys.ts` derives its wrap key from a twelve-word phrase, and its header
 * explains at length why that derivation is memory-hard: the phrase's entropy
 * is an ASSUMPTION about a random number generator, and Argon2id is what makes
 * a wrong assumption survivable.
 *
 * `prf.ts` derives its wrap key from a WebAuthn PRF output, and that assumption
 * is not present. The PRF output is a 32-byte HMAC computed inside an
 * authenticator under a per-credential secret the authenticator minted: there
 * is no user-chosen input, no dictionary, and no guessing space smaller than
 * 2^256 for an attacker who does not hold the authenticator. Stretching it
 * would cost a second of a person's time per unlock and remove nothing from an
 * attacker's reach. HKDF is the correct KDF for a high-entropy secret, which is
 * exactly the case `keys.ts`'s header says it would use HKDF for.
 *
 * # Why it is written here rather than imported
 *
 * Everything under `client/src` reaches a hash through {@link Platform}, so a
 * host with a native SHA-256 uses it, and `platform.test.ts` is the one place
 * the two hosts' hashes are pinned against fixed vectors. An HKDF that imported
 * its own SHA-256 would be a second hash implementation in the bundle,
 * unchecked by that contract.
 *
 * The implementation is small and the risk of a small hand-rolled MAC is that
 * it is subtly wrong, so `hkdf.test.ts` pins it against RFC 5869's published
 * vectors AND against `@noble/hashes`'s independent HKDF for random inputs.
 */

import type { Platform } from "../platform";

/** SHA-256's block size, in bytes. The HMAC padding length. */
const BLOCK_BYTES = 64;

/** SHA-256's output, in bytes. HKDF's `HashLen`. */
export const HASH_BYTES = 32;

/**
 * HMAC-SHA-256 (RFC 2104).
 *
 * `key` of any length: longer than one block is hashed first, shorter is zero
 * padded, exactly as the RFC specifies.
 */
export function hmacSha256(key: Uint8Array, message: Uint8Array, p: Platform): Uint8Array {
  const block = new Uint8Array(BLOCK_BYTES);
  block.set(key.length > BLOCK_BYTES ? p.sha256(key) : key, 0);

  const inner = new Uint8Array(BLOCK_BYTES + message.length);
  const outer = new Uint8Array(BLOCK_BYTES + HASH_BYTES);
  for (let i = 0; i < BLOCK_BYTES; i++) {
    inner[i] = block[i]! ^ 0x36;
    outer[i] = block[i]! ^ 0x5c;
  }
  inner.set(message, BLOCK_BYTES);
  outer.set(p.sha256(inner), BLOCK_BYTES);

  const tag = p.sha256(outer);
  // The padded key is the only buffer here derived from secret material that
  // outlives its use, so it does not outlive it.
  block.fill(0);
  inner.fill(0);
  outer.fill(0);
  return tag;
}

/** HKDF-Extract (RFC 5869 §2.2). A salt of zero length is the all-zero block, per the RFC. */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array, p: Platform): Uint8Array {
  return hmacSha256(salt.length === 0 ? new Uint8Array(HASH_BYTES) : salt, ikm, p);
}

/** HKDF-Expand (RFC 5869 §2.3). */
export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number, p: Platform): Uint8Array {
  if (length < 0 || length > 255 * HASH_BYTES) {
    throw new RangeError(`HKDF-SHA-256 can produce at most ${255 * HASH_BYTES} bytes, not ${length}`);
  }
  const out = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  for (let counter = 1, filled = 0; filled < length; counter++) {
    const input = new Uint8Array(previous.length + info.length + 1);
    input.set(previous, 0);
    input.set(info, previous.length);
    input[input.length - 1] = counter;
    previous = hmacSha256(prk, input, p);
    out.set(previous.subarray(0, Math.min(HASH_BYTES, length - filled)), filled);
    filled += HASH_BYTES;
  }
  return out;
}

/** HKDF-SHA-256, extract then expand. */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
  p: Platform,
): Uint8Array {
  const prk = hkdfExtract(salt, ikm, p);
  try {
    return hkdfExpand(prk, info, length, p);
  } finally {
    prk.fill(0);
  }
}
