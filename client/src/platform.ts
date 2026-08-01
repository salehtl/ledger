/**
 * # The platform seam
 *
 * `client/src` was written against Bun. Phase 2 runs the same source on Hermes,
 * inside a React Native app, and Hermes has no `Bun`, no `Buffer`, no
 * `node:zlib` and no `node:crypto`. This module is the one place that
 * difference is allowed to exist: everything above it — `replay/`,
 * `invariants/`, `norm/`, `tmpl/`, `wire/` — calls {@link platform} and never
 * touches a host primitive directly.
 *
 * ## What is deliberately NOT here
 *
 * **There is no `ed25519Verify`, and that is correct rather than an omission.**
 * `net/client.ts` imports `sign` and not `verify`, and `verifyChain`,
 * `verifyHashList` and `verifyFetchedRange` are sha256 linkage only. The client
 * never verifies a signature: "writer-chain verification" means *the blobs form
 * an unbroken sha256 chain*, not *an authenticated writer produced them*. The
 * signature gates writer REGISTRATION, server-side. If Phase 3 ever wants
 * clients to verify blob signatures, that is new work and a new method here.
 *
 * **There is no filesystem method.** `store/store.ts`'s `fileStore()` is
 * entirely `node:fs` — 0600 chmod, temp-file-plus-rename, a sidecar
 * `.gitignore` — and shimming that onto a phone would be the wrong shape
 * anyway. Task 5 replaces the whole store with a SQLite one; this seam
 * deliberately declines to make the file store portable.
 *
 * **There is no wall clock and no regex compiler.** `new Date` and `new RegExp`
 * remain direct calls: both exist on Hermes, and the risk with them is
 * *divergent behaviour*, not absence. That is measured on-device (Task 4 Steps
 * 4 and 5) rather than papered over with a wrapper that would hide the
 * divergence it exists to find.
 *
 * ## Loading this module on Hermes
 *
 * {@link bunPlatform} needs `node:zlib` and `node:crypto`, which are imported
 * statically because that is the only form Bun, `tsc` and Metro all agree on.
 * Metro will try to resolve them for the app bundle, so `app/`'s
 * `metro.config.js` must either map them to `{ type: "empty" }` in
 * `resolveRequest`, or shadow this file with a `platform.native.ts` sibling
 * (Metro prefers the `.native` extension automatically).
 *
 * Under either arrangement the auto-install below **measures** whether the
 * builtins actually arrived rather than sniffing for a runtime, so a stubbed
 * import leaves the registry empty and {@link platform} throws a sentence that
 * names the fix — instead of installing an implementation whose methods are all
 * `undefined`.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

/**
 * Every host primitive `client/src` needs, and nothing else.
 *
 * Implementations must satisfy `platform.test.ts` exactly. That file is the
 * contract — it is run against `bunPlatform` here and against the React Native
 * implementation on-device, and anything it does not pin is something the two
 * are free to disagree about.
 */
export interface Platform {
  /** SHA-256. Returns 32 bytes and never aliases its input. */
  sha256(data: Uint8Array): Uint8Array;

  /**
   * Gzip at **level 9**. The level is part of the contract, not an internal
   * detail: `sealBlob` compresses at 9, the framed result is what the chain
   * hashes, and the compressed length decides the size bucket.
   */
  gzip(data: Uint8Array): Uint8Array;

  /**
   * Gunzip under a hard output cap: output of `maxOutputBytes` is returned,
   * anything past it throws.
   *
   * **The cap must be enforced during inflation, not checked afterwards.** A
   * blob is attacker-influenced and the 1 MiB top bucket can carry a stream
   * that inflates to roughly a gigabyte, so "decompress then measure" is a
   * remote OOM on a phone. This is the sync equivalent of Go's
   * `io.LimitReader(zr, MaxPlaintext+1)`.
   */
  gunzip(data: Uint8Array, maxOutputBytes: number): Uint8Array;

  /** A fresh Ed25519 keypair. `priv` is the 32-byte seed, `pub` the 32-byte key. */
  ed25519GenerateKey(): { priv: Uint8Array; pub: Uint8Array };

  /** The public key for a 32-byte Ed25519 seed. Throws if `priv` is not 32 bytes. */
  ed25519PublicKey(priv: Uint8Array): Uint8Array;

  /** PureEdDSA over `msg` with a 32-byte seed. 64 bytes out, deterministic. */
  ed25519Sign(priv: Uint8Array, msg: Uint8Array): Uint8Array;

  /** A random v4 UUID, from a cryptographic source. */
  randomUUID(): string;

  /** `n` cryptographically random bytes. */
  randomBytes(n: number): Uint8Array;

  /** Lower-case hex. */
  toHex(b: Uint8Array): string;

  /**
   * Lower-case hex, **strictly**. Odd length, upper case or any non-hex
   * character throws.
   *
   * `Buffer.from(s, "hex")` stops at the first invalid character and returns a
   * SHORT buffer instead, which is how a corrupted 64-character chain hash
   * becomes a plausible-looking 20-byte one.
   */
  fromHex(s: string): Uint8Array;

  /** Standard base64, padded. Never the URL-safe alphabet. */
  toBase64(b: Uint8Array): string;

  /**
   * Standard base64, **strictly**: length a multiple of four, no character
   * outside `A-Za-z0-9+/`, padding only at the end.
   *
   * `Buffer.from(s, "base64")` silently skips anything outside the alphabet, so
   * a corrupted body comes back short and plausible — and a short blob is not a
   * size bucket, so it is reported as a bucket violation rather than as the
   * transport fault it is.
   */
  fromBase64(s: string): Uint8Array;

  /** WHATWG UTF-8 encoding: a lone surrogate becomes U+FFFD, never a throw. */
  utf8Encode(s: string): Uint8Array;

  /**
   * WHATWG UTF-8 decoding, **non-fatal** and **BOM-stripping** — the defaults of
   * a bare `new TextDecoder()`.
   *
   * Non-fatal because invalid UTF-8 must become U+FFFD rather than throw, which
   * is what Go's `encoding/json` does inside a string and what
   * `wire/op.ts:parseBody` relies on. BOM-stripping because `TextDecoder`'s
   * default `ignoreBOM: false` means "consume and remove the BOM" — the
   * opposite of what the option name reads like, and the opposite of what a
   * hand-rolled decoder does. `norm/charset.ts` opts out of this explicitly
   * with `ignoreBOM: true` and keeps using the global on purpose.
   */
  utf8Decode(b: Uint8Array): string;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

let active: Platform | undefined;

/**
 * Installs the implementation every call site will use. The app calls this at
 * module load, before anything reaches the seam.
 */
export function setPlatform(p: Platform): void {
  active = p;
}

/** The installed implementation. Throws if none has been installed. */
export function platform(): Platform {
  if (active === undefined) {
    throw new Error("no Platform installed: call setPlatform() before using the client library on this runtime");
  }
  return active;
}

// ---------------------------------------------------------------------------
// The Bun/Node implementation
// ---------------------------------------------------------------------------

const HEX = /^([0-9a-f]{2})*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The 16-byte PKCS#8 prelude for a raw Ed25519 seed: SEQUENCE, v0, OID 1.3.101.112, OCTET STRING(0x20). */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function seedToPKCS8(seed: Uint8Array): Buffer {
  if (seed.length !== 32) throw new TypeError(`ed25519 private key must be 32 bytes, got ${seed.length}`);
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  der.set(PKCS8_ED25519_PREFIX, 0);
  der.set(seed, PKCS8_ED25519_PREFIX.length);
  return Buffer.from(der);
}

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

/**
 * The default, installed on import wherever `node:zlib` and `node:crypto`
 * actually resolve. Bun and Node both qualify; Hermes does not.
 */
export const bunPlatform: Platform = {
  sha256(data: Uint8Array): Uint8Array {
    const h = new Bun.CryptoHasher("sha256");
    h.update(data);
    return new Uint8Array(h.digest());
  },

  gzip(data: Uint8Array): Uint8Array {
    return new Uint8Array(gzipSync(data, { level: 9 }));
  },

  gunzip(data: Uint8Array, maxOutputBytes: number): Uint8Array {
    // `maxOutputLength` makes zlib itself abort the inflate, so the cap costs
    // one allocation of the capped size rather than one of the bomb's size.
    return new Uint8Array(gunzipSync(data, { maxOutputLength: maxOutputBytes }));
  },

  ed25519GenerateKey(): { priv: Uint8Array; pub: Uint8Array } {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" }) as { x?: string; d?: string };
    if (typeof jwk.x !== "string" || typeof jwk.d !== "string") throw new Error("ed25519 key did not export as a JWK");
    return { priv: new Uint8Array(Buffer.from(jwk.d, "base64url")), pub: new Uint8Array(Buffer.from(jwk.x, "base64url")) };
  },

  ed25519PublicKey(priv: Uint8Array): Uint8Array {
    const pub = createPublicKey(createPrivateKey({ key: seedToPKCS8(priv), format: "der", type: "pkcs8" }));
    const jwk = pub.export({ format: "jwk" }) as { x?: string };
    if (typeof jwk.x !== "string") throw new Error("ed25519 public key did not export as a JWK");
    return new Uint8Array(Buffer.from(jwk.x, "base64url"));
  },

  ed25519Sign(priv: Uint8Array, msg: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, msg, createPrivateKey({ key: seedToPKCS8(priv), format: "der", type: "pkcs8" })));
  },

  randomUUID(): string {
    return randomUUID();
  },

  randomBytes(n: number): Uint8Array {
    return new Uint8Array(randomBytes(n));
  },

  toHex(b: Uint8Array): string {
    return Buffer.from(b).toString("hex");
  },

  fromHex(s: string): Uint8Array {
    if (!HEX.test(s)) throw new TypeError(`not lower-case hex: ${JSON.stringify(s)}`);
    return new Uint8Array(Buffer.from(s, "hex"));
  },

  toBase64(b: Uint8Array): string {
    return Buffer.from(b).toString("base64");
  },

  fromBase64(s: string): Uint8Array {
    if (s.length % 4 !== 0 || !BASE64.test(s)) throw new TypeError(`not standard base64: ${JSON.stringify(s)}`);
    return new Uint8Array(Buffer.from(s, "base64"));
  },

  utf8Encode(s: string): Uint8Array {
    return utf8Encoder.encode(s);
  },

  utf8Decode(b: Uint8Array): string {
    return utf8Decoder.decode(b);
  },
};

// Measured, not sniffed: if Metro stubbed the builtins out, these are
// `undefined` and the registry stays empty so `platform()` throws a sentence
// that names the fix, rather than installing an object of `undefined`s that
// fails somewhere far away.
if (typeof gzipSync === "function" && typeof randomUUID === "function" && typeof Bun !== "undefined") {
  setPlatform(bunPlatform);
}
