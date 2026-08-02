/**
 * gzip/gunzip for Hermes, from `fflate`.
 *
 * # The cap is the whole point of this file
 *
 * `Platform.gunzip(data, maxOutputBytes)` must refuse **during** inflation, not
 * after it. A blob is attacker-influenced, the 1 MiB top size bucket can carry
 * a deflate stream that inflates to roughly a gigabyte, and "inflate it all,
 * then measure, then throw" is a remote OOM on a phone that throws politely
 * afterwards. Node's `zlib` has `maxOutputLength` for exactly this;
 * **`fflate` has no equivalent**, which is why this is hand-built.
 *
 * Two `fflate` APIs were rejected before this one:
 *
 *  - `gunzipSync(data)` reads the gzip footer's ISIZE field and preallocates
 *    that many bytes *before* inflating anything. ISIZE is 4 attacker-chosen
 *    bytes at the end of the blob, so this is a 4 GiB allocation primitive.
 *  - `gunzipSync(data, { out })` with a pre-sized buffer never grows the
 *    buffer, but it also never stops: `inflt` keeps decoding with its writes
 *    silently dropped past the end of the typed array and then returns a
 *    truncated result with no error. Memory bounded, CPU not, and — worse — a
 *    silent short read where a throw is required.
 *
 * What is left is the streaming `Gunzip`, fed in small slices, with the running
 * output total checked in the `ondata` callback and a throw the moment it
 * passes the cap. Throwing out of `ondata` propagates out of `push`, so no
 * further input is fed and the work stops there.
 *
 * `SLICE_BYTES` bounds the overshoot: DEFLATE's maximum expansion is ~1032:1,
 * so at most ~4 MiB is inflated after the cap is passed before the next check
 * fires. That is a bounded, transient allocation rather than an unbounded one.
 *
 * `platform.test.ts`'s "refused during inflation, not after it" test is what
 * holds this in place — it compares this path against the *same* implementation
 * inflating the *same* bomb under a cap that never trips, so machine speed and
 * background load cancel out and there is no magic millisecond threshold.
 */

import { Gunzip, gzipSync } from "fflate";

/** How much compressed input is fed per `push`. See the header. */
const SLICE_BYTES = 4096;

/**
 * Gzip at level 9.
 *
 * **This is NOT byte-identical to `node:zlib`'s level 9**, and it is not
 * required to be. `client/src/platform.test.ts` pins `bunPlatform.gzip` against
 * `zlib.gzipSync(x, {level: 9})` byte-for-byte because there it is comparing
 * zlib to itself; `fflate` is a different DEFLATE implementation with a
 * different header (`OS` byte, `XFL`) and different match choices. Nothing
 * depends on the two agreeing: a blob is compressed once, by the device that
 * mints it, and the chain hashes the bytes that device produced. What does
 * depend on the *level* is `sealBlob`'s size bucket, which is derived from the
 * compressed length — so a Hermes-minted blob may land in a different bucket
 * than a Bun-minted one would have for the same plaintext. That is a property
 * of the padding scheme, not a divergence in it.
 */
export function gzip(data: Uint8Array): Uint8Array {
  return gzipSync(data, { level: 9, mtime: 0 });
}

/** Thrown when the decompressed output would pass `maxOutputBytes`. */
export class GunzipCapExceeded extends Error {
  constructor(cap: number) {
    super(`decompressed payload exceeds ${cap} bytes`);
    this.name = "GunzipCapExceeded";
  }
}

// CRC-32 (IEEE, reflected), because `fflate` computes one internally and
// exports nothing to reach it, and the gzip footer is the only thing that can
// detect the truncation below.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = (CRC_TABLE[(c ^ (b[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function readU32LE(b: Uint8Array, at: number): number {
  return (((b[at] as number) | ((b[at + 1] as number) << 8) | ((b[at + 2] as number) << 16) | ((b[at + 3] as number) << 24)) >>> 0);
}

/**
 * Gunzip under a hard output cap. Output of exactly `maxOutputBytes` is
 * returned; one byte more throws {@link GunzipCapExceeded}.
 *
 * # The footer is checked here, because nothing else checks it
 *
 * The first version of this function trusted `fflate`'s `final` callback flag
 * to mean "the stream ended". It does not: `Gunzip` passes back whatever
 * `final` argument the *caller* handed `push`, so a check on it is true by
 * construction and a gzip with its 8-byte footer sliced off returned 1,100
 * bytes and no error. That is a short read presented as success, on
 * attacker-influenced input, which is the one failure `wire/blob.ts`'s callers
 * cannot detect for themselves.
 *
 * `Gunzip` validates neither the CRC nor the length — `fflate`'s gzip footer
 * is read only by `gunzipSync`, and then only to size an allocation. So both
 * are validated here against the recomputed output.
 *
 * **Multi-member (concatenated) gzip is refused**, as a consequence: its
 * trailing footer describes the last member, not the whole output. Nothing in
 * the wire format produces one — `sealBlob` compresses a single payload — and
 * accepting a stream whose declared length disagrees with what was decoded is
 * exactly the property being defended.
 */
export function gunzip(data: Uint8Array, maxOutputBytes: number): Uint8Array {
  // 10-byte minimum header + at least one deflate byte + 8-byte footer.
  if (data.length < 19) throw new Error(`gunzip: input too short to be a gzip stream (${data.length} bytes)`);

  const chunks: Uint8Array[] = [];
  let total = 0;

  const g = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > maxOutputBytes) throw new GunzipCapExceeded(maxOutputBytes);
    if (chunk.length > 0) chunks.push(chunk);
  });

  for (let i = 0; i < data.length; i += SLICE_BYTES) {
    const end = Math.min(i + SLICE_BYTES, data.length);
    g.push(data.subarray(i, end), end === data.length);
  }

  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }

  // Length first, CRC second, and the order is load-bearing rather than
  // stylistic: the length comparison is O(1) and the CRC is O(output). On an
  // attacker-influenced 1 MiB blob, hashing a megabyte to reject something the
  // 4-byte length field already disproved is work done on the phone at the
  // attacker's request. `platform.test.ts` asserts the message, which is what
  // pins the order — the two checks otherwise catch the same corruptions and a
  // test that only asserts "it threw" cannot tell which one fired.
  const declaredLength = readU32LE(data, data.length - 4);
  if (declaredLength !== total >>> 0) {
    throw new Error(`gunzip: gzip length field says ${declaredLength} bytes, decoded ${total}`);
  }
  const declaredCrc = readU32LE(data, data.length - 8);
  const actualCrc = crc32(out);
  if (declaredCrc !== actualCrc) {
    throw new Error(`gunzip: gzip CRC mismatch (declared ${declaredCrc}, computed ${actualCrc})`);
  }

  return out;
}
