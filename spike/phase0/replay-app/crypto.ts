import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { gunzipSync } from "fflate";

export const RECORD_SIZE = 1016;
const PAD_SIZE = 968;
const INFO = new TextEncoder().encode("ledger-phase0");
const ZERO_NONCE = new Uint8Array(12);

// Derive the recipient's public key once per private key. This is a real
// elliptic-curve scalar multiplication (the same cost as the per-record
// shared-secret derivation below), but the recipient key is fixed for the
// whole corpus — callers must derive it once and pass it into every
// openBlob call. openBlob previously re-derived it on every record, which
// measured at ~45% of total decrypt time across 3,683 records (as much as
// the actually-required shared-secret derivation), and would have inflated
// decryptMs on-device where Hermes' BigInt is slower than V8's.
export function derivePub(recipPriv: Uint8Array): Uint8Array {
  return x25519.getPublicKey(recipPriv);
}

export function openBlob(blob: Uint8Array, recipPriv: Uint8Array, recipPub: Uint8Array): Uint8Array {
  if (blob.length !== RECORD_SIZE) throw new Error(`bad blob size ${blob.length}`);
  const ephPub = blob.subarray(0, 32);
  const shared = x25519.getSharedSecret(recipPriv, ephPub);
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(recipPub, 32);
  const key = hkdf(sha256, shared, salt, INFO, 32);
  const padded = gcm(key, ZERO_NONCE).decrypt(blob.subarray(32));
  const n = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  // Deliberate improvement over the brief's verbatim code: the Go reference
  // (main.go's open()) has no equivalent bound check because Go's slice
  // expression `padded[4 : 4+n]` panics safely as a recoverable runtime
  // error. In JS, `subarray` silently clamps out-of-range indices instead
  // of throwing, so a corrupt/malicious length prefix would otherwise feed
  // gunzipSync a truncated or wrong slice and fail with a confusing gzip
  // error deep in fflate — or on-device, surface as an unhandled throw with
  // no context. Fail fast with a clear message instead.
  if (n > PAD_SIZE - 4) throw new Error(`bad length prefix ${n} (max ${PAD_SIZE - 4})`);
  return gunzipSync(padded.subarray(4, 4 + n));
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
