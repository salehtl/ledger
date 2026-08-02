/**
 * The SQLite projection of a folded {@link State} — the tables the UI reads.
 *
 * # Why a projection exists at all
 *
 * The op log is the source of truth and {@link State} is the derived view, but
 * `State` is a set of JavaScript `Map`s that only exists while the fold's
 * process does. A list screen that wants "the 50 most recent transactions,
 * newest first, excluding superseded" cannot ask a `Map` for that without
 * walking all 3,683 of them, and a budget screen that wants a per-category sum
 * cannot either. So the fold's result is written into indexed tables once, and
 * every screen queries those.
 *
 * The projection is a **cache of a pure function of a prefix of the log**. It is
 * never an input to a fold, never hashed into a chain, never uploaded. If it is
 * lost, wrong, or written by an older build, the repair is to drop it and
 * re-project — which is what {@link project} does on every version mismatch and
 * on every incomplete previous run.
 *
 * # Money is TEXT, and that is not a storage detail
 *
 * SQLite has no unsigned 64-bit integer and its `INTEGER` binds to a JS
 * `number` on the way back out. A `number` in a money path is the defect this
 * whole codebase is written against (spec §3.7:125 — the FX intermediate
 * product passes 2^53 long before the result does), so `amount_minor`,
 * `amount_home_minor`, split parts and `rate_micro` are TEXT holding decimal
 * strings and are read back through {@link parseDecimal} into `bigint`. The UI
 * never sees a `number` for money because there is no `number` to see.
 *
 * `at_seq` is TEXT for the same reason: a `seq` is a `bigint`.
 *
 * # Chunked, and yielding
 *
 * {@link project} writes {@link PROJECT_CHUNK} rows per transaction and awaits
 * `between` after each chunk. The chunking bounds what one SQLite transaction
 * holds; the **yield** is what gives the collector a turn, which is the part
 * Phase 0's post-mortem found load-bearing. Neither is free to remove: see
 * `net/engine.ts`'s regression tests, which measure retention across chunks
 * rather than counting `setTimeout` calls.
 *
 * A projection is therefore NOT atomic as a whole — it cannot be, because a
 * `SqlDriver.transaction` takes a synchronous function and an `await` inside one
 * is not expressible. {@link ProjectionMeta.complete} is how that is made safe:
 * it is cleared before the first row is written and set after the last, so an
 * interrupted projection is *visibly* partial and the next {@link project} call
 * rebuilds it from scratch instead of serving half a log as if it were whole.
 *
 * # Host imports
 *
 * None. `SqlDriver` is imported with `import type`, exactly as `store/sqlite.ts`
 * does, so this module is reachable from Hermes and drags no `bun:sqlite` with
 * it.
 */

import type { SqlDriver, SqlStatement } from "../store/driver";
import { parseDecimal } from "../wire/op";
import type { Anomaly, ForkNotice, ParseTier, Rule, Split, State, Txn } from "./state";

/**
 * The projection's schema version.
 *
 * A mismatch **drops and rebuilds**, it never migrates. The projection holds no
 * information that is not recomputable from the log, so a migration would be
 * code with no reason to exist and one more thing that can be wrong.
 */
export const PROJECTION_VERSION = 1;

/**
 * Rows written per transaction, and per yield.
 *
 * The same 250 the Phase 0 fix shipped with and `store/store.ts`'s `ROW_CHUNK`
 * uses. It is repeated here rather than imported because the two count
 * different things — that one is op-log rows read, this one is projected rows
 * written — and a future tuning of one must not silently retune the other.
 */
export const PROJECT_CHUNK = 250;

export const PROJECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS txn (
  id                    TEXT    PRIMARY KEY,
  ingest_id             TEXT    NOT NULL,
  amount_minor          TEXT    NOT NULL,
  currency              TEXT    NOT NULL,
  direction             TEXT    NOT NULL,
  posted_at             TEXT    NOT NULL,
  merchant_raw          TEXT    NOT NULL,
  last4                 TEXT    NOT NULL,
  category              TEXT,
  needs_review          INTEGER NOT NULL,
  provenance            TEXT    NOT NULL,
  amount_home_minor     TEXT,
  unparsed              INTEGER NOT NULL,
  tier                  TEXT    NOT NULL,
  parse_error           TEXT,
  superseded_by         TEXT,
  possible_duplicate_of TEXT,
  version               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS txn_posted_at    ON txn (posted_at);
CREATE INDEX IF NOT EXISTS txn_needs_review ON txn (needs_review);
CREATE INDEX IF NOT EXISTS txn_category     ON txn (category, posted_at);
CREATE INDEX IF NOT EXISTS txn_superseded   ON txn (superseded_by);

CREATE TABLE IF NOT EXISTS txn_split (
  txn_id       TEXT    NOT NULL,
  idx          INTEGER NOT NULL,
  category     TEXT    NOT NULL,
  amount_minor TEXT    NOT NULL,
  PRIMARY KEY (txn_id, idx)
);

CREATE TABLE IF NOT EXISTS rule (
  id       TEXT    PRIMARY KEY,
  pattern  TEXT    NOT NULL,
  match    TEXT    NOT NULL,
  category TEXT    NOT NULL,
  priority INTEGER NOT NULL,
  version  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate (
  currency   TEXT PRIMARY KEY,
  rate_micro TEXT
);

CREATE TABLE IF NOT EXISTS fork_notice (
  idx         INTEGER PRIMARY KEY,
  entity_kind TEXT    NOT NULL,
  entity_id   TEXT    NOT NULL,
  winner_op   TEXT    NOT NULL,
  loser_op    TEXT    NOT NULL,
  at_seq      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS anomaly (
  idx    INTEGER PRIMARY KEY,
  kind   TEXT    NOT NULL,
  detail TEXT    NOT NULL,
  at_seq TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  version       INTEGER NOT NULL,
  cursor_hot    TEXT    NOT NULL,
  cursor_cold   TEXT    NOT NULL,
  home_currency TEXT,
  complete      INTEGER NOT NULL
);
`;

/** What a completed {@link project} wrote. Counts, for a progress line and a test. */
export interface ProjectReport {
  txns: number;
  splits: number;
  rules: number;
  rates: number;
  forks: number;
  anomalies: number;
  /** Transactions written per chunk; `chunks - 1` yields happened between them. */
  chunks: number;
}

export interface ProjectOptions {
  chunkSize?: number;
  /** Awaited between chunks. `net/engine.ts` passes the `setTimeout(0)` yield. */
  between?: (chunk: number) => Promise<void> | void;
  /** Consulted at every chunk boundary; a `true` abandons the projection. */
  cancelled?: () => boolean;
}

/**
 * The projection's own bookkeeping row.
 *
 * `complete` is the load-bearing field: `false` means a projection was started
 * and not finished, and the tables must not be read.
 */
export interface ProjectionMeta {
  version: number;
  cursorHot: bigint;
  cursorCold: bigint;
  homeCurrency: string | null;
  complete: boolean;
}

/** Raised when {@link project} was abandoned through {@link ProjectOptions.cancelled}. */
export class ProjectionCancelled extends Error {
  constructor(readonly chunk: number) {
    super(`projection cancelled after ${chunk} chunk${chunk === 1 ? "" : "s"}`);
    this.name = "ProjectionCancelled";
  }
}

interface Stmts {
  txn: SqlStatement;
  split: SqlStatement;
  rule: SqlStatement;
  rate: SqlStatement;
  fork: SqlStatement;
  anomaly: SqlStatement;
  meta: SqlStatement;
}

function prepare(db: SqlDriver): Stmts {
  return {
    txn: db.prepare(
      `INSERT INTO txn (id, ingest_id, amount_minor, currency, direction, posted_at, merchant_raw, last4,
                        category, needs_review, provenance, amount_home_minor, unparsed, tier, parse_error,
                        superseded_by, possible_duplicate_of, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    split: db.prepare("INSERT INTO txn_split (txn_id, idx, category, amount_minor) VALUES (?, ?, ?, ?)"),
    rule: db.prepare("INSERT INTO rule (id, pattern, match, category, priority, version) VALUES (?, ?, ?, ?, ?, ?)"),
    rate: db.prepare("INSERT INTO rate (currency, rate_micro) VALUES (?, ?)"),
    fork: db.prepare(
      "INSERT INTO fork_notice (idx, entity_kind, entity_id, winner_op, loser_op, at_seq) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    anomaly: db.prepare("INSERT INTO anomaly (idx, kind, detail, at_seq) VALUES (?, ?, ?, ?)"),
    meta: db.prepare(
      `INSERT INTO projection_meta (id, version, cursor_hot, cursor_cold, home_currency, complete)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, cursor_hot = excluded.cursor_hot,
         cursor_cold = excluded.cursor_cold, home_currency = excluded.home_currency, complete = excluded.complete`,
    ),
  };
}

/** Creates the tables if they are not there. Idempotent, and safe to call often. */
export function ensureProjection(db: SqlDriver): void {
  db.exec(PROJECTION_SCHEMA);
}

/**
 * Replaces the projection with `s`, a chunk per transaction, yielding between
 * chunks.
 *
 * It is a full replace rather than a delta, and deliberately: a fold is a pure
 * function of a log prefix, so "what changed since last time" is not something
 * the state carries — deriving it would mean diffing two states, which costs
 * more than rewriting the rows it would have found. Task 9's snapshot is what
 * removes the *fold* from the common path; this stays a replace.
 */
export async function project(db: SqlDriver, s: State, opts: ProjectOptions = {}): Promise<ProjectReport> {
  const chunkSize = opts.chunkSize ?? PROJECT_CHUNK;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`project needs a positive integer chunk size, got ${String(chunkSize)}`);
  }
  ensureProjection(db);
  const st = prepare(db);

  // Cleared BEFORE anything is written. An interrupted projection then reads
  // back as incomplete rather than as a short log, which is the difference
  // between "rebuild me" and "the user lost half their transactions".
  db.transaction(() => {
    for (const t of ["txn", "txn_split", "rule", "rate", "fork_notice", "anomaly"]) db.exec(`DELETE FROM ${t}`);
    writeMeta(st, s, false);
  });

  const report: ProjectReport = { txns: 0, splits: 0, rules: 0, rates: 0, forks: 0, anomalies: 0, chunks: 0 };
  const total = s.txns.size;
  const it = s.txns.values();

  for (;;) {
    // The chunk is drawn from the Map's ITERATOR, never from `[...s.txns]`:
    // materializing the whole list first would be the read-all-then-write shape
    // the chunking exists to forbid, and it would look identical in every test
    // that only counts rows.
    const batch: Txn[] = [];
    for (let i = 0; i < chunkSize; i++) {
      const next = it.next();
      if (next.done === true) break;
      batch.push(next.value);
    }
    if (batch.length === 0) break;

    db.transaction(() => {
      for (const t of batch) {
        writeTxn(st, t);
        writeSplits(st, t.id, t.splits);
        report.splits += t.splits.length;
      }
    });
    report.txns += batch.length;
    report.chunks++;
    if (report.txns >= total) break;
    if (opts.cancelled?.() === true) throw new ProjectionCancelled(report.chunks);
    await opts.between?.(report.chunks);
  }

  // The small tables. They are bounded by the number of currencies, rules and
  // surfaced notices rather than by the log's length, so they are one write.
  db.transaction(() => {
    for (const [id, r] of s.rules) {
      writeRule(st, id, r);
      report.rules++;
    }
    for (const [ccy, micro] of s.rates) {
      // A key present with `null` is a live `rate_unset`, which is NOT the same
      // as an absent key ("no rate was ever set"). The row exists with a NULL
      // `rate_micro` so that distinction survives the projection.
      st.rate.run(ccy, micro === null ? null : micro.toString(10));
      report.rates++;
    }
    for (const [i, f] of s.forks.entries()) {
      writeFork(st, i, f);
      report.forks++;
    }
    for (const [i, a] of s.anomalies.entries()) {
      writeAnomaly(st, i, a);
      report.anomalies++;
    }
    writeMeta(st, s, true);
  });

  return report;
}

function writeMeta(st: Stmts, s: State, complete: boolean): void {
  st.meta.run(
    PROJECTION_VERSION,
    s.cursors.hot.toString(10),
    s.cursors.cold.toString(10),
    s.homeCurrency,
    complete ? 1 : 0,
  );
}

function writeTxn(st: Stmts, t: Txn): void {
  st.txn.run(
    t.id,
    t.ingest_id,
    t.amount_minor.toString(10),
    t.currency,
    t.direction,
    t.posted_at,
    t.merchant_raw,
    t.last4,
    t.category,
    t.needs_review ? 1 : 0,
    t.provenance,
    t.amount_home_minor === null ? null : t.amount_home_minor.toString(10),
    t.unparsed ? 1 : 0,
    t.tier,
    t.parse_error,
    t.superseded_by,
    t.possible_duplicate_of,
    t.version,
  );
}

function writeSplits(st: Stmts, txnID: string, splits: readonly Split[]): void {
  // The index is stored because a split list is a SEQUENCE — `serializeState`
  // leaves it in order on purpose — and a projection that read it back in
  // whatever order SQLite chose would compare equal on sums while disagreeing
  // on the thing the user typed.
  for (const [i, p] of splits.entries()) st.split.run(txnID, i, p.category, p.amount_minor.toString(10));
}

function writeRule(st: Stmts, id: string, r: Rule): void {
  st.rule.run(id, r.pattern, r.match, r.category, r.priority, r.version);
}

function writeFork(st: Stmts, idx: number, f: ForkNotice): void {
  st.fork.run(idx, f.entity.kind, f.entity.id, f.winner_op, f.loser_op, f.at_seq.toString(10));
}

function writeAnomaly(st: Stmts, idx: number, a: Anomaly): void {
  st.anomaly.run(idx, a.kind, a.detail, a.at_seq.toString(10));
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

const TXN_COLUMNS =
  "id, ingest_id, amount_minor, currency, direction, posted_at, merchant_raw, last4, category, " +
  "needs_review, provenance, amount_home_minor, unparsed, tier, parse_error, superseded_by, " +
  "possible_duplicate_of, version";

/**
 * Reads the meta row, or `null` when the projection has never been written.
 *
 * A caller must treat `complete === false` and `version !== PROJECTION_VERSION`
 * the same way it treats `null`: rebuild. {@link projectionIsUsable} is that
 * rule, in one place.
 */
export function readMeta(db: SqlDriver): ProjectionMeta | null {
  ensureProjection(db);
  const got = db.prepare("SELECT version, cursor_hot, cursor_cold, home_currency, complete FROM projection_meta WHERE id = 1").all();
  const row = got[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    version: num(row["version"], "version"),
    cursorHot: parseDecimal(text(row["cursor_hot"], "cursor_hot")),
    cursorCold: parseDecimal(text(row["cursor_cold"], "cursor_cold")),
    homeCurrency: row["home_currency"] === null ? null : text(row["home_currency"], "home_currency"),
    complete: num(row["complete"], "complete") !== 0,
  };
}

/** Whether the tables may be read: written by this build, and finished. */
export function projectionIsUsable(db: SqlDriver): boolean {
  const m = readMeta(db);
  return m !== null && m.complete && m.version === PROJECTION_VERSION;
}

/**
 * Every projected transaction, keyed by id, as a {@link Txn}.
 *
 * A test accessor and a small-account convenience — the UI queries slices with
 * its own SQL and never loads the table. It is here rather than in a test file
 * so that `projectionMatchesState` compares against the same decoder the
 * product would use: a comparison against a hand-written decoder would certify
 * the test's reading of the rows, not the projection's.
 */
export function readTxns(db: SqlDriver): Map<string, Txn> {
  ensureProjection(db);
  const splits = new Map<string, Split[]>();
  for (const raw of db.prepare("SELECT txn_id, idx, category, amount_minor FROM txn_split ORDER BY txn_id, idx").all()) {
    const r = raw as Record<string, unknown>;
    const id = text(r["txn_id"], "txn_id");
    const list = splits.get(id) ?? [];
    list.push({ category: text(r["category"], "category"), amount_minor: parseDecimal(text(r["amount_minor"], "amount_minor")) });
    splits.set(id, list);
  }
  const out = new Map<string, Txn>();
  for (const raw of db.prepare(`SELECT ${TXN_COLUMNS} FROM txn`).all()) {
    const r = raw as Record<string, unknown>;
    const id = text(r["id"], "id");
    out.set(id, {
      id,
      ingest_id: text(r["ingest_id"], "ingest_id"),
      amount_minor: parseDecimal(text(r["amount_minor"], "amount_minor")),
      currency: text(r["currency"], "currency"),
      direction: direction(r["direction"]),
      posted_at: text(r["posted_at"], "posted_at"),
      merchant_raw: text(r["merchant_raw"], "merchant_raw"),
      last4: text(r["last4"], "last4"),
      category: r["category"] === null ? null : text(r["category"], "category"),
      needs_review: num(r["needs_review"], "needs_review") !== 0,
      unparsed: num(r["unparsed"], "unparsed") !== 0,
      tier: tier(r["tier"]),
      parse_error: r["parse_error"] === null ? null : text(r["parse_error"], "parse_error"),
      provenance: provenance(r["provenance"]),
      amount_home_minor: r["amount_home_minor"] === null ? null : parseDecimal(text(r["amount_home_minor"], "amount_home_minor")),
      splits: splits.get(id) ?? [],
      superseded_by: r["superseded_by"] === null ? null : text(r["superseded_by"], "superseded_by"),
      possible_duplicate_of:
        r["possible_duplicate_of"] === null ? null : text(r["possible_duplicate_of"], "possible_duplicate_of"),
      version: num(r["version"], "version"),
    });
  }
  return out;
}

/** Every projected rule, by id. */
export function readRules(db: SqlDriver): Map<string, Rule> {
  ensureProjection(db);
  const out = new Map<string, Rule>();
  for (const raw of db.prepare("SELECT id, pattern, match, category, priority, version FROM rule").all()) {
    const r = raw as Record<string, unknown>;
    out.set(text(r["id"], "id"), {
      pattern: text(r["pattern"], "pattern"),
      match: text(r["match"], "match"),
      category: text(r["category"], "category"),
      priority: num(r["priority"], "priority"),
      version: num(r["version"], "version"),
    });
  }
  return out;
}

/** Every projected rate. A present key with a `null` value is a live `rate_unset`. */
export function readRates(db: SqlDriver): Map<string, bigint | null> {
  ensureProjection(db);
  const out = new Map<string, bigint | null>();
  for (const raw of db.prepare("SELECT currency, rate_micro FROM rate").all()) {
    const r = raw as Record<string, unknown>;
    out.set(
      text(r["currency"], "currency"),
      r["rate_micro"] === null ? null : parseDecimal(text(r["rate_micro"], "rate_micro")),
    );
  }
  return out;
}

/** Fork notices in fold order. */
export function readForks(db: SqlDriver): ForkNotice[] {
  ensureProjection(db);
  return db
    .prepare("SELECT entity_kind, entity_id, winner_op, loser_op, at_seq FROM fork_notice ORDER BY idx")
    .all()
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        entity: { kind: text(r["entity_kind"], "entity_kind"), id: text(r["entity_id"], "entity_id") },
        winner_op: text(r["winner_op"], "winner_op"),
        loser_op: text(r["loser_op"], "loser_op"),
        at_seq: parseDecimal(text(r["at_seq"], "at_seq")),
      };
    });
}

/** Anomalies in fold order. */
export function readAnomalies(db: SqlDriver): Anomaly[] {
  ensureProjection(db);
  return db
    .prepare("SELECT kind, detail, at_seq FROM anomaly ORDER BY idx")
    .all()
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        kind: text(r["kind"], "kind"),
        detail: text(r["detail"], "detail"),
        at_seq: parseDecimal(text(r["at_seq"], "at_seq")),
      };
    });
}

// ---------------------------------------------------------------------------
// Column decoding
//
// Every column is re-validated on the way out for the same reason
// `store/sqlite.ts`'s `toWireRow` does it: this reads bytes that have been on
// disk, and a type confusion that reached the UI as a money value would be a
// silent wrong number rather than a loud failure.
// ---------------------------------------------------------------------------

function text(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`projected column ${name} is ${typeof v}, want string`);
  return v;
}

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`projected column ${name} is ${String(v)}, want an integer`);
  return v;
}

function direction(v: unknown): Txn["direction"] {
  const s = text(v, "direction");
  if (s !== "debit" && s !== "credit" && s !== "") throw new Error(`projected direction ${JSON.stringify(s)} is not a direction`);
  return s;
}

function tier(v: unknown): ParseTier {
  const s = text(v, "tier");
  if (s !== "template" && s !== "heuristic" && s !== "none") throw new Error(`projected tier ${JSON.stringify(s)} is not a tier`);
  return s;
}

function provenance(v: unknown): Txn["provenance"] {
  const s = text(v, "provenance");
  if (s !== "ingest" && s !== "user") throw new Error(`projected provenance ${JSON.stringify(s)} is not a provenance`);
  return s;
}
