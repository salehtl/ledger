/**
 * The `@noble` CONTROL ARM: the pure-JavaScript open, in full.
 *
 * This is not a fallback and it is not dead code. It is the measurement's
 * denominator. Phase 0 measured 14.86 ms per blob for the same work on the
 * operator's daily iPhone; running the identical library on the SAME device in
 * the SAME session is what makes `R = C_noble / C_native` a within-device ratio
 * rather than a comparison of two different phones, which is
 * `spike/phase0/RESULTS.md` Caveat 1's entire complaint.
 *
 * # It must do exactly the work the native arm does — no more, no less
 *
 * Per record: one X25519 scalar multiplication, one HKDF-SHA256 extract+expand,
 * one AES-256-GCM open. The recipient's own public key is derived ONCE, outside
 * the loop, because it is a constant of the recipient and the native module does
 * the same. Nothing else may be hoisted:
 *
 *  - Hoisting the X25519 agreement measures fallback F4 (one KEM per epoch) and
 *    reports a speedup the production design does not have.
 *  - Hoisting the HKDF derive is the same mistake one layer down. Phase 0
 *    hoisted `derivePub` because it genuinely was constant; the per-record
 *    derive is not.
 *
 * {@link openNoble} therefore takes a prepared {@link NobleRecipient} holding
 * only the two genuinely constant values, and does everything else inline.
 */

import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { aadBytes, cipherRegion, embeddedAAD, encOf, ENC_INFO, equalBytes, nonceOf, type Position } from "./frame.ts";

const encoder = new TextEncoder();

export interface NobleRecipient {
  priv: Uint8Array;
  /** Derived once. The native module derives it once per call too. */
  pub: Uint8Array;
  info: Uint8Array;
}

export function nobleRecipient(priv: Uint8Array, info: string = ENC_INFO): NobleRecipient {
  if (priv.length !== 32) throw new Error(`recipient private key is ${priv.length} bytes, want 32`);
  return { priv, pub: x25519.getPublicKey(priv), info: encoder.encode(info) };
}

/**
 * Opens one framed v2 record and returns the decrypted sealed region.
 *
 * The region — `[4B payloadLen][gzip payload][zero padding]` — is returned
 * verbatim, exactly as the native module returns it, so the two arms are
 * measuring the same boundary. Gunzip is the caller's, through the platform
 * seam, which enforces the output cap during inflation.
 */
export function openNoble(rec: NobleRecipient, record: Uint8Array): Uint8Array {
  const enc = encOf(record);
  const nonce = nonceOf(record);
  const aad = embeddedAAD(record);
  const shared = x25519.getSharedSecret(rec.priv, enc);
  const salt = new Uint8Array(enc.length + rec.pub.length);
  salt.set(enc, 0);
  salt.set(rec.pub, enc.length);
  const key = hkdf(sha256, shared, salt, rec.info, 32);
  return gcm(key, nonce, aad).decrypt(cipherRegion(record));
}

/**
 * Opens a record AT a claimed position, which is what `openBlob` guarantees and
 * what {@link openNoble} alone does not.
 *
 * The AEAD binds the AAD it reads out of the frame, so a blob replayed to
 * another position authenticates perfectly against its own embedded AAD and
 * opens. The position check has to come from the caller's envelope — this is the
 * same defect the Go tests caught in `EncSealer.Open`'s first draft, kept here so
 * the two implementations agree about what "open" means.
 */
export function openNobleAt(rec: NobleRecipient, p: Position, record: Uint8Array): Uint8Array {
  if (!equalBytes(embeddedAAD(record), aadBytes(p))) {
    throw new Error("associated data mismatch: sealed at a different position");
  }
  return openNoble(rec, record);
}
