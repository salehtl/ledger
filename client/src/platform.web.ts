/**
 * The browser `Platform`: WebCrypto has no synchronous digest/sign, so this
 * is pure JS over `@noble/hashes`, `@noble/curves` and `fflate` instead —
 * same shape as `bunPlatform` in `platform.ts`, same contract in
 * `platform.test.ts` (mirrored for this module in `platform.web.test.ts`).
 *
 * This module does NOT call `setPlatform` on import. `bunPlatform` in
 * `platform.ts` auto-installs itself for tests and any Bun/Node entrypoint;
 * the browser app calls `setPlatform(webPlatform)` explicitly at boot, once,
 * before anything reaches the seam.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { gzipSync, Gunzip } from "fflate";
import { aesGcmOpen, aesGcmSeal } from "./platform.aead";
import { argon2idOf } from "./platform.argon2";
import type { Argon2idParams, Platform } from "./platform";

const HEX = "0123456789abcdef";
const HEX_STRICT = /^([0-9a-f]{2})*$/;
const BASE64_STRICT = /^[A-Za-z0-9+/]*={0,2}$/;

// Hoisted like bunPlatform's — this runs per stored record on the cold
// restore path, so a fresh TextEncoder/TextDecoder per call is a real cost,
// not a style nit.
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

// A table-based CRC32 (the IEEE 802.3 / gzip polynomial), built once. Used to
// validate a gzip trailer ourselves — see the comment in `gunzip` below for
// why fflate's own decode does not do this.
const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32LE(b: Uint8Array, offset: number): number {
  return ((b[offset]! | (b[offset + 1]! << 8) | (b[offset + 2]! << 16) | (b[offset + 3]! << 24)) >>> 0);
}

// Chosen so a single push() call — even fed the most compressible input
// possible — never materializes an unbounded amount of output before the
// running-total check below gets a chance to reject it. Deflate's worst-case
// expansion is roughly 1032 bytes of output per byte of compressed input (an
// LZ77 back-reference can copy up to 258 bytes for a handful of coded bits),
// so this bounds a single push to roughly CHUNK * 1032 bytes — about 260 KiB
// for CHUNK=256 — confirmed by feeding a 64 MiB all-zero bomb through this
// exact path (240 KB materialized before the cap tripped). That is the true
// bound: NOT "one chunk of compressed input", because a highly compressible
// chunk decodes to far more than its own byte count.
const GUNZIP_CHUNK = 256;

export const webPlatform: Platform = {
  sha256(data: Uint8Array): Uint8Array {
    return sha256(data);
  },

  gzip(data: Uint8Array): Uint8Array {
    // `mtime: 0` matters: fflate stamps the wall clock into the gzip header
    // by default (bytes 4-7), which would make sealing the same content
    // twice on the same device produce two different blobs — and per
    // `platform.ts`, the gzip result IS what the chain hashes and what picks
    // the size bucket. Byte-identity with `bunPlatform`'s output is not
    // achievable (different deflate implementations produce different
    // compressed bytes for the same input) and is not required; determinism
    // of THIS implementation against itself is what's required, and that's
    // what `mtime: 0` buys.
    return gzipSync(data, { level: 9, mtime: 0 });
  },

  gunzip(data: Uint8Array, maxOutputBytes: number): Uint8Array {
    // Single inflate pass. The compressed input is fed to fflate's streaming
    // `Gunzip` in small chunks (see `GUNZIP_CHUNK` above for why the chunk
    // size is what it is), and the running decompressed total is checked
    // after every chunk, aborting the moment it exceeds the cap — bounding
    // how much of a bomb's output is ever materialized, rather than the
    // whole bomb.
    let total = 0;
    let overCap = false;
    const outChunks: Uint8Array[] = [];

    const inflator = new Gunzip((chunk: Uint8Array) => {
      if (overCap) return;
      total += chunk.length;
      if (total > maxOutputBytes) {
        overCap = true;
        return;
      }
      outChunks.push(chunk);
    });

    if (data.length === 0) {
      inflator.push(data, true);
    } else {
      for (let i = 0; i < data.length && !overCap; i += GUNZIP_CHUNK) {
        const final = i + GUNZIP_CHUNK >= data.length;
        inflator.push(data.subarray(i, i + GUNZIP_CHUNK), final);
      }
    }

    if (overCap) {
      throw new Error(`gunzip: output exceeds cap of ${maxOutputBytes} bytes`);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of outChunks) {
      out.set(c, offset);
      offset += c.length;
    }

    // fflate's streaming `Gunzip` validates the header (the magic-byte check
    // in fflate's `gzs` throws synchronously above on a bad header, which is
    // how non-gzip input is already rejected) but does NOT verify the
    // trailing CRC32/ISIZE the way `bunPlatform`'s `node:zlib` gunzipSync
    // does — a single flipped byte in an otherwise well-formed stream
    // decodes "successfully" to the wrong bytes and returns silently. That
    // is exactly the corruption-masking failure this seam exists to refuse,
    // so the trailer is validated here, against the output already
    // accumulated above — not by inflating a second time, which would cost
    // a straight 2x on the cold-restore path (this function runs once per
    // stored record, across thousands of records).
    if (data.length < 18) throw new Error("gunzip: truncated gzip stream");
    const trailer = data.subarray(data.length - 8);
    const expectedCrc = readUint32LE(trailer, 0);
    const expectedIsize = readUint32LE(trailer, 4);
    const actualCrc = crc32(out);
    const actualIsize = out.length >>> 0; // ISIZE is the length mod 2^32.
    if (actualCrc !== expectedCrc || actualIsize !== expectedIsize) {
      throw new Error("gunzip: corrupt gzip data (CRC32/ISIZE mismatch)");
    }

    return out;
  },

  ed25519GenerateKey(): { priv: Uint8Array; pub: Uint8Array } {
    const priv = ed25519.utils.randomSecretKey();
    return { priv, pub: ed25519.getPublicKey(priv) };
  },

  ed25519PublicKey(priv: Uint8Array): Uint8Array {
    if (priv.length !== 32) throw new TypeError(`ed25519 private key must be 32 bytes, got ${priv.length}`);
    return ed25519.getPublicKey(priv);
  },

  // noble's argument order is (message, privateKey) — the RFC 8032 vector
  // catches a swap.
  ed25519Sign(priv: Uint8Array, msg: Uint8Array): Uint8Array {
    if (priv.length !== 32) throw new TypeError(`ed25519 private key must be 32 bytes, got ${priv.length}`);
    return ed25519.sign(msg, priv);
  },

  // noble's X25519, against `platform.ts`'s `node:crypto` one. Two
  // implementations, RFC 7748's vectors on both — the same arrangement Ed25519
  // above already has.
  x25519GenerateKey(): { priv: Uint8Array; pub: Uint8Array } {
    const priv = x25519.utils.randomSecretKey();
    return { priv, pub: x25519.getPublicKey(priv) };
  },

  x25519PublicKey(priv: Uint8Array): Uint8Array {
    if (priv.length !== 32) throw new TypeError(`x25519 private key must be 32 bytes, got ${priv.length}`);
    return x25519.getPublicKey(priv);
  },

  // The same implementation `bunPlatform` runs — see `platform.argon2.ts`.
  argon2id(password: Uint8Array, salt: Uint8Array, params: Argon2idParams): Uint8Array {
    return argon2idOf(password, salt, params);
  },

  aesGcmSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    return aesGcmSeal(key, nonce, aad, plaintext);
  },

  aesGcmOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
    return aesGcmOpen(key, nonce, aad, sealed);
  },

  randomUUID(): string {
    return crypto.randomUUID();
  },

  randomBytes(n: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(n));
  },

  toHex(b: Uint8Array): string {
    let s = "";
    for (const byte of b) s += HEX.charAt(byte >> 4) + HEX.charAt(byte & 15);
    return s;
  },

  fromHex(s: string): Uint8Array {
    if (!HEX_STRICT.test(s)) throw new TypeError(`not lower-case hex: ${JSON.stringify(s)}`);
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  },

  toBase64(b: Uint8Array): string {
    // Chunked: String.fromCharCode(...b) blows the argument limit on large
    // blobs.
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) {
      s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    }
    return btoa(s);
  },

  fromBase64(s: string): Uint8Array {
    // `atob` silently skips characters outside the alphabet and tolerates
    // padding anywhere, which turns a corrupted body into a plausible-looking
    // short one — the same failure mode `platform.ts`'s doc comment calls out
    // for `Buffer.from(s, "base64")`. Validate strictly first.
    if (s.length % 4 !== 0 || !BASE64_STRICT.test(s)) throw new TypeError(`not standard base64: ${JSON.stringify(s)}`);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },

  utf8Encode(s: string): Uint8Array {
    return utf8Encoder.encode(s);
  },

  utf8Decode(b: Uint8Array): string {
    return utf8Decoder.decode(b);
  },
};
