/**
 * The invariant checker: the instrument Phase 1's exit criterion is written
 * against ("a headless client replays cleanly with invariants green across two
 * concurrent writers", spec §5).
 *
 * # What this file is, and the one way it can fail
 *
 * Every other v2 component is checked by its own tests. This one is checked by
 * nothing, and everything downstream is checked by it — so the only failure that
 * really matters here is a check that PASSES on broken state. A vacuous
 * invariant is worse than an absent one: absent, someone notices; vacuous, the
 * exit criterion goes green with the feature missing. That is not hypothetical —
 * the plan's own first draft left `I11_roster_checkpoint` undefined for the
 * no-checkpoint case, and Task 38's "zero hard stops" would have been green with
 * checkpoints entirely unimplemented.
 *
 * So three rules govern this file:
 *
 *   1. **Every invariant has a test that constructs a state violating it** and
 *      asserts the id appears. An invariant with no failing fixture is
 *      undertested by construction.
 *   2. **Nothing throws.** A checker that crashes on broken input tells the
 *      caller nothing and kills the session on the exception rather than on the
 *      finding. Every check runs inside {@link runGuarded}, and a check that
 *      throws becomes a `hard_stop` naming itself.
 *   3. **A check that cannot be made to bite is reported as such**, not quietly
 *      weakened into something that always passes. Where the plan's wording
 *      cannot be asserted, the code says so at the site (see I9 and I14).
 *
 * # Two severities, and what a caller must do with them
 *
 * `hard_stop` violations must abort the sync session — the client must not
 * persist a cursor or a pinned head over them (spec §3.3:68 reserves this for
 * chain breaks and unknown-newer schema versions, which is what the hard-stop
 * set below is drawn from). `notice` violations must be PRINTED and never
 * suppressed. `checkAll` decides neither; it returns everything it found.
 *
 * # Where this deviates from the plan's signature, and why
 *
 * The plan (`docs/superpowers/plans/2026-08-01-v2-phase1-backend.md:2082`) gives
 * a `CheckInput` that cannot express three of its own seventeen invariants:
 *
 *   - **`ops` is `LogEntry[]`, not `{op, seq}[]`.** An {@link Op} carries no
 *     writer: writer identity is blob-level and AAD-bound, precisely so that no
 *     writer can author ops "as" the ingest writer. Replay takes `writer_id`
 *     alongside `seq` and so must anything that re-folds (I9, I10).
 *   - **`userId` is added.** I4 compares each blob's embedded AAD against
 *     `(user_id, stream, writer_id, writer_counter)`; without the user id the
 *     check cannot be written at all, and it is the field that detects a blob
 *     spliced in from another account.
 *   - **`next` is added.** I1's own statement ends "the last equals the
 *     response's `next`", and `next` is what the client persists as its cursor.
 *     A `next` that may run past the rows delivered means the client skips
 *     everything in between, permanently and silently.
 *   - **`pinnedBlobHashes` is added.** I3b's whole point is a cold body swapped
 *     *after* its hash was pinned — a cross-session claim. With only the current
 *     response's hash list, the check can only ever compare the server's bytes
 *     against the server's own simultaneous claim about them. Task 14's
 *     `pull-cold-hashes` already persists exactly this map.
 *
 * # What is deliberately NOT asserted
 *
 * Each of these fires on a CORRECT log, and each is one plausible tightening
 * away from being reintroduced. `check.test.ts` pins all four.
 *
 *   - **`future_parent` is not an error.** It is reachable through every refusal
 *     that returns before the version bump (`invalid_op`, `entity_kind_mismatch`,
 *     `invalid_parent`, `nonexistent_parent`, `invalid_payload`, `split_sum`),
 *     because a refusal consumes no version while its author believed the head
 *     had moved. Tolerating it is what lets a corrected op apply cleanly instead
 *     of forking against a phantom.
 *   - **"Every stale-parent op yields a ForkNotice" is false.** A stale-parent op
 *     whose payload is refused produces no notice at all, because the payload
 *     check runs first, by design.
 *   - **A home currency in `pendingByCurrency` is not "a rate is missing".**
 *     `txn_edited{amount_home_minor: null}` on a home-currency row re-arms a
 *     bucket no `rate_set` can ever drain, since that op is refused. It is
 *     deterministic and repairable by a later carrying edit.
 *   - **`possible_duplicate_of` is a snapshot, not a live claim.** The row it
 *     points at may since have been edited into another fingerprint bucket, and
 *     nothing re-walks the rows pointing at it. Asserting a shared fingerprint
 *     would fail on a correct log.
 *
 * # It does not rely on `serializeState`
 *
 * `serializeState` compares values and not iteration order, and Go randomizes
 * map iteration — so it is not sufficient as the cross-executor witness, and
 * building a checker on it would inherit that blind spot. I9 and I10 compare
 * named fields of a re-fold instead.
 */

import { fold, type LogEntry } from "../replay/replay";
import { entityKey, type State } from "../replay/state";
import { BUCKETS, aad, embeddedAAD, openBlob, type Stream } from "../wire/blob";
import {
  ChainBreakError,
  ZERO_HASH,
  chainHash,
  chainKey,
  verifyHashList,
  type ChainKey,
  type ChainRow,
  type HashRow,
  type Head,
} from "../wire/chain";
import { KIND_RAW_BODY, SCHEMA_VERSION, compareUTF8, kindOf } from "../wire/op";

// ---------------------------------------------------------------------------
// The inputs
// ---------------------------------------------------------------------------

export interface Violation {
  id: string;
  severity: "hard_stop" | "notice";
  detail: string;
}

/**
 * One op-log row as `GET /api/v1/sync` returns it, decoded.
 *
 * It is {@link ChainRow} plus the two fields the chain does not need and the
 * checker does: `seq` (the total order I1 reasons about) and `size_bucket` (the
 * padding rung I5 reasons about). Task 14's response decoder produces these.
 */
export interface SyncRow extends ChainRow {
  seq: bigint;
  size_bucket: number;
}

/** The two writer kinds `GET /api/v1/writers` reports (mirrors `auth.Kind*`). */
export const WRITER_KIND_DEVICE = "device";
export const WRITER_KIND_INGEST = "ingest";

/**
 * One roster row. Revoked writers are INCLUDED in the server's answer, because
 * "this writer was retired" and "this writer was never here" have to be
 * different answers to a device auditing a peer's chain.
 */
export interface Writer {
  writer_id: string;
  kind: string;
  /** null while the writer is live. */
  revoked_at: string | null;
}

export interface CheckInput {
  /** The account these blobs are sealed for; half of what I4 compares. */
  userId: string;
  /** The stream this pull covered. Cursors and chains are both per-stream. */
  stream: Stream;
  /** The rows this pull returned, in the order the server returned them. */
  rows: SyncRow[];
  /** The per-blob hash list (spec §3.3:72), when one was fetched. */
  hashList: HashRow[];
  /**
   * **Every op folded into `state`, in fold order** — not just this page's.
   *
   * I9 and I10 re-derive the state from these, so a partial list is not a
   * weaker check, it is a wrong one. That is not left to trust: I10 compares
   * the re-fold's transactions against `state` in BOTH directions, so a caller
   * that passes only a suffix gets a loud violation rather than a green run.
   */
  ops: LogEntry[];
  state: State;
  roster: Writer[];
  /** Per (writer_id, stream) chain heads the client has already verified. */
  pinnedHeads: Map<ChainKey, Head>;
  /**
   * Per-blob hashes pinned by an earlier `pull-cold-hashes`, keyed by chain and
   * then by `writer_counter`. This is what makes I3b a claim across sessions
   * rather than a comparison of the server against itself.
   */
  pinnedBlobHashes: Map<ChainKey, Map<bigint, Uint8Array>>;
  /** The cursor this pull resumed from, for this stream. */
  cursorBefore: bigint;
  /** The cursor the response tells the client to persist. */
  next: bigint;
}

/**
 * The anomaly vocabulary the fold can produce, frozen here so that an anomaly
 * kind the engine grows without telling anyone is REPORTED rather than counted
 * silently into a total (I14).
 *
 * Twenty kinds. Task 11 recorded nineteen and Task 12 then added
 * `rate_set_before_home_currency`; `check.test.ts` re-derives this set from
 * `replay.ts` itself so the next addition cannot drift past unnoticed.
 */
export const ANOMALY_KINDS: ReadonlySet<string> = new Set([
  "duplicate_create",
  "duplicate_delivery",
  "duplicate_ingest",
  "edit_of_superseded",
  "entity_kind_mismatch",
  "future_parent",
  "home_currency_reset",
  "invalid_op",
  "invalid_parent",
  "invalid_payload",
  "nonexistent_parent",
  "possible_duplicate",
  "rate_set_before_home_currency",
  "rate_set_for_home_currency",
  "rate_unset_for_home_currency",
  "split_sum",
  "supersede_without_origin",
  "unhandled_op",
  "unknown_entity",
  "unsupported_edit_field",
]);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const hard = (id: string, detail: string): Violation => ({ id, severity: "hard_stop", detail });
const note = (id: string, detail: string): Violation => ({ id, severity: "notice", detail });

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Plain comparison: every value compared here is a public chain hash. */
function equalBytes(a: unknown, b: unknown): boolean {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const is32 = (b: unknown): b is Uint8Array => b instanceof Uint8Array && b.length === 32;

/** `chainKey` refuses an unusable writer id; a checker reports rather than throws. */
function safeChainKey(writerId: unknown, stream: unknown): ChainKey | null {
  if (typeof writerId !== "string" || (stream !== "hot" && stream !== "cold")) return null;
  try {
    return chainKey(writerId, stream);
  } catch {
    return null;
  }
}

/** Groups by writer, preserving first-seen order so the output is deterministic. */
function byWriter<T extends { writer_id: string }>(xs: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const w = typeof x.writer_id === "string" ? x.writer_id : "";
    const list = out.get(w);
    if (list === undefined) out.set(w, [x]);
    else list.push(x);
  }
  return out;
}

/** A position, for a message a human has to act on. */
const at = (writerId: unknown, stream: unknown, counter: unknown): string =>
  `(${String(writerId)}, ${String(stream)}, counter ${String(counter)})`;

/**
 * The re-fold I9 and I10 share, computed once.
 *
 * `fold` throws for the two conditions it will not paper over — a caller folding
 * out of order, and an unknown newer schema version — so the failure is captured
 * rather than propagated, and I10 reports it.
 */
interface Refold {
  state: State | null;
  error: string | null;
}

function refold(input: CheckInput): Refold {
  try {
    return { state: fold(input.ops), error: null };
  } catch (err) {
    return { state: null, error: msg(err) };
  }
}

// ---------------------------------------------------------------------------
// I1 — the pulled stream's ordering
// ---------------------------------------------------------------------------

const I1 = "I1_stream_cursor_monotone";

/**
 * Within the pulled stream, `seq` is strictly increasing, every row is past the
 * cursor the client resumed from, and `next` names the last row delivered.
 *
 * **Global `seq` contiguity is deliberately not asserted.** `seq` is one total
 * order across both streams (Decision 13), so a hot-only pull legitimately sees
 * 1, 3, 5, … — those are the cold rows the client chose not to fetch, not gaps.
 * Detecting a genuinely dropped row is I2's job, against the per-(writer,
 * stream) chain, which IS contiguous (spec §3.3:65).
 */
function checkStreamOrder(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  let previous: bigint | null = null;
  for (const [n, r] of i.rows.entries()) {
    if (r.stream !== i.stream) {
      out.push(hard(I1, `row ${n} is on stream ${JSON.stringify(r.stream)}, but this is a ${i.stream} pull`));
    }
    if (typeof r.seq !== "bigint") {
      out.push(hard(I1, `row ${n} has seq ${JSON.stringify(r.seq)}, which is not a bigint`));
      continue;
    }
    if (typeof i.cursorBefore === "bigint" && r.seq <= i.cursorBefore) {
      out.push(hard(I1, `row ${n} is at seq ${r.seq}, at or behind the cursor ${i.cursorBefore} this pull resumed from`));
    }
    if (previous !== null && r.seq <= previous) {
      out.push(hard(I1, `row ${n} is at seq ${r.seq}, which does not follow ${previous}: the page is reordered or repeats a row`));
    }
    previous = r.seq;
  }

  // `next` is what the client persists as its cursor. A `next` beyond the rows
  // actually delivered silently skips everything in between, forever.
  const last = i.rows[i.rows.length - 1];
  const want = last === undefined ? i.cursorBefore : last.seq;
  if (typeof i.next !== "bigint") {
    out.push(hard(I1, `the response's next is ${JSON.stringify(i.next)}, which is not a bigint`));
  } else if (i.next !== want) {
    out.push(
      hard(
        I1,
        `the response's next is ${i.next}, but the last row it delivered is at ${want} — ` +
          `persisting that cursor would skip every row in between`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// I2 — per (writer, stream) counter contiguity
// ---------------------------------------------------------------------------

const I2 = "I2_writer_counters";

/**
 * Per (writer_id, stream), `writer_counter` runs contiguously from the pinned
 * head: no gaps, no duplicates, no reordering. This is what detects a dropped
 * row (spec §3.3:65), which I1 deliberately does not.
 *
 * **Checked against the HASH LIST when one is present for that writer**, and
 * against the fetched rows otherwise. That distinction is what makes a 90-day
 * rolling cold window legal rather than a permanent violation: spec §3.3:70
 * makes cold bodies lazily synced, so their absence is by design, while §3.3:72's
 * compact hash list still proves the chain has no holes.
 */
function checkWriterCounters(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  const hashes = byWriter(i.hashList);
  const rows = byWriter(i.rows.filter((r) => r.stream === i.stream));
  const writers = new Map<string, "hash list" | "rows">();
  for (const w of hashes.keys()) writers.set(w, "hash list");
  for (const w of rows.keys()) if (!writers.has(w)) writers.set(w, "rows");

  for (const [w, source] of writers) {
    const list: { writer_counter: bigint }[] = source === "hash list" ? hashes.get(w)! : rows.get(w)!;
    const key = safeChainKey(w, i.stream);
    if (key === null) {
      out.push(hard(I2, `a ${source} entry names writer ${JSON.stringify(w)}, which cannot be a chain key`));
      continue;
    }
    let want = (i.pinnedHeads.get(key)?.counter ?? 0n) + 1n;
    for (const [n, e] of list.entries()) {
      if (typeof e.writer_counter !== "bigint") {
        out.push(hard(I2, `(${key}) ${source} entry ${n} has counter ${JSON.stringify(e.writer_counter)}`));
        continue;
      }
      if (e.writer_counter !== want) {
        out.push(
          hard(
            I2,
            `(${key}) ${source} entry ${n} has counter ${e.writer_counter} where ${want} is due — ` +
              `a gap, a duplicate or a reordering, and each of the three means a row is missing or repeated`,
          ),
        );
        // Resynchronised so one break is one violation rather than a cascade.
        want = e.writer_counter + 1n;
        continue;
      }
      want++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I3 — the hash chain over the bytes actually delivered
// ---------------------------------------------------------------------------

const I3 = "I3_chain";

/**
 * For every blob whose BYTES are present: `blob_hash === SHA256(prev_hash ‖
 * blob)`, the first blob of a chain links to `ZERO_HASH`, and consecutive blobs
 * link to each other and to the pinned head.
 *
 * Formulated per-blob rather than as one contiguous run because the cold stream
 * legitimately delivers a window (counters 40 and 50 with nothing between), and
 * a run-based check would read that as a break. Every hash is RECOMPUTED from
 * the row's stored bytes, so a server that substitutes a blob cannot stay
 * consistent by also editing the hash column.
 *
 * **What it cannot detect, by construction:** a server that re-chains what it
 * serves. A truncation verifies; a whole alternative history, correctly chained
 * from genesis, verifies. Those are caught only against a head the verifier
 * already trusts — a persisted pinned head, or I11's checkpoint.
 */
function checkChain(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  const byPosition = new Map<string, SyncRow>();
  for (const r of i.rows) byPosition.set(`${r.writer_id}|${r.stream}|${r.writer_counter}`, r);

  for (const [n, r] of i.rows.entries()) {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    if (!(r.blob instanceof Uint8Array)) {
      out.push(hard(I3, `row ${n} ${where} carries no blob bytes to verify`));
      continue;
    }
    if (!is32(r.prev_hash) || !is32(r.blob_hash)) {
      out.push(hard(I3, `row ${n} ${where} has a prev_hash or blob_hash that is not 32 bytes`));
      continue;
    }
    const got = chainHash(r.prev_hash, r.blob);
    if (!equalBytes(got, r.blob_hash)) {
      out.push(hard(I3, `${where} claims hash ${hex(r.blob_hash)}, but its bytes hash to ${hex(got)}`));
    }

    if (typeof r.writer_counter !== "bigint") continue;
    const before = byPosition.get(`${r.writer_id}|${r.stream}|${r.writer_counter - 1n}`);
    if (before !== undefined) {
      if (!equalBytes(r.prev_hash, before.blob_hash)) {
        out.push(hard(I3, `${where} links to ${hex(r.prev_hash)}, but the blob before it hashes to ${hex(before.blob_hash)}`));
      }
      continue;
    }
    if (r.writer_counter === 1n) {
      if (!equalBytes(r.prev_hash, ZERO_HASH)) {
        out.push(hard(I3, `${where} is the first blob of its chain but links to ${hex(r.prev_hash)}, not the genesis hash`));
      }
      continue;
    }
    const key = safeChainKey(r.writer_id, r.stream);
    const pinned = key === null ? undefined : i.pinnedHeads.get(key);
    if (pinned !== undefined && pinned.counter === r.writer_counter - 1n && !equalBytes(r.prev_hash, pinned.hash)) {
      out.push(hard(I3, `${where} links to ${hex(r.prev_hash)}, but the head this client pinned is ${hex(pinned.hash)}`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I3b — the cold hash list, and the bodies checked against it
// ---------------------------------------------------------------------------

const I3B = "I3b_cold_hash_list";

/**
 * The hash list is contiguous and correctly linked from the pinned head, and
 * every cold body actually fetched hashes to the entry that was pinned for it
 * (spec §3.3:72).
 *
 * The list ALONE proves nothing about the bodies — they are not here to hash, so
 * a server free to invent both sides produces a list that verifies. What it
 * proves is that the server COMMITTED to this exact sequence of hashes at this
 * moment; the second half below is what turns that commitment into detection,
 * because the server cannot afterwards change its mind about a hash it has
 * already handed over.
 *
 * Run for any stream whose response carried a hash list — the endpoint serves
 * `hot` too, for a client that has pruned local blobs — but the body check is
 * cold-only, because hot bodies are verified against their own chain by I2+I3.
 */
function checkColdHashList(i: CheckInput): Violation[] {
  const out: Violation[] = [];

  for (const [w, list] of byWriter(i.hashList)) {
    const key = safeChainKey(w, i.stream);
    if (key === null) {
      out.push(hard(I3B, `a hash list entry names writer ${JSON.stringify(w)}, which cannot be a chain key`));
      continue;
    }
    try {
      verifyHashList(key, list, i.pinnedHeads.get(key) ?? { counter: 0n, hash: ZERO_HASH });
    } catch (err) {
      if (!(err instanceof ChainBreakError)) throw err;
      out.push(hard(I3B, msg(err)));
    }
  }

  if (i.stream !== "cold") return out;

  // Everything pinned for this stream: an earlier session's persisted map, plus
  // whatever this response committed to.
  const pinned = new Map<string, Uint8Array>();
  for (const [key, m] of i.pinnedBlobHashes) {
    const sep = typeof key === "string" ? key.indexOf("|") : -1;
    if (sep < 0 || key.slice(sep + 1) !== i.stream) continue;
    for (const [counter, hash] of m) pinned.set(`${key.slice(0, sep)}|${counter}`, hash);
  }
  for (const h of i.hashList) pinned.set(`${h.writer_id}|${h.writer_counter}`, h.blob_hash);

  for (const r of i.rows) {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    const want = pinned.get(`${r.writer_id}|${r.writer_counter}`);
    if (want === undefined) {
      // "I have no pin for this one" is exactly the answer a hostile server
      // wants, so an unpinned body is refused rather than accepted unverified.
      out.push(hard(I3B, `a cold body arrived at ${where}, whose hash was never pinned, so nothing can check it`));
      continue;
    }
    if (!(r.blob instanceof Uint8Array) || !is32(r.prev_hash)) continue; // I3 reported it
    const got = chainHash(r.prev_hash, r.blob);
    if (!equalBytes(got, want)) {
      out.push(hard(I3B, `the cold body at ${where} hashes to ${hex(got)}, but ${hex(want)} was pinned for it`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I4 — the AAD binds a blob to the position it is stored at
// ---------------------------------------------------------------------------

const I4 = "I4_aad";

/**
 * Each blob's embedded associated data equals `(user_id, stream, writer_id,
 * writer_counter)` taken from its own row.
 *
 * This is what stops a server replaying a blob into another position, stream or
 * account — the replay protection Phase 3's AEAD provides cryptographically and
 * Phase 1 provides structurally. The AAD is cleartext framing in both phases, so
 * this check costs no key and does not change when sealing turns on.
 */
function checkAAD(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  for (const [n, r] of i.rows.entries()) {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    let want: Uint8Array;
    try {
      want = aad({ userId: i.userId, stream: r.stream, writerId: r.writer_id, writerCounter: r.writer_counter });
    } catch (err) {
      out.push(hard(I4, `row ${n} ${where} does not name a position a blob could be sealed at: ${msg(err)}`));
      continue;
    }
    let got: Uint8Array;
    try {
      got = embeddedAAD(r.blob);
    } catch (err) {
      out.push(hard(I4, `row ${n} ${where} carries no readable associated data: ${msg(err)}`));
      continue;
    }
    if (!equalBytes(got, want)) {
      out.push(hard(I4, `the blob served at ${where} was sealed as ${JSON.stringify(text(got))}, not ${JSON.stringify(text(want))}`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I5 — the size-bucket ladder
// ---------------------------------------------------------------------------

const I5 = "I5_bucket";

/**
 * Every stored blob is exactly `size_bucket` bytes long and `size_bucket` is one
 * of the seven frozen rungs. Padding to a bucket is what stops a blob's size
 * leaking its content's size; a blob off the ladder either did not go through
 * the sealer or was edited after it did.
 */
function checkBucket(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  for (const r of i.rows) {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    if (typeof r.size_bucket !== "number" || !BUCKETS.includes(r.size_bucket)) {
      out.push(hard(I5, `${where} declares size_bucket ${JSON.stringify(r.size_bucket)}, which is not one of the seven buckets`));
      continue;
    }
    if (!(r.blob instanceof Uint8Array) || r.blob.length !== r.size_bucket) {
      const n = r.blob instanceof Uint8Array ? r.blob.length : "no";
      out.push(hard(I5, `${where} declares size_bucket ${r.size_bucket} but carries ${n} bytes`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I6 — schema versions
// ---------------------------------------------------------------------------

const I6 = "I6_schema_version";

/**
 * No op is from a newer schema version than this build understands.
 *
 * `decodeBlobOps` already hard-stops on one, and this re-asserts it against the
 * ops as folded — a re-assertion rather than a duplicate, because ops can also
 * be assembled in code (Task 14's `emit`) and never pass a decoder at all.
 */
function checkSchemaVersion(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  for (const [n, e] of i.ops.entries()) {
    const v = (e as { op?: { v?: unknown; op_id?: unknown } }).op?.v;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      out.push(hard(I6, `op ${n} declares version ${JSON.stringify(v)}`));
    } else if (v > SCHEMA_VERSION) {
      out.push(hard(I6, `op ${n} (${String(e.op.op_id)}) is v${v}, and this build supports v${SCHEMA_VERSION}`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I7 — one live transaction per ingest id
// ---------------------------------------------------------------------------

const I7 = "I7_one_live_per_ingest";

/**
 * `liveByIngestID` holds exactly one live transaction per ingest id, and every
 * live transaction is reachable from it.
 *
 * The map gives "at most one" for free; the second direction is what makes it
 * exactly one, and it is the direction the whole dedup design rests on (spec
 * §3.3:67 keys dedup on ingest identity, not on parse output). A retired row
 * staying visible in `txns` is correct and is not flagged.
 */
function checkOneLivePerIngest(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  for (const [ingestID, txnID] of i.state.liveByIngestID) {
    const t = i.state.txns.get(txnID);
    if (t === undefined) {
      out.push(hard(I7, `the live index maps ingest ${ingestID.slice(0, 12)}… to ${txnID}, which is not a transaction`));
      continue;
    }
    if (t.ingest_id !== ingestID) {
      out.push(hard(I7, `the live index files ${txnID} under ingest ${ingestID.slice(0, 12)}…, but the row carries ${t.ingest_id.slice(0, 12)}…`));
    }
    if (t.superseded_by !== null) {
      out.push(hard(I7, `the live index names ${txnID} as live, but it was superseded by ${t.superseded_by}`));
    }
  }
  for (const [id, t] of i.state.txns) {
    if (t.superseded_by !== null) continue;
    const live = i.state.liveByIngestID.get(t.ingest_id);
    if (live !== id) {
      out.push(
        hard(
          I7,
          `${id} is live but the index for its ingest ${t.ingest_id.slice(0, 12)}… names ${live === undefined ? "nothing" : live} — ` +
            `two live rows for one email, or a live row nothing can find`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I8 — splits sum to their parent
// ---------------------------------------------------------------------------

const I8 = "I8_split_sum";

/** Every applied split's parts sum exactly to its parent's `amount_minor`. */
function checkSplitSum(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  for (const [id, t] of i.state.txns) {
    if (!Array.isArray(t.splits) || t.splits.length === 0) continue;
    let sum = 0n;
    let shaped = true;
    for (const [n, p] of t.splits.entries()) {
      if (typeof p.amount_minor !== "bigint") {
        // Checked before summing: `0n + 10000` throws, and a check that throws
        // tells the caller far less than a check that names the field.
        out.push(hard(I8, `${id} split part ${n} carries ${typeof p.amount_minor} ${JSON.stringify(String(p.amount_minor))}, not a bigint`));
        shaped = false;
        continue;
      }
      sum += p.amount_minor;
    }
    if (!shaped) continue;
    if (typeof t.amount_minor !== "bigint") continue; // I12 reported it
    if (sum !== t.amount_minor) {
      out.push(hard(I8, `${id} is split into parts summing to ${sum}, but the transaction is ${t.amount_minor}`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I9 — version contiguity
// ---------------------------------------------------------------------------

const I9 = "I9_version_contiguity";

/**
 * Every entity's applied versions are `1…head`, with no gaps.
 *
 * # How this is actually assertable
 *
 * The state records each entity's HEAD version, not the set of versions that
 * were applied to reach it — so "no gaps" cannot be read off `state` alone, and
 * a checker that only re-derived it from the fold would be asserting a property
 * the fold makes true by construction (`version += 1`, always) and therefore
 * asserting nothing. The three checkable halves it decomposes into:
 *
 *   1. **Shape.** A head version is an integer ≥ 1, because numbering starts at
 *      the create and version 0 never existed.
 *   2. **Bijection.** Every head has a materialized entity and every
 *      materialized entity has a head, at the SAME version. This is the one that
 *      bites: the fork-loser path mirrors the head version onto the entity
 *      through a separate call, and a state where the two drift is a state two
 *      replicas cannot agree on.
 *   3. **Re-derivation.** The head version equals what re-folding `ops` from
 *      position 0 produces. Since the re-fold's version line is contiguous by
 *      construction, equality with it IS the contiguity claim, transferred onto
 *      a state that may have been assembled or persisted by anything.
 *
 * `heads` retaining an entry for a retired transaction forever is correct and is
 * not flagged: a supersede does not end the predecessor's version line, because
 * an edit authored offline against the retired row still arrives and still has
 * to resolve.
 */
function checkVersionContiguity(i: CheckInput, r: Refold): Violation[] {
  const out: Violation[] = [];
  const materialized = new Map<string, { version: unknown; what: string }>();
  for (const [id, t] of i.state.txns) materialized.set(entityKey("txn", id), { version: t.version, what: `txn ${id}` });
  for (const [id, x] of i.state.rules) materialized.set(entityKey("rule", id), { version: x.version, what: `rule ${id}` });

  for (const [key, head] of i.state.heads) {
    const what = `${head.kind} ${head.id}`;
    if (typeof head.version !== "number" || !Number.isInteger(head.version) || head.version < 1) {
      out.push(hard(I9, `${what} has head version ${JSON.stringify(head.version)}; versions start at 1, so 0 never existed`));
    }
    const m = materialized.get(key);
    if (m === undefined) {
      out.push(hard(I9, `${what} has a head at version ${head.version} but is not materialized anywhere`));
      continue;
    }
    if (m.version !== head.version) {
      out.push(hard(I9, `${m.what} is materialized at version ${JSON.stringify(m.version)} while its head is at ${head.version}`));
    }
  }
  for (const [key, m] of materialized) {
    if (!i.state.heads.has(key)) {
      out.push(hard(I9, `${m.what} is materialized at version ${JSON.stringify(m.version)} with no head registered for it`));
    }
  }

  if (r.state === null) return out; // I10 reports the re-fold failure
  for (const [key, head] of r.state.heads) {
    const have = i.state.heads.get(key);
    if (have === undefined) {
      out.push(hard(I9, `${head.kind} ${head.id} reaches version ${head.version} in the op log but has no head in the state`));
    } else if (have.version !== head.version) {
      out.push(
        hard(
          I9,
          `${head.kind} ${head.id} is at version ${have.version} in the state, but re-folding the log from position 0 ` +
            `reaches ${head.version} — the version line has a gap or a jump`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I10 — the state is reproducible by re-folding from position 0
// ---------------------------------------------------------------------------

const I10 = "I10_fx_prefix_monotone";

/**
 * Re-folding every op from position 0 reproduces every `amount_home_minor` in
 * the state.
 *
 * This is the check that catches the FX hazard spec §3.7:134 names: freezing a
 * snapshot at the END of a fold, against the final rate head, agrees with the
 * correct answer on the final state of many logs and disagrees on every
 * intermediate one. A device that synced in ten chunks and one restoring from
 * scratch would then show different money.
 *
 * Compared BOTH ways, which is also what makes `ops` being the whole history a
 * checked precondition rather than a documented one: a caller that passes only
 * this page's ops gets a loud violation instead of a vacuous pass.
 *
 * It compares named fields rather than `serializeState`, on purpose. Two states
 * legitimately differ in fields the witness does compare — `unreadable` and the
 * cursor both move for a set-aside blob that contributes no ops — so a
 * whole-state comparison would fire on a correct log.
 */
function checkFXPrefixMonotone(i: CheckInput, r: Refold): Violation[] {
  if (r.state === null) {
    return [hard(I10, `the ops backing this state cannot be re-folded in the order given: ${r.error}`)];
  }
  const out: Violation[] = [];
  for (const [id, t] of i.state.txns) {
    const again = r.state.txns.get(id);
    if (again === undefined) {
      out.push(hard(I10, `${id} is in the state but re-folding the op log from position 0 never creates it`));
      continue;
    }
    if (t.amount_home_minor !== again.amount_home_minor) {
      out.push(
        hard(
          I10,
          `${id} holds the home-currency snapshot ${String(t.amount_home_minor)}, but re-folding from position 0 ` +
            `computes ${String(again.amount_home_minor)} — a snapshot must be frozen at its own log position, never at the final rate head`,
        ),
      );
    }
  }
  for (const id of r.state.txns.keys()) {
    if (!i.state.txns.has(id)) {
      out.push(hard(I10, `re-folding the op log from position 0 creates ${id}, which is not in the state`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I11 — roster and checkpoint
// ---------------------------------------------------------------------------

const I11 = "I11_roster_checkpoint";

/**
 * The cross-check that stops a server silently omitting a whole writer (spec
 * §3.4). A chain verifies relative to a head the verifier already trusts, and
 * `writer_checkpoint` is where a device gets a trusted head for a PEER's chain.
 *
 * The no-checkpoint case is defined rather than left open, because undefined is
 * how this invariant passes vacuously with the feature absent:
 *
 *   - **no checkpoint, ≤ 1 live device writer** → `notice`. A brand-new
 *     single-device user has nothing to cross-check. (Zero device writers gets
 *     the same answer for the same reason; the plan named only the one-writer
 *     case, and leaving the other undefined would reopen exactly the hole this
 *     paragraph exists to close.)
 *   - **no checkpoint, ≥ 2 live device writers** → `hard_stop`. With multiple
 *     devices enrolled the protection does not exist, and sync must not proceed
 *     as though it did.
 *   - **a checkpoint exists** → `hard_stop` if a live device writer is missing
 *     from it, or if a head claims a counter above what has been observed.
 *
 * # Two severities that look inconsistent and are not
 *
 * "The roster omits a writer the checkpoint names" is a NOTICE, while "the
 * checkpoint omits a writer the roster names" is a HARD STOP. Both directions
 * are reachable by a benign race — a device enrolled between the roster fetch
 * and the pull, or after the last checkpoint was written — and the plan makes
 * only the second a hard stop. The asymmetry earns itself: the second race
 * self-heals, because Task 14's `push` emits a checkpoint whenever the roster it
 * sees has changed, so a freshly enrolled writer is checkpointed on its own
 * first push. The first has no such repair, and hard-stopping every sync over a
 * roster that is one request stale would make the product unusable.
 *
 * # A bootstrap ordering dependency this creates, which Task 14 must handle
 *
 * "Two or more device writers and no checkpoint" is a hard stop, and
 * `Client.pull()` persists nothing over a hard stop — so a SECOND device cannot
 * finish its first sync until some device has written a checkpoint. That is not
 * a bug in the rule; it is the rule doing its job, because such an account has
 * no cross-check against a withheld writer. It is self-clearing, because `push`
 * emits a checkpoint whenever the roster it sees has changed, so enrolling a
 * second device makes the first one checkpoint on its next push (and Task 38
 * step 4 already sequences it that way). But it means enrolment and the first
 * checkpoint are ORDERED, and a client that enrols a device and immediately
 * pulls from it will hard-stop until the peer pushes. `check.test.ts` pins the
 * behaviour page by page so this cannot be rediscovered as a mystery.
 *
 * # Counters are only compared where there is something to compare against
 *
 * A hot-only pull cannot observe the cold chain — that is what spec §3.3:70
 * makes normal — so a checkpoint head on the other stream is reported as
 * uncross-checked rather than treated as evidence of withholding. On the stream
 * being pulled there is no such excuse: a checkpoint proves the writer's blobs
 * existed before the checkpoint's own position, which this client has already
 * folded past, so "we have seen none of them" means the server withheld them.
 */
function checkRosterCheckpoint(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  const roster = new Map(i.roster.map((w) => [w.writer_id, w]));
  const liveDevices = i.roster.filter((w) => w.kind === WRITER_KIND_DEVICE && w.revoked_at === null);

  // A writer appending blobs the roster has never heard of is the same class of
  // omission, catchable without a checkpoint. A notice, for the race above.
  for (const w of new Set(i.rows.map((r) => r.writer_id))) {
    if (!roster.has(w)) {
      out.push(note(I11, `the server served blobs from writer ${JSON.stringify(w)}, which its own roster does not list`));
    }
  }

  const checkpoints = i.state.checkpoints;
  if (checkpoints.length === 0) {
    if (liveDevices.length >= 2) {
      const names = liveDevices.map((w) => w.writer_id).join(", ");
      out.push(
        hard(
          I11,
          `${liveDevices.length} device writers are enrolled (${names}) and no writer_checkpoint has been seen — ` +
            `nothing cross-checks one device's chain against another's, so a withheld writer would be invisible`,
        ),
      );
      return out;
    }
    out.push(
      note(
        I11,
        liveDevices.length === 1 ? "no checkpoint yet (single writer)" : "no checkpoint yet (no device writers enrolled)",
      ),
    );
    return out;
  }

  const named = new Set(checkpoints.map((c) => c.writer_id));
  for (const w of liveDevices) {
    if (!named.has(w.writer_id)) {
      out.push(
        hard(
          I11,
          `the latest writer_checkpoint names no head for live device writer ${w.writer_id} — ` +
            `that writer's chain has no trusted head, so a truncation of it would verify`,
        ),
      );
    }
  }

  for (const c of checkpoints) {
    if (!roster.has(c.writer_id)) {
      out.push(note(I11, `the latest writer_checkpoint names writer ${JSON.stringify(c.writer_id)}, which the server's roster does not list`));
    }
    const key = safeChainKey(c.writer_id, c.stream);
    if (key === null) {
      out.push(hard(I11, `a checkpoint head names (${c.writer_id}, ${c.stream}), which cannot be a chain key`));
      continue;
    }
    if (c.stream !== i.stream) {
      out.push(
        note(
          I11,
          `checkpoint head (${key}) claims counter ${c.counter} and was not cross-checked: this pull covered the ` +
            `${i.stream} stream only`,
        ),
      );
      continue;
    }
    const observed = observedHead(i, key);
    if (typeof c.counter === "bigint" && c.counter > observed) {
      out.push(
        hard(
          I11,
          `checkpoint head (${key}) claims counter ${c.counter}, but the highest blob this client has ever seen on ` +
            `that chain is ${observed} — the server is withholding rows a peer device has already witnessed`,
        ),
      );
    }
  }
  return out;
}

/** The highest counter this client has evidence of on one chain. */
function observedHead(i: CheckInput, key: ChainKey): bigint {
  let best = i.pinnedHeads.get(key)?.counter ?? 0n;
  for (const r of i.rows) {
    if (safeChainKey(r.writer_id, r.stream) === key && typeof r.writer_counter === "bigint" && r.writer_counter > best) {
      best = r.writer_counter;
    }
  }
  for (const h of i.hashList) {
    if (safeChainKey(h.writer_id, i.stream) === key && typeof h.writer_counter === "bigint" && h.writer_counter > best) {
      best = h.writer_counter;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// I12 — money shape
// ---------------------------------------------------------------------------

const I12 = "I12_money_shape";

/**
 * Every amount is a positive BigInt, every direction is `debit` or `credit`, and
 * no money field anywhere holds a `number`.
 *
 * A `number` is not a style violation: `amount_minor × rate_micro` exceeds 2^53
 * long before the result does, so a float on this path produces a plausible
 * answer that is wrong by a minor unit rather than an obvious failure.
 *
 * A home-currency snapshot of ZERO is accepted. Rounding half-up can genuinely
 * produce it (one minor unit at a tiny rate), and `amount_home_minor` is the one
 * money field that is a computed result rather than a parsed amount.
 */
function checkMoneyShape(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  for (const [id, t] of i.state.txns) {
    if (typeof t.amount_minor !== "bigint") {
      out.push(hard(I12, `${id}.amount_minor is a ${typeof t.amount_minor} (${JSON.stringify(String(t.amount_minor))}), not a bigint`));
    } else if (t.amount_minor <= 0n) {
      out.push(hard(I12, `${id}.amount_minor is ${t.amount_minor}; amounts are always positive and direction carries the sign`));
    }
    if (t.direction !== "debit" && t.direction !== "credit") {
      out.push(hard(I12, `${id}.direction is ${JSON.stringify(t.direction)}, not debit or credit`));
    }
    if (t.amount_home_minor !== null) {
      if (typeof t.amount_home_minor !== "bigint") {
        out.push(hard(I12, `${id}.amount_home_minor is a ${typeof t.amount_home_minor}, not a bigint or null`));
      } else if (t.amount_home_minor < 0n) {
        out.push(hard(I12, `${id}.amount_home_minor is ${t.amount_home_minor}, and a converted amount is never negative`));
      }
    }
    for (const [n, p] of (Array.isArray(t.splits) ? t.splits : []).entries()) {
      if (typeof p.amount_minor !== "bigint") {
        out.push(hard(I12, `${id} split part ${n} carries a ${typeof p.amount_minor}, not a bigint`));
      } else if (p.amount_minor <= 0n) {
        out.push(hard(I12, `${id} split part ${n} is ${p.amount_minor}, and a split part is a positive amount`));
      }
    }
  }
  for (const [ccy, rate] of i.state.rates) {
    if (rate === null) continue; // a live rate_unset, which is a fact and not a rate
    if (typeof rate !== "bigint") {
      out.push(hard(I12, `the rate head for ${ccy} is a ${typeof rate}, not a bigint — rate_micro overflows a double when multiplied`));
    } else if (rate <= 0n) {
      out.push(hard(I12, `the rate head for ${ccy} is ${rate}`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I13 — a supersede names an ingest a txn_ingested introduced
// ---------------------------------------------------------------------------

const I13 = "I13_supersede_has_origin";

/**
 * Every `txn_superseded` names an ingest id that an EARLIER `txn_ingested`
 * introduced.
 *
 * Derived from the ops rather than read off `state.anomalies`, on purpose: a
 * checker whose findings are the engine's own findings re-printed cannot catch
 * the engine. It agrees with `supersede_without_origin` when both are looking at
 * the same log, and that agreement is worth something precisely because the two
 * were computed independently.
 *
 * A notice, not a hard stop: the supersede still materializes a visible row, and
 * the missing origin is recoverable by syncing the blob that carries it.
 */
function checkSupersedeHasOrigin(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  const introduced = new Set<string>();
  for (const e of i.ops) {
    const op = e.op;
    if (op === undefined || op === null) continue;
    if (op.type === "txn_ingested") {
      if (typeof op.ingest_id === "string") introduced.add(op.ingest_id);
      continue;
    }
    if (op.type !== "txn_superseded") continue;
    if (typeof op.ingest_id !== "string" || !introduced.has(op.ingest_id)) {
      const shown = typeof op.ingest_id === "string" ? `${op.ingest_id.slice(0, 12)}…` : JSON.stringify(op.ingest_id);
      out.push(note(I13, `${op.op_id} at seq ${e.seq} supersedes ingest ${shown}, which no earlier txn_ingested introduced`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I14 — forks and anomalies are surfaced, never zero-suppressed
// ---------------------------------------------------------------------------

const I14 = "I14_forks_surfaced";

/**
 * Reports the fork and anomaly counts UNCONDITIONALLY, including when both are
 * zero, and checks that what was surfaced is well formed.
 *
 * # Why the unconditional notice is the invariant
 *
 * "Forks and anomalies are surfaced, never zero-suppressed" is not a predicate
 * over the state — it is a property of the REPORT. An operator who only sees
 * this line when it is non-empty cannot tell a clean sync from a broken
 * reporting path, which is the whole failure this exists to prevent. So the
 * notice is emitted always, and its content is what varies.
 *
 * Three things about it are checkable, and each has a violating fixture:
 *
 *   - **Every anomaly kind is in the frozen vocabulary.** A kind the engine grew
 *     without anyone updating {@link ANOMALY_KINDS} is reported by name instead
 *     of being counted silently into a total.
 *   - **No fork names one op as both winner and loser.** That is the exact shape
 *     the op-redelivery hazard produced: an entity forked against itself.
 *   - **A duplicate flagged on a row is also in the anomaly stream.** Bounded as
 *     `flagged ≤ possible_duplicate anomalies`, because a row can be re-indexed
 *     into a new bucket (gaining a second anomaly) or edited out of one (keeping
 *     the old anomaly), so only that direction is true of a correct log.
 *
 * # What it must NOT assert
 *
 * That `possible_duplicate_of` still points at a row sharing its fingerprint.
 * The field is a snapshot of the answer at the moment the row was indexed; the
 * pointed-at row can afterwards be edited into a different bucket and nothing
 * re-walks the rows pointing at it. Re-deriving it on every edit would be a scan,
 * and the value of a duplicate NOTICE does not justify one.
 *
 * Everything here is `notice` severity, per the plan. A fork naming one op twice
 * is a real defect, so the detail says so in as many words rather than raising a
 * severity the plan did not sanction.
 */
function checkForksSurfaced(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  const forks = i.state.forks;
  const anomalies = i.state.anomalies;

  const counts = new Map<string, number>();
  for (const a of anomalies) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort(([a], [b]) => compareUTF8(a, b))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  out.push(
    note(
      I14,
      `${plural(forks.length, "fork", "forks")}, ${plural(anomalies.length, "anomaly", "anomalies")}` +
        (breakdown === "" ? "" : ` (${breakdown})`),
    ),
  );

  const unknown = [...counts.keys()].filter((k) => !ANOMALY_KINDS.has(k)).sort(compareUTF8);
  if (unknown.length > 0) {
    out.push(
      note(
        I14,
        `anomaly kind(s) outside the frozen vocabulary: ${unknown.join(", ")} — the engine grew a refusal this ` +
          `checker does not know about, so nothing is validating how it is surfaced`,
      ),
    );
  }

  for (const f of forks) {
    if (f.winner_op === f.loser_op) {
      out.push(
        note(
          I14,
          `the fork on ${f.entity.kind} ${f.entity.id} at seq ${f.at_seq} names ${f.winner_op} as BOTH winner and ` +
            `loser: the entity was forked against itself, which means an op was applied twice`,
        ),
      );
    }
    if (typeof f.at_seq !== "bigint") {
      out.push(note(I14, `the fork on ${f.entity.kind} ${f.entity.id} records at_seq ${JSON.stringify(f.at_seq)}, not a bigint`));
    }
  }

  const flagged = [...i.state.txns.values()].filter((t) => typeof t.possible_duplicate_of === "string").length;
  const surfaced = counts.get("possible_duplicate") ?? 0;
  if (flagged > surfaced) {
    out.push(
      note(
        I14,
        `${flagged} transaction(s) carry possible_duplicate_of but only ${surfaced} possible_duplicate anomal${surfaced === 1 ? "y" : "ies"} ` +
          `were surfaced — a flagged duplicate is missing from the anomaly stream`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// I15 — unreadable blobs are set aside, and never abort
// ---------------------------------------------------------------------------

const I15 = "I15_unreadable_set_aside";

/**
 * Every blob that failed to decode is in `state.unreadable` with the position it
 * came from, and none of them aborted the session.
 *
 * # The two severities, and why they differ
 *
 * The PRESENCE of set-aside blobs is a `notice`: spec §3.3:68 reserves hard
 * stops for chain breaks and unknown-newer versions, and one bad blob must never
 * strand a device. But a set-aside record that does not say where it came from,
 * or one the cursor never moved past, is a `hard_stop` — those are not "a blob
 * was unreadable", they are "the set-aside mechanism is broken".
 *
 * The cursor half is the one that matters. A seq consumed by a set-aside blob
 * that the cursor did not advance over can be re-delivered later with DIFFERENT
 * content and folded as if it were new, and the client would re-request the same
 * unreadable blob forever in the meantime.
 */
function checkUnreadableSetAside(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  const list = i.state.unreadable;
  if (list.length > 0) {
    const where = list.map((u) => `${at(u.writer_id, u.stream, u.writer_counter)} at seq ${String(u.seq)}`).join("; ");
    out.push(note(I15, `${list.length} blob(s) set aside and not folded: ${where}`));
  }
  for (const [n, u] of list.entries()) {
    if (
      typeof u.writer_id !== "string" ||
      u.writer_id === "" ||
      (u.stream !== "hot" && u.stream !== "cold") ||
      typeof u.writer_counter !== "bigint" ||
      u.writer_counter < 1n ||
      typeof u.seq !== "bigint" ||
      u.seq < 1n
    ) {
      out.push(
        hard(
          I15,
          `set-aside record ${n} does not name the position it came from ` +
            `(writer ${JSON.stringify(u.writer_id)}, stream ${JSON.stringify(u.stream)}, counter ${String(u.writer_counter)}, ` +
            `seq ${String(u.seq)}) — an unrecoverable blob nobody can go back and fetch`,
        ),
      );
      continue;
    }
    if (u.stream === "hot" && typeof i.state.cursors.hot === "bigint" && i.state.cursors.hot < u.seq) {
      out.push(
        hard(
          I15,
          `the blob set aside at seq ${u.seq} did not carry the cursor past it (the cursor is at ${i.state.cursors.hot}) — ` +
            `that seq can be re-delivered later with different content and folded as if it were new`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// I16 — cold blobs carry no ops
// ---------------------------------------------------------------------------

const I16 = "I16_cold_carries_no_ops";

/**
 * Every fetched cold blob decodes as a `raw_body` record and never as an op
 * list.
 *
 * This is what licenses a hot-only sync to be a COMPLETE materialization: state
 * is a pure function of the hot stream. If a cold blob could ever carry state,
 * every hot-only client — which is the mode the product actually ships (spec
 * §3.3:70) — would be silently wrong, with no symptom until someone compared two
 * devices.
 *
 * A body that will not parse at all is left alone: that is an unreadable blob,
 * which is I15's business and a notice. Only a body that parses and then
 * declares itself something other than a raw record is a violation — otherwise
 * this check would relabel every corrupt cold blob as a smuggled op list.
 */
function checkColdCarriesNoOps(i: CheckInput): Violation[] {
  if (i.stream !== "cold") return [];
  const out: Violation[] = [];
  for (const r of i.rows) {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    let plaintext: Uint8Array;
    try {
      plaintext = openBlob(
        { userId: i.userId, stream: r.stream, writerId: r.writer_id, writerCounter: r.writer_counter },
        r.blob,
      );
    } catch {
      continue; // I4 / I5 / I15 own this blob; nothing here can be claimed about its kind
    }
    try {
      JSON.parse(text(plaintext));
    } catch {
      continue; // not even a JSON document: unreadable, not a smuggled op list
    }
    let kind: string;
    try {
      kind = kindOf(plaintext);
    } catch (err) {
      out.push(hard(I16, `the cold blob at ${where} declares no usable kind: ${msg(err)}`));
      continue;
    }
    if (kind !== KIND_RAW_BODY) {
      out.push(
        hard(
          I16,
          `the cold blob at ${where} decodes as ${JSON.stringify(kind)}, not ${JSON.stringify(KIND_RAW_BODY)} — ` +
            `cold blobs carry raw email bodies and nothing else, or a hot-only sync stops being a complete materialization`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------

interface Invariant {
  id: string;
  run: (i: CheckInput, r: Refold) => Violation[];
}

/**
 * The seventeen, in the order they are reported. Each is a small named function
 * returning its own violations, so a new invariant is one entry plus one test.
 */
const CHECKS: readonly Invariant[] = [
  { id: I1, run: checkStreamOrder },
  { id: I2, run: checkWriterCounters },
  { id: I3, run: checkChain },
  { id: I3B, run: checkColdHashList },
  { id: I4, run: checkAAD },
  { id: I5, run: checkBucket },
  { id: I6, run: checkSchemaVersion },
  { id: I7, run: checkOneLivePerIngest },
  { id: I8, run: checkSplitSum },
  { id: I9, run: checkVersionContiguity },
  { id: I10, run: checkFXPrefixMonotone },
  { id: I11, run: checkRosterCheckpoint },
  { id: I12, run: checkMoneyShape },
  { id: I13, run: checkSupersedeHasOrigin },
  { id: I14, run: checkForksSurfaced },
  { id: I15, run: checkUnreadableSetAside },
  { id: I16, run: checkColdCarriesNoOps },
];

/**
 * Every invariant id, derived from the table above so the two cannot drift. The
 * CLI prints its length; a test pins it at seventeen.
 */
export const INVARIANT_IDS: readonly string[] = CHECKS.map((c) => c.id);

/**
 * Runs every invariant and returns everything found. The caller decides:
 * `hard_stop` aborts the sync session, `notice` is printed.
 *
 * It never throws. A check that does is converted into a `hard_stop` naming
 * itself, because a checker that dies on broken input has told the caller
 * nothing — and "the state could not be certified" is exactly a hard stop.
 */
export function checkAll(input: CheckInput): Violation[] {
  const r = refold(input);
  const out: Violation[] = [];
  for (const c of CHECKS) {
    try {
      out.push(...c.run(input, r));
    } catch (err) {
      out.push(hard(c.id, `the check itself could not run, so this state is uncertified: ${msg(err)}`));
    }
  }
  return out;
}
