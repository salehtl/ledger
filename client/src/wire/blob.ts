/**
 * The on-the-wire envelope every v2 op-log row is stored in, mirroring
 * `internal/v2/blob/blob.go`: the framing, the size-bucket padding, and the
 * associated data that binds a blob to its position.
 *
 * # The wire format (frozen — see the Go package doc for why nothing may move)
 *
 * ```
 * [1B version=1][2B BE aadLen][aad][12B nonce][ sealed region ][16B tag]
 * total length == size bucket, exactly
 * ```
 *
 * where the sealed region is `[4B BE payloadLen][payload][zero padding]` and
 * payload = gzip(plaintext) — compress THEN seal, so Phase 3's ciphertext is
 * incompressible by construction and a body's compression ratio is not
 * observable from its stored size.
 *
 * Two details are load-bearing on this side of the port:
 *
 *  1. The padding AND the length prefix live INSIDE the sealed region. A
 *     cleartext length field would make bucket padding cosmetic — an observer
 *     would read the exact compressed size off the wire and the 1/4/16/… ladder
 *     would hide nothing.
 *  2. The nonce and tag slots are reserved NOW, as zeros. Adding them in Phase 3
 *     would push every blob whose payload sits within 28 bytes of a boundary
 *     into the next bucket, silently re-fingerprinting part of the corpus.
 *
 * # Phase 1 is PLAINTEXT
 *
 * Nothing here is confidential or authentic. The payload is readable, the AAD
 * comparison is a structural check against a caller-supplied envelope, and the
 * zero tag authenticates nothing. That is deliberate (the phase plan's global
 * constraints): code that "helpfully" seals early breaks the corpus-shape
 * measurements Phase 2 depends on. {@link openBlob} is the mirror of
 * `blob.PlaintextSealer.Open`, not of a future AEAD open.
 *
 * # Errors are set-aside, never hard stops
 *
 * Every failure {@link openBlob} raises for STORED BYTES is a
 * {@link BlobDecodeError}: that one blob is set aside with a visible warning and
 * sync continues (spec §3.3:68). A bad {@link Envelope} is an
 * {@link InvalidEnvelopeError} instead, because it is the caller's bug rather
 * than a property of the blob — the same line Go draws between `ErrSetAside` and
 * `ErrInvalidEnvelope`.
 */

import { platform } from "../platform";
import { BlobDecodeError, InvalidEnvelopeError } from "./op";

/** The envelope version byte. It versions the FRAMING, not the ops inside. */
export const VERSION = 1;

const VERSION_SIZE = 1;
const AAD_LEN_SIZE = 2;
const PAYLOAD_LEN_SIZE = 4;

/** 96 bits, the size AES-GCM uses (spec §3.4). Reserved and zero in Phase 1. */
export const NONCE_SIZE = 12;
/** The AES-GCM authentication tag. Reserved and zero in Phase 1. */
export const TAG_SIZE = 16;

/**
 * Bounds the plaintext on BOTH sides: {@link sealBlob} refuses to frame more,
 * {@link openBlob} refuses to decompress more. The open side is what stops a
 * gzip bomb — inbound mail is attacker-influenced and 4 MB of one byte fits the
 * 4 KB bucket, so the framing alone cannot bound the allocation.
 *
 * 2 MiB rather than the 1 MB SMTP DATA cap because a cold plaintext is a
 * RawBody record with the mail base64'd inside it: a legal 1 MiB message becomes
 * ~1.37 MB of plaintext and would be permanently unopenable under a 1 MB cap.
 */
export const MAX_PLAINTEXT = 2 << 20;

/** The size ladder every blob is padded up to, in bytes. Seven rungs, frozen. */
export const BUCKETS: readonly number[] = [1 << 10, 4 << 10, 16 << 10, 64 << 10, 256 << 10, 512 << 10, 1024 << 10];

/** The largest blob this format can carry. */
export const MAX_BUCKET = 1 << 20;

export type Stream = "hot" | "cold";
export const STREAM_HOT = "hot";
/** The cold stream carries raw email bodies and never ops (invariant I16). */
export const STREAM_COLD = "cold";

const AAD_SEPARATOR = "|";

/**
 * The position a blob occupies. Its four fields are exactly the associated data
 * spec §3.4 binds, and the set is frozen: adding a field invalidates every
 * stored blob, removing one reopens a replay path.
 */
export interface Envelope {
  /** canonical lowercase hyphenated UUID, as the API returns it */
  userId: string;
  stream: Stream;
  writerId: string;
  /** 1-based position within (writer_id, stream); chains are per-stream */
  writerCounter: bigint;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Rejects envelopes whose AAD would be ambiguous or nonsensical. Mirrors
 * `blob.Envelope.Validate`.
 *
 * The user id must be the canonical hyphenated form (case-insensitively). Go's
 * `uuid.Parse` also accepts `urn:uuid:…`, braces and the unhyphenated 32-char
 * spelling and canonicalises them, so accepting them here without normalising
 * would produce a DIFFERENT AAD for the same user — a blob no other device
 * could open at the position it occupies.
 */
export function validateEnvelope(e: Envelope): void {
  const id = typeof e.userId === "string" ? e.userId.toLowerCase() : "";
  if (!CANONICAL_UUID.test(id)) {
    throw new InvalidEnvelopeError(`user_id ${JSON.stringify(e.userId)} is not a canonical UUID`);
  }
  if (id === NIL_UUID) throw new InvalidEnvelopeError("user_id is zero");
  if (e.stream !== STREAM_HOT && e.stream !== STREAM_COLD) {
    throw new InvalidEnvelopeError(`stream is ${JSON.stringify(e.stream)}, want "hot" or "cold"`);
  }
  if (typeof e.writerId !== "string" || e.writerId === "") throw new InvalidEnvelopeError("writer_id is empty");
  if (e.writerId.includes(AAD_SEPARATOR)) {
    throw new InvalidEnvelopeError(`writer_id may not contain ${JSON.stringify(AAD_SEPARATOR)}`);
  }
  if (typeof e.writerCounter !== "bigint") throw new InvalidEnvelopeError("writer_counter must be a bigint");
  if (e.writerCounter < 1n) {
    throw new InvalidEnvelopeError(`writer_counter is ${e.writerCounter}, and counters are 1-based`);
  }
  const n = overhead(aadBytes(e).length);
  if (n > BUCKETS[0]!) {
    throw new InvalidEnvelopeError(`framing overhead ${n} does not fit the smallest bucket`);
  }
}

function aadBytes(e: Envelope): Uint8Array {
  // The counter is decimal, from a bigint, so it is exact at any magnitude —
  // Number(counter).toString() would start lying at 2^53 and produce an AAD no
  // other executor computes.
  return platform().utf8Encode(
    [e.userId.toLowerCase(), e.stream, e.writerId, e.writerCounter.toString(10)].join(AAD_SEPARATOR),
  );
}

/**
 * The canonical associated data: `user_id|stream|writer_id|writer_counter`, with
 * the counter in decimal. The separator is not escaped, so
 * {@link validateEnvelope} must have rejected a field containing it — otherwise
 * two different positions would produce identical associated data.
 */
export function aad(e: Envelope): Uint8Array {
  validateEnvelope(e);
  return aadBytes(e);
}

/** Every framed byte that is not payload or padding. */
function overhead(aadLen: number): number {
  return VERSION_SIZE + AAD_LEN_SIZE + aadLen + NONCE_SIZE + PAYLOAD_LEN_SIZE + TAG_SIZE;
}

/**
 * The smallest bucket that can hold n bytes, where n is the TOTAL framed
 * length — header, AAD, nonce, sealed region and tag together. Sizing on the
 * payload alone would let the header push a blob past its bucket.
 */
export function bucketFor(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new BlobDecodeError(`negative or non-integer length ${n}`);
  for (const b of BUCKETS) if (n <= b) return b;
  throw new RangeError(`${n} bytes exceeds the largest bucket ${MAX_BUCKET}`);
}

function isBucket(n: number): boolean {
  return BUCKETS.includes(n);
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * The half-open byte range of a framed blob that Phase 3 encrypts: everything
 * after the nonce and before the tag, which is the payload length, the payload
 * and the padding.
 *
 * Callers use it to reason about the format without re-deriving offsets — the
 * same reason `blob.SealedRegion` exists in Go, and the reason {@link openBlob}
 * and {@link sealBlob} both call it instead of computing their own.
 */
export function sealedRegion(b: Uint8Array): { start: number; end: number } {
  if (b.length < VERSION_SIZE + AAD_LEN_SIZE) {
    throw new BlobDecodeError(`${b.length} bytes is shorter than the header`);
  }
  const aadLen = view(b).getUint16(VERSION_SIZE);
  const start = VERSION_SIZE + AAD_LEN_SIZE + aadLen + NONCE_SIZE;
  const end = b.length - TAG_SIZE;
  if (end < start + PAYLOAD_LEN_SIZE) {
    throw new BlobDecodeError(`aadLen ${aadLen} leaves no room for a payload`);
  }
  return { start, end };
}

/**
 * The associated data a framed blob carries, read straight out of the frame. It
 * neither opens nor decrypts anything, because the AAD is CLEARTEXT in the frame
 * in both phases — it sits ahead of the nonce and outside {@link sealedRegion}.
 *
 * That is what lets the SERVER check a submitted blob's position while holding
 * no key in Phase 3, and it is what {@link openBlob} compares against: the
 * reader's slice is derived HERE, so reader and writer cannot drift apart.
 */
export function embeddedAAD(b: Uint8Array): Uint8Array {
  const { start } = sealedRegion(b);
  // sealedRegion has already bounds-checked everything this slices.
  return b.subarray(VERSION_SIZE + AAD_LEN_SIZE, start - NONCE_SIZE);
}

/**
 * Constant-time-shaped byte comparison. Timing tells an attacker nothing about
 * plaintext framing, but Phase 3 hands this comparison to an AEAD and the check
 * that replaces it is constant time — so the shape is kept, exactly as Go keeps
 * `subtle.ConstantTimeCompare` here.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Compresses plaintext, frames it and pads the result to a size bucket.
 *
 * Level 9 mirrors Go's `gzip.BestCompression`. The two compressors do not
 * produce identical bytes — different deflate implementations, and Go stamps a
 * different OS byte in the gzip header — and nothing requires them to: each blob
 * is sealed once, by its author, and the chain hashes the bytes as stored. What
 * the level does buy is that a TypeScript-authored blob lands in the same BUCKET
 * as the Go-authored one would, so the corpus shape does not depend on which
 * device wrote a row.
 */
export function sealBlob(e: Envelope, plaintext: Uint8Array): Uint8Array {
  validateEnvelope(e);
  if (plaintext.length > MAX_PLAINTEXT) {
    throw new RangeError(`plaintext is ${plaintext.length} bytes, cap is ${MAX_PLAINTEXT}`);
  }
  const ad = aadBytes(e);
  const payload = platform().gzip(plaintext);
  const bucket = bucketFor(overhead(ad.length) + payload.length);

  const out = new Uint8Array(bucket);
  out[0] = VERSION;
  view(out).setUint16(VERSION_SIZE, ad.length);
  out.set(ad, VERSION_SIZE + AAD_LEN_SIZE);
  // out[.. +NONCE_SIZE] stays zero: the nonce slot, reserved for Phase 3.

  // Deliberately re-derived from the bytes just written rather than computed
  // alongside them, so seal and open get their offsets from one function.
  const { start, end } = sealedRegion(out);
  // Unreachable while bucketFor and overhead agree, which is the point of
  // asserting it: the two are the only reason the payload is known to fit, and
  // a silent overrun here would be a blob that seals and never opens.
  if (start + PAYLOAD_LEN_SIZE + payload.length > end) {
    throw new RangeError("framed payload runs past the sealed region");
  }
  view(out).setUint32(start, payload.length);
  out.set(payload, start + PAYLOAD_LEN_SIZE);
  // The rest of the region stays zero: padding, INSIDE the sealed region.
  // out[end..] stays zero: the tag slot, reserved for Phase 3.
  return out;
}

/**
 * Reverses {@link sealBlob}. It rejects a blob whose embedded AAD does not match
 * the envelope the caller expects it at, which is what stops a server replaying
 * a blob into another position, stream or user. That is the replay protection
 * Phase 3's AEAD will provide cryptographically and Phase 1 provides
 * structurally.
 */
export function openBlob(e: Envelope, bytes: Uint8Array): Uint8Array {
  validateEnvelope(e);
  if (!isBucket(bytes.length)) throw new BlobDecodeError(`${bytes.length} bytes is not a size bucket`);
  if (bytes[0] !== VERSION) throw new BlobDecodeError(`unsupported envelope version ${bytes[0]}`);

  const { start, end } = sealedRegion(bytes);
  if (!equalBytes(embeddedAAD(bytes), aadBytes(e))) {
    throw new BlobDecodeError("associated data mismatch: sealed at a different position");
  }

  const n = view(bytes).getUint32(start);
  if (n > end - start - PAYLOAD_LEN_SIZE) {
    throw new BlobDecodeError(`payload length ${n} runs past the sealed region`);
  }
  return decompress(bytes.subarray(start + PAYLOAD_LEN_SIZE, start + PAYLOAD_LEN_SIZE + n));
}

/**
 * Gunzips under a hard output cap.
 *
 * `Bun.gunzipSync` — which the task brief suggested — has no cap, and a blob is
 * attacker-influenced: the 1 MiB top bucket can carry a gzip stream that
 * inflates to roughly a gigabyte, so an uncapped decompress is a remote OOM on
 * a phone. The seam's cap is the sync equivalent of the
 * `io.LimitReader(zr, MaxPlaintext+1)` Go uses, and every implementation of it
 * must enforce the bound DURING inflation, not after — see `platform.ts`.
 *
 * The two-stage shape is deliberate: the seam is asked for `MAX_PLAINTEXT + 1`
 * so that a payload of exactly `MAX_PLAINTEXT + 1` inflates far enough to be
 * *distinguishable* from one of exactly `MAX_PLAINTEXT`, and the length check
 * below is what turns the extra byte into this module's own error message
 * rather than the decompressor's.
 */
function decompress(payload: Uint8Array): Uint8Array {
  let out: Uint8Array;
  try {
    out = platform().gunzip(payload, MAX_PLAINTEXT + 1);
  } catch (err) {
    throw new BlobDecodeError(`gzip: ${(err as Error).message}`);
  }
  if (out.length > MAX_PLAINTEXT) {
    throw new BlobDecodeError(`decompressed payload exceeds ${MAX_PLAINTEXT} bytes`);
  }
  return new Uint8Array(out);
}
