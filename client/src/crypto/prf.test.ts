/**
 * The PRF wrap: the second envelope around the account's key set, sealed under
 * a WebAuthn PRF output instead of under the recovery phrase.
 *
 * The properties under test are the ones that decide whether a real financial
 * history stays reachable:
 *
 *   - the two envelopes carry the SAME body, byte for byte, so a device that
 *     opened either holds the same keys;
 *   - the whole header is authenticated, so nothing about the derivation can be
 *     rewritten by a holder of the blob;
 *   - the derivation is pinned to a fixed vector, so it cannot drift and strand
 *     every wrap in existence;
 *   - every way of being wrong is a refusal, because the answer to all of them
 *     is the recovery phrase.
 */

import { describe, expect, test } from "bun:test";
import { bunPlatform } from "../platform";
import { webPlatform } from "../platform.web";
import { AES_NONCE_BYTES } from "../platform.aead";
import { hkdfSha256 } from "./hkdf";
import {
  KDF_HKDF_SHA256,
  PRF_EVAL_SALT,
  PRF_HEADER_BYTES,
  PRF_OUTPUT_BYTES,
  PRF_WRAPPED_BYTES,
  PRF_WRAP_VERSION,
  prfWrappedBlobParams,
  unwrapPrfKeys,
  wrapPrfKeys,
} from "./prf";
import { WrapError, encodeKeyBody, generateAccountKeys, unwrapAccountKeys, wrapAccountKeys } from "./keys";

const P = bunPlatform;

const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const FAST = { t: 1, m: 64, p: 1 } as const;

const prfOutput = (fill: number): Uint8Array => new Uint8Array(PRF_OUTPUT_BYTES).fill(fill);

describe("wrapPrfKeys / unwrapPrfKeys", () => {
  test("round-trips the whole key set, and the envelope is the declared shape", async () => {
    const keys = generateAccountKeys(P);
    const want = P.toHex(encodeKeyBody(keys));
    const blob = await wrapPrfKeys(prfOutput(7), keys, P);

    expect(blob.length).toBe(PRF_WRAPPED_BYTES);
    expect(blob[0]).toBe(PRF_WRAP_VERSION);
    expect(blob[1]).toBe(KDF_HKDF_SHA256);
    expect(prfWrappedBlobParams(blob)).toEqual({ version: PRF_WRAP_VERSION, kdf: KDF_HKDF_SHA256 });

    const opened = await unwrapPrfKeys(prfOutput(7), blob, P);
    expect(P.toHex(encodeKeyBody(opened))).toBe(want);
    expect(P.toHex(opened.ingestPub)).toBe(P.toHex(P.x25519PublicKey(opened.ingestPriv)));
    expect(P.toHex(opened.recoveryPub)).toBe(P.toHex(P.ed25519PublicKey(opened.recoverySeed)));
  });

  test("what one host wrapped, the other unwraps", async () => {
    const keys = generateAccountKeys(P);
    const want = P.toHex(encodeKeyBody(keys));
    const blob = await wrapPrfKeys(prfOutput(9), keys, webPlatform);
    expect(P.toHex(encodeKeyBody(await unwrapPrfKeys(prfOutput(9), blob, P)))).toBe(want);
  });

  test("two wraps of the same keys under the same PRF output differ, and both open", async () => {
    const a = generateAccountKeys(P);
    const body = P.toHex(encodeKeyBody(a));
    const one = await wrapPrfKeys(prfOutput(3), a, P);
    const two = await wrapPrfKeys(prfOutput(3), a, P);
    expect(P.toHex(one)).not.toBe(P.toHex(two));
    expect(P.toHex(encodeKeyBody(await unwrapPrfKeys(prfOutput(3), one, P)))).toBe(body);
    expect(P.toHex(encodeKeyBody(await unwrapPrfKeys(prfOutput(3), two, P)))).toBe(body);
  });

  test("a different PRF output does not open it", async () => {
    const blob = await wrapPrfKeys(prfOutput(1), generateAccountKeys(P), P);
    await expect(unwrapPrfKeys(prfOutput(2), blob, P)).rejects.toThrow(WrapError);
  });

  test("a PRF output that is not 32 bytes is refused rather than padded", async () => {
    const keys = generateAccountKeys(P);
    await expect(wrapPrfKeys(new Uint8Array(31).fill(1), keys, P)).rejects.toThrow(WrapError);
    const blob = await wrapPrfKeys(prfOutput(1), generateAccountKeys(P), P);
    await expect(unwrapPrfKeys(new Uint8Array(33).fill(1), blob, P)).rejects.toThrow(WrapError);
  });
});

// The whole reason both envelopes exist: a device that unlocked with Face ID
// and a device that typed the phrase must end up holding the identical key set.
// Anything less is an account that reads its own history on one device and not
// on the other.
test("the PRF wrap and the phrase wrap carry byte-identical bodies", async () => {
  const keys = generateAccountKeys(P);
  const body = P.toHex(encodeKeyBody(keys));

  const phraseBlob = await wrapAccountKeys(PHRASE, keys, P, FAST);
  const prfBlob = await wrapPrfKeys(prfOutput(5), keys, P);

  const fromPhrase = await unwrapAccountKeys(PHRASE, phraseBlob, P);
  const fromPrf = await unwrapPrfKeys(prfOutput(5), prfBlob, P);

  expect(P.toHex(encodeKeyBody(fromPrf))).toBe(P.toHex(encodeKeyBody(fromPhrase)));
  expect(P.toHex(encodeKeyBody(fromPrf))).toBe(body);
});

describe("the header is authenticated, not merely prefixed", () => {
  /** Seals a body the way the envelope does, but with an associated data of the caller's choosing. */
  const sealWith = async (aad: Uint8Array, salt: Uint8Array, nonce: Uint8Array, body: Uint8Array): Promise<Uint8Array> => {
    const key = hkdfSha256(prfOutput(4), salt, P.utf8Encode("ledger-v2-prf-wrap-v1"), 32, P);
    const sealed = await P.aesGcmSeal(key, nonce, aad, body);
    const out = new Uint8Array(PRF_HEADER_BYTES + sealed.length);
    out[0] = PRF_WRAP_VERSION;
    out[1] = KDF_HKDF_SHA256;
    out.set(salt, 2);
    out.set(nonce, 2 + 32);
    out.set(sealed, PRF_HEADER_BYTES);
    return out;
  };

  const domain = P.utf8Encode("ledger-v2-account-keys-prf\x00");
  const salt = new Uint8Array(32).fill(0x11);
  const nonce = new Uint8Array(AES_NONCE_BYTES).fill(0x22);

  test("a blob whose associated data omits the header does not open", async () => {
    const keys = generateAccountKeys(P);
    const blob = await sealWith(domain, salt, nonce, encodeKeyBody(keys));
    await expect(unwrapPrfKeys(prfOutput(4), blob, P)).rejects.toThrow(WrapError);
  });

  test("a blob sealed under the phrase envelope's domain does not open as a PRF wrap", async () => {
    const keys = generateAccountKeys(P);
    const header = new Uint8Array(PRF_HEADER_BYTES);
    header[0] = PRF_WRAP_VERSION;
    header[1] = KDF_HKDF_SHA256;
    header.set(salt, 2);
    header.set(nonce, 2 + 32);
    const wrongDomain = P.utf8Encode("ledger-v2-account-keys\x00");
    const aad = new Uint8Array(wrongDomain.length + header.length);
    aad.set(wrongDomain, 0);
    aad.set(header, wrongDomain.length);
    const blob = await sealWith(aad, salt, nonce, encodeKeyBody(keys));
    await expect(unwrapPrfKeys(prfOutput(4), blob, P)).rejects.toThrow(WrapError);
  });

  test("the same body, sealed with the domain AND the header, does open", async () => {
    const keys = generateAccountKeys(P);
    const want = P.toHex(encodeKeyBody(keys));
    const header = new Uint8Array(PRF_HEADER_BYTES);
    header[0] = PRF_WRAP_VERSION;
    header[1] = KDF_HKDF_SHA256;
    header.set(salt, 2);
    header.set(nonce, 2 + 32);
    const aad = new Uint8Array(domain.length + header.length);
    aad.set(domain, 0);
    aad.set(header, domain.length);
    const blob = await sealWith(aad, salt, nonce, encodeKeyBody(keys));
    expect(P.toHex(encodeKeyBody(await unwrapPrfKeys(prfOutput(4), blob, P)))).toBe(want);
  });

  test("rewriting a salt or nonce byte makes the blob refuse to open", async () => {
    const blob = await wrapPrfKeys(prfOutput(6), generateAccountKeys(P), P);
    for (const at of [2, PRF_HEADER_BYTES - 1]) {
      const edited = Uint8Array.from(blob);
      edited[at] = edited[at]! ^ 0xff;
      await expect(unwrapPrfKeys(prfOutput(6), edited, P)).rejects.toThrow(WrapError);
    }
  });
});

// The derivation, pinned. A change to it is not a refactor: it is every wrap in
// existence becoming unopenable, and it has to look like a deliberate edit.
test("the wrap key is HKDF-SHA-256 over the PRF output, at a fixed vector", async () => {
  const salt = new Uint8Array(32).fill(0x11);
  const nonce = new Uint8Array(AES_NONCE_BYTES).fill(0x33);
  const key = hkdfSha256(prfOutput(0x42), salt, P.utf8Encode("ledger-v2-prf-wrap-v1"), 32, P);
  expect(P.toHex(key)).toBe("3c12560ec8be71a9190fff6f41f9d1590932f115ba76ac48b932a0d7cb691aac");

  // And that key is the one the envelope actually uses: a blob sealed by hand
  // under it opens through the public API.
  const keys = generateAccountKeys(P);
  const want = P.toHex(encodeKeyBody(keys));
  const header = new Uint8Array(PRF_HEADER_BYTES);
  header[0] = PRF_WRAP_VERSION;
  header[1] = KDF_HKDF_SHA256;
  header.set(salt, 2);
  header.set(nonce, 2 + 32);
  const domain = P.utf8Encode("ledger-v2-account-keys-prf\x00");
  const aad = new Uint8Array(domain.length + header.length);
  aad.set(domain, 0);
  aad.set(header, domain.length);
  const sealed = await P.aesGcmSeal(key, nonce, aad, encodeKeyBody(keys));
  const blob = new Uint8Array(PRF_HEADER_BYTES + sealed.length);
  blob.set(header, 0);
  blob.set(sealed, PRF_HEADER_BYTES);
  expect(P.toHex(encodeKeyBody(await unwrapPrfKeys(prfOutput(0x42), blob, P)))).toBe(want);
});

describe("malformed blobs", () => {
  test("an unknown newer version is a hard stop, not a guess", async () => {
    const blob = await wrapPrfKeys(prfOutput(1), generateAccountKeys(P), P);
    blob[0] = PRF_WRAP_VERSION + 1;
    expect(() => prfWrappedBlobParams(blob)).toThrow(WrapError);
    await expect(unwrapPrfKeys(prfOutput(1), blob, P)).rejects.toThrow(WrapError);
  });

  test("a phrase-wrapped blob is not accepted as a PRF wrap", async () => {
    const phraseBlob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P, FAST);
    await expect(unwrapPrfKeys(prfOutput(1), phraseBlob, P)).rejects.toThrow(WrapError);
  });

  test("a truncated or oversized blob is refused before any derivation runs", async () => {
    await expect(unwrapPrfKeys(prfOutput(1), new Uint8Array(10), P)).rejects.toThrow(WrapError);
    await expect(unwrapPrfKeys(prfOutput(1), new Uint8Array(5000), P)).rejects.toThrow(WrapError);
    const short = new Uint8Array(PRF_HEADER_BYTES + 20);
    short[0] = PRF_WRAP_VERSION;
    short[1] = KDF_HKDF_SHA256;
    await expect(unwrapPrfKeys(prfOutput(1), short, P)).rejects.toThrow(WrapError);
  });
});

// It is a protocol constant: changing it invalidates every wrap ever written,
// because the authenticator would evaluate its PRF over different input.
test("the PRF evaluation salt is fixed", () => {
  expect(PRF_EVAL_SALT.length).toBe(32);
  expect(P.toHex(PRF_EVAL_SALT)).toBe("6c65646765722d76322d7072662d756e6c6f636b2d7631000000000000000000");
});
