/**
 * The cross-language conformance check, as a function of an "open" so that ONE
 * contract is run by two executors: `@noble` under `bun test` on this box, and
 * the Swift module on the device from the bench screen.
 *
 * The Phase 2 plan put this at `app/test/device/vectors.test.ts`, which
 * `jest.config.js` explicitly says is run by NEITHER runner. A conformance test
 * nothing runs is the "written, tested green, never wired" shape twice over — and
 * this project has already had two reports caught measuring a function the runner
 * never calls. So the assertions live here, `vectors.test.ts` beside them runs
 * them under `bun test src` on every gate, and the bench screen runs the same
 * function against the native arm on the device.
 */

import { equalBytes, type Position } from "./frame.ts";

export interface VectorRecord {
  name: string;
  note?: string;
  user_id: string;
  stream: string;
  writer_id: string;
  writer_counter: string;
  record_base64: string;
  expect_plaintext_base64?: string;
  expect_error?: string;
  embedded_aad_utf8: string;
}

export interface VectorFile {
  note: string;
  envelope_version: number;
  record_size: number;
  enc_size: number;
  nonce_size: number;
  tag_size: number;
  hkdf_info: string;
  construction: string;
  recipient_pub: string;
  recipient_priv: string;
  synthetic: boolean;
  vectors: VectorRecord[];
}

/** An open that takes the position, i.e. the full `openBlob` contract. */
export type OpenAt = (p: Position, record: Uint8Array) => Uint8Array;

export interface VectorResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function positionOf(v: VectorRecord): Position {
  return {
    userId: v.user_id,
    stream: v.stream,
    writerId: v.writer_id,
    writerCounter: BigInt(v.writer_counter),
  };
}

/**
 * Runs every vector and returns a per-vector verdict.
 *
 * `openAt` is handed the DECRYPTED SEALED REGION's caller: it must return the
 * region (`[4B payloadLen][gzip payload][padding]`) and `unwrap` turns that into
 * the plaintext. Splitting them keeps the native arm's boundary — which stops at
 * the region — honest, rather than folding a gunzip into the thing being timed.
 */
export function checkVectors(
  file: VectorFile,
  openAt: OpenAt,
  unwrap: (region: Uint8Array) => Uint8Array,
): VectorResult[] {
  const out: VectorResult[] = [];
  for (const v of file.vectors) {
    const record = fromBase64(v.record_base64);
    const p = positionOf(v);
    if (v.expect_error !== undefined) {
      // The vector that makes the suite worth running. Without it an
      // implementation that ignores the associated data entirely passes
      // everything else — the exact defect Phase 1's Task 10 caught in its own
      // first draft.
      let threw = false;
      try {
        openAt(p, record);
      } catch {
        threw = true;
      }
      out.push({
        name: v.name,
        ok: threw,
        detail: threw ? "threw, as required" : "OPENED — this implementation does not check the AAD",
      });
      continue;
    }
    try {
      const plain = unwrap(openAt(p, record));
      const want = fromBase64(v.expect_plaintext_base64 ?? "");
      out.push({
        name: v.name,
        ok: equalBytes(plain, want),
        detail: equalBytes(plain, want) ? "matches" : `opened to ${plain.length} bytes, want ${want.length}`,
      });
    } catch (err) {
      out.push({ name: v.name, ok: false, detail: `threw: ${(err as Error).message}` });
    }
  }
  return out;
}

/**
 * Structural checks on the vector FILE itself, independent of any open.
 *
 * They exist because a vectors file that lost its mismatch case, or that got
 * regenerated from real data, would still pass {@link checkVectors} completely.
 */
export function checkVectorFile(file: VectorFile): string[] {
  const problems: string[] = [];
  if (!file.synthetic) problems.push("the vectors file does not declare itself synthetic");
  if (file.envelope_version !== 2) problems.push(`envelope_version is ${file.envelope_version}, want 2`);
  if (file.record_size !== 1024) problems.push(`record_size is ${file.record_size}, want 1024`);
  if (file.enc_size !== 32) problems.push(`enc_size is ${file.enc_size}, want 32`);
  if (file.nonce_size !== 12) problems.push(`nonce_size is ${file.nonce_size}, want 12`);
  if (file.tag_size !== 16) problems.push(`tag_size is ${file.tag_size}, want 16`);
  if (file.hkdf_info !== "ledger-phase2-encv2") problems.push(`hkdf_info is ${file.hkdf_info}`);
  if (file.vectors.length !== 10) problems.push(`${file.vectors.length} vectors, want 10`);
  const mismatches = file.vectors.filter((v) => v.expect_error !== undefined).length;
  if (mismatches !== 1) {
    problems.push(`${mismatches} AAD-mismatch vectors, want exactly 1`);
  }
  return problems;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Standard base64, decoded by hand.
 *
 * `atob` exists on Hermes but round-trips through a binary string, and Node's
 * byte-container global does not exist there at all (and is banned in `app/src`
 * — see `host-globals.test.ts`). This decoder is strict rather than lenient:
 * host base64 decoders commonly skip anything outside the alphabet and return a
 * SHORT result, which is how a corrupted vector becomes a plausible-looking
 * failure somewhere else.
 */
export function fromBase64(s: string): Uint8Array {
  if (s.length % 4 !== 0) throw new Error(`base64 length ${s.length} is not a multiple of four`);
  let pad = 0;
  while (pad < 2 && s.endsWith("=", s.length - pad)) pad++;
  const clean = pad > 0 ? s.slice(0, s.length - pad) : s;
  const out = new Uint8Array(((s.length / 4) * 3) - pad);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error(`base64: illegal character ${JSON.stringify(ch)}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (o !== out.length) throw new Error(`base64: decoded ${o} bytes, expected ${out.length}`);
  return out;
}

/** Lower-case hex, strictly. Odd length or a non-hex character throws. */
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`hex length ${s.length} is odd`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = s.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-f]{2}$/.test(byte)) throw new Error(`hex: illegal pair ${JSON.stringify(byte)}`);
    out[i] = parseInt(byte, 16);
  }
  return out;
}
