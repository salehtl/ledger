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
import { ed25519 } from "@noble/curves/ed25519.js";
import { gzipSync, gunzipSync, Gunzip } from "fflate";
import type { Platform } from "./platform";

const HEX = "0123456789abcdef";
const HEX_STRICT = /^([0-9a-f]{2})*$/;
const BASE64_STRICT = /^[A-Za-z0-9+/]*={0,2}$/;

export const webPlatform: Platform = {
  sha256(data: Uint8Array): Uint8Array {
    return sha256(data);
  },

  gzip(data: Uint8Array): Uint8Array {
    return gzipSync(data, { level: 9 });
  },

  gunzip(data: Uint8Array, maxOutputBytes: number): Uint8Array {
    // fflate's `gunzipSync` has no incremental "stop inflating past N bytes"
    // hook the way Node's zlib does with `maxOutputLength`, so the cap is
    // enforced first via the streaming `Gunzip` API: the COMPRESSED input is
    // fed in small chunks, and the running decompressed total is checked
    // after every chunk, aborting the moment it exceeds the cap. That bounds
    // how much of a bomb's output is ever materialized to roughly one
    // chunk's worth of expansion past the cap, rather than the whole bomb.
    //
    // Once the streaming pass proves the true output is within the cap, a
    // second pass through `gunzipSync` re-derives the result through fflate's
    // CRC32/ISIZE-trailer-checked path — cheap at this point because the
    // output is already known to be small — which catches a truncated or
    // corrupted trailer that the streaming path alone does not validate.
    const CHUNK = 8192;
    let total = 0;
    let overCap = false;

    const inflator = new Gunzip((chunk: Uint8Array) => {
      if (overCap) return;
      total += chunk.length;
      if (total > maxOutputBytes) overCap = true;
    });

    if (data.length === 0) {
      inflator.push(data, true);
    } else {
      for (let i = 0; i < data.length && !overCap; i += CHUNK) {
        const final = i + CHUNK >= data.length;
        inflator.push(data.subarray(i, i + CHUNK), final);
      }
    }

    if (overCap) {
      throw new Error(`gunzip: output exceeds cap of ${maxOutputBytes} bytes`);
    }

    return gunzipSync(data);
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
    return new TextEncoder().encode(s);
  },

  utf8Decode(b: Uint8Array): string {
    return new TextDecoder("utf-8").decode(b);
  },
};
