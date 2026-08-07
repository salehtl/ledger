/**
 * `webPlatform`'s contract, layered on top of `platform.test.ts`.
 *
 * (a) Fixed vectors: the subset of `platform.test.ts`'s pinned vectors most
 * likely to catch a hand-rolled implementation drifting — sha256 of the empty
 * string, RFC 8032 test-vector-1, hex/base64 leading-zero-byte and 0xFF
 * cases, and the four-byte-codepoint UTF-8 case — run again here directly
 * against `webPlatform`.
 *
 * (b) Cross-implementation equivalence: 50 pseudorandom byte strings (fixed
 * seed, not `Math.random`, so failures reproduce) checked byte-for-byte
 * between `webPlatform` and `bunPlatform` for sha256/toHex/toBase64/
 * utf8Encode, plus a gzip(web) -> gunzip(bun) round-trip (compressed bytes
 * may legitimately differ between gzip implementations; the round-trip may
 * not).
 *
 * (c) gzip determinism: `platform.ts` states the gzip result IS what the
 * chain hashes, so `webPlatform.gzip` must be deterministic against itself
 * even though it is not byte-identical to `bunPlatform`'s output.
 *
 * (d) The rest of `platform.test.ts`'s gunzip contract, replayed here rather
 * than by parameterizing `platform.test.ts` itself over both
 * implementations — that file is guarded, and importing `webPlatform` into
 * it would change its shape for `bunPlatform` too: truncated/non-gzip input
 * throws, the cap is refused during inflation (timing), and a CRC32
 * corruption case checked against `bunPlatform` (this implementation's own
 * regression: fflate's decode does not verify the gzip trailer's checksum on
 * its own).
 */

import { describe, expect, test } from "bun:test";
import { gzipSync } from "fflate";
import { bunPlatform } from "./platform";
import { webPlatform } from "./platform.web";

const W = webPlatform;

const hexToBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

// mulberry32 — deterministic, seedable, no dependency on Math.random.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytesFrom(rng: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

describe("webPlatform: fixed vectors", () => {
  test("sha256 of the empty string", () => {
    expect(W.toHex(W.sha256(new Uint8Array(0)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  describe("ed25519 RFC 8032 test vector 1", () => {
    const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const SIG =
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
      "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

    test("derives the public key from the seed", () => {
      expect(W.toHex(W.ed25519PublicKey(hexToBytes(SECRET)))).toBe(PUBLIC);
    });

    test("signs the empty message to the published signature", () => {
      expect(W.toHex(W.ed25519Sign(hexToBytes(SECRET), new Uint8Array(0)))).toBe(SIG);
    });
  });

  describe("hex", () => {
    test("a leading zero byte survives", () => {
      expect(W.toHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe("000fff");
    });

    test("0xFF and the full byte range round-trip", () => {
      const all = new Uint8Array(256);
      for (let i = 0; i < 256; i++) all[i] = i;
      const s = W.toHex(all);
      expect(s.length).toBe(512);
      expect(s.slice(0, 6)).toBe("000102");
      expect(s.slice(-6)).toBe("fdfeff");
      expect(W.fromHex(s)).toEqual(all);
    });

    test("odd length is refused", () => {
      expect(() => W.fromHex("abc")).toThrow();
    });

    test("upper case is refused", () => {
      expect(() => W.fromHex("AABB")).toThrow();
    });

    test("a non-hex character is refused rather than truncating", () => {
      expect(() => W.fromHex("00zz11")).toThrow();
    });
  });

  describe("base64", () => {
    test("a leading zero byte and a 0xFF byte round-trip", () => {
      expect(W.toBase64(new Uint8Array([0x00, 0xff]))).toBe("AP8=");
      expect(W.fromBase64("AP8=")).toEqual(new Uint8Array([0x00, 0xff]));
    });

    test("characters outside the standard alphabet are refused, not skipped", () => {
      expect(() => W.fromBase64("YW Jj")).toThrow();
      expect(() => W.fromBase64("YWJ\n")).toThrow();
      expect(() => W.fromBase64("-_-_")).toThrow();
      expect(() => W.fromBase64("YWJj*")).toThrow();
    });

    test("a length that is not a multiple of four is refused", () => {
      expect(() => W.fromBase64("YWJja")).toThrow();
    });

    test("padding in the middle is refused", () => {
      expect(() => W.fromBase64("YQ==YQ==")).toThrow();
    });
  });

  describe("utf8", () => {
    test("a four-byte codepoint (surrogate pair) round-trips", () => {
      const g = "\u{1D11E}"; // MUSICAL SYMBOL G CLEF
      expect(W.utf8Encode(g)).toEqual(new Uint8Array([0xf0, 0x9d, 0x84, 0x9e]));
      expect(W.utf8Decode(new Uint8Array([0xf0, 0x9d, 0x84, 0x9e]))).toBe(g);
    });

    test("a lone high surrogate encodes as the replacement character", () => {
      expect(W.utf8Encode("\uD800")).toEqual(new Uint8Array([0xef, 0xbf, 0xbd]));
    });

    test("a leading UTF-8 BOM is stripped", () => {
      expect(W.utf8Decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
    });
  });
});

describe("webPlatform vs bunPlatform: cross-implementation equivalence", () => {
  const rng = mulberry32(0xc0ffee);
  const samples: Uint8Array[] = [];
  for (let i = 0; i < 50; i++) {
    samples.push(randomBytesFrom(rng, Math.floor(rng() * 512)));
  }

  test("sha256 agrees byte-for-byte on 50 pseudorandom inputs", () => {
    for (const s of samples) {
      expect(W.toHex(W.sha256(s))).toBe(bunPlatform.toHex(bunPlatform.sha256(s)));
    }
  });

  test("toHex agrees on 50 pseudorandom inputs", () => {
    for (const s of samples) {
      expect(W.toHex(s)).toBe(bunPlatform.toHex(s));
    }
  });

  test("toBase64 agrees on 50 pseudorandom inputs", () => {
    for (const s of samples) {
      expect(W.toBase64(s)).toBe(bunPlatform.toBase64(s));
    }
  });

  test("utf8Encode agrees on a fixed set of strings, including surrogate/BOM edge cases", () => {
    const strs = [
      "",
      "hello",
      "é€",
      "\u{1D11E}",
      "مرحبا",
      "\uD800",
      "a\uDC00b",
    ];
    for (const s of strs) {
      expect(W.utf8Encode(s)).toEqual(bunPlatform.utf8Encode(s));
    }
  });

  test("bunPlatform.gunzip(webPlatform.gzip(x), 1<<20) round-trips for 50 pseudorandom inputs", () => {
    for (const s of samples) {
      expect(bunPlatform.gunzip(W.gzip(s), 1 << 20)).toEqual(s);
    }
  });
});

describe("webPlatform: gzip determinism", () => {
  // fflate stamps the wall clock into the gzip header (bytes 4-7, MTIME) by
  // default. `platform.ts` states the gzip result IS what the chain hashes
  // and what selects the size bucket, so sealing the same content twice on
  // the same device must produce the same blob bytes — `webPlatform.gzip`
  // passes `mtime: 0` for exactly this reason.
  test("gzip(x) equals gzip(x) across separate calls", () => {
    const plain = W.utf8Encode("the quick brown fox".repeat(50));
    const a = W.gzip(plain);
    const b = W.gzip(plain);
    expect(a).toEqual(b);
  });

  test("the header's MTIME field (bytes 4-7) is zero", () => {
    const z = W.gzip(W.utf8Encode("hello world"));
    expect([z[4], z[5], z[6], z[7]]).toEqual([0, 0, 0, 0]);
  });

  // Not byte-identical to bunPlatform — a different deflate implementation
  // legitimately produces different compressed bytes for the same input.
  // That is expected and is NOT what this asserts.
  test("gzip output size is not required to match bunPlatform's byte-for-byte", () => {
    const plain = W.utf8Encode("the quick brown fox".repeat(50));
    expect(W.gzip(plain)).not.toEqual(bunPlatform.gzip(plain));
  });
});

describe("webPlatform gunzip cap", () => {
  test("gunzip throws when output exceeds maxOutputBytes", () => {
    const bomb = W.gzip(new Uint8Array(4 << 20));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => W.gunzip(bomb, 1024)).toThrow();
  });

  test("output under the cap is returned whole", () => {
    const plain = new Uint8Array(1000).fill(0x41);
    expect(W.gunzip(W.gzip(plain), 1000).length).toBe(1000);
  });

  test("the cap is exact: one byte over throws, exactly at the cap does not", () => {
    const z = W.gzip(new Uint8Array(1000).fill(0x41));
    expect(() => W.gunzip(z, 1000)).not.toThrow();
    expect(() => W.gunzip(z, 999)).toThrow();
  });

  // Mirrors `platform.test.ts`'s "the cap is refused during inflation, not
  // after it" — the bomb test above only proves the cap throws, not that it
  // was refused cheaply. Same construction: the capped path is compared
  // against the SAME implementation inflating the SAME bomb with a cap that
  // never trips, so machine speed and background load cancel out. Measured
  // locally: a correct implementation is roughly 215-230x cheaper for a
  // 32 MiB bomb; an inflate-then-check implementation would be close to 1x
  // (never cheaper). The 4x threshold sits nowhere near either number.
  test("the cap is refused during inflation, not after it", () => {
    const N = 32 << 20;
    const bomb = W.gzip(new Uint8Array(N));
    const capped = () => {
      try {
        W.gunzip(bomb, 1024);
      } catch {
        /* expected */
      }
    };
    const full = () => W.gunzip(bomb, N + 1);

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

  test("truncated gzip throws rather than returning a short read", () => {
    const z = W.gzip(W.utf8Encode("hello world".repeat(100)));
    expect(() => W.gunzip(z.subarray(0, z.length - 8), 1 << 20)).toThrow();
  });

  test("non-gzip input throws", () => {
    expect(() => W.gunzip(W.utf8Encode("not gzip at all"), 1024)).toThrow();
  });

  // `compresses at level 9` for bunPlatform asserts byte-identity with
  // node:zlib at level 9 — not achievable here (different deflate
  // implementation, confirmed to differ by a byte even with mtime forced to
  // 0). What IS checkable without claiming byte-identity: level 9 compresses
  // at least as well as a much weaker level on the same compressible input.
  test("compresses at level 9 (checked via relative size, not byte-identity)", () => {
    const plain = W.utf8Encode("aaaabbbbcccc".repeat(400));
    const level9 = W.gzip(plain);
    const level1 = gzipSync(plain, { level: 1, mtime: 0 });
    expect(level9.length).toBeLessThanOrEqual(level1.length);
  });

  // The behavioural divergence this fix exists for: fflate's own decode does
  // not verify the gzip trailer's CRC32, so a single flipped byte in a
  // well-formed stream would otherwise decode "successfully" to the wrong
  // bytes on webPlatform while bunPlatform (node:zlib) throws. Both must
  // throw.
  test("a flipped CRC32 byte is refused, matching bunPlatform", () => {
    const plain = W.utf8Encode("the quick brown fox".repeat(50));
    const z = W.gzip(plain);
    const corrupt = z.slice();
    const i = corrupt.length - 5; // inside the CRC32 field
    corrupt[i] = (corrupt[i]! ^ 0xff) & 0xff;
    expect(() => W.gunzip(corrupt, 1 << 20)).toThrow();
    expect(() => bunPlatform.gunzip(corrupt, 1 << 20)).toThrow();
  });
});
