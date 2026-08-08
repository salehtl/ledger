/**
 * HMAC-SHA-256 and HKDF-SHA-256 against RFC 5869's published vectors, and
 * against an independent implementation.
 *
 * A hand-rolled MAC is worth exactly what its vectors are worth: a wrong one
 * still round-trips with itself, and every test that only wraps and unwraps
 * would pass. So the fixed vectors come first, and `@noble/hashes`'s HKDF —
 * which shares no code with this — is run over random inputs after them.
 */

import { describe, expect, test } from "bun:test";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { bunPlatform } from "../platform";
import { webPlatform } from "../platform.web";
import { HASH_BYTES, hkdfExpand, hkdfExtract, hkdfSha256, hmacSha256 } from "./hkdf";

const P = bunPlatform;

const hex = (s: string): Uint8Array => P.fromHex(s);
const rep = (byte: number, n: number): Uint8Array => new Uint8Array(n).fill(byte);

describe("HKDF-SHA-256, RFC 5869 vectors", () => {
  // §A.1: basic.
  test("case 1", () => {
    const ikm = rep(0x0b, 22);
    const salt = hex("000102030405060708090a0b0c");
    const info = hex("f0f1f2f3f4f5f6f7f8f9");
    expect(P.toHex(hkdfExtract(salt, ikm, P))).toBe(
      "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5",
    );
    expect(P.toHex(hkdfSha256(ikm, salt, info, 42, P))).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  // §A.2: longer inputs and outputs.
  test("case 2", () => {
    const ikm = hex(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f" +
        "303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f",
    );
    const salt = hex(
      "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f" +
        "909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
    );
    const info = hex(
      "b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf" +
        "e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
    );
    expect(P.toHex(hkdfSha256(ikm, salt, info, 82, P))).toBe(
      "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09" +
        "da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87",
    );
  });

  // §A.3: zero-length salt and info. The salt substitution is the part that is
  // easy to get wrong, because an implementation that HMACs with an empty key
  // still produces a plausible-looking output.
  test("case 3, empty salt and info", () => {
    expect(P.toHex(hkdfSha256(rep(0x0b, 22), new Uint8Array(0), new Uint8Array(0), 42, P))).toBe(
      "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
    );
  });
});

describe("hmacSha256", () => {
  // RFC 4231 §4.2 and §4.3: a short key and a key longer than the 64-byte
  // block, which is the branch that hashes the key first.
  test("RFC 4231 test case 1", () => {
    expect(P.toHex(hmacSha256(rep(0x0b, 20), P.utf8Encode("Hi There"), P))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  test("RFC 4231 test case 6, a key longer than one block", () => {
    expect(
      P.toHex(hmacSha256(rep(0xaa, 131), P.utf8Encode("Test Using Larger Than Block-Size Key - Hash Key First"), P)),
    ).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  });
});

test("agrees with an independent HKDF over random inputs, on both hosts", () => {
  for (let i = 0; i < 16; i++) {
    const ikm = P.randomBytes(1 + (i % 48));
    const salt = P.randomBytes(i % 40);
    const info = P.randomBytes(i % 24);
    const length = 1 + ((i * 7) % 96);
    const want = P.toHex(nobleHkdf(nobleSha256, ikm, salt, info, length));
    expect(P.toHex(hkdfSha256(ikm, salt, info, length, P))).toBe(want);
    expect(P.toHex(hkdfSha256(ikm, salt, info, length, webPlatform))).toBe(want);
  }
});

test("refuses an expansion longer than 255 blocks", () => {
  const prk = hkdfExtract(new Uint8Array(0), P.utf8Encode("x"), P);
  expect(() => hkdfExpand(prk, new Uint8Array(0), 255 * HASH_BYTES + 1, P)).toThrow(RangeError);
});
