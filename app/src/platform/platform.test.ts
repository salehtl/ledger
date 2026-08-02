/**
 * The React Native `Platform`, run against the seam's contract on this box.
 *
 * # Why this file exists rather than re-running the client's own
 *
 * `client/src/platform.test.ts` is the contract, and it opens by saying so:
 * *"the specification a SECOND implementation has to satisfy"*. It pins that
 * specification against `bunPlatform` via a hard-coded `const P = bunPlatform`,
 * so it cannot be pointed at another implementation without either editing it
 * (the collected-count gate says no test may be weakened, and swapping the
 * subject weakens all 51) or having `client/` import from `app/` (the
 * dependency inversion Task 5 refused for the same reason).
 *
 * So the vectors are mirrored here. Mirroring drifts, so the drift is measured:
 * the last `describe` in this file reads `client/src/platform.test.ts` off disk
 * and fails if it contains a vector this file has no counterpart for. Adding a
 * vector to the contract turns this file red until it is mirrored.
 *
 * # What this does NOT establish
 *
 * Every module under test here is pure JavaScript, so this runs the real
 * implementation — but it runs it on **Bun, not Hermes**. Hermes has a
 * different regex engine, a different `Date` parser and a different BigInt, and
 * `expo-crypto` is not exercised at all (`index.ts` injects it; this file
 * injects a Bun-backed `RandomSource` with the same contract). Task 4 Step 4's
 * on-device run against these same vectors is still owed and is not discharged
 * by a green run here.
 */

import { describe, expect, test } from "bun:test";
import { randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from "node:crypto";

import { createPlatform } from "./platform.ts";

const P = createPlatform({
  randomUUID: () => nodeRandomUUID(),
  randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
});

const hexToBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

describe("sha256", () => {
  test("the empty string", () => {
    expect(P.toHex(P.sha256(new Uint8Array(0)))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test('"abc"', () => {
    expect(P.toHex(P.sha256(P.utf8Encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

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

  /**
   * The contract's version of this test asserts byte-equality with
   * `zlib.gzipSync(x, {level: 9})`. That works there because it compares zlib
   * against itself. `fflate` is a different DEFLATE implementation with
   * different match choices, so byte-equality is the wrong assertion here and
   * asserting it would only prove `fflate` is not zlib.
   *
   * The level is pinned directly instead, at the byte gzip reserves for it.
   * **XFL (header byte 8) is 2 for maximum compression and 0 for the default**
   * — `fflate`'s `gzh` writes `o.level == 9 ? 2 : 0`, and zlib writes the same
   * (measured: 2 at level 9, 0 at level 6). That is an independent observation
   * of the level rather than a size comparison, which on a highly compressible
   * input is not an observation at all: the first draft of this test compared
   * level 9 against the default and both produced exactly 50 bytes.
   *
   * Then both interop directions, which is what a shared corpus actually needs.
   */
  test("compresses at level 9", async () => {
    const { gzipSync: fflateDefault } = await import("fflate");
    const { gunzipSync: zlibGunzip, gzipSync: zlibGzip } = await import("node:zlib");
    // `new Uint8Array(x)` rather than passing `x` straight through: TypeScript
    // 5.7 made `Uint8Array` generic over its buffer, and `@types/node` wants
    // `Uint8Array<ArrayBuffer>` where the seam returns `Uint8Array<ArrayBufferLike>`.
    const plain = new Uint8Array(P.utf8Encode("aaaabbbbcccc".repeat(400)));

    expect(P.gzip(plain)[8]).toBe(2); // XFL = maximum compression
    expect(fflateDefault(plain, { mtime: 0 })[8]).toBe(0); // and the default is distinguishable
    expect(new Uint8Array(zlibGzip(plain, { level: 9 }))[8]).toBe(2); // zlib agrees on the encoding

    // A gzip stream zlib accepts, and a zlib stream this accepts.
    expect(new Uint8Array(zlibGunzip(new Uint8Array(P.gzip(plain))))).toEqual(plain);
    expect(P.gunzip(new Uint8Array(zlibGzip(plain, { level: 9 })), 1 << 20)).toEqual(plain);
  });

  test("output under the cap is returned whole", () => {
    const plain = new Uint8Array(1000).fill(0x41);
    expect(P.gunzip(P.gzip(plain), 1000).length).toBe(1000);
  });

  test("a gzip bomb throws at the cap", () => {
    const bomb = P.gzip(new Uint8Array(4 << 20));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => P.gunzip(bomb, 1024)).toThrow();
  });

  // The bomb test above only proves the cap THROWS. It cannot tell "refused
  // during inflation" from "inflated 32 MiB, then measured, then threw" — both
  // throw, and the second is a remote OOM on a phone.
  //
  // Timing, but not a magic millisecond: the capped path is compared against
  // the SAME implementation inflating the SAME bomb with a cap that never
  // trips, so machine speed, engine and background load cancel out.
  //
  // If this ever goes red, the fix is an implementation that bounds output
  // during inflation — NOT a smaller ratio. `fflate` has no `maxOutputLength`,
  // so the mechanism is slice-by-slice feeding with a throw out of `ondata`;
  // see `gzip.ts`.
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
    // The message, not just the throw. Cutting the 8-byte footer leaves the
    // deflate stream complete, so `fflate` decodes 1,100 bytes and reports no
    // error at all — the first draft of `gzip.ts` returned them. What catches
    // it is the gzip length field, read from what is now deflate data. A bare
    // `toThrow()` cannot tell that apart from the CRC check firing, and
    // removing the length check then survives the whole suite (mutation M04).
    expect(() => P.gunzip(z.subarray(0, z.length - 8), 1 << 20)).toThrow(/length field/);
  });

  test("non-gzip input throws", () => {
    expect(() => P.gunzip(P.utf8Encode("not gzip at all, not even close"), 1 << 20)).toThrow();
  });

  // Not in the contract, and they should be. `fflate`'s `Gunzip` hands the
  // `final` flag from `push` straight back to the callback, so "did the stream
  // end?" answered from that flag is true by construction — the first draft of
  // `gzip.ts` did exactly that and returned 1,100 bytes for a gzip with its
  // footer removed. The footer is checked instead, and these are its two
  // halves, each corrupted so that only one of the two checks can see it.
  test("a payload byte flipped mid-stream is caught by the gzip CRC", () => {
    const z = P.gzip(P.utf8Encode("hello world".repeat(100)));
    const bad = new Uint8Array(z);
    // Flip a bit in the CRC field itself: the deflate stream and the length
    // field are both untouched, so the CRC is the only check that can fire.
    bad[bad.length - 5] = (bad[bad.length - 5] as number) ^ 0x01;
    expect(() => P.gunzip(bad, 1 << 20)).toThrow(/CRC mismatch/);
  });

  test("a declared length that disagrees with what decoded is refused", () => {
    const z = P.gzip(P.utf8Encode("hello world".repeat(100)));
    const bad = new Uint8Array(z);
    // Tamper ISIZE only. The CRC still matches, so this isolates the O(1)
    // length check — which must also run first, before a megabyte of
    // attacker-supplied output is hashed to reach the same conclusion.
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 0x01;
    expect(() => P.gunzip(bad, 1 << 20)).toThrow(/length field/);
  });
});

describe("ed25519", () => {
  // RFC 8032 §7.1 test vectors.
  const seed1 = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  const pub1 = hexToBytes("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const sig1 = hexToBytes(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );
  const seed2 = hexToBytes("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
  const pub2 = hexToBytes("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
  const sig2 = hexToBytes(
    "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  );

  test("derives RFC 8032 test 1's public key from its seed", () => {
    expect(P.ed25519PublicKey(seed1)).toEqual(pub1);
  });

  test("signs RFC 8032 test 1's empty message to the published signature", () => {
    expect(P.ed25519Sign(seed1, new Uint8Array(0))).toEqual(sig1);
  });

  test("RFC 8032 test 2", () => {
    expect(P.ed25519PublicKey(seed2)).toEqual(pub2);
    expect(P.ed25519Sign(seed2, new Uint8Array([0x72]))).toEqual(sig2);
  });

  test("Ed25519 is deterministic — the same message signs identically twice", () => {
    const msg = P.utf8Encode("the same message, twice");
    expect(P.ed25519Sign(seed1, msg)).toEqual(P.ed25519Sign(seed1, msg));
  });

  test("a generated key's public half is the one derived from its private half", () => {
    const { priv, pub } = P.ed25519GenerateKey();
    expect(priv.length).toBe(32);
    expect(pub.length).toBe(32);
    expect(P.ed25519PublicKey(priv)).toEqual(pub);
  });

  test("two generated keys differ", () => {
    expect(P.toHex(P.ed25519GenerateKey().priv)).not.toBe(P.toHex(P.ed25519GenerateKey().priv));
  });

  test("a seed that is not 32 bytes is refused", () => {
    expect(() => P.ed25519PublicKey(new Uint8Array(31))).toThrow();
    expect(() => P.ed25519Sign(new Uint8Array(33), new Uint8Array(1))).toThrow();
  });
});

describe("hex", () => {
  test("a leading zero byte survives", () => {
    expect(P.toHex(new Uint8Array([0x00, 0x01, 0x0f]))).toBe("00010f");
  });

  test("0xFF and the full byte range round-trip", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const h = P.toHex(all);
    expect(h.length).toBe(512);
    expect(h.endsWith("ff")).toBe(true);
    expect(P.fromHex(h)).toEqual(all);
  });

  test("the empty input round-trips", () => {
    expect(P.toHex(new Uint8Array(0))).toBe("");
    expect(P.fromHex("")).toEqual(new Uint8Array(0));
  });

  test("output is lower case", () => {
    expect(P.toHex(new Uint8Array([0xab, 0xcd, 0xef]))).toBe("abcdef");
  });

  test("odd length is refused", () => {
    expect(() => P.fromHex("abc")).toThrow();
  });

  test("a non-hex character is refused rather than truncating", () => {
    expect(() => P.fromHex("zz")).toThrow();
    expect(() => P.fromHex("00zz11")).toThrow();
  });

  test("upper case is refused — chain hashes are lower-case hex on the wire", () => {
    expect(() => P.fromHex("ABCDEF")).toThrow();
  });
});

describe("base64", () => {
  test("a leading zero byte and a 0xFF byte round-trip", () => {
    const b = new Uint8Array([0x00, 0xff, 0x00, 0xff]);
    expect(P.fromBase64(P.toBase64(b))).toEqual(b);
  });

  test("each padding length", () => {
    expect(P.toBase64(P.utf8Encode("a"))).toBe("YQ==");
    expect(P.toBase64(P.utf8Encode("ab"))).toBe("YWI=");
    expect(P.toBase64(P.utf8Encode("abc"))).toBe("YWJj");
    expect(P.utf8Decode(P.fromBase64("YQ=="))).toBe("a");
    expect(P.utf8Decode(P.fromBase64("YWI="))).toBe("ab");
    expect(P.utf8Decode(P.fromBase64("YWJj"))).toBe("abc");
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
    // 0xFB 0xEF 0xBE -> "++++"-ish; pick bytes that hit indices 62 and 63.
    const b = new Uint8Array([0xfb, 0xff, 0xbf]);
    const s = P.toBase64(b);
    expect(s).toContain("+");
    expect(s).toContain("/");
    expect(s).not.toContain("-");
    expect(s).not.toContain("_");
  });

  test("characters outside the standard alphabet are refused, not skipped", () => {
    expect(() => P.fromBase64("YQ-=")).toThrow();
    expect(() => P.fromBase64("YQ_=")).toThrow();
    expect(() => P.fromBase64("Y Q==")).toThrow();
  });

  test("a length that is not a multiple of four is refused", () => {
    expect(() => P.fromBase64("YQ")).toThrow();
    expect(() => P.fromBase64("YWJjZ")).toThrow();
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

  test("a lone high surrogate encodes as the replacement character", () => {
    expect(P.utf8Encode("\uD800")).toEqual(new Uint8Array([0xef, 0xbf, 0xbd]));
  });

  test("a lone low surrogate encodes as the replacement character", () => {
    expect(P.utf8Encode("a\uDC00b")).toEqual(new Uint8Array([0x61, 0xef, 0xbf, 0xbd, 0x62]));
  });

  test("invalid bytes decode to the replacement character rather than throwing", () => {
    expect(P.utf8Decode(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a�b");
    expect(P.utf8Decode(new Uint8Array([0xc3]))).toBe("�");
  });

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

  test("randomBytes fills the buffer", () => {
    const a = P.toHex(P.randomBytes(32));
    expect(a).not.toBe("00".repeat(32));
    expect(a).not.toBe(P.toHex(P.randomBytes(32)));
  });

  // Not in the contract, and it should be: `createPlatform` takes the RNG as a
  // parameter precisely so no `Math.random` fallback can hide in it, and the
  // Ed25519 seed is the value where that would matter most.
  test("ed25519GenerateKey draws its seed from the injected RNG, not a fallback", () => {
    const seed = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    const scripted = createPlatform({
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      randomBytes: (n) => seed.subarray(0, n),
    });
    const { priv, pub } = scripted.ed25519GenerateKey();
    expect(priv).toEqual(seed);
    expect(pub).toEqual(hexToBytes("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"));
  });
});

/**
 * The drift guard.
 *
 * A mirrored contract only stays a contract while it stays mirrored. This reads
 * the source of `client/src/platform.test.ts` and requires every vector title
 * in it to exist in this file too. It is deliberately title-based rather than
 * count-based: a count can be satisfied by adding any test at all.
 *
 * The one exception is the registry pair, which tests `client/src`'s module
 * registry rather than any implementation — `setPlatform` is called by
 * `app/src/platform/index.ts`, whose `expo-crypto` import cannot load here.
 */
describe("contract drift against client/src/platform.test.ts", () => {
  const EXEMPT = new Set(["bunPlatform is installed on import", "setPlatform swaps the active implementation, and it can be restored"]);

  const titles = (src: string): string[] => {
    const out: string[] = [];
    const re = /^\s*test\((["'`])((?:\\.|(?!\1).)*)\1/gm;
    for (const m of src.matchAll(re)) out.push((m[2] as string).replace(/\\(["'`])/g, "$1"));
    return out;
  };

  test("every contract vector has a counterpart here", async () => {
    const contractPath = new URL("../../../client/src/platform.test.ts", import.meta.url).pathname;
    const contract = titles(await Bun.file(contractPath).text());
    const mine = new Set(titles(await Bun.file(new URL(import.meta.url).pathname).text()));

    // The guard is worthless if it read the wrong file or matched nothing.
    expect(contract.length).toBeGreaterThan(40);

    const missing = contract.filter((t) => !EXEMPT.has(t) && !mine.has(t));
    expect(missing).toEqual([]);
  });
});
