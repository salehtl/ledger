/**
 * The per-(writer_id, stream) hash chains of spec §3.3, mirroring
 * `internal/v2/oplog/chain.go`.
 *
 * # The rule, frozen
 *
 * For each (writer_id, stream) INDEPENDENTLY:
 *
 * ```
 * blob_hash[n] = SHA256(blob_hash[n-1] || blob_bytes[n]),  blob_hash[0] = 32 zero bytes
 * ```
 *
 * The hash covers the STORED bytes — the framed, padded envelope, which is
 * plaintext in Phase 1 and ciphertext in Phase 3 — so the formula does not
 * change when sealing turns on, and anyone holding the stored blob can recompute
 * it, including a server that cannot read it.
 *
 * # Why per (writer, stream) and not per writer (Decision 13)
 *
 * The ingest writer appends a hot blob and a cold blob for the same email. A
 * single chain per writer would interleave them, so a hot-only pull would see
 * counters 1, 3, 5, … whose prev_hash values point at cold blobs the client
 * deliberately did not fetch. Spec §3.3:70 makes the cold stream lazily synced
 * behind a rolling window, so those gaps are permanent and by design — the
 * client could not tell "I skipped cold on purpose" from "the server dropped an
 * op". Splitting the chain per stream makes the hot chain self-verifying from
 * hot rows alone and confines lazy verification to cold, where
 * {@link verifyHashList} is the mechanism.
 *
 * # What these chains prove, and what they do NOT (spec §3.3(b))
 *
 * Read the Phase 1 caveat below before quoting either of these.
 *
 *   - A CLIENT writer's chain is computed on the device, over blobs sealed under
 *     a key the server does not hold. ONCE THAT IS TRUE (Phase 3), the server
 *     cannot forge it, so a server that drops or reorders that device's ops is
 *     detected. That is a real integrity claim about the operator.
 *   - The INGEST writer's chain is computed by the server, over material the
 *     server itself sealed. It proves storage and backup integrity and it proves
 *     NOTHING about operator honesty, in any phase. A compromised server can
 *     fabricate a perfectly well-formed ingest chain of transactions that never
 *     happened. No caller may present a valid ingest chain as evidence that the
 *     ingest history is genuine.
 *
 * # What Phase 1 does NOT claim
 *
 * Phase 1 blobs are PLAINTEXT with a zero tag. There is no DEK yet, so "the
 * server cannot forge a client writer's chain" is a property of the FINISHED
 * system and not of what ships today: as built, the server could author a client
 * writer's blobs and chain them flawlessly, and nothing here would notice. The
 * chains are still worth building now, because their shape is what Phase 3 makes
 * unforgeable and because they already detect accidental loss and reordering in
 * storage — but a Phase 1 chain is evidence about mistakes, not about an
 * adversary.
 */

import { platform } from "../platform";
import type { Stream } from "./blob";

/** The genesis of every chain: the prev-hash of writer_counter 1. */
export const ZERO_HASH: Uint8Array = new Uint8Array(32);

/**
 * Advances a writer's chain: SHA256(prev || blobBytes). It hashes the FRAMED
 * bytes, not the plaintext, so the chain covers the padding and the header too.
 */
export function chainHash(prev: Uint8Array, blobBytes: Uint8Array): Uint8Array {
  const buf = new Uint8Array(prev.length + blobBytes.length);
  buf.set(prev, 0);
  buf.set(blobBytes, prev.length);
  return platform().sha256(buf);
}

/**
 * The key every pinned head and every chain check is filed under. Chains are per
 * (writer_id, stream), so a head that does not name a stream is meaningless.
 */
export type ChainKey = string;

export function chainKey(writerId: string, stream: Stream): ChainKey {
  if (writerId === "" || writerId.includes("|")) {
    throw new Error(`writer_id ${JSON.stringify(writerId)} cannot be part of a chain key`);
  }
  return `${writerId}|${stream}`;
}

/** The head of one chain: its highest verified counter and that blob's hash. */
export interface Head {
  counter: bigint;
  hash: Uint8Array;
}

/**
 * One op-log row, as pulled. Counters and seqs are bigint; a number would round.
 *
 * `writer_id` and `stream` are REQUIRED, not optional. They started optional —
 * "checked when the server sent them" — which quietly meant the cross-chain
 * splice detection in {@link verifyChain} did not happen at all against a row
 * type that omitted them. Go cannot be bypassed that way because `oplog.Row`
 * always carries both from their database columns, and this is the mirror of
 * that. `GET /api/v1/sync` returns both on every row, so Task 13's and Task 14's
 * response types must keep populating them.
 */
export interface ChainRow {
  writer_counter: bigint;
  prev_hash: Uint8Array;
  blob_hash: Uint8Array;
  blob: Uint8Array;
  writer_id: string;
  stream: Stream;
}

/**
 * One entry of the compact per-blob hash list (spec §3.3:72).
 *
 * `prev_hash` and `writer_id` are required for the same reason as on
 * {@link ChainRow}: `GET /api/v1/sync/hashes` returns both, and an optional
 * field is a check that silently does not run. There is no `stream` — that
 * endpoint is per-stream, so the stream is the caller's `ChainKey` and not the
 * server's word.
 */
export interface HashRow {
  seq: bigint;
  writer_counter: bigint;
  blob_hash: Uint8Array;
  prev_hash: Uint8Array;
  writer_id: string;
}

/**
 * A writer's hash chain does not line up: a counter that skips, a prev_hash that
 * does not match the row before it, or a blob_hash that is not
 * SHA256(prev || bytes).
 *
 * This is a HARD STOP for a syncing client (spec §3.3:68) — the same class as
 * `UnknownNewerVersionError` and deliberately NOT the same class as
 * `BlobDecodeError`, which is a warning about one unreadable blob. Do not throw
 * it for anything less: a protocol mistake that costs nothing must not raise a
 * non-dismissable "your server may have tampered with your data" warning.
 */
export class ChainBreakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainBreakError";
  }
}

/**
 * Plain early-exit comparison, unlike blob.ts's constant-time one: every value
 * compared here is a chain hash, which the server sent us and which is public in
 * both phases. There is no secret for a timing side channel to leak.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const hex = (b: Uint8Array) => platform().toHex(b);

/**
 * Checks that a row belongs to the chain being verified.
 *
 * Interleaving two writers with continuous counters and honestly recomputed
 * hashes passes every other check in {@link verifyChain}, so this is the only
 * thing standing between a spliced response and a clean bill of health. A
 * missing field is therefore an error rather than a skipped check — the version
 * that treated absence as "nothing to compare" turned the whole detection off
 * for any caller whose row type omitted them.
 *
 * `stream` is undefined for hash-list entries, whose endpoint is per-stream; the
 * caller passes nothing and the stream half is simply not the server's to claim.
 */
function requireSameChain(key: ChainKey, i: number, writerID: string, stream?: string): void {
  const sep = key.indexOf("|");
  const wantWriter = key.slice(0, sep);
  const wantStream = key.slice(sep + 1);
  if (typeof writerID !== "string" || writerID === "") {
    throw new ChainBreakError(`row ${i} names no writer, so it cannot be attributed to the chain (${key})`);
  }
  if (writerID !== wantWriter) {
    throw new ChainBreakError(`row ${i} is from writer ${JSON.stringify(writerID)}, but the chain is (${key})`);
  }
  if (stream !== undefined && stream !== wantStream) {
    throw new ChainBreakError(`row ${i} is on stream ${JSON.stringify(stream)}, but the chain is (${key})`);
  }
}

/**
 * Reports whether rows are a contiguous, correctly hashed continuation of
 * `pinnedHead` — use `{counter: 0n, hash: ZERO_HASH}` to verify from genesis.
 * Rows must be in counter order and all from one (writer_id, stream).
 *
 * This is the CLIENT's check. Every hash is RECOMPUTED from the row's stored
 * bytes rather than read from the row, so a server that substitutes a blob
 * cannot keep the chain intact by also editing the hash column.
 *
 * # Exactly what it detects, and what it cannot
 *
 * It detects any break RELATIVE TO `pinnedHead`: an op missing from the middle,
 * two ops served out of order, a substituted or edited blob, a forged prev_hash,
 * a run that does not continue the head it was verified against, and rows from
 * more than one (writer, stream) spliced together.
 *
 * It does NOT, by itself, detect a server that RE-CHAINS what it serves. A
 * truncation (a genuine 1..5 served as 1..3) verifies. A whole alternative
 * history, correctly chained from genesis, verifies. Both are caught only by
 * comparing the head this ends at against a head the verifier already trusts —
 * which is what a persisted local head gives a returning device and what spec
 * §3.3(c)'s writer_checkpoint op gives a device auditing a PEER's chain. Callers
 * must not read "verifyChain passed" as "the server served me everything"; it
 * means "what the server served me is a consistent continuation of the head I
 * gave it".
 */
export function verifyChain(key: ChainKey, rows: ChainRow[], pinnedHead: Head): void {
  let prev = pinnedHead.hash;
  let want = pinnedHead.counter + 1n;
  for (const [i, r] of rows.entries()) {
    requireSameChain(key, i, r.writer_id, r.stream);
    if (r.writer_counter !== want) {
      throw new ChainBreakError(`(${key}) row ${i} has counter ${r.writer_counter}, want ${want}`);
    }
    if (!equalBytes(r.prev_hash, prev)) {
      throw new ChainBreakError(`(${key}) counter ${r.writer_counter} links to ${hex(r.prev_hash)}, but the chain is at ${hex(prev)}`);
    }
    const got = chainHash(prev, r.blob);
    if (!equalBytes(r.blob_hash, got)) {
      throw new ChainBreakError(`(${key}) counter ${r.writer_counter} claims hash ${hex(r.blob_hash)}, but its bytes hash to ${hex(got)}`);
    }
    prev = got;
    want++;
  }
}

/**
 * The head a verified run ends at. Split from {@link verifyChain} rather than
 * returned by it so that persisting a head is a separate, deliberate act: the
 * CLI advances its cursor and its pinned heads only after the invariant checker
 * reports no hard stop.
 */
export function headAfter(rows: ChainRow[], pinnedHead: Head): Head {
  const last = rows[rows.length - 1];
  return last === undefined ? pinnedHead : { counter: last.writer_counter, hash: last.blob_hash };
}

/**
 * Verifies that the compact per-blob hash list is contiguous from the pinned
 * head and returns the new head (spec §3.3:72). This is how a client pins a cold
 * chain it has not downloaded: the cold stream is lazily synced behind a rolling
 * window, so its bodies are legitimately absent.
 *
 * # What it proves, precisely
 *
 * The hash list ALONE cannot prove `blob_hash[n] = SHA256(blob_hash[n-1] ||
 * blob[n])`, because the bodies are not here to hash — a server free to invent
 * both sides produces a list that verifies. What it proves is that the server
 * COMMITTED to this exact sequence of hashes at this moment. Every later range
 * fetch is then checked against the pinned entry by {@link verifyFetchedRange},
 * and that is what makes a swapped cold body detectable: the server cannot
 * change its mind about a hash it has already handed over.
 *
 * What IS checked here: counter contiguity from the pinned head, strictly
 * increasing seq, the writer when the server names it, and — because the
 * server's hash list carries prev_hash — that each entry links to the one before
 * it and the first links to the pinned head.
 */
export function verifyHashList(key: ChainKey, list: HashRow[], pinnedHead: Head): Head {
  let prev = pinnedHead.hash;
  let want = pinnedHead.counter + 1n;
  let lastSeq: bigint | undefined;
  for (const [i, h] of list.entries()) {
    // A hash-list entry names a writer but not a stream: the endpoint is
    // per-stream, so the stream is the caller's `key` and not the server's word.
    requireSameChain(key, i, h.writer_id);
    if (h.writer_counter !== want) {
      throw new ChainBreakError(`(${key}) hash list entry ${i} has counter ${h.writer_counter}, want ${want}`);
    }
    if (lastSeq !== undefined && h.seq <= lastSeq) {
      throw new ChainBreakError(`(${key}) hash list entry ${i} has seq ${h.seq}, which does not follow ${lastSeq}`);
    }
    if (h.blob_hash.length !== 32) {
      throw new ChainBreakError(`(${key}) hash list entry ${i} has a ${h.blob_hash.length}-byte hash`);
    }
    if (!equalBytes(h.prev_hash, prev)) {
      throw new ChainBreakError(
        `(${key}) hash list entry ${i} links to ${hex(h.prev_hash)}, but the chain is at ${hex(prev)}`,
      );
    }
    lastSeq = h.seq;
    prev = h.blob_hash;
    want++;
  }
  return { counter: want - 1n, hash: prev };
}

/**
 * Checks fetched cold bodies against the hashes {@link verifyHashList} pinned.
 * Throws if a body's recomputed hash differs from the pinned one, or if it sits
 * at a counter that was never pinned.
 *
 * Recomputing from `(prev_hash, blob)` rather than trusting the row's
 * `blob_hash` is what makes this worth doing: to pass, a server would have to
 * find a `(prev, body)` pair hashing to a value it already published, which is a
 * preimage. An unpinned counter is refused rather than accepted-and-unverified,
 * since "I have no pin for this one" is exactly the answer a server wants.
 */
export function verifyFetchedRange(pinned: Map<bigint, Uint8Array>, rows: ChainRow[]): void {
  for (const r of rows) {
    const want = pinned.get(r.writer_counter);
    if (want === undefined) {
      throw new ChainBreakError(`counter ${r.writer_counter} was never pinned, so its body cannot be verified`);
    }
    const got = chainHash(r.prev_hash, r.blob);
    if (!equalBytes(got, want)) {
      throw new ChainBreakError(`counter ${r.writer_counter} hashes to ${hex(got)}, but ${hex(want)} was pinned`);
    }
  }
}
