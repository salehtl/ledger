/**
 * AES-256-GCM for the platform seam — the one primitive on it that is
 * **asynchronous**, and the one that has a single implementation shared by both
 * hosts rather than two.
 *
 * # Why it is async, on a seam whose whole character is synchronous
 *
 * `platform.ts` is synchronous because everything above it — `replay/`,
 * `wire/`, `norm/` — runs inside fold loops that cannot await, and
 * `platform.web.ts` is pure JS for exactly that reason: WebCrypto offers no
 * synchronous digest or signature.
 *
 * This primitive is different in the only way that matters: it is not called
 * from a fold. Phase 3 Task 1 uses it **twice in the life of an account** — once
 * to wrap the account keys under the recovery phrase at onboarding, once to
 * unwrap them on a recovering device — and Tasks 2 and 3 will do their per-record
 * sealing against non-extractable `CryptoKey` handles, which is a WebCrypto API
 * and is async whatever this module does. So the choice was never
 * "sync or async"; it was "async, or a second hand-rolled AES in the bundle".
 *
 * # Why one implementation and not two
 *
 * Every other seam method has two implementations on purpose: `node:crypto` on
 * one side and `@noble/*` on the other, cross-checked against fixed vectors, so
 * a bug in either is visible. That argument does not transfer here.
 *
 * A block cipher is where "two implementations" stops being a safety property
 * and becomes a liability: the pure-JS one would be the one running in every
 * browser, it would not be constant-time, and it would be a new dependency
 * carrying the app's at-rest confidentiality. `crypto.subtle` exists in Bun,
 * in Node and in every browser this product supports, and it is the same
 * specification with the same test vectors on all of them — so the divergence
 * this seam exists to manage is not present to begin with. The fixed NIST
 * vectors in `platform.test.ts` and `platform.web.test.ts` still run on both
 * sides, so a host whose WebCrypto is not the AES-GCM everyone else has fails
 * loudly rather than silently.
 *
 * # The shape
 *
 * `seal` returns **ciphertext || 16-byte tag**, which is what WebCrypto itself
 * produces and what `internal/v2/blob`'s Go sealer emits; `open` takes the same
 * concatenation. Nothing here invents a framing — the envelope is
 * `crypto/keys.ts`'s business, and a primitive that also framed would give the
 * Go side two things to agree with instead of one.
 *
 * Lengths are checked HERE rather than left to the host. WebCrypto accepts a
 * nonce of any length by rehashing it with GHASH, which is legal and is not what
 * this product means: every nonce it produces is 12 random bytes, and a 16-byte
 * one reaching this function is a caller bug, not a format to support.
 */

/** AES-256. The only key size this seam admits. */
export const AES_KEY_BYTES = 32;

/** The 96-bit nonce GCM is specified for, and the only length accepted here. */
export const AES_NONCE_BYTES = 12;

/** The GCM authentication tag, at its full 128-bit length. */
export const AES_TAG_BYTES = 16;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (c === undefined || c.subtle === undefined) {
    throw new Error(
      "no WebCrypto on this runtime: AES-GCM needs crypto.subtle, which is absent " +
        "(in a browser this means the page is not a secure context)",
    );
  }
  return c.subtle;
}

// A fresh `importKey` per call, deliberately. Caching a CryptoKey against raw
// key bytes would mean holding a map keyed by secret material for the lifetime
// of the process, to save a sub-millisecond call on a path taken twice per
// account.
// `"encrypt" | "decrypt"` rather than the DOM's `KeyUsage`: `client/`'s
// tsconfig has no DOM lib, and naming the two values this module actually uses
// is more honest than widening the parameter to keep a type name.
async function importKey(key: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (key.length !== AES_KEY_BYTES) {
    throw new TypeError(`an AES-256-GCM key is ${AES_KEY_BYTES} bytes, got ${key.length}`);
  }
  return subtle().importKey("raw", toBuffer(key), "AES-GCM", false, [usage]);
}

/**
 * The `BufferSource` to hand WebCrypto for `b`.
 *
 * A `Uint8Array` may be a view onto a larger buffer (every `subarray` is), and
 * handing WebCrypto the underlying `.buffer` would encrypt the whole of it — so
 * a view is copied to a buffer of exactly its own length and a whole array is
 * passed through untouched.
 *
 * It returns the TYPED ARRAY rather than a detached `ArrayBuffer`, which is not
 * a style choice: under vitest's jsdom environment an `ArrayBuffer` produced by
 * `.buffer.slice()` fails Node's WebCrypto `instanceof` check across the realm
 * boundary ("2nd argument is not instance of ArrayBuffer, Buffer, TypedArray,
 * or DataView"), while the typed array is accepted. Both are legal
 * `BufferSource`s to the specification.
 */
function toBuffer(b: Uint8Array): Uint8Array<ArrayBuffer> {
  // Unconditionally a copy, rather than passing a whole array through: the
  // check that would let one through ("byteOffset 0 and byteLength equal to the
  // buffer's") is exactly the check that is wrong for a `SharedArrayBuffer`- or
  // resizable-buffer-backed view, and these buffers are key material and
  // envelope-sized. One allocation is not a cost worth a conditional here.
  return new Uint8Array(b);
}

function checkNonce(nonce: Uint8Array): void {
  if (nonce.length !== AES_NONCE_BYTES) {
    throw new TypeError(`an AES-GCM nonce is ${AES_NONCE_BYTES} bytes, got ${nonce.length}`);
  }
}

/** Seals `plaintext`, returning ciphertext || tag. */
export async function aesGcmSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  checkNonce(nonce);
  const k = await importKey(key, "encrypt");
  const out = await subtle().encrypt(
    { name: "AES-GCM", iv: toBuffer(nonce), additionalData: toBuffer(aad), tagLength: AES_TAG_BYTES * 8 },
    k,
    toBuffer(plaintext),
  );
  return new Uint8Array(out);
}

/**
 * Opens ciphertext || tag, or throws.
 *
 * Every failure — wrong key, wrong nonce, wrong associated data, a flipped bit
 * — is the same rejection with no detail, because they are the same fact to the
 * caller and telling them apart is an oracle.
 */
export async function aesGcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  checkNonce(nonce);
  // Checked here so a truncated blob is a length complaint rather than an
  // authentication failure: the two are different faults and only one of them
  // means "the wrong key was used".
  if (sealed.length < AES_TAG_BYTES) {
    throw new TypeError(`sealed input is ${sealed.length} bytes, shorter than the ${AES_TAG_BYTES}-byte tag`);
  }
  const k = await importKey(key, "decrypt");
  let out: ArrayBuffer;
  try {
    out = await subtle().decrypt(
      { name: "AES-GCM", iv: toBuffer(nonce), additionalData: toBuffer(aad), tagLength: AES_TAG_BYTES * 8 },
      k,
      toBuffer(sealed),
    );
  } catch {
    throw new Error("aes-256-gcm: authentication failed");
  }
  return new Uint8Array(out);
}
