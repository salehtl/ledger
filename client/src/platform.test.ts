/**
 * The platform seam's contract, as fixed vectors.
 *
 * These are not "does the Bun implementation work" tests — Bun's `node:zlib`
 * and `node:crypto` are not on trial. They are the specification a SECOND
 * implementation has to satisfy: Task 4 Step 4 runs this same file's vectors
 * against the React Native `Platform` on a device, and anything not pinned here
 * is something the two implementations are free to disagree about.
 *
 * So the vectors are chosen for the places a hand-rolled implementation drifts:
 * hex of a leading zero byte (a `toString(16)` without padding drops it),
 * base64 of a byte pair that produces padding, the BOM (`TextDecoder`'s default
 * `ignoreBOM: false` STRIPS it, which is the opposite of what the option name
 * suggests and the opposite of what a naive decoder does), a lone surrogate,
 * and a gzip bomb whose cap must be enforced DURING inflation rather than after.
 */

import { describe, expect, test } from "bun:test";
import { bunPlatform, platform, setPlatform } from "./platform";
import type { Platform } from "./platform";

const P = bunPlatform;

const hexToBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

describe("sha256", () => {
  // FIPS 180-2 / the two vectors every implementation is checked against.
  test("the empty string", () => {
    expect(P.toHex(P.sha256(new Uint8Array(0)))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test('"abc"', () => {
    expect(P.toHex(P.sha256(P.utf8Encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  // 1,000,000 'a' — the vector that catches a block-boundary or length-encoding
  // bug, which the two short vectors above cannot.
  test("a million 'a'", () => {
    const a = new Uint8Array(1_000_000).fill(0x61);
    expect(P.toHex(P.sha256(a))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  test("digests 32 bytes and does not alias its input", () => {
    const input = P.utf8Encode("abc");
    const d = P.sha256(input);
    expect(d.length).toBe(32);
    expect(d.buffer === input.buffer).toBe(false);
  });
});

describe("gzip", () => {
  test("round-trips, and emits the gzip magic", () => {
    const plain = P.utf8Encode("the quick brown fox".repeat(50));
    const z = P.gzip(plain);
    expect(z[0]).toBe(0x1f);
    expect(z[1]).toBe(0x8b);
    expect(P.gunzip(z, 1 << 20)).toEqual(plain);
  });

  test("round-trips the empty input", () => {
    expect(P.gunzip(P.gzip(new Uint8Array(0)), 1024)).toEqual(new Uint8Array(0));
  });

  test("round-trips arbitrary binary, including every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(P.gunzip(P.gzip(all), 1024)).toEqual(all);
  });

  // `sealBlob` compresses at level 9 and the framed result is what the chain
  // hashes, so the level is part of the seam's contract and not an internal
  // detail. If this ever changes, previously sealed fixtures stop matching.
  test("compresses at level 9", async () => {
    const { gzipSync } = await import("node:zlib");
    const plain = P.utf8Encode("aaaabbbbcccc".repeat(400));
    expect(P.gzip(plain)).toEqual(new Uint8Array(gzipSync(plain, { level: 9 })));
  });

  test("output under the cap is returned whole", () => {
    const plain = new Uint8Array(1000).fill(0x41);
    expect(P.gunzip(P.gzip(plain), 1000).length).toBe(1000);
  });

  // The guard that matters. 4 MiB of zeros compresses to a few KiB, so an
  // implementation that inflates first and measures afterwards allocates 4 MiB
  // to answer a question about 1 KiB — and the real bucket is 1 MiB of input
  // inflating to roughly a gigabyte.
  test("a gzip bomb throws at the cap", () => {
    const bomb = P.gzip(new Uint8Array(4 << 20));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => P.gunzip(bomb, 1024)).toThrow();
  });

  // The bomb test above only proves the cap THROWS. It cannot tell "refused
  // during inflation" from "inflated 32 MiB, then measured, then threw" — both
  // throw, and the second is a remote OOM on a phone. This is the mutation that
  // survived the first battery, so it gets a test that can see the difference.
  //
  // Timing, but not a magic millisecond: the capped path is compared against
  // the SAME implementation inflating the SAME bomb with a cap that never
  // trips, so machine speed, engine and background load cancel out. Measured
  // here: a correct implementation is 272–446x cheaper; the inflate-then-check
  // mutant is 0.4–1.0x, i.e. never cheaper at all. The 4x threshold sits two
  // orders of magnitude from the first and 4x from the second.
  //
  // If this ever goes red, the fix is an implementation that bounds output
  // during inflation — NOT a smaller ratio.
  test("the cap is refused during inflation, not after it", () => {
    const N = 32 << 20;
    const bomb = P.gzip(new Uint8Array(N));
    const capped = () => {
      try {
        P.gunzip(bomb, 1024);
      } catch {
        /* expected */
      }
    };
    const full = () => P.gunzip(bomb, N + 1);

    capped();
    full(); // warm both paths before either is timed
    const best = (f: () => void): number => {
      let ms = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        f();
        ms = Math.min(ms, performance.now() - t);
      }
      return ms;
    };
    const cappedMs = best(capped);
    const fullMs = best(full);
    expect(cappedMs * 4).toBeLessThan(fullMs);
  });

  test("the cap is exact: one byte over throws, exactly at the cap does not", () => {
    const z = P.gzip(new Uint8Array(1000).fill(0x41));
    expect(() => P.gunzip(z, 1000)).not.toThrow();
    expect(() => P.gunzip(z, 999)).toThrow();
  });

  test("truncated gzip throws rather than returning a short read", () => {
    const z = P.gzip(P.utf8Encode("hello world".repeat(100)));
    expect(() => P.gunzip(z.subarray(0, z.length - 8), 1 << 20)).toThrow();
  });

  test("non-gzip input throws", () => {
    expect(() => P.gunzip(P.utf8Encode("not gzip at all"), 1024)).toThrow();
  });
});

describe("ed25519", () => {
  // RFC 8032 §7.1, TEST 1.
  const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  const SIG =
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
    "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

  test("derives RFC 8032 test 1's public key from its seed", () => {
    expect(P.toHex(P.ed25519PublicKey(hexToBytes(SECRET)))).toBe(PUBLIC);
  });

  test("signs RFC 8032 test 1's empty message to the published signature", () => {
    expect(P.toHex(P.ed25519Sign(hexToBytes(SECRET), new Uint8Array(0)))).toBe(SIG);
  });

  // RFC 8032 §7.1, TEST 2 — a one-byte message, which catches an implementation
  // that gets the empty case right by accident.
  test("RFC 8032 test 2", () => {
    const seed = hexToBytes("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
    expect(P.toHex(P.ed25519PublicKey(seed))).toBe("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
    expect(P.toHex(P.ed25519Sign(seed, hexToBytes("72")))).toBe(
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da" +
        "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    );
  });

  test("Ed25519 is deterministic — the same message signs identically twice", () => {
    const seed = hexToBytes(SECRET);
    const msg = P.utf8Encode("ledger-v2-writer-registration");
    expect(P.toHex(P.ed25519Sign(seed, msg))).toBe(P.toHex(P.ed25519Sign(seed, msg)));
  });

  test("a generated key's public half is the one derived from its private half", () => {
    const { priv, pub } = P.ed25519GenerateKey();
    expect(priv.length).toBe(32);
    expect(pub.length).toBe(32);
    expect(P.toHex(P.ed25519PublicKey(priv))).toBe(P.toHex(pub));
  });

  test("two generated keys differ", () => {
    expect(P.toHex(P.ed25519GenerateKey().priv)).not.toBe(P.toHex(P.ed25519GenerateKey().priv));
  });

  test("a seed that is not 32 bytes is refused", () => {
    expect(() => P.ed25519PublicKey(new Uint8Array(31))).toThrow();
    expect(() => P.ed25519Sign(new Uint8Array(33), new Uint8Array(0))).toThrow();
  });
});

describe("hex", () => {
  test("a leading zero byte survives", () => {
    expect(P.toHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe("000fff");
  });

  test("0xFF and the full byte range round-trip", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const s = P.toHex(all);
    expect(s.length).toBe(512);
    expect(s.slice(0, 6)).toBe("000102");
    expect(s.slice(-6)).toBe("fdfeff");
    expect(P.fromHex(s)).toEqual(all);
  });

  test("the empty input round-trips", () => {
    expect(P.toHex(new Uint8Array(0))).toBe("");
    expect(P.fromHex("")).toEqual(new Uint8Array(0));
  });

  test("output is lower case", () => {
    expect(P.toHex(new Uint8Array([0xab, 0xcd, 0xef]))).toBe("abcdef");
  });

  // `Buffer.from(s, "hex")` stops at the first invalid character and returns a
  // SHORT buffer rather than throwing, which is how a corrupted 64-char chain
  // hash becomes a plausible-looking 20-byte one. Every call site guards with a
  // regex today; the seam refuses on its own so a site that forgets fails loud.
  test("odd length is refused", () => {
    expect(() => P.fromHex("abc")).toThrow();
  });

  test("a non-hex character is refused rather than truncating", () => {
    expect(() => P.fromHex("00zz11")).toThrow();
    expect(() => P.fromHex("0011 22")).toThrow();
  });

  test("upper case is refused — chain hashes are lower-case hex on the wire", () => {
    expect(() => P.fromHex("AABB")).toThrow();
  });
});

describe("base64", () => {
  test("a leading zero byte and a 0xFF byte round-trip", () => {
    expect(P.toBase64(new Uint8Array([0x00, 0xff]))).toBe("AP8=");
    expect(P.fromBase64("AP8=")).toEqual(new Uint8Array([0x00, 0xff]));
  });

  test("each padding length", () => {
    expect(P.toBase64(P.utf8Encode("a"))).toBe("YQ==");
    expect(P.toBase64(P.utf8Encode("ab"))).toBe("YWI=");
    expect(P.toBase64(P.utf8Encode("abc"))).toBe("YWJj");
    expect(P.fromBase64("YQ==")).toEqual(P.utf8Encode("a"));
    expect(P.fromBase64("YWI=")).toEqual(P.utf8Encode("ab"));
    expect(P.fromBase64("YWJj")).toEqual(P.utf8Encode("abc"));
  });

  test("the full byte range round-trips", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(P.fromBase64(P.toBase64(all))).toEqual(all);
  });

  test("the empty input round-trips", () => {
    expect(P.toBase64(new Uint8Array(0))).toBe("");
    expect(P.fromBase64("")).toEqual(new Uint8Array(0));
  });

  test("62 and 63 encode as + and /, never - and _", () => {
    expect(P.toBase64(new Uint8Array([0xff, 0xef, 0xbf]))).toBe("/++/");
  });

  // The strictness `wire/op.ts`'s `decodeBase64Strict` and `net/client.ts`'s
  // `unbase64` exist for: a decoder that skips unknown characters turns a
  // corrupted body into a short one, and a short blob is not a size bucket, so
  // it gets reported as a bucket violation instead of as a transport fault.
  test("characters outside the standard alphabet are refused, not skipped", () => {
    expect(() => P.fromBase64("YW Jj")).toThrow();
    expect(() => P.fromBase64("YWJ\n")).toThrow();
    expect(() => P.fromBase64("-_-_")).toThrow();
    expect(() => P.fromBase64("YWJj*")).toThrow();
  });

  test("a length that is not a multiple of four is refused", () => {
    expect(() => P.fromBase64("YWJja")).toThrow();
  });

  test("padding in the middle is refused", () => {
    expect(() => P.fromBase64("YQ==YQ==")).toThrow();
  });
});

describe("utf8", () => {
  test("ASCII round-trips", () => {
    expect(P.utf8Encode("hello")).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    expect(P.utf8Decode(new Uint8Array([104, 101, 108, 108, 111]))).toBe("hello");
  });

  test("a two-byte and a three-byte codepoint", () => {
    expect(P.utf8Encode("é")).toEqual(new Uint8Array([0xc3, 0xa9]));
    expect(P.utf8Encode("€")).toEqual(new Uint8Array([0xe2, 0x82, 0xac]));
    expect(P.utf8Decode(new Uint8Array([0xe2, 0x82, 0xac]))).toBe("€");
  });

  test("a four-byte codepoint (surrogate pair) round-trips", () => {
    const g = "\u{1D11E}"; // MUSICAL SYMBOL G CLEF
    expect(P.utf8Encode(g)).toEqual(new Uint8Array([0xf0, 0x9d, 0x84, 0x9e]));
    expect(P.utf8Decode(new Uint8Array([0xf0, 0x9d, 0x84, 0x9e]))).toBe(g);
  });

  test("Arabic, because the corpus is UAE bank mail", () => {
    const s = "مرحبا";
    expect(P.utf8Decode(P.utf8Encode(s))).toBe(s);
  });

  // Encoding is WHATWG, not "throw": an unpaired surrogate becomes U+FFFD.
  test("a lone high surrogate encodes as the replacement character", () => {
    expect(P.utf8Encode("\uD800")).toEqual(new Uint8Array([0xef, 0xbf, 0xbd]));
  });

  test("a lone low surrogate encodes as the replacement character", () => {
    expect(P.utf8Encode("a\uDC00b")).toEqual(new Uint8Array([0x61, 0xef, 0xbf, 0xbd, 0x62]));
  });

  // Decoding is non-fatal, matching what Go's encoding/json does with invalid
  // UTF-8 inside a string — `wire/op.ts:parseBody` depends on this NOT throwing.
  test("invalid bytes decode to the replacement character rather than throwing", () => {
    expect(P.utf8Decode(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a�b");
    expect(P.utf8Decode(new Uint8Array([0xc3]))).toBe("�");
  });

  // `TextDecoder`'s DEFAULT is `ignoreBOM: false`, which means the BOM is
  // consumed and removed. A hand-rolled decoder keeps it, producing a leading
  // U+FEFF in a JSON body that then fails to parse. `norm/charset.ts:87` opts
  // OUT of this with `ignoreBOM: true`; the seam's default must opt in.
  test("a leading UTF-8 BOM is stripped", () => {
    expect(P.utf8Decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
  });

  test("a BOM that is not leading is kept", () => {
    expect(P.utf8Decode(new Uint8Array([0x61, 0xef, 0xbb, 0xbf, 0x62]))).toBe("a﻿b");
  });
});

describe("random", () => {
  test("randomUUID is a v4 UUID", () => {
    const u = P.randomUUID();
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("randomUUID does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(P.randomUUID());
    expect(seen.size).toBe(200);
  });

  test("randomBytes returns the requested length", () => {
    expect(P.randomBytes(0).length).toBe(0);
    expect(P.randomBytes(1).length).toBe(1);
    expect(P.randomBytes(32).length).toBe(32);
  });

  // Not a randomness test — a test that the buffer was actually filled. A stub
  // returning `new Uint8Array(n)` passes a length check and hands the writer
  // registration a constant nonce.
  test("randomBytes fills the buffer", () => {
    const a = P.toHex(P.randomBytes(32));
    expect(a).not.toBe("00".repeat(32));
    expect(a).not.toBe(P.toHex(P.randomBytes(32)));
  });
});

describe("the registry", () => {
  test("bunPlatform is installed on import", () => {
    expect(platform()).toBe(bunPlatform);
  });

  test("setPlatform swaps the active implementation, and it can be restored", () => {
    const fake: Platform = { ...bunPlatform, randomUUID: () => "00000000-0000-4000-8000-000000000000" };
    try {
      setPlatform(fake);
      expect(platform()).toBe(fake);
      expect(platform().randomUUID()).toBe("00000000-0000-4000-8000-000000000000");
    } finally {
      setPlatform(bunPlatform);
    }
    expect(platform()).toBe(bunPlatform);
  });
});
