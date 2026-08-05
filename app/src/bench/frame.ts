/**
 * Envelope framing VERSION 2, in TypeScript — a BENCHMARK INSTRUMENT.
 *
 * The Go twin is `internal/v2/blob/encv2.go` and it is the authority; this file
 * exists so the `@noble` control arm and the native arms can be driven from the
 * same offsets, and so `bun test` on this box can check the format without a
 * device.
 *
 * # Why this is not a change to `client/src/wire/blob.ts`
 *
 * Phase 2 is plaintext. `openBlob` is a gunzip and a byte-compare, and it must
 * stay that way: Phase 3 swaps exactly one implementation and the Phase 2 plan's
 * Global Constraints forbid adding encryption to the product path. The v1 reader
 * must therefore REFUSE a v2 blob — `unsupported envelope version 2` — which is
 * the framing-version mechanism working as designed and is asserted in
 * `frame.test.ts`. Nothing in this directory is imported by the sync path.
 *
 * # The layout, and the trap that makes it worth a helper
 *
 * ```
 * v1: [1B version=1][2B BE aadLen][aad]         [12B nonce][ sealed region ][16B tag]
 * v2: [1B version=2][2B BE aadLen][aad][32B enc][12B nonce][ sealed region ][16B tag]
 * ```
 *
 * Three functions derive offsets, INDEPENDENTLY, and Decision 12 spells out what
 * happens if only some of them learn about `enc`:
 *
 *  - {@link sealedRegion} — `start` gains 32.
 *  - {@link embeddedAAD} — in `blob.ts` this is `subarray(3, start - NONCE_SIZE)`.
 *    Branch `sealedRegion` and not this, and `start` has moved while the slice
 *    end has not, so the AAD compare reads the 32 bytes of `enc` as part of the
 *    associated data. Every open fails — or worse, PASSES, if the generator made
 *    the same mistake symmetrically.
 *  - {@link overhead} — decides the size bucket. Under-count by 32 and a record
 *    near a bucket boundary silently overruns its bucket.
 *
 * So all of them consult {@link frameLayout} and none of them tests the version
 * byte itself. That is the entire point: two can agree and the third not, and a
 * single source of geometry is what makes that impossible rather than unlikely.
 */

export const FRAME_V1 = 1;
export const FRAME_V2 = 2;

export const VERSION_SIZE = 1;
export const AAD_LEN_SIZE = 2;
export const PAYLOAD_LEN_SIZE = 4;
export const ENC_SIZE = 32;
export const NONCE_SIZE = 12;
export const TAG_SIZE = 16;

/** The size ladder, mirroring `client/src/wire/blob.ts`. */
export const BUCKETS: readonly number[] = [
  1 << 10,
  4 << 10,
  16 << 10,
  64 << 10,
  256 << 10,
  512 << 10,
  1024 << 10,
];

/** The HKDF info string. Must equal `blob.EncInfo` in Go and the Swift module. */
export const ENC_INFO = "ledger-phase2-encv2";

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

/** Everything about a frame that depends on its version byte. */
export interface FrameLayout {
  version: number;
  encSize: number;
}

/** The single version branch in the whole format. */
export function frameLayout(version: number): FrameLayout {
  if (version === FRAME_V1) return { version, encSize: 0 };
  if (version === FRAME_V2) return { version, encSize: ENC_SIZE };
  throw new FrameError(`unsupported envelope version ${version}`);
}

/** Every framed byte that is not payload or padding. */
export function overhead(layout: FrameLayout, aadLen: number): number {
  return VERSION_SIZE + AAD_LEN_SIZE + aadLen + layout.encSize + NONCE_SIZE + PAYLOAD_LEN_SIZE + TAG_SIZE;
}

/** The smallest bucket that holds a TOTAL framed length of n bytes. */
export function bucketFor(n: number): number {
  for (const b of BUCKETS) if (n <= b) return b;
  throw new FrameError(`${n} bytes exceeds the largest bucket`);
}

export function isBucket(n: number): boolean {
  return BUCKETS.includes(n);
}

function aadLenOf(b: Uint8Array): number {
  if (b.length < VERSION_SIZE + AAD_LEN_SIZE) {
    throw new FrameError(`${b.length} bytes is shorter than the header`);
  }
  return (b[VERSION_SIZE]! << 8) | b[VERSION_SIZE + 1]!;
}

/** Where the ephemeral public key starts. Same expression on both sides. */
export function encOffset(_layout: FrameLayout, aadLen: number): number {
  return VERSION_SIZE + AAD_LEN_SIZE + aadLen;
}

/** Where the nonce starts. */
export function nonceOffset(layout: FrameLayout, aadLen: number): number {
  return encOffset(layout, aadLen) + layout.encSize;
}

/** The half-open byte range an AEAD encrypts: payload length, payload, padding. */
export function sealedRegion(b: Uint8Array): { start: number; end: number } {
  const layout = frameLayout(b[0] ?? -1);
  const aadLen = aadLenOf(b);
  const start = nonceOffset(layout, aadLen) + NONCE_SIZE;
  const end = b.length - TAG_SIZE;
  if (end < start + PAYLOAD_LEN_SIZE) {
    throw new FrameError(`aadLen ${aadLen} leaves no room for a payload`);
  }
  return { start, end };
}

/**
 * The associated data a framed blob carries.
 *
 * BOTH ends of the slice come from the layout. Deriving the end as
 * `start - NONCE_SIZE`, which is what `blob.ts` does and what an unbranched port
 * of it would keep doing, is precisely the bug Decision 12 names.
 */
export function embeddedAAD(b: Uint8Array): Uint8Array {
  const layout = frameLayout(b[0] ?? -1);
  const aadLen = aadLenOf(b);
  sealedRegion(b); // bounds-check the whole frame before slicing any of it
  return b.subarray(VERSION_SIZE + AAD_LEN_SIZE, encOffset(layout, aadLen));
}

export function encOf(b: Uint8Array): Uint8Array {
  const layout = frameLayout(b[0] ?? -1);
  if (layout.encSize === 0) throw new FrameError(`version ${layout.version} has no enc field`);
  const aadLen = aadLenOf(b);
  sealedRegion(b);
  const off = encOffset(layout, aadLen);
  return b.subarray(off, off + layout.encSize);
}

export function nonceOf(b: Uint8Array): Uint8Array {
  const layout = frameLayout(b[0] ?? -1);
  const aadLen = aadLenOf(b);
  sealedRegion(b);
  const off = nonceOffset(layout, aadLen);
  return b.subarray(off, off + NONCE_SIZE);
}

/** The ciphertext and its tag, contiguous: exactly what AES-GCM opens. */
export function cipherRegion(b: Uint8Array): Uint8Array {
  const { start } = sealedRegion(b);
  return b.subarray(start);
}

/** One blob's position, mirroring `client/src/wire/blob.ts`'s `Envelope`. */
export interface Position {
  userId: string;
  stream: string;
  writerId: string;
  writerCounter: bigint;
}

const encoder = new TextEncoder();

/**
 * `user_id|stream|writer_id|writer_counter`, with the counter in DECIMAL from a
 * bigint. `Number(counter).toString()` would start lying at 2^53 and produce an
 * AAD no other executor computes.
 */
export function aadBytes(p: Position): Uint8Array {
  return encoder.encode([p.userId.toLowerCase(), p.stream, p.writerId, p.writerCounter.toString(10)].join("|"));
}

/**
 * Reads the length-prefixed payload out of an opened sealed region.
 *
 * The region is `[4B BE payloadLen][gzip payload][zero padding]`. The native
 * module returns the region verbatim and does NOT gunzip — decompression belongs
 * to the platform seam, which enforces the output cap during inflation.
 */
export function payloadOf(region: Uint8Array): Uint8Array {
  if (region.length < PAYLOAD_LEN_SIZE) throw new FrameError(`region is ${region.length} bytes`);
  const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
  const n = view.getUint32(0);
  if (n > region.length - PAYLOAD_LEN_SIZE) {
    throw new FrameError(`payload length ${n} runs past the ${region.length}-byte region`);
  }
  return region.subarray(PAYLOAD_LEN_SIZE, PAYLOAD_LEN_SIZE + n);
}

/** Constant-time-shaped byte comparison, the same shape `blob.ts` keeps. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
