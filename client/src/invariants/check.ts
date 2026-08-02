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

import { platform } from "../platform";
import { applyOp, type LogEntry } from "../replay/replay";
import { emptyState, entityKey, type State } from "../replay/state";
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
import {
  KIND_RAW_BODY,
  SCHEMA_VERSION,
  UnknownNewerVersionError,
  compareUTF8,
  decodeBlobOps,
  decodeRawBody,
  kindOf,
} from "../wire/op";

// ---------------------------------------------------------------------------
// The inputs
// ---------------------------------------------------------------------------

export interface Violation {
  id: string;
  severity: "hard_stop" | "notice";
  detail: string;
  /**
   * Which CONDITION under this id was hit, where one invariant covers more than
   * one and a caller has to act on them differently.
   *
   * Only `I11_roster_checkpoint` sets it today, and the reason is a hole that
   * was built end to end before this field existed. I11 bundles a benign
   * condition — "the roster has a live device writer this checkpoint does not
   * name" — with an adversarial one — "the server is withholding rows a peer has
   * already witnessed". Task 14's `push` must proceed over the first, because
   * writing the checkpoint is the repair and refusing deadlocks the whole
   * account; it must NEVER proceed over the second, because a device that is
   * being withheld from has nothing trustworthy to attest, and a checkpoint it
   * wrote would replace the honest one and launder the attack into a notice.
   *
   * **Absent means "not safe to proceed over".** The field is optional so that a
   * condition added later is un-escapable by default: a caller allow-lists the
   * kinds it knows are benign and treats everything else, kinded or not, as a
   * stop. Do not invert that into a deny-list.
   */
  kind?: string;
}

/**
 * `I11_roster_checkpoint`: the roster names a live device writer that the latest
 * checkpoint does not cover (including "there is no checkpoint at all").
 *
 * Benign — it is reachable by an ordinary race, a device enrolled since the last
 * checkpoint was written — and REPAIRABLE by writing a checkpoint, which is why
 * it is the one hard stop a push may proceed over.
 */
export const VIOLATION_ROSTER_COVERAGE = "roster_coverage";

/**
 * `I11_roster_checkpoint`: a checkpoint attests a head above the highest blob
 * this client has ever seen on that chain — the server is withholding rows a
 * peer device already witnessed.
 *
 * Adversarial, and NOT repairable by this device: it cannot attest a chain it is
 * being lied to about. Anything that treats I11 as one condition and proceeds
 * will proceed over this too.
 */
export const VIOLATION_CHAIN_WITHHELD = "chain_withheld";

/**
 * `I6_schema_version` / `I15_unreadable_set_aside`: an op or a blob is from a
 * schema version newer than this build understands.
 *
 * Kinded because it is the one hard stop whose meaning to a USER is completely
 * different from every other one: nothing is wrong with the data and nothing is
 * wrong with the server — this app is behind. `surface.ts` turns it into "update
 * the app" rather than into the tamper message, which is a distinction spec
 * §3.3:68 makes and Task 12 Step 3 requires a test for.
 */
export const VIOLATION_NEWER_VERSION = "newer_version";

/**
 * A check threw, or the row source was not re-iterable: the state is
 * UNCERTIFIED rather than known-bad.
 *
 * It is a hard stop for the same reason a chain break is — nothing downstream
 * may treat this state as verified — but the copy a user gets says the checker
 * could not finish, because "your data has been tampered with" would be a claim
 * nothing measured.
 */
export const VIOLATION_CHECK_FAILED = "check_failed";

/** `I11_roster_checkpoint`: no checkpoint exists yet and none is required. Routine. */
export const NOTICE_NO_CHECKPOINT_YET = "no_checkpoint_yet";

/**
 * `I11_roster_checkpoint`: a checkpoint head on the stream this pull did not
 * cover, so it was not cross-checked. Routine — spec §3.3:70 makes a hot-only
 * pull the shipping mode, so this is emitted per device per stream on every
 * healthy sync, and Phase 1's exit run drowned in them.
 */
export const NOTICE_OTHER_STREAM = "other_stream";

/** `I14_forks_surfaced`: the unconditional fork/anomaly count line. Routine by construction. */
export const NOTICE_COUNTS = "counts";

/** `I15_unreadable_set_aside`: the "N blob(s) set aside" line — the third UI lane. */
export const NOTICE_SET_ASIDE = "set_aside";

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

/**
 * A re-iterable sequence delivered a chunk at a time, retaining nothing between
 * chunks.
 *
 * This is what makes the checker streamable. `RowStore.range` is the only read
 * path the store offers and `eachRowChunk(250)` is the sanctioned full pass, so
 * a whole-log check that wanted an array would have to build one — which is
 * exactly the >500 MB shape Phase 0 froze on, at up to 1 MiB per blob
 * ({@link BUCKETS}).
 *
 * **`each` must be callable more than once and must yield the same sequence
 * every time.** Several invariants need their own pass (I1 walks seqs, I3 walks
 * the chain, I15 opens every blob), and none of them may lean on another's. A
 * one-shot generator is therefore NOT a valid source; {@link arrayChunks} and
 * the store-backed sources in `source.ts` are both re-iterable by construction,
 * and `checkAllStream` asserts the row source is re-iterable rather than
 * trusting it (see {@link REITERABLE}).
 *
 * A source must retain no chunk it has handed out, and no consumer here keeps
 * one: `stream.test.ts` poisons every chunk once the next is requested and
 * re-runs the whole checker over it.
 */
export interface Chunks<T> {
  each(fn: (chunk: readonly T[]) => void): void;
}

/** The chunk size the store's full pass uses, and the one an array source mimics. */
export const CHECK_CHUNK = 250;

/**
 * An in-memory array as a {@link Chunks}, sliced at {@link CHECK_CHUNK}.
 *
 * The array front door ({@link checkAll}) goes through this, so the array path
 * and the streaming path are one implementation and cannot drift. It slices
 * rather than handing the whole array over precisely so the array path exercises
 * chunk boundaries too — a source that yielded one giant chunk would let a
 * consumer that retains chunks pass every test.
 */
export function arrayChunks<T>(xs: readonly T[], limit: number = CHECK_CHUNK): Chunks<T> {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`arrayChunks needs a positive integer chunk size, got ${String(limit)}`);
  return {
    each(fn) {
      if (!Array.isArray(xs)) {
        // `checkAll` is handed junk in one test on purpose; a source that threw
        // here would turn every check into "the check itself could not run"
        // instead of the specific finding each one owes.
        return;
      }
      for (let n = 0; n < xs.length; n += limit) fn(xs.slice(n, n + limit));
    },
  };
}

/** Walks every element of a source, flattened, with a running index. */
function eachOf<T>(src: Chunks<T>, fn: (x: T, n: number) => void): void {
  let n = 0;
  src.each((chunk) => {
    for (const x of chunk) fn(x, n++);
  });
}

/**
 * The cap on how many findings ONE invariant contributes to one report.
 *
 * Two reasons, and the second is the load-bearing one. A hostile page can make a
 * per-row check fire on every row, and an unbounded `Violation[]` is then the
 * retention the streaming exists to remove — the array would grow with the log
 * even though nothing else does. And Phase 1's exit record says a notice list
 * nobody reads is the same as no invariants, which is what an 8,000-line report
 * is.
 *
 * Truncation is NEVER silent: {@link sink} appends a line naming exactly how
 * many further findings that invariant had and at what severity, so the report
 * still says "this is worse than what you can see" rather than quietly ending.
 */
export const MAX_FINDINGS_PER_INVARIANT = 64;

interface Sink {
  push(v: Violation): void;
  /** True once nothing further will be listed — a scan may stop refining detail. */
  readonly full: boolean;
  take(id: string): Violation[];
}

function sink(): Sink {
  const out: Violation[] = [];
  let dropped = 0;
  let droppedHardStops = 0;
  return {
    push(v) {
      if (out.length < MAX_FINDINGS_PER_INVARIANT) {
        out.push(v);
        return;
      }
      dropped++;
      if (v.severity === "hard_stop") droppedHardStops++;
    },
    get full() {
      return out.length >= MAX_FINDINGS_PER_INVARIANT;
    },
    take(id) {
      if (dropped === 0) return out;
      const severity = droppedHardStops > 0 ? "hard_stop" : "notice";
      out.push({
        id,
        severity,
        detail:
          `…and ${dropped} further finding(s) from this invariant were not listed (${droppedHardStops} of them hard stops); ` +
          `the first ${MAX_FINDINGS_PER_INVARIANT} are above`,
      });
      return out;
    },
  };
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
 * {@link CheckInput} with the two unbounded fields as {@link Chunks} instead of
 * arrays. **This is the real input type**; {@link CheckInput} is the array front
 * door, and {@link checkAll} is one line over this.
 *
 * `rows` and `ops` are the only two fields that grow with the log. Everything
 * else is bounded by something the device holds anyway: `state` by the entity
 * count, `pinnedHeads`/`pinnedBlobHashes` by the chains, `roster` by the
 * writers, and `hashList` by one response.
 */
export interface StreamCheckInput extends Omit<CheckInput, "rows" | "ops"> {
  rows: Chunks<SyncRow>;
  ops: Chunks<LogEntry>;
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
/** A hard stop that names WHICH condition under its id was hit; see {@link Violation.kind}. */
const hardKind = (id: string, kind: string, detail: string): Violation => ({ id, severity: "hard_stop", detail, kind });
/** A notice that names its condition, so a surface can group it without matching prose. */
const noteKind = (id: string, kind: string, detail: string): Violation => ({ id, severity: "notice", detail, kind });

const hex = (b: Uint8Array): string => platform().toHex(b);
const text = (b: Uint8Array): string => platform().utf8Decode(b);
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

function refold(input: StreamCheckInput): Refold {
  try {
    // `fold` folds INTO a state, so the re-fold is incremental by chunk and the
    // ops are never all in hand at once. What it holds is the state, which is
    // bounded by the entity count rather than by the log — the same thing the
    // device holds anyway.
    const state = emptyState();
    input.ops.each((chunk) => {
      for (const e of chunk) applyOp(state, e);
    });
    return { state, error: null };
  } catch (err) {
    return { state: null, error: msg(err) };
  }
}

/** Renders a leaf for a message. `bigint` has no JSON form, so it is explicit. */
function show(v: unknown): string {
  if (typeof v === "bigint") return `${v}`;
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** At most this many differences are listed before the message is summarised. */
const DIFF_LIMIT = 8;

/**
 * Walks two values that ought to be equal and records every path where they are
 * not, as `state` versus `log`.
 *
 * Deliberately structural rather than a serialized-string comparison: a single
 * "these two states differ" line is useless for acting on, and the whole point
 * of naming a path like `txns/t2/provenance` is that the reader knows at once
 * whether the log or the state is the thing that moved.
 */
function diffValue(path: string, state: unknown, log: unknown, out: string[]): void {
  if (out.length >= DIFF_LIMIT) return;

  if (state instanceof Map || log instanceof Map) {
    if (!(state instanceof Map) || !(log instanceof Map)) {
      out.push(`${path}: one side is a Map and the other is not`);
      return;
    }
    const keys = [...new Set([...state.keys(), ...log.keys()].map(String))].sort(compareUTF8);
    for (const k of keys) {
      if (!state.has(k)) out.push(`${path}/${k}: absent from the state, present in the op log`);
      else if (!log.has(k)) out.push(`${path}/${k}: present in the state, absent from the op log`);
      else diffValue(`${path}/${k}`, state.get(k), log.get(k), out);
      if (out.length >= DIFF_LIMIT) return;
    }
    return;
  }

  if (state instanceof Set || log instanceof Set) {
    if (!(state instanceof Set) || !(log instanceof Set)) {
      out.push(`${path}: one side is a Set and the other is not`);
      return;
    }
    const a = [...state].map(String).sort(compareUTF8).join(",");
    const b = [...log].map(String).sort(compareUTF8).join(",");
    if (a !== b) out.push(`${path}: state holds {${a}}, the op log gives {${b}}`);
    return;
  }

  if (Array.isArray(state) || Array.isArray(log)) {
    if (!Array.isArray(state) || !Array.isArray(log)) {
      out.push(`${path}: one side is an array and the other is not`);
      return;
    }
    if (state.length !== log.length) {
      out.push(`${path}: the state has ${state.length} entr${state.length === 1 ? "y" : "ies"}, the op log gives ${log.length}`);
      return;
    }
    for (let n = 0; n < state.length; n++) {
      diffValue(`${path}/${n}`, state[n], log[n], out);
      if (out.length >= DIFF_LIMIT) return;
    }
    return;
  }

  if (state !== null && log !== null && typeof state === "object" && typeof log === "object") {
    const keys = [...new Set([...Object.keys(state), ...Object.keys(log)])].sort(compareUTF8);
    for (const k of keys) {
      diffValue(`${path}/${k}`, (state as Record<string, unknown>)[k], (log as Record<string, unknown>)[k], out);
      if (out.length >= DIFF_LIMIT) return;
    }
    return;
  }

  if (state === log) return;
  if (path.endsWith("/amount_home_minor")) {
    // The FX hazard deserves its own sentence: the generic wording would not
    // tell the reader that a snapshot is frozen at a POSITION.
    out.push(
      `${path}: the state holds ${show(state)} but re-folding from position 0 computes ${show(log)} — ` +
        `a snapshot is frozen at its own log position, never at the final rate head`,
    );
    return;
  }
  out.push(`${path}: the state holds ${show(state)}, the op log gives ${show(log)}`);
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
function checkStreamOrder(i: StreamCheckInput): Violation[] {
  const out = sink();
  let previous: bigint | null = null;
  // The last row's seq, carried out of the pass rather than indexed out of an
  // array — the one thing `next` has to be compared against.
  let lastSeq: unknown = undefined;
  let sawRow = false;
  eachOf(i.rows, (r, n) => {
    sawRow = true;
    lastSeq = r.seq;
    if (r.stream !== i.stream) {
      out.push(hard(I1, `row ${n} is on stream ${JSON.stringify(r.stream)}, but this is a ${i.stream} pull`));
    }
    if (typeof r.seq !== "bigint") {
      out.push(hard(I1, `row ${n} has seq ${JSON.stringify(r.seq)}, which is not a bigint`));
      return;
    }
    if (typeof i.cursorBefore !== "bigint") {
      // Reported, not skipped. A mistyped cursor silently disables the "no row
      // behind the cursor" check, which is the one that catches a rewind.
      if (n === 0) out.push(hard(I1, `cursorBefore is ${JSON.stringify(i.cursorBefore)}, not a bigint, so no row can be checked against it`));
    } else if (r.seq <= i.cursorBefore) {
      out.push(hard(I1, `row ${n} is at seq ${r.seq}, at or behind the cursor ${i.cursorBefore} this pull resumed from`));
    }
    if (previous !== null && r.seq <= previous) {
      out.push(hard(I1, `row ${n} is at seq ${r.seq}, which does not follow ${previous}: the page is reordered or repeats a row`));
    }
    previous = r.seq;
  });

  // `next` is what the client persists as its cursor. A `next` beyond the rows
  // actually delivered silently skips everything in between, forever.
  const want: unknown = sawRow ? lastSeq : i.cursorBefore;
  if (typeof i.next !== "bigint") {
    out.push(hard(I1, `the response's next is ${JSON.stringify(i.next)}, which is not a bigint`));
  } else if (i.next !== want) {
    out.push(
      hard(
        I1,
        `the response's next is ${i.next}, but the last row it delivered is at ${String(want)} — ` +
          `persisting that cursor would skip every row in between`,
      ),
    );
  }
  return out.take(I1);
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
 * # Which sequence is checked, and why it is never a choice between them
 *
 * The COLD stream is lazily synced behind a rolling window (spec §3.3:70), so
 * its fetched bodies are legitimately sparse and only its hash list can prove
 * the chain has no holes (§3.3:72). The HOT stream has no such excuse: a hot
 * pull returns every row, so its rows must be contiguous on their own.
 *
 * So the two sequences are checked INDEPENDENTLY — the hash list whenever one is
 * present, and the rows whenever the stream is hot — rather than one being
 * selected in preference to the other. An earlier draft picked "hash list if
 * present, else rows", which meant a hot pull that happened to carry a hash list
 * silently switched off row-contiguity: a dropped hot row then produced no
 * violation from any of the seventeen, because I3 does not link across an absent
 * row and I9/I10 compare state against ops and never rows against ops. That is
 * precisely the dropped-row detection §3.3:65 assigns to this invariant.
 */
function checkWriterCounters(i: StreamCheckInput): Violation[] {
  const out = sink();

  /**
   * One writer's run, walked incrementally. The whole per-writer state is an
   * index and the next counter due, so the rows themselves are never grouped
   * into lists — which is what `byWriter` over the whole log used to do.
   */
  interface Run {
    key: ChainKey | null;
    n: number;
    want: bigint;
    findings: Violation[];
  }
  const start = (w: string, source: string): Run => {
    const key = safeChainKey(w, i.stream);
    const run: Run = { key, n: 0, want: 0n, findings: [] };
    if (key === null) {
      run.findings.push(hard(I2, `a ${source} entry names writer ${JSON.stringify(w)}, which cannot be a chain key`));
      return run;
    }
    run.want = (i.pinnedHeads.get(key)?.counter ?? 0n) + 1n;
    return run;
  };
  const step = (run: Run, source: string, counter: unknown): void => {
    if (run.key === null) return;
    const n = run.n++;
    if (typeof counter !== "bigint") {
      run.findings.push(hard(I2, `(${run.key}) ${source} entry ${n} has counter ${JSON.stringify(counter)}`));
      return;
    }
    if (counter !== run.want) {
      run.findings.push(
        hard(
          I2,
          `(${run.key}) ${source} entry ${n} has counter ${counter} where ${run.want} is due — ` +
            `a gap, a duplicate or a reordering, and each of the three means a row is missing or repeated`,
        ),
      );
      // Resynchronised so one break is one violation rather than a cascade.
      run.want = counter + 1n;
      return;
    }
    run.want++;
  };

  // The hash list is one response's worth and is already an array; the ROWS are
  // the unbounded side, and they are walked once, in order, with one `Run` per
  // writer. Findings are buffered per writer and flushed in first-seen order so
  // the report still reads run by run rather than interleaved by arrival.
  const hashRuns = new Map<string, Run>();
  for (const [w, list] of byWriter(i.hashList)) {
    const run = start(w, "hash list");
    hashRuns.set(w, run);
    for (const e of list) step(run, "hash list", e.writer_counter);
  }
  for (const run of hashRuns.values()) for (const v of run.findings) out.push(v);

  // Hot rows are checked ALWAYS, hash list or not. Cold rows are a window.
  if (i.stream === "hot") {
    const rowRuns = new Map<string, Run>();
    eachOf(i.rows, (r) => {
      if (r.stream !== i.stream) return;
      const w = typeof r.writer_id === "string" ? r.writer_id : "";
      let run = rowRuns.get(w);
      if (run === undefined) {
        run = start(w, "rows");
        rowRuns.set(w, run);
      }
      step(run, "rows", r.writer_counter);
      // Bounded even against a page that violates on every row: the per-writer
      // buffer stops growing once nothing further would be listed anyway.
      if (run.findings.length > MAX_FINDINGS_PER_INVARIANT) {
        for (const v of run.findings) out.push(v);
        run.findings = [];
      }
    });
    for (const run of rowRuns.values()) for (const v of run.findings) out.push(v);
  }
  return out.take(I2);
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
function checkChain(i: StreamCheckInput): Violation[] {
  const out = sink();
  // The predecessor lookup, over a WINDOW rather than the whole log: the last
  // {@link LINK_WINDOW} positions seen, as `position → blob_hash` (32 bytes),
  // never the rows and never the blobs.
  //
  // What that window costs is stated precisely, because a checker that quietly
  // stopped linking would be the worst kind of regression. A blob's predecessor
  // is found here whenever it arrived within the last 512 rows — which covers
  // every case that occurs: `GET /api/v1/sync` caps a page at 8 blobs, and a
  // whole-log pass reads ascending by seq out of SQLite, so a predecessor is
  // always within a handful of rows. Beyond the window the row falls through to
  // the pinned-head and genesis branches below exactly as a row whose
  // predecessor was not delivered does — and a page that reorders by more than
  // 512 rows is already two hard stops from I1 and I2.
  const recent = new Map<string, Uint8Array>();
  const remember = (r: SyncRow, blobHash: Uint8Array): void => {
    if (recent.size >= LINK_WINDOW) {
      const oldest = recent.keys().next();
      if (!oldest.done) recent.delete(oldest.value);
    }
    recent.set(`${r.writer_id}|${r.stream}|${r.writer_counter}`, blobHash);
  };

  eachOf(i.rows, (r, n) => {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    if (!(r.blob instanceof Uint8Array)) {
      out.push(hard(I3, `row ${n} ${where} carries no blob bytes to verify`));
      return;
    }
    if (!is32(r.prev_hash) || !is32(r.blob_hash)) {
      out.push(hard(I3, `row ${n} ${where} has a prev_hash or blob_hash that is not 32 bytes`));
      return;
    }
    const got = chainHash(r.prev_hash, r.blob);
    if (!equalBytes(got, r.blob_hash)) {
      out.push(hard(I3, `${where} claims hash ${hex(r.blob_hash)}, but its bytes hash to ${hex(got)}`));
    }

    if (typeof r.writer_counter !== "bigint") return;
    const before = recent.get(`${r.writer_id}|${r.stream}|${r.writer_counter - 1n}`);
    remember(r, r.blob_hash);
    if (before !== undefined) {
      if (!equalBytes(r.prev_hash, before)) {
        out.push(hard(I3, `${where} links to ${hex(r.prev_hash)}, but the blob before it hashes to ${hex(before)}`));
      }
      return;
    }
    if (r.writer_counter === 1n) {
      if (!equalBytes(r.prev_hash, ZERO_HASH)) {
        out.push(hard(I3, `${where} is the first blob of its chain but links to ${hex(r.prev_hash)}, not the genesis hash`));
      }
      return;
    }
    const key = safeChainKey(r.writer_id, r.stream);
    const pinned = key === null ? undefined : i.pinnedHeads.get(key);
    if (pinned !== undefined && pinned.counter === r.writer_counter - 1n && !equalBytes(r.prev_hash, pinned.hash)) {
      out.push(hard(I3, `${where} links to ${hex(r.prev_hash)}, but the head this client pinned is ${hex(pinned.hash)}`));
    }
  });
  return out.take(I3);
}

/** How many positions {@link checkChain} keeps for its predecessor lookup. */
const LINK_WINDOW = 512;

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
function checkColdHashList(i: StreamCheckInput): Violation[] {
  const out = sink();

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

  // Everything pinned for this stream. The persisted map is loaded FIRST and is
  // authoritative: where this response's hash list disagrees with a hash the
  // client already holds, the server has changed its mind about something it
  // already committed to, and that disagreement is information rather than
  // something to resolve in the server's favour. An earlier draft let the
  // response overwrite the pin, which handed a re-serving server a free swap.
  const pinned = new Map<string, Uint8Array>();
  for (const [key, m] of i.pinnedBlobHashes) {
    const sep = typeof key === "string" ? key.indexOf("|") : -1;
    if (sep < 0 || key.slice(sep + 1) !== i.stream) continue;
    for (const [counter, hash] of m) pinned.set(`${key.slice(0, sep)}|${counter}`, hash);
  }
  for (const h of i.hashList) {
    const at_ = `${h.writer_id}|${h.writer_counter}`;
    const already = pinned.get(at_);
    if (already === undefined) {
      pinned.set(at_, h.blob_hash);
      continue;
    }
    if (!equalBytes(already, h.blob_hash)) {
      out.push(
        hard(
          I3B,
          `the hash list now gives ${hex(h.blob_hash)} for ${at(h.writer_id, i.stream, h.writer_counter)}, but ` +
            `${hex(already)} was already pinned for it — a server cannot change its mind about a hash it has ` +
            `already handed over`,
        ),
      );
    }
    // The older pin stands, so a conflict cannot also launder the body below.
  }

  // The body check runs for ANY stream that has pins, so a hot pull carrying a
  // hash list gets its bodies cross-checked too. Only COLD treats an unpinned
  // body as a violation: a hot pull normally carries no hash list at all, and
  // its bodies are covered by I2's row contiguity plus I3's chain instead.
  eachOf(i.rows, (r) => {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    const want = pinned.get(`${r.writer_id}|${r.writer_counter}`);
    if (want === undefined) {
      if (i.stream !== "cold") return;
      // "I have no pin for this one" is exactly the answer a hostile server
      // wants, so an unpinned cold body is refused rather than accepted unverified.
      out.push(hard(I3B, `a cold body arrived at ${where}, whose hash was never pinned, so nothing can check it`));
      return;
    }
    if (!(r.blob instanceof Uint8Array) || !is32(r.prev_hash)) return; // I3 reported it
    const got = chainHash(r.prev_hash, r.blob);
    if (!equalBytes(got, want)) {
      out.push(hard(I3B, `the body at ${where} hashes to ${hex(got)}, but ${hex(want)} was pinned for it`));
    }
  });
  return out.take(I3B);
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
function checkAAD(i: StreamCheckInput): Violation[] {
  const out = sink();
  eachOf(i.rows, (r, n) => {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    let want: Uint8Array;
    try {
      want = aad({ userId: i.userId, stream: r.stream, writerId: r.writer_id, writerCounter: r.writer_counter });
    } catch (err) {
      out.push(hard(I4, `row ${n} ${where} does not name a position a blob could be sealed at: ${msg(err)}`));
      return;
    }
    let got: Uint8Array;
    try {
      got = embeddedAAD(r.blob);
    } catch (err) {
      out.push(hard(I4, `row ${n} ${where} carries no readable associated data: ${msg(err)}`));
      return;
    }
    if (!equalBytes(got, want)) {
      out.push(hard(I4, `the blob served at ${where} was sealed as ${JSON.stringify(text(got))}, not ${JSON.stringify(text(want))}`));
    }
  });
  return out.take(I4);
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
function checkBucket(i: StreamCheckInput): Violation[] {
  const out = sink();
  eachOf(i.rows, (r) => {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    if (typeof r.size_bucket !== "number" || !BUCKETS.includes(r.size_bucket)) {
      out.push(hard(I5, `${where} declares size_bucket ${JSON.stringify(r.size_bucket)}, which is not one of the seven buckets`));
      return;
    }
    if (!(r.blob instanceof Uint8Array) || r.blob.length !== r.size_bucket) {
      const n = r.blob instanceof Uint8Array ? r.blob.length : "no";
      out.push(hard(I5, `${where} declares size_bucket ${r.size_bucket} but carries ${n} bytes`));
    }
  });
  return out.take(I5);
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
function checkSchemaVersion(i: StreamCheckInput): Violation[] {
  const out = sink();
  eachOf(i.ops, (e, n) => {
    const v = (e as { op?: { v?: unknown; op_id?: unknown } }).op?.v;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      out.push(hard(I6, `op ${n} declares version ${JSON.stringify(v)}`));
    } else if (v > SCHEMA_VERSION) {
      out.push(hardKind(I6, VIOLATION_NEWER_VERSION, `op ${n} (${String(e.op.op_id)}) is v${v}, and this build supports v${SCHEMA_VERSION}`));
    }
  });
  return out.take(I6);
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
function checkOneLivePerIngest(i: StreamCheckInput): Violation[] {
  const out = sink();
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
  return out.take(I7);
}

// ---------------------------------------------------------------------------
// I8 — splits sum to their parent
// ---------------------------------------------------------------------------

const I8 = "I8_split_sum";

/** Every applied split's parts sum exactly to its parent's `amount_minor`. */
function checkSplitSum(i: StreamCheckInput): Violation[] {
  const out = sink();
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
  return out.take(I8);
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
function checkVersionContiguity(i: StreamCheckInput, r: Refold): Violation[] {
  const out = sink();
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

  if (r.state === null) return out.take(I9); // I10 reports the re-fold failure
  // BOTH directions. A one-directional refold→state walk misses an entity the
  // state holds that the log never creates — which for a rule is missed
  // entirely, since I10's existence check only covers transactions. It is also
  // what makes "ops is the whole history" a checked precondition for an account
  // that holds only rules, where I10 has no transactions to compare at all.
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
  for (const [key, head] of i.state.heads) {
    if (!r.state.heads.has(key)) {
      out.push(
        hard(
          I9,
          `${head.kind} ${head.id} is at version ${head.version} in the state, but no op in the log ever creates it — ` +
            `a phantom entity, or an op log that is not the one this state was folded from`,
        ),
      );
    }
  }
  return out.take(I9);
}

// ---------------------------------------------------------------------------
// I10 — the state is reproducible by re-folding from position 0
// ---------------------------------------------------------------------------

const I10 = "I10_fx_prefix_monotone";

/**
 * Re-folding every op from position 0 reproduces the state — every
 * `amount_home_minor`, and every other materialized field with it.
 *
 * The FX snapshot is what the invariant is NAMED for, because it is the field
 * with the subtle failure: freezing at the END of a fold, against the final rate
 * head, agrees with the correct answer on the final state of many logs and
 * disagrees on every intermediate one, so a device that synced in ten chunks and
 * one restoring from scratch would show different money (spec §3.7:134).
 *
 * # Why the comparison is the whole state and not just that one field
 *
 * An earlier draft compared `amount_home_minor` and existence only, and
 * therefore certified as clean a state whose `amount_minor`, `category`,
 * `direction`, `splits`, `provenance`, `rates` or `homeCurrency` disagreed with
 * its own op log — **including a reordered pair of concurrent ops that flips the
 * fork winner**, which is the precise subject of the exit criterion. `provenance`
 * is the sharpest of those: it is derived from the blob's `writer_id` rather than
 * from any payload field expressly so that no writer can claim `ingest`
 * provenance, and re-attributing an op in the `ops` list was silent.
 *
 * # The three fields deliberately excluded, and why they are not a hole
 *
 * `unreadable`, `cursors` and `appliedAtCursor` are DELIVERY bookkeeping, and
 * the two folds legitimately disagree about them: a blob that was set aside is
 * recorded in `state.unreadable` and advances `cursors.hot` while contributing
 * no ops at all, so a re-fold of the ops cannot reproduce either. `unreadable`
 * is I15's, `cursors` is the sync layer's, and `appliedAtCursor` is excluded from
 * the convergence claim by `state.ts` itself. `heads` is excluded here only
 * because I9 compares it, in both directions, with better messages.
 *
 * Compared BOTH ways, which is also what makes `ops` being the whole history a
 * checked precondition rather than a documented one.
 */
function checkFXPrefixMonotone(i: StreamCheckInput, r: Refold): Violation[] {
  if (r.state === null) {
    return [hard(I10, `the ops backing this state cannot be re-folded in the order given: ${r.error}`)];
  }
  const out = sink();
  for (const id of i.state.txns.keys()) {
    if (!r.state.txns.has(id)) {
      out.push(hard(I10, `${id} is in the state but re-folding the op log from position 0 never creates it`));
    }
  }
  for (const id of r.state.txns.keys()) {
    if (!i.state.txns.has(id)) {
      out.push(hard(I10, `re-folding the op log from position 0 creates ${id}, which is not in the state`));
    }
  }

  // Every materialized field, both folds, one structural walk.
  const diffs: string[] = [];
  for (const [id, t] of i.state.txns) {
    const again = r.state.txns.get(id);
    if (again !== undefined) diffValue(`txns/${id}`, t, again, diffs);
  }
  for (const field of ["homeCurrency", "rates", "rules", "liveByIngestID", "byFingerprint", "pendingByCurrency", "checkpoints", "forks", "anomalies"] as const) {
    diffValue(field, i.state[field], r.state[field], diffs);
  }
  for (const d of diffs.slice(0, DIFF_LIMIT)) {
    out.push(hard(I10, `the state disagrees with a re-fold of its own op log at ${d}`));
  }
  if (diffs.length >= DIFF_LIMIT) {
    out.push(hard(I10, `…and further disagreements between the state and a re-fold of its own op log beyond the first ${DIFF_LIMIT}`));
  }
  return out.take(I10);
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
 *   - **a checkpoint exists** → `hard_stop` if any live roster writer is missing
 *     from it — `ingest` included, see the coverage loop — or if a head claims a
 *     counter above what has been observed.
 *
 * # Two hard stops under one id, and why they must be told apart
 *
 * This check reports both "the roster names a live device writer the checkpoint
 * does not cover" ({@link VIOLATION_ROSTER_COVERAGE}) and "a checkpoint attests
 * a head above anything this client has seen" ({@link VIOLATION_CHAIN_WITHHELD}).
 * They share an id because they are one property — a checkpoint that actually
 * cross-checks the roster — but a CALLER must act on them oppositely, and the
 * `kind` field exists because treating them as one built a real hole:
 *
 * Task 14's `push` proceeds over the coverage case, because writing the
 * checkpoint IS the repair and refusing deadlocks an account whose every device
 * needs a checkpoint before it can sync. Given only the id, it proceeded over
 * the withholding case too — so a server that truncated a peer's chain could
 * get a third device to overwrite the honest attestation with one claiming
 * genesis, after which the truncation surfaced only as the notice below and
 * nothing forced repair. A device being withheld from must author no checkpoint
 * at all; it has nothing trustworthy to attest.
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
 * # CHECKPOINT_NAMES_THE_ROSTER — a binding contract on Task 14's `checkpoint`
 *
 * **A `writer_checkpoint` must name one head for every (roster writer × stream)
 * pair, using counter 0 and the genesis hash for a chain that holds no blobs.**
 * It must NOT name only the chains its author happens to have observed.
 *
 * This is not a preference; without it the invariant is unsatisfiable in the
 * exit test's own configuration. A checkpoint built from observed heads can
 * never name a writer that has authored nothing — it has no head to observe —
 * so an enrolled-but-silent `dev-b` would hard-stop every sync forever, and no
 * checkpoint any device could emit would clear it. Plan line 2284 (the notice is
 * gone at step 4) and step 6 (zero hard stops on a pull before dev-b writes at
 * step 9) both depend on the contract above. An earlier draft of this file
 * claimed the case was "self-clearing because `push` checkpoints when the roster
 * changes"; that reasoning is circular — a writer is only observable after it
 * pushes, which is exactly what has not happened yet.
 *
 * `encodeCheckpointPayload` accepts `{counter: "0", hash: <64 zeros>}`, and this
 * check treats it as satisfying coverage while asserting nothing false: `0 >
 * observed` is never true, so a zero entry can hide no withheld rows.
 *
 * # The bootstrap ordering that REMAINS after the contract
 *
 * "Two or more device writers and no checkpoint at all" is still a hard stop,
 * and `Client.pull()` persists nothing over a hard stop — so a second device
 * cannot finish its first sync until *some* device has written *a* checkpoint.
 * That is the rule doing its job: such an account has no cross-check against a
 * withheld writer. Task 38 step 4 already sequences it correctly (dev-a
 * checkpoints, then dev-b pulls). `check.test.ts` pins the behaviour page by
 * page so it cannot be rediscovered as a mystery.
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
function checkRosterCheckpoint(i: StreamCheckInput): Violation[] {
  const out = sink();
  const roster = new Map(i.roster.map((w) => [w.writer_id, w]));
  const live = i.roster.filter((w) => w.revoked_at === null);
  const liveDevices = live.filter((w) => w.kind === WRITER_KIND_DEVICE);

  // ONE row pass, shared by both halves of this check: the set of writers that
  // actually served blobs, and the highest counter seen on each chain. Neither
  // retains a row, and both are bounded by the number of writers — where
  // `observedHead` used to re-scan every row per checkpoint head.
  const rowWriters = new Set<string>();
  const observed = new Map<ChainKey, bigint>();
  eachOf(i.rows, (r) => {
    if (typeof r.writer_id === "string") rowWriters.add(r.writer_id);
    const key = safeChainKey(r.writer_id, r.stream);
    if (key !== null && typeof r.writer_counter === "bigint" && r.writer_counter > (observed.get(key) ?? -1n)) {
      observed.set(key, r.writer_counter);
    }
  });

  // A writer appending blobs the roster has never heard of is the same class of
  // omission, catchable without a checkpoint. A notice, for the race above.
  for (const w of rowWriters) {
    if (!roster.has(w)) {
      out.push(note(I11, `the server served blobs from writer ${JSON.stringify(w)}, which its own roster does not list`));
    }
  }

  const checkpoints = i.state.checkpoints;
  if (checkpoints.length === 0) {
    if (liveDevices.length >= 2) {
      const names = liveDevices.map((w) => w.writer_id).join(", ");
      out.push(
        hardKind(
          I11,
          VIOLATION_ROSTER_COVERAGE,
          `${liveDevices.length} device writers are enrolled (${names}) and no writer_checkpoint has been seen — ` +
            `nothing cross-checks one device's chain against another's, so a withheld writer would be invisible`,
        ),
      );
      return out.take(I11);
    }
    out.push(
      noteKind(
        I11,
        NOTICE_NO_CHECKPOINT_YET,
        liveDevices.length === 1 ? "no checkpoint yet (single writer)" : "no checkpoint yet (no device writers enrolled)",
      ),
    );
    return out.take(I11);
  }

  // Coverage is per (writer, STREAM), because a head that does not name a stream
  // is meaningless (Decision 13) and a checkpoint that named only `dev-b|cold`
  // would otherwise satisfy a hot pull.
  //
  // It runs over every LIVE roster writer and not over the device subset, and
  // the writer that makes the difference is `ingest`. Every device chain is
  // already covered by the device that owns it re-signing its own head; the
  // ingest chain is written by the SERVER and is the one chain a user cannot
  // re-derive from any device they hold — and it is where their bank mail
  // lands. Excluding it left the single chain most needing tamper-evidence
  // with none: a server that dropped the last N emails produced a chain that is
  // still dense from 1, so I2 and I3 are both satisfied, and no checkpoint
  // contradicted it. Covering it is what turns that into a `chain_withheld`
  // hard stop below.
  const named = new Set(checkpoints.map((c) => `${c.writer_id}|${c.stream}`));
  for (const w of live) {
    if (!named.has(`${w.writer_id}|${i.stream}`)) {
      const what = w.kind === WRITER_KIND_DEVICE ? "device writer" : `${w.kind} writer`;
      out.push(
        hardKind(
          I11,
          VIOLATION_ROSTER_COVERAGE,
          `the latest writer_checkpoint names no ${i.stream} head for live ${what} ${w.writer_id} — ` +
            `that writer's chain has no trusted head, so a truncation of it would verify. A writer that has ` +
            `authored nothing is named at counter 0 with the genesis hash; see CHECKPOINT_NAMES_THE_ROSTER`,
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
    if (typeof c.counter !== "bigint") {
      // Reported rather than skipped: a mistyped counter is a checkpoint that
      // cannot be compared, and silently not comparing it is how the whole
      // cross-check goes missing without anyone noticing.
      out.push(hard(I11, `checkpoint head (${key}) has counter ${JSON.stringify(c.counter)}, which is not a bigint and cannot be compared`));
      continue;
    }
    if (c.counter === 0n && !/^0{64}$/.test(c.hash)) {
      // Counter 0 is the head of an EMPTY chain, whose hash is genesis by
      // definition. Anything else is a head claiming to be nothing and something.
      out.push(hard(I11, `checkpoint head (${key}) is at counter 0 but names hash ${c.hash}, not the genesis hash`));
    }
    if (c.stream !== i.stream) {
      out.push(
        noteKind(
          I11,
          NOTICE_OTHER_STREAM,
          `checkpoint head (${key}) claims counter ${c.counter} and was not cross-checked: this pull covered the ` +
            `${i.stream} stream only`,
        ),
      );
      continue;
    }
    const observedCounter = observedHead(i, key, observed);
    if (c.counter > observedCounter) {
      out.push(
        hardKind(
          I11,
          VIOLATION_CHAIN_WITHHELD,
          `checkpoint head (${key}) claims counter ${c.counter}, but the highest blob this client has ever seen on ` +
            `that chain is ${observedCounter} — the server is withholding rows a peer device has already witnessed`,
        ),
      );
    } else if (c.counter === 0n && observedCounter > 0n) {
      out.push(
        note(
          I11,
          `checkpoint head (${key}) claims that chain is empty, but this client has verified ${observedCounter} blob(s) on ` +
            `it — the checkpoint provides NO trusted head for that chain, so a truncation of it would verify. ` +
            `Re-checkpoint from a device that has synced it`,
        ),
      );
    }
  }
  return out.take(I11);
}

/**
 * The highest counter this client has evidence of on one chain.
 *
 * Four sources, and the fourth is not optional. `pinnedBlobHashes` is the
 * per-blob hash list a client pinned with `pull-cold-hashes`, and a pin at
 * counter N IS evidence: that call verifies the list is contiguous and
 * correctly chained from the pinned head BEFORE pinning any of it, so the
 * server has committed to a blob at N whether or not the body was ever
 * downloaded.
 *
 * Leaving it out was wrong in exactly the configuration spec §3.3:70 calls
 * normal — cold bodies are a lazily-synced window, so "hashes pinned to the
 * head, no bodies" is what a healthy device looks like — and a standalone `cli
 * check` passes no pinned heads on purpose (it re-verifies from genesis; see
 * {@link Client.check}). The two together made a device that had done precisely
 * the right thing report `chain_withheld` about mail it had verified the hashes
 * of itself. Counting the pins can only LOWER a hard stop that was never true;
 * it can never hide a withholding, because a pin is something the server said.
 */
function observedHead(i: StreamCheckInput, key: ChainKey, fromRows: ReadonlyMap<ChainKey, bigint>): bigint {
  let best = i.pinnedHeads.get(key)?.counter ?? 0n;
  for (const counter of i.pinnedBlobHashes.get(key)?.keys() ?? []) {
    if (typeof counter === "bigint" && counter > best) best = counter;
  }
  const inRows = fromRows.get(key);
  if (inRows !== undefined && inRows > best) best = inRows;
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
 *
 * # The unparsed row is the exception, and it is a two-sided one
 *
 * A message no tier resolved is appended anyway (spec §2's drop policy) with
 * `0n`, `""` and `""` where the money would be — a shape every rule above
 * rejects. So `unparsed` selects which rule set applies, and the checker asserts
 * BOTH directions rather than merely relaxing one:
 *
 *   - an unparsed row must carry the empty shape *exactly*, because one carrying
 *     a real amount is money hidden from every total on the device
 *     (`countsTowardMoney` excludes it) rather than money shown wrongly, and
 *   - a parsed row must carry money, unchanged from before.
 *
 * Relaxing only the first would be the mutant this exists to catch: a checker
 * that simply allowed `0n` everywhere passes both an unparsed row and a broken
 * parsed one, and `amount_minor === 0n` would then be the only thing left
 * distinguishing them — which is precisely the inference the decoder refuses to
 * let anyone make.
 */
function checkMoneyShape(i: StreamCheckInput): Violation[] {
  const out = sink();
  for (const [id, t] of i.state.txns) {
    // Every branch below keys on this flag, so a non-boolean here does not just
    // mis-describe a row — a truthy string would read as unparsed and switch the
    // money rules off entirely, disarming the checker with the field it uses to
    // decide.
    if (typeof t.unparsed !== "boolean") {
      out.push(hard(I12, `${id}.unparsed is a ${typeof t.unparsed} (${JSON.stringify(String(t.unparsed))}), not a boolean`));
    }
    if (typeof t.amount_minor !== "bigint") {
      out.push(hard(I12, `${id}.amount_minor is a ${typeof t.amount_minor} (${JSON.stringify(String(t.amount_minor))}), not a bigint`));
    } else if (t.unparsed === true) {
      if (t.amount_minor !== 0n) {
        out.push(hard(I12, `${id} is unparsed and carries amount_minor ${t.amount_minor}; nothing was extracted, so there is no amount`));
      }
      if (t.currency !== "") {
        out.push(hard(I12, `${id} is unparsed and carries currency ${JSON.stringify(t.currency)}; nothing was extracted, so there is no currency`));
      }
      if (t.direction !== "") {
        out.push(hard(I12, `${id} is unparsed and carries direction ${JSON.stringify(t.direction)}; nothing was extracted, so there is no direction`));
      }
      if (t.amount_home_minor !== null) {
        out.push(
          hard(I12, `${id} is unparsed and carries amount_home_minor ${t.amount_home_minor}; there is no native amount to have converted`),
        );
      }
    } else if (t.amount_minor <= 0n) {
      out.push(hard(I12, `${id}.amount_minor is ${t.amount_minor}; amounts are always positive and direction carries the sign`));
    }
    if (t.unparsed !== true && t.direction !== "debit" && t.direction !== "credit") {
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
  return out.take(I12);
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
function checkSupersedeHasOrigin(i: StreamCheckInput, r: Refold): Violation[] {
  const out = sink();
  const introduced = new Set<string>();
  eachOf(i.ops, (e) => {
    const op = e.op;
    if (op === undefined || op === null) return;
    if (op.type === "txn_ingested") {
      // An op being PRESENT is not an op having applied: a `txn_ingested` refused
      // as a duplicate_create or duplicate_ingest introduces nothing, and
      // counting it would leave this check quiet exactly where the engine raises
      // `supersede_without_origin`. The re-fold already says which creates took:
      // the entity exists and carries this ingest id.
      const id = op.entity?.id;
      const applied =
        r.state === null || (typeof id === "string" && r.state.txns.get(id)?.ingest_id === op.ingest_id);
      if (typeof op.ingest_id === "string" && applied) introduced.add(op.ingest_id);
      return;
    }
    if (op.type !== "txn_superseded") return;
    if (typeof op.ingest_id !== "string" || !introduced.has(op.ingest_id)) {
      const shown = typeof op.ingest_id === "string" ? `${op.ingest_id.slice(0, 12)}…` : JSON.stringify(op.ingest_id);
      out.push(note(I13, `${op.op_id} at seq ${e.seq} supersedes ingest ${shown}, which no earlier txn_ingested introduced`));
    }
  });
  return out.take(I13);
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
function checkForksSurfaced(i: StreamCheckInput): Violation[] {
  const out = sink();
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
    noteKind(
      I14,
      NOTICE_COUNTS,
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

  // Only the op ids the forks NAME are looked for, so the pass keeps a set
  // bounded by the fork count rather than by the log. Building a set of every
  // op id — which is what this did — is O(log) retention for a question asked
  // about at most two ids per fork.
  const wanted = new Set<string>();
  for (const f of forks) {
    if (typeof f.winner_op === "string") wanted.add(f.winner_op);
    if (typeof f.loser_op === "string") wanted.add(f.loser_op);
  }
  const opIDs = new Set<string>();
  if (wanted.size > 0) {
    eachOf(i.ops, (e) => {
      const id = e.op?.op_id;
      if (typeof id === "string" && wanted.has(id)) opIDs.add(id);
    });
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
    // A fork notice is identical on every replica precisely BECAUSE it names op
    // ids rather than positions — which is only worth anything if those ids name
    // ops that are actually in the log. The ops are in hand, so join them.
    for (const [role, id] of [["winner", f.winner_op], ["loser", f.loser_op]] as const) {
      if (!opIDs.has(id)) {
        out.push(note(I14, `the fork on ${f.entity.kind} ${f.entity.id} names ${JSON.stringify(id)} as its ${role}, which is not an op in the log`));
      }
    }
  }

  for (const [n, a] of anomalies.entries()) {
    if (typeof a.at_seq !== "bigint") {
      out.push(note(I14, `anomaly ${n} (${a.kind}) records at_seq ${JSON.stringify(a.at_seq)}, not a bigint — it cannot be located in the log`));
    }
  }

  // Referential existence only. Whether the two still SHARE a fingerprint is
  // deliberately not asked (correction 7): the field is a snapshot, and the row
  // it points at may since have been edited into another bucket. But it must at
  // least point at a row, or the notice names nothing a user can look at.
  for (const [id, t] of i.state.txns) {
    if (typeof t.possible_duplicate_of === "string" && !i.state.txns.has(t.possible_duplicate_of)) {
      out.push(note(I14, `${id} is flagged as a possible duplicate of ${t.possible_duplicate_of}, which is not a transaction in this state`));
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
  return out.take(I14);
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
function checkUnreadableSetAside(i: StreamCheckInput): Violation[] {
  const out = sink();
  const list = i.state.unreadable;

  // The FORWARD direction: every hot blob in this page that will not decode must
  // be in `unreadable`. An earlier draft implemented only the converse — it
  // validated records already present — so emptying `unreadable` on a state with
  // a genuinely undecodable blob gave a clean run, and a blob the fold dropped
  // silently was indistinguishable from one that decoded fine.
  //
  // Scoped to blobs that OPEN and then fail to decode, which is exactly the
  // `foldBlobs` set-aside path. A blob that will not open never reaches the fold
  // at all and is I4's or I5's finding, not a missing set-aside record.
  const setAside = new Set(list.map((u) => `${u.writer_id}|${u.stream}|${u.writer_counter}|${u.seq}`));
  if (i.stream === "hot") {
    eachOf(i.rows, (r) => {
      let plaintext: Uint8Array;
      try {
        plaintext = openBlob(
          { userId: i.userId, stream: r.stream, writerId: r.writer_id, writerCounter: r.writer_counter },
          r.blob,
        );
      } catch {
        return;
      }
      let reason: string;
      try {
        decodeBlobOps(plaintext);
        return; // it decodes, so nothing is owed
      } catch (err) {
        reason = msg(err);
        if (err instanceof UnknownNewerVersionError) {
          // Not a set-aside at all: an unknown newer version is one of the two
          // conditions spec §3.3:68 reserves a HARD STOP for, and the ops it
          // carries never reach `ops`, so I6 cannot see them either.
          out.push(
            hardKind(
              I15,
              VIOLATION_NEWER_VERSION,
              `the blob at ${at(r.writer_id, r.stream, r.writer_counter)} carries a newer schema version and must stop this sync: ${reason}`,
            ),
          );
          return;
        }
      }
      if (!setAside.has(`${r.writer_id}|${r.stream}|${r.writer_counter}|${r.seq}`)) {
        out.push(
          hard(
            I15,
            `the blob at ${at(r.writer_id, r.stream, r.writer_counter)} (seq ${String(r.seq)}) does not decode ` +
              `(${reason}) and is not in state.unreadable — it was dropped silently instead of being set aside`,
          ),
        );
      }
    });
  }
  if (list.length > 0) {
    const where = list.map((u) => `${at(u.writer_id, u.stream, u.writer_counter)} at seq ${String(u.seq)}`).join("; ");
    out.push(noteKind(I15, NOTICE_SET_ASIDE, `${list.length} blob(s) set aside and not folded: ${where}`));
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
    if (u.stream !== "hot") continue;
    if (typeof i.state.cursors.hot !== "bigint") {
      out.push(hard(I15, `state.cursors.hot is ${JSON.stringify(i.state.cursors.hot)}, not a bigint, so no set-aside blob can be checked against it`));
      continue;
    }
    if (i.state.cursors.hot < u.seq) {
      out.push(
        hard(
          I15,
          `the blob set aside at seq ${u.seq} did not carry the cursor past it (the cursor is at ${i.state.cursors.hot}) — ` +
            `that seq can be re-delivered later with different content and folded as if it were new`,
        ),
      );
    }
  }
  return out.take(I15);
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
function checkColdCarriesNoOps(i: StreamCheckInput): Violation[] {
  if (i.stream !== "cold") return [];
  const out = sink();
  eachOf(i.rows, (r) => {
    const where = at(r.writer_id, r.stream, r.writer_counter);
    let plaintext: Uint8Array;
    try {
      plaintext = openBlob(
        { userId: i.userId, stream: r.stream, writerId: r.writer_id, writerCounter: r.writer_counter },
        r.blob,
      );
    } catch {
      return; // I4 / I5 / I15 own this blob; nothing here can be claimed about its kind
    }
    try {
      JSON.parse(text(plaintext));
    } catch {
      return; // not even a JSON document: unreadable, not a smuggled op list
    }
    let kind: string;
    try {
      kind = kindOf(plaintext);
    } catch (err) {
      out.push(hard(I16, `the cold blob at ${where} declares no usable kind: ${msg(err)}`));
      return;
    }
    if (kind !== KIND_RAW_BODY) {
      out.push(
        hard(
          I16,
          `the cold blob at ${where} decodes as ${JSON.stringify(kind)}, not ${JSON.stringify(KIND_RAW_BODY)} — ` +
            `cold blobs carry raw email bodies and nothing else, or a hot-only sync stops being a complete materialization`,
        ),
      );
      return;
    }
    // The label is not the record. `kindOf` reads one field, so a body that says
    // `raw_body` and then carries something else entirely would pass a
    // label-only check — and "it claimed to be a raw record and is not one" is
    // exactly as unaccounted-for as an op list.
    try {
      decodeRawBody(plaintext);
    } catch (err) {
      out.push(hard(I16, `the cold blob at ${where} says it is a ${KIND_RAW_BODY} but does not decode as one: ${msg(err)}`));
    }
  });
  return out.take(I16);
}

// ---------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------

interface Invariant {
  id: string;
  run: (i: StreamCheckInput, r: Refold) => Violation[];
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
  return checkAllStream({
    ...input,
    rows: arrayChunks((input as { rows?: readonly SyncRow[] }).rows ?? []),
    ops: arrayChunks((input as { ops?: readonly LogEntry[] }).ops ?? []),
  });
}

/**
 * A source that hands out the same sequence twice is the one precondition the
 * streaming checks cannot verify for themselves — several of them take their
 * own pass, and a one-shot generator would leave every pass after the first
 * looking at an EMPTY log. Which is the vacuous-pass failure this whole file
 * exists to prevent: eight of the seventeen would report nothing and be read as
 * green.
 *
 * So it is measured, once, before anything is checked: two passes over the row
 * source must agree on how many rows they saw. Cheap (a count, no retention),
 * and it turns a silent green into a named hard stop.
 */
const REITERABLE = "REITERABLE_SOURCE";

function countChunks<T>(src: Chunks<T>): number {
  let n = 0;
  src.each((chunk) => {
    n += chunk.length;
  });
  return n;
}

/**
 * Runs every invariant over a streamed log and returns everything found.
 *
 * The caller decides: `hard_stop` aborts the sync session, `notice` is printed.
 * `surface.ts` turns this list into the three UI states spec §3.4 and §3.3:74
 * require, and is where the {@link Violation.kind} distinction is acted on.
 *
 * It never throws. A check that does is converted into a `hard_stop` naming
 * itself, because a checker that dies on broken input has told the caller
 * nothing — and "the state could not be certified" is exactly a hard stop.
 */
export function checkAllStream(input: StreamCheckInput): Violation[] {
  const out: Violation[] = [];
  try {
    const first = countChunks(input.rows);
    const second = countChunks(input.rows);
    if (first !== second) {
      out.push(
        hardKind(
          REITERABLE,
          VIOLATION_CHECK_FAILED,
          `the row source yielded ${first} rows and then ${second}: it is not re-iterable, so every check that takes ` +
            `its own pass would be reading a different log from the one before it`,
        ),
      );
    }
  } catch (err) {
    out.push(hardKind(REITERABLE, VIOLATION_CHECK_FAILED, `the row source could not be walked, so nothing below was checked against it: ${msg(err)}`));
  }

  const r = refold(input);
  for (const c of CHECKS) {
    try {
      out.push(...c.run(input, r));
    } catch (err) {
      out.push(hardKind(c.id, VIOLATION_CHECK_FAILED, `the check itself could not run, so this state is uncertified: ${msg(err)}`));
    }
  }
  return out;
}
