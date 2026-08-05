/**
 * The device-local fold snapshot: what makes the second launch not re-fold.
 *
 * # What it is
 *
 * A cold restore folds the whole log once. Every launch after that must not:
 * the fold is the 58-second operation Phase 0 froze on, and a user who opens
 * the app to check one number should not pay for it. So the folded
 * {@link State} is serialized into one SQLite row, and the next launch loads it
 * and folds only the ops that arrived since.
 *
 * Phase 0's "13 ms warm start" is **not** evidence that this is cheap. That
 * measurement was a post-mount `SELECT COUNT(*)` plus an aggregate — it never
 * touched a fold, a parse, or a bigint. The quantity that matters here is
 * {@link loadSnapshot}'s own cost, and it is measured rather than assumed: see
 * "The load budget" below.
 *
 * # Why this is not §3.3's deferred compaction (Decision 5)
 *
 * The snapshot never enters the op log, is never hashed into a writer chain, is
 * never uploaded, and is never re-encoded by a party that did not author it.
 * §3.3:80's byte-canonicity prerequisite is a statement about *re-encoding
 * foreign ops*; §3.3:81's head-registry reclamation is about *pruning entity
 * heads*, which this does not do — {@link State.heads} is serialized verbatim.
 * A snapshot is a cache of a pure function of a prefix of the log, and its
 * correctness is checkable by recomputing that function. `snapshot.test.ts`
 * pins the first claim structurally (`nothing in the snapshot ever reaches an
 * emitted op`) and `audit.ts` is the recomputation.
 *
 * # The question that decides whether this module is safe
 *
 * *What makes a snapshot invalid, and does anything actually notice?*
 *
 * A stale snapshot is worse than no snapshot. No snapshot costs 58 seconds; a
 * stale one makes every screen show confident wrong numbers, and there is no
 * user-visible symptom until the totals are compared against a bank statement.
 * Task 5 already hit this shape: a v1 state file loaded as "synced" over an
 * empty log, and `check` passed it **vacuously** — every invariant was true of
 * a log with nothing in it. So this module refuses to be checkable only by
 * checks that an empty log satisfies.
 *
 * Five independent things can make a snapshot invalid, and each has a detector:
 *
 * | invalid because | detected by |
 * |---|---|
 * | this build's container format changed | {@link SNAPSHOT_VERSION} |
 * | the **fold's semantics** changed under it (a `replay.ts` fix) | {@link foldFingerprint} — a canary log folded at load and compared |
 * | the log it folded is gone, truncated, or belongs to another account | the {@link LogBinding} tip probe |
 * | the stored bytes are damaged | the payload digest |
 * | the log's prefix changed *below* the tip, on a chain the tip does not cover | **nothing here** — only `audit.ts`'s periodic re-fold |
 *
 * That last row is the honest one. The tip probe binds the snapshot to the row
 * at its cursor, and `WireRow.prev_hash` chains that row back through *its own
 * writer's* blobs — so a substitution anywhere in the dominant `ingest` chain
 * moves the tip and is caught. A substitution in a *different* writer's chain
 * whose last row sits below the cursor is not, and cannot be without either
 * re-reading the prefix or pinning every writer's head. `audit.ts` is the
 * backstop, and the reason it is scheduled rather than optional.
 *
 * **Every rejection is recorded** ({@link readEvents}). A snapshot that fails
 * its binding means the log changed under it, which is a finding — not a cache
 * miss to swallow. The Integrity screen reads these rows.
 *
 * # The load budget
 *
 * Warm first paint is a spec gate (<2 s) and the plan's exit condition for this
 * task is `loadSnapshot ≤ 400 ms at the full corpus on the P2 device`. Two
 * things follow, and both are built here rather than left to Task 28:
 *
 *  1. **The cost is bounded structurally, not by a stopwatch.** A duration
 *     assertion is a property of the machine, not of the algorithm — two have
 *     already gone into this project and one failed under load. So the gate
 *     asserts the things that *decide* the duration: the payload stays under
 *     {@link SNAPSHOT_MAX_BYTES}; the decode visits a number of nodes linear in
 *     the corpus ({@link SnapshotLoad.nodes}); the log is probed O(1) times and
 *     never scanned; and a **rejected snapshot never reads the payload column
 *     at all**, so the pathological launch is the cheap one. The wall clock is
 *     measured, reported, and gated behind `LEDGER_SNAPSHOT_BENCH=1`.
 *  2. **The measured cost is dominated by `JSON.parse`,** which is why
 *     {@link SNAPSHOT_MAX_BYTES} is the ceiling that matters. At the 3,683-txn
 *     reference corpus the payload is ~3.5 MB — inside the plan's ~4 MB
 *     threshold, so `txns` stays in the blob rather than moving to its own
 *     table, but with only ~13 % of headroom. See the task report.
 *
 * # Host imports
 *
 * None. `SqlDriver` is a type-only import, exactly as `projection.ts` does, so
 * this module is reachable from Hermes.
 */

import { fold, type LogEntry } from "./replay";
import {
  serializeState,
  type Anomaly,
  type CheckpointEntry,
  type EntityHead,
  type ForkNotice,
  type ParseTier,
  type Rule,
  type Split,
  type State,
  type Txn,
  type Unreadable,
} from "./state";
import { platform } from "../platform";
import type { RowStore, WireRow } from "../store/store";
import type { SqlDriver, SqlStatement } from "../store/driver";
import { STREAM_HOT } from "../wire/blob";
import { compareUTF8, parseDecimal, type Op, type OpType } from "../wire/op";

/**
 * The snapshot container's version.
 *
 * A mismatch **discards**, it never migrates: the snapshot holds no information
 * that is not recomputable from the log, so a migration would be code with no
 * reason to exist and one more thing that can be wrong.
 *
 * Bump this when the *container* changes — a field added to {@link State}, a
 * change to `serializeState`'s canonicalisation, a change to what is stored
 * alongside the payload. Do **not** rely on it to catch a change in what the
 * fold *means*: nobody bumps a constant they did not think about, and Task 5's
 * report records a `STATE_VERSION` bump that was needed only because a reviewer
 * noticed. {@link foldFingerprint} is the mechanism that does not need anyone
 * to notice.
 */
export const SNAPSHOT_VERSION = 2;

/**
 * The largest payload this module will store without complaint.
 *
 * Not a storage limit — SQLite is happy with far more. It is the **load budget**
 * expressed in the one unit that is a property of the data rather than of the
 * machine. `loadSnapshot`'s cost is dominated by `JSON.parse` over these bytes
 * plus one linear decode pass, so a byte ceiling is a millisecond ceiling once
 * the device's throughput is known — and unlike a millisecond ceiling it does
 * not fail on a busy box.
 *
 * 6 MB, against ~3.5 MB measured at the 3,683-transaction reference corpus.
 * The margin is deliberately not generous: the plan's remedy for exceeding
 * ~4 MB is to split `txns` into its own table so the budget screen's slice
 * loads first and the rest hydrates behind it, and that is a **design change**.
 * Discovering it needs doing is the point of the ceiling, so the ceiling has to
 * be low enough to be reached before Task 28 does.
 */
export const SNAPSHOT_MAX_BYTES = 6_000_000;

/** The fold-cache tables. Created idempotently, like `PROJECTION_SCHEMA`. */
export const SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS fold_snapshot (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  version     INTEGER NOT NULL,
  fold_print  TEXT    NOT NULL,
  cursor_hot  TEXT    NOT NULL,
  cursor_cold TEXT    NOT NULL,
  bound_tip   TEXT    NOT NULL,
  bound_rows  INTEGER NOT NULL,
  digest      TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  saved_at    INTEGER NOT NULL,
  state_json  TEXT    NOT NULL,
  applied_json TEXT   NOT NULL
);

CREATE TABLE IF NOT EXISTS fold_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  detail     TEXT    NOT NULL,
  cursor_hot TEXT    NOT NULL,
  bytes      INTEGER NOT NULL,
  ms         INTEGER NOT NULL
);
`;

/** How many {@link readEvents} rows are kept. Bookkeeping must not grow with the log. */
export const EVENT_HISTORY = 64;

/** Canonical encoding of the delivery-only cursor set omitted by serializeState. */
export function serializeAppliedAtCursor(applied: ReadonlySet<string>): string {
  return JSON.stringify([...applied].sort(compareUTF8));
}

// ---------------------------------------------------------------------------
// Binding the snapshot to the log it folded
// ---------------------------------------------------------------------------

/**
 * The narrow view of the op log a snapshot needs in order to prove it is still
 * talking about the same log.
 *
 * # Why this is a parameter and not something `loadSnapshot` derives
 *
 * The plan's signature was `loadSnapshot(db: SqlDriver)`. With that signature a
 * snapshot cannot be checked against anything: it would load whatever the row
 * says, over whatever log happens to be on disk. That is precisely the shape
 * Task 5 had to fix — a state file that loaded as "synced" over an empty log,
 * which every invariant then passed *vacuously*. So the binding is a required
 * argument. An optional one would be an optional defect: every caller that
 * forgot it would still work, and would still be wrong.
 *
 * It is deliberately **not** the whole {@link RowStore}. This module must not be
 * able to scan the log — a snapshot loader that reads rows is a fold with extra
 * steps, and `RowStore.all()` was removed for exactly that reason. Two methods,
 * both O(1) against the `(stream, seq_key)` primary key.
 */
export interface LogBinding {
  /**
   * The identity of the HOT row at exactly `seq`, or `null` when the store
   * holds no row there.
   *
   * `null` is the empty-log answer, the wiped-database answer, the
   * signed-in-as-someone-else answer and the truncated-log answer, and all four
   * must reject the snapshot.
   */
  tipAt(seq: bigint): string | null;
  /** How many hot rows are held. Recorded for the event log, never a gate — see {@link saveSnapshot}. */
  rows(): number;
}

/**
 * The identifying bytes of one row, as a string.
 *
 * `blob_hash` is the commitment to the body and `prev_hash` is the link to the
 * previous blob **of the same writer** — which is what makes this more than a
 * point check: a substitution anywhere in that writer's chain below this row
 * changes `prev_hash` here. NUL separates the fields because none of them can
 * contain one (they are hex, decimal or a stream name), so no two distinct rows
 * can produce the same string by re-splitting.
 */
export function rowIdentity(row: WireRow): string {
  return [row.seq, row.stream, row.writer_id, row.writer_counter, row.blob_hash, row.prev_hash].join(" ");
}

/** A {@link LogBinding} over a {@link RowStore}, using `range()` — the only read path. */
export function rowStoreBinding(rows: RowStore): LogBinding {
  return {
    tipAt(seq) {
      if (seq <= 0n) return null;
      // ONE row, from immediately below the seq we want. `range` is exclusive on
      // `afterSeq`, so this returns the row AT `seq` when there is one and the
      // next row above it when there is not — hence the equality check, without
      // which a snapshot whose own row had been pruned would bind to a stranger.
      const got = rows.range(STREAM_HOT, seq - 1n, 1);
      const row = got[0];
      if (row === undefined) return null;
      if (parseDecimal(row.seq) !== seq) return null;
      return rowIdentity(row);
    },
    rows: () => rows.count(STREAM_HOT),
  };
}

// ---------------------------------------------------------------------------
// The fold fingerprint
// ---------------------------------------------------------------------------

/**
 * A digest of what this build's fold *does*, computed by folding a canary log.
 *
 * # The failure it exists for
 *
 * {@link SNAPSHOT_VERSION} catches a change to the container. Nothing catches a
 * change to the **meaning** of a fold — a bug fix in `replay.ts`, a corrected
 * fork tiebreak, a changed dedup rule — and after one of those every snapshot
 * on every device is a cache of a function that no longer exists. It still
 * loads. It still binds to the log. Every screen is then confidently wrong
 * until the periodic audit runs, days later.
 *
 * Relying on the author of the fix to bump a constant is the discipline this
 * project has already watched fail. So the check is a **measurement**: fold a
 * fixed log with this build and hash the result. If the fold changed on any
 * path the canary walks, the digest changes and every stored snapshot is
 * discarded on the next launch, automatically.
 *
 * # What it does not claim
 *
 * It is a sentinel, not a proof. It is sensitive exactly to the paths
 * {@link CANARY} exercises, and a fold change on a path it misses is invisible
 * to it — which is why `snapshot.test.ts` asserts the canary is *hostile*
 * (every op type, a real fork, a dedup anomaly, a supersede, a frozen and an
 * unfrozen FX row, an unparsed row) rather than merely non-empty, and why the
 * periodic re-fold in `audit.ts` is the backstop rather than an optimisation.
 *
 * Memoised: the canary is ~20 ops and the digest is computed once per process.
 */
let foldPrint: string | null = null;

export function foldFingerprint(): string {
  if (foldPrint !== null) return foldPrint;
  const serialized = serializeState(fold(CANARY()));
  const p = platform();
  foldPrint = p.toHex(p.sha256(new TextEncoder().encode(serialized))).slice(0, 32);
  return foldPrint;
}

/** For tests that need to observe the memoisation, and for nothing else. */
export function resetFoldFingerprint(): void {
  foldPrint = null;
}

const CANARY_DAY = "2020-01-0";

function canaryOp(type: OpType, writer: string, rest: Partial<Op> & { payload: unknown }, n: number): LogEntry {
  return {
    writer_id: writer,
    seq: 0n,
    op: {
      v: 1,
      type,
      op_id: `canary-${n.toString(10).padStart(2, "0")}`,
      authored_at: `${CANARY_DAY}${((n % 9) + 1).toString(10)}T0${(n % 9).toString(10)}:00:00Z`,
      parent_version: null,
      ...rest,
    },
  };
}

/**
 * The log {@link foldFingerprint} folds. Hostile on purpose, in the way
 * `projection.test.ts`'s fixture is: a log whose rows agree cannot tell a
 * correct fold from one that lost a field.
 *
 * Every op type in `OP_TYPES` appears. Beyond that it contains a real
 * concurrent fork (two writers editing from the same parent), a duplicate
 * ingest, a supersede, a split, an edit, an unparsed row, a currency that is
 * frozen by a rate and one that stays pending, and a `rate_unset` — so the FX
 * head resolution, the pending index, the fingerprint heuristic, the head
 * registry and the anomaly list all contribute to the digest.
 *
 * Do not "tidy" it. Every branch it walks is a branch a `replay.ts` change can
 * be caught on.
 */
function CANARY(): LogEntry[] {
  const id = (n: number): string => `c${n.toString(10)}`;
  const ing = (n: number): string => `${n.toString(16).padStart(64, "0")}`;
  const txn = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    amount_minor: `${1000 + n}`,
    currency: n % 3 === 0 ? "USD" : "AED",
    direction: n % 2 === 0 ? "debit" : "credit",
    posted_at: `${CANARY_DAY}${((n % 9) + 1).toString(10)}T12:00:00Z`,
    merchant_raw: `CANARY MERCHANT ${n.toString(10)}`,
    last4: `${(1000 + n).toString(10)}`,
    needs_review: n % 2 === 0,
    tier: n % 2 === 0 ? "template" : "heuristic",
    ...over,
  });
  let n = 0;
  const es: LogEntry[] = [
    canaryOp("home_currency_set", "dev-a", { payload: { currency: "AED" } }, ++n),
    canaryOp("rate_set", "dev-a", { payload: { currency: "USD", rate_micro: "3672500" } }, ++n),
    canaryOp("rate_set", "dev-a", { payload: { currency: "JPY", rate_micro: "24500" } }, ++n),
    canaryOp("rate_unset", "dev-a", { payload: { currency: "JPY" } }, ++n),
    canaryOp("txn_ingested", "ingest", { entity: { kind: "txn", id: id(1) }, ingest_id: ing(1), payload: txn(1) }, ++n),
    canaryOp("txn_ingested", "ingest", { entity: { kind: "txn", id: id(2) }, ingest_id: ing(2), payload: txn(2) }, ++n),
    // GBP has no rate: this row stays in `pendingByCurrency` forever, so the
    // pending index is part of the digest.
    canaryOp(
      "txn_ingested",
      "ingest",
      { entity: { kind: "txn", id: id(3) }, ingest_id: ing(3), payload: txn(3, { currency: "GBP" }) },
      ++n,
    ),
    // Unparsed: zero amount, empty currency and direction, tier "none".
    canaryOp(
      "txn_ingested",
      "ingest",
      {
        entity: { kind: "txn", id: id(4) },
        ingest_id: ing(4),
        payload: { amount_minor: "0", currency: "", direction: "", posted_at: `${CANARY_DAY}5T00:00:00Z`, merchant_raw: "", last4: "", tier: "none", needs_review: true, unparsed: true },
      },
      ++n,
    ),
    canaryOp("txn_categorized", "dev-a", { entity: { kind: "txn", id: id(1) }, parent_version: 1, payload: { category: "groceries" } }, ++n),
    canaryOp(
      "txn_split",
      "dev-a",
      { entity: { kind: "txn", id: id(1) }, parent_version: 2, payload: { parts: [{ category: "food", amount_minor: "600" }, { category: "household", amount_minor: "401" }] } },
      ++n,
    ),
    canaryOp("txn_edited", "dev-b", { entity: { kind: "txn", id: id(2) }, parent_version: 1, payload: { merchant_raw: "CANARY EDITED" } }, ++n),
    // A true concurrent fork: two writers from the same parent version.
    canaryOp("txn_categorized", "dev-a", { entity: { kind: "txn", id: id(3) }, parent_version: 1, payload: { category: "travel" } }, ++n),
    canaryOp("txn_categorized", "dev-b", { entity: { kind: "txn", id: id(3) }, parent_version: 1, payload: { category: "transport" } }, ++n),
    // A duplicate ingest: an anomaly, no fork.
    canaryOp("txn_ingested", "ingest", { entity: { kind: "txn", id: id(5) }, ingest_id: ing(1), payload: txn(5) }, ++n),
    // A supersede of c2's ingest identity: retires it and creates a new row.
    canaryOp("txn_superseded", "ingest", { entity: { kind: "txn", id: id(6) }, ingest_id: ing(2), payload: txn(6) }, ++n),
    canaryOp("rule_added", "dev-a", { entity: { kind: "rule", id: "r1" }, payload: { pattern: "CANARY", match: "contains", category: "misc", priority: 10 } }, ++n),
    canaryOp("rule_added", "dev-b", { entity: { kind: "rule", id: "r2" }, payload: { pattern: "^CAN", match: "regex", category: "other", priority: 90 } }, ++n),
    canaryOp(
      "writer_checkpoint",
      "dev-a",
      { payload: { heads: [{ writer_id: "dev-a", stream: "hot", counter: "3", hash: "a".repeat(64) }, { writer_id: "ingest", stream: "hot", counter: "7", hash: "b".repeat(64) }] } },
      ++n,
    ),
  ];
  return es.map((e, i) => ({ ...e, seq: BigInt(i + 1) }));
}

// ---------------------------------------------------------------------------
// Errors and verdicts
// ---------------------------------------------------------------------------

/** {@link saveSnapshot} was handed a state it cannot honestly describe. */
export class SnapshotBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotBindingError";
  }
}

/** A stored snapshot could not be read back as a {@link State}. */
export class SnapshotDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotDecodeError";
  }
}

/**
 * Why a stored snapshot was not used. Every value is a row in
 * {@link readEvents} and a line the Integrity screen can render.
 *
 * `absent` is the only one that is not a finding.
 */
export type SnapshotReject =
  | "absent"
  | "version"
  | "fold_semantics"
  | "log_diverged"
  | "corrupt"
  | "undecodable"
  | "cursor_disagreement";

/** What {@link loadSnapshot} did, whether or not it produced a state. */
export interface SnapshotLoad {
  state: State;
  cursor: { hot: bigint; cold: bigint };
  /** Payload bytes read. The quantity {@link SNAPSHOT_MAX_BYTES} bounds. */
  bytes: number;
  /**
   * Values the decoder visited.
   *
   * A machine-independent unit of work, so "the load is linear in the corpus"
   * is assertable without a stopwatch: `nodes(4n) / nodes(n) ≈ 4`. A decode
   * that went quadratic — or that quietly re-walked the log — shows up here and
   * nowhere else.
   */
  nodes: number;
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

interface Stmts {
  meta: SqlStatement;
  payload: SqlStatement;
  write: SqlStatement;
  clear: SqlStatement;
  event: SqlStatement;
  events: SqlStatement;
  trimEvents: SqlStatement;
}

const cached = new WeakMap<SqlDriver, Stmts>();

function stmts(db: SqlDriver): Stmts {
  const have = cached.get(db);
  if (have !== undefined) return have;
  db.exec(SNAPSHOT_SCHEMA);
  const made: Stmts = {
    // The metadata and the payload are SEPARATE statements, and that is the
    // load budget rather than tidiness: a snapshot that fails its version, its
    // fold fingerprint or its log binding is rejected without ever reading the
    // 3.5 MB TEXT column. The launch that has to re-fold anyway does not also
    // pay to parse a snapshot it is about to throw away.
    meta: db.prepare(
      "SELECT version, fold_print, cursor_hot, cursor_cold, bound_tip, bound_rows, digest, bytes, saved_at FROM fold_snapshot WHERE id = 1",
    ),
    payload: db.prepare("SELECT state_json, applied_json FROM fold_snapshot WHERE id = 1"),
    write: db.prepare(
      `INSERT INTO fold_snapshot (id, version, fold_print, cursor_hot, cursor_cold, bound_tip, bound_rows,
                                  digest, bytes, saved_at, state_json, applied_json)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, fold_print = excluded.fold_print,
         cursor_hot = excluded.cursor_hot, cursor_cold = excluded.cursor_cold, bound_tip = excluded.bound_tip,
         bound_rows = excluded.bound_rows, digest = excluded.digest, bytes = excluded.bytes,
         saved_at = excluded.saved_at, state_json = excluded.state_json, applied_json = excluded.applied_json`,
    ),
    clear: db.prepare("DELETE FROM fold_snapshot WHERE id = 1"),
    event: db.prepare("INSERT INTO fold_event (at, kind, detail, cursor_hot, bytes, ms) VALUES (?, ?, ?, ?, ?, ?)"),
    events: db.prepare("SELECT at, kind, detail, cursor_hot, bytes, ms FROM fold_event ORDER BY id DESC LIMIT ?"),
    trimEvents: db.prepare(`DELETE FROM fold_event WHERE id NOT IN (SELECT id FROM fold_event ORDER BY id DESC LIMIT ${EVENT_HISTORY})`),
  };
  cached.set(db, made);
  return made;
}

/** Creates the tables if they are not there. Idempotent, safe to call often. */
export function ensureSnapshot(db: SqlDriver): void {
  stmts(db);
}

/**
 * One line of this device's fold-cache history: saves, rejections, and
 * `audit.ts`'s runs.
 *
 * It exists because a cache that fails silently is a cache nobody can debug.
 * `kind` is a short token, `detail` is a sentence, and neither ever carries a
 * merchant, an amount or any other fragment of the user's data — this table is
 * for the Integrity screen and for a support conversation.
 */
export interface FoldEvent {
  at: number;
  kind: string;
  detail: string;
  cursorHot: bigint;
  bytes: number;
  ms: number;
}

/** Appends a fold-cache event, trimming the history to {@link EVENT_HISTORY}. */
export function recordEvent(db: SqlDriver, e: Omit<FoldEvent, "at"> & { at?: number }): void {
  const st = stmts(db);
  st.event.run(e.at ?? Date.now(), e.kind, e.detail, e.cursorHot.toString(10), e.bytes, e.ms);
  st.trimEvents.run();
}

/** The most recent events, newest first. */
export function readEvents(db: SqlDriver, limit = EVENT_HISTORY): FoldEvent[] {
  return stmts(db)
    .events.all(limit)
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        at: int(r["at"], "at"),
        kind: str(r["kind"], "kind"),
        detail: str(r["detail"], "detail"),
        cursorHot: parseDecimal(str(r["cursor_hot"], "cursor_hot")),
        bytes: int(r["bytes"], "bytes"),
        ms: int(r["ms"], "ms"),
      };
    });
}

/** Drops the stored snapshot. The next launch re-folds. */
export function clearSnapshot(db: SqlDriver): void {
  stmts(db).clear.run();
}

/**
 * Serializes `s` into the one snapshot row.
 *
 * # The three refusals, and why they are refusals rather than repairs
 *
 * A snapshot is written once and read many times, so a wrong one is amplified.
 * All three checks below compare the state against a source *outside* itself —
 * the sync layer's cursor, and the store's rows — because a check derived from
 * the same expression as the thing it checks is the defect shape this project
 * has hit thirteen times.
 *
 *  1. **`cursor` must equal `s.cursors`.** The caller passes the sync layer's
 *     cursor and the fold carries its own; they are computed by different code
 *     from different sources (the persisted `ClientState` and the highest `seq`
 *     the fold was offered). If they disagree, one of them is wrong and baking
 *     either into a cache would make it permanent.
 *  2. **The store must actually hold the row at `s.cursors.hot`.** The fold
 *     claims to have consumed it. If it is not there, the state was folded from
 *     a log this device no longer has, and the snapshot would have nothing to
 *     bind to.
 *  3. **A genesis state clears rather than saves.** `cursors.hot === 0n` means
 *     nothing has been folded, so there is nothing to cache — and a snapshot
 *     with no row to bind to would validate against *any* log, including
 *     someone else's. That is the vacuous pass, pre-empted.
 *
 * `bytes` over {@link SNAPSHOT_MAX_BYTES} is recorded as an event and the
 * snapshot is still written: refusing to save would silently return the device
 * to a 58-second launch, which is worse than a slow one. The gate that fails is
 * the test, where a human can act on it.
 */
export function saveSnapshot(db: SqlDriver, s: State, cursor: { hot: bigint; cold: bigint }, log: LogBinding): void {
  const st = stmts(db);
  if (cursor.hot !== s.cursors.hot || cursor.cold !== s.cursors.cold) {
    throw new SnapshotBindingError(
      `sync cursor (${cursor.hot.toString(10)}/${cursor.cold.toString(10)}) disagrees with the folded cursor ` +
        `(${s.cursors.hot.toString(10)}/${s.cursors.cold.toString(10)}): one of them is wrong, so neither is cached`,
    );
  }
  if (s.cursors.hot === 0n) {
    clearSnapshot(db);
    recordEvent(db, { kind: "cleared", detail: "state is at genesis; nothing to cache", cursorHot: 0n, bytes: 0, ms: 0 });
    return;
  }
  const tip = log.tipAt(s.cursors.hot);
  if (tip === null) {
    throw new SnapshotBindingError(
      `the fold consumed hot seq ${s.cursors.hot.toString(10)} but the row store holds no row there: ` +
        `this state was folded from a log this device does not have`,
    );
  }

  const stateJSON = serializeState(s);
  const appliedJSON = serializeAppliedAtCursor(s.appliedAtCursor);
  // String.length counts UTF-16 code units, not bytes. Merchant/category text
  // is Unicode, while the load ceiling is explicitly a byte budget; measuring
  // code units would let a non-ASCII corpus exceed the ceiling by up to 3x.
  const p = platform();
  const bytes = p.utf8Encode(stateJSON).byteLength + p.utf8Encode(appliedJSON).byteLength;
  const digest = p.toHex(p.sha256(p.utf8Encode(`${stateJSON}\0${appliedJSON}`)));
  const at = Date.now();

  db.transaction(() => {
    st.write.run(
      SNAPSHOT_VERSION,
      foldFingerprint(),
      s.cursors.hot.toString(10),
      s.cursors.cold.toString(10),
      tip,
      log.rows(),
      digest,
      bytes,
      at,
      stateJSON,
      appliedJSON,
    );
  });
  recordEvent(db, {
    at,
    kind: "saved",
    detail: bytes > SNAPSHOT_MAX_BYTES ? `payload is ${bytes} bytes, over the ${SNAPSHOT_MAX_BYTES}-byte budget` : "ok",
    cursorHot: s.cursors.hot,
    bytes,
    ms: 0,
  });
}

/**
 * Restores the folded state, or `null` when there is nothing usable.
 *
 * The order of the checks is the load budget: everything that can reject a
 * snapshot without reading its payload runs first, so the launch that has to
 * re-fold anyway does not also parse 3.5 MB it is about to discard.
 *
 * A rejection **drops the snapshot and records why**. Returning `null` and
 * leaving the row in place would mean every launch re-folds *and* every launch
 * re-discovers the same problem, with nothing anywhere saying so.
 */
export function loadSnapshot(db: SqlDriver, log: LogBinding): SnapshotLoad | null {
  const verdict = readSnapshot(db, log);
  if ("reject" in verdict) {
    if (verdict.reject !== "absent") {
      clearSnapshot(db);
      recordEvent(db, {
        kind: "rejected",
        detail: `${verdict.reject}: ${verdict.detail}`,
        cursorHot: verdict.cursorHot,
        bytes: 0,
        ms: 0,
      });
    }
    return null;
  }
  return verdict;
}

/** {@link loadSnapshot} without the side effects, so a test can name the reason. */
export function readSnapshot(
  db: SqlDriver,
  log: LogBinding,
): SnapshotLoad | { reject: SnapshotReject; detail: string; cursorHot: bigint } {
  const st = stmts(db);
  const raw = st.meta.all()[0] as Record<string, unknown> | undefined;
  if (raw === undefined) return { reject: "absent", detail: "no snapshot has been saved", cursorHot: 0n };

  const version = int(raw["version"], "version");
  const cursorHot = parseDecimal(str(raw["cursor_hot"], "cursor_hot"));
  const no = (reject: SnapshotReject, detail: string): { reject: SnapshotReject; detail: string; cursorHot: bigint } => ({ reject, detail, cursorHot });

  if (version !== SNAPSHOT_VERSION) {
    return no("version", `written by container v${version.toString(10)}, this build is v${SNAPSHOT_VERSION.toString(10)}`);
  }
  const print = str(raw["fold_print"], "fold_print");
  if (print !== foldFingerprint()) {
    // The fold itself changed under this snapshot. Not a corruption and not a
    // container change — the cached value is of a function this build no longer
    // computes, so it is discarded whether or not anyone remembered to bump
    // SNAPSHOT_VERSION.
    return no("fold_semantics", `folded by a build whose canary digest was ${print}, this build's is ${foldFingerprint()}`);
  }
  const boundTip = str(raw["bound_tip"], "bound_tip");
  const tip = log.tipAt(cursorHot);
  if (tip === null) {
    return no("log_diverged", `the log holds no hot row at seq ${cursorHot.toString(10)}`);
  }
  if (tip !== boundTip) {
    return no("log_diverged", `the hot row at seq ${cursorHot.toString(10)} is not the row this snapshot folded`);
  }

  // Only now is the payload worth reading.
  const body = st.payload.all()[0] as Record<string, unknown> | undefined;
  if (body === undefined) return no("corrupt", "the snapshot row lost its payload between two reads");
  const stateJSON = str(body["state_json"], "state_json");
  const appliedJSON = str(body["applied_json"], "applied_json");
  const p = platform();
  const digest = p.toHex(p.sha256(new TextEncoder().encode(`${stateJSON} ${appliedJSON}`)));
  if (digest !== str(raw["digest"], "digest")) {
    return no("corrupt", "the stored payload does not match its digest");
  }

  let decoded: { state: State; nodes: number };
  try {
    decoded = decodeSnapshot(stateJSON, appliedJSON);
  } catch (err) {
    return no("undecodable", (err as Error).message);
  }
  // The decoded state's OWN cursor against the indexed column the binding was
  // checked with. Two copies of the same number written at different times: if
  // they disagree the row was assembled wrong, and the tip check above proved
  // nothing because it checked the wrong seq.
  if (decoded.state.cursors.hot !== cursorHot) {
    return no(
      "cursor_disagreement",
      `the payload folds to seq ${decoded.state.cursors.hot.toString(10)} but the row is indexed at ${cursorHot.toString(10)}`,
    );
  }
  return {
    state: decoded.state,
    cursor: { hot: cursorHot, cold: parseDecimal(str(raw["cursor_cold"], "cursor_cold")) },
    bytes: new TextEncoder().encode(stateJSON).byteLength + new TextEncoder().encode(appliedJSON).byteLength,
    nodes: decoded.nodes,
  };
}

/**
 * The stored payload as bytes, without decoding it into a {@link State}.
 *
 * `audit.ts` compares a fresh `serializeState()` against these bytes directly:
 * the canonical form is the comparison, so decoding first would add a whole
 * decoder to the trusted path of a check whose entire job is to be independent
 * of it.
 */
export function readSnapshotPayload(
  db: SqlDriver,
): { stateJSON: string; appliedJSON: string; cursorHot: bigint; cursorCold: bigint; digest: string } | null {
  const st = stmts(db);
  const raw = st.meta.all()[0] as Record<string, unknown> | undefined;
  if (raw === undefined) return null;
  const body = st.payload.all()[0] as Record<string, unknown> | undefined;
  if (body === undefined) return null;
  return {
    stateJSON: str(body["state_json"], "state_json"),
    appliedJSON: str(body["applied_json"], "applied_json"),
    cursorHot: parseDecimal(str(raw["cursor_hot"], "cursor_hot")),
    cursorCold: parseDecimal(str(raw["cursor_cold"], "cursor_cold")),
    digest: str(raw["digest"], "digest"),
  };
}

/** The stored payload's size, for a budget assertion. `null` when there is none. */
export function snapshotBytes(db: SqlDriver): number | null {
  const raw = stmts(db).meta.all()[0] as Record<string, unknown> | undefined;
  if (raw === undefined) return null;
  return int(raw["bytes"], "bytes");
}

// ---------------------------------------------------------------------------
// The decoder
//
// Hand-written and field-by-field, in the same idiom as `projection.ts`'s
// column decoders and for the same reason — but here there is a second reason
// that is easy to miss and expensive to get wrong.
//
// `serializeState` renders a `bigint` as a decimal STRING. `JSON.parse` gives
// that string back as a string. So a decoder that forgot to revive a money
// field would leave a `string` where a `bigint` belongs, and the round-trip
// test everyone reaches for first — `serializeState(loaded) === stored` —
// would still pass, because `canonical()` renders a bigint and a string
// identically. The equality check is blind to exactly the defect it looks like
// it is testing for.
//
// Two things follow. Every field is revived explicitly, through `parseDecimal`,
// which also enforces the decimal grammar. And `snapshot.test.ts` proves the
// revival by walking the original and the restored state in parallel and
// comparing `typeof` at every leaf — a check the serialization cannot satisfy
// by construction.
// ---------------------------------------------------------------------------

/**
 * Every field of {@link State}, so the decoder is exhaustive by enumeration
 * rather than by whoever wrote it remembering.
 *
 * Pinned against `Object.keys(emptyState())` by a test: a field added to
 * `State` later fails loudly here instead of being silently dropped from every
 * device's cache.
 */
export const SNAPSHOT_FIELDS: readonly (keyof State)[] = [
  "txns",
  "liveByIngestID",
  "byFingerprint",
  "rules",
  "homeCurrency",
  "rates",
  "rateUpdatedAt",
  "pendingByCurrency",
  "checkpoints",
  "forks",
  "anomalies",
  "unreadable",
  "cursors",
  "appliedAtCursor",
  "heads",
];

let nodes = 0;

function decodeSnapshot(stateJSON: string, appliedJSON: string): { state: State; nodes: number } {
  nodes = 0;
  const root = JSON.parse(stateJSON) as unknown;
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new SnapshotDecodeError("snapshot payload is not an object");
  }
  const r = root as Record<string, unknown>;
  // `serializeState` omits exactly `appliedAtCursor`; every other field must be
  // present. A missing one is a snapshot written by a build with a different
  // State, which SNAPSHOT_VERSION should have caught — so it is a decode
  // failure rather than a defaulted field, because a defaulted `heads` map is a
  // fold that silently forgets every entity's version line.
  for (const k of SNAPSHOT_FIELDS) {
    if (k === "appliedAtCursor") continue;
    if (!(k in r)) throw new SnapshotDecodeError(`snapshot payload has no ${k}`);
  }
  const s: State = {
    txns: pairs(r["txns"], "txns", decodeTxn),
    liveByIngestID: pairs(r["liveByIngestID"], "liveByIngestID", (v, w) => str(v, w)),
    byFingerprint: pairs(r["byFingerprint"], "byFingerprint", (v, w) => list(v, w, (x, y) => str(x, y))),
    rules: pairs(r["rules"], "rules", decodeRule),
    homeCurrency: r["homeCurrency"] === null ? null : str(r["homeCurrency"], "homeCurrency"),
    rates: pairs(r["rates"], "rates", (v, w) => (v === null ? null : parseDecimal(str(v, w)))),
    rateUpdatedAt: pairs(r["rateUpdatedAt"], "rateUpdatedAt", (v, w) => str(v, w)),
    pendingByCurrency: pairs(r["pendingByCurrency"], "pendingByCurrency", (v, w) => new Set(list(v, w, (x, y) => str(x, y)))),
    checkpoints: list(r["checkpoints"], "checkpoints", decodeCheckpoint),
    forks: list(r["forks"], "forks", decodeFork),
    anomalies: list(r["anomalies"], "anomalies", decodeAnomaly),
    unreadable: list(r["unreadable"], "unreadable", decodeUnreadable),
    cursors: decodeCursors(r["cursors"]),
    appliedAtCursor: new Set(list(JSON.parse(appliedJSON) as unknown, "appliedAtCursor", (x, y) => str(x, y))),
    heads: pairs(r["heads"], "heads", decodeHead),
  };
  // An O(1) guard on the way out, because the whole module is worthless if the
  // reviver silently stopped reviving. The exhaustive version of this lives in
  // the test suite; this one costs nothing and catches a wholesale failure.
  if (typeof s.cursors.hot !== "bigint") throw new SnapshotDecodeError("restored cursor is not a bigint");
  return { state: s, nodes };
}

function decodeTxn(v: unknown, where: string): Txn {
  const r = obj(v, where);
  return {
    id: str(r["id"], `${where}.id`),
    ingest_id: str(r["ingest_id"], `${where}.ingest_id`),
    amount_minor: parseDecimal(str(r["amount_minor"], `${where}.amount_minor`)),
    currency: str(r["currency"], `${where}.currency`),
    direction: direction(r["direction"], `${where}.direction`),
    posted_at: str(r["posted_at"], `${where}.posted_at`),
    merchant_raw: str(r["merchant_raw"], `${where}.merchant_raw`),
    last4: str(r["last4"], `${where}.last4`),
    category: r["category"] === null ? null : str(r["category"], `${where}.category`),
    needs_review: bool(r["needs_review"], `${where}.needs_review`),
    unparsed: bool(r["unparsed"], `${where}.unparsed`),
    tier: tier(r["tier"], `${where}.tier`),
    parse_error: r["parse_error"] === null ? null : str(r["parse_error"], `${where}.parse_error`),
    provenance: provenance(r["provenance"], `${where}.provenance`),
    amount_home_minor: r["amount_home_minor"] === null ? null : parseDecimal(str(r["amount_home_minor"], `${where}.amount_home_minor`)),
    splits: list(r["splits"], `${where}.splits`, decodeSplit),
    superseded_by: r["superseded_by"] === null ? null : str(r["superseded_by"], `${where}.superseded_by`),
    possible_duplicate_of: r["possible_duplicate_of"] === null ? null : str(r["possible_duplicate_of"], `${where}.possible_duplicate_of`),
    version: int(r["version"], `${where}.version`),
  };
}

function decodeSplit(v: unknown, where: string): Split {
  const r = obj(v, where);
  return { category: str(r["category"], `${where}.category`), amount_minor: parseDecimal(str(r["amount_minor"], `${where}.amount_minor`)) };
}

function decodeRule(v: unknown, where: string): Rule {
  const r = obj(v, where);
  return {
    pattern: str(r["pattern"], `${where}.pattern`),
    match: str(r["match"], `${where}.match`),
    category: str(r["category"], `${where}.category`),
    priority: int(r["priority"], `${where}.priority`),
    version: int(r["version"], `${where}.version`),
  };
}

function decodeCheckpoint(v: unknown, where: string): CheckpointEntry {
  const r = obj(v, where);
  return {
    writer_id: str(r["writer_id"], `${where}.writer_id`),
    stream: str(r["stream"], `${where}.stream`),
    counter: parseDecimal(str(r["counter"], `${where}.counter`)),
    hash: str(r["hash"], `${where}.hash`),
  };
}

function decodeFork(v: unknown, where: string): ForkNotice {
  const r = obj(v, where);
  const e = obj(r["entity"], `${where}.entity`);
  return {
    entity: { kind: str(e["kind"], `${where}.entity.kind`), id: str(e["id"], `${where}.entity.id`) },
    winner_op: str(r["winner_op"], `${where}.winner_op`),
    loser_op: str(r["loser_op"], `${where}.loser_op`),
    at_seq: parseDecimal(str(r["at_seq"], `${where}.at_seq`)),
  };
}

function decodeAnomaly(v: unknown, where: string): Anomaly {
  const r = obj(v, where);
  return {
    kind: str(r["kind"], `${where}.kind`),
    detail: str(r["detail"], `${where}.detail`),
    at_seq: parseDecimal(str(r["at_seq"], `${where}.at_seq`)),
  };
}

function decodeUnreadable(v: unknown, where: string): Unreadable {
  const r = obj(v, where);
  return {
    writer_id: str(r["writer_id"], `${where}.writer_id`),
    stream: str(r["stream"], `${where}.stream`),
    writer_counter: parseDecimal(str(r["writer_counter"], `${where}.writer_counter`)),
    seq: parseDecimal(str(r["seq"], `${where}.seq`)),
    reason: str(r["reason"], `${where}.reason`),
  };
}

function decodeHead(v: unknown, where: string): EntityHead {
  const r = obj(v, where);
  return {
    kind: str(r["kind"], `${where}.kind`),
    id: str(r["id"], `${where}.id`),
    version: int(r["version"], `${where}.version`),
    op_id: str(r["op_id"], `${where}.op_id`),
    writer_id: str(r["writer_id"], `${where}.writer_id`),
    authored_at_ms: int(r["authored_at_ms"], `${where}.authored_at_ms`),
  };
}

function decodeCursors(v: unknown): { hot: bigint; cold: bigint } {
  const r = obj(v, "cursors");
  return { hot: parseDecimal(str(r["hot"], "cursors.hot")), cold: parseDecimal(str(r["cold"], "cursors.cold")) };
}

/** `canonical()` renders a Map as sorted `[key, value]` pairs. This reads them back. */
function pairs<V>(v: unknown, where: string, dec: (value: unknown, where: string) => V): Map<string, V> {
  if (!Array.isArray(v)) throw new SnapshotDecodeError(`${where} is ${typeof v}, want an array of pairs`);
  nodes += v.length;
  const out = new Map<string, V>();
  for (const [i, entry] of v.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new SnapshotDecodeError(`${where}[${i}] is not a [key, value] pair`);
    out.set(str(entry[0], `${where}[${i}] key`), dec(entry[1], `${where}[${i}]`));
  }
  return out;
}

function list<V>(v: unknown, where: string, dec: (value: unknown, where: string) => V, message?: string): V[] {
  if (!Array.isArray(v)) throw new SnapshotDecodeError(message ?? `${where} is ${typeof v}, want an array`);
  nodes += v.length;
  return v.map((x, i) => dec(x, `${where}[${i}]`));
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new SnapshotDecodeError(`${where} is ${v === null ? "null" : typeof v}, want an object`);
  }
  nodes++;
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string") throw new SnapshotDecodeError(`${where} is ${typeof v}, want a string`);
  nodes++;
  return v;
}

function int(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new SnapshotDecodeError(`${where} is ${String(v)}, want an integer`);
  nodes++;
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw new SnapshotDecodeError(`${where} is ${typeof v}, want a boolean`);
  nodes++;
  return v;
}

function direction(v: unknown, where: string): Txn["direction"] {
  const s = str(v, where);
  if (s !== "debit" && s !== "credit" && s !== "") throw new SnapshotDecodeError(`${where} ${JSON.stringify(s)} is not a direction`);
  return s;
}

function tier(v: unknown, where: string): ParseTier {
  const s = str(v, where);
  if (s !== "template" && s !== "heuristic" && s !== "none") throw new SnapshotDecodeError(`${where} ${JSON.stringify(s)} is not a tier`);
  return s;
}

function provenance(v: unknown, where: string): Txn["provenance"] {
  const s = str(v, where);
  if (s !== "ingest" && s !== "user") throw new SnapshotDecodeError(`${where} ${JSON.stringify(s)} is not a provenance`);
  return s;
}
