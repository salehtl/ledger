/**
 * The SQLite store — the one a phone uses.
 *
 * # What it fixes
 *
 * `Client.commit()` saves the state after every mutation. When the state
 * carried the rows, that rewrote the whole op log every time; here `save()`
 * writes one small `client_state` row and the log is an append-only table that
 * a save never touches. The rows are read back by {@link RowStore.range} only —
 * there is no method that returns the whole log, because loading 3,683 blobs
 * into one array is the shape the Phase 0 build froze on.
 *
 * # What it does NOT fix
 *
 * Retention. `wire_rows` keeps every hot blob forever, which is the second of
 * `client/README.md`'s three objections to reusing this client as a product.
 * {@link RowStore.prune} is the mechanism, Task 10's rolling window is the
 * policy for cold, and hot is an open question (spec §3.3:73 defers compaction
 * to ~50k ops).
 *
 * # Two schema decisions worth reading
 *
 * **`seq` is a decimal string, and `seq_key` is what it sorts by.** SQLite
 * integers are 64-bit signed and the wire format is a decimal string, so `seq`
 * is stored as text — but plain lexicographic ordering of decimal text puts
 * `"10"` before `"9"`, and no small-N test crosses that boundary. `seq_key` is
 * the seq with its digit count in front (`"0210"` for 10, `"019"` for 9), which
 * makes lexicographic order numeric order for every value, past 2^64 included,
 * and makes the primary key CANONICAL: `"007"` and `"7"` are the same position
 * and must not both be stored.
 *
 * **`blob` is TEXT, holding the base64 exactly as the server sent it.** The
 * chain hashes those bytes. Decoding to a BLOB on write and re-encoding on read
 * inserts a normalisation step between "the bytes that were verified" and "the
 * bytes that are re-verified", to save 25 % of a few megabytes. Not worth it.
 */

import type { SqlDriver, SqlStatement } from "./driver";
import {
  checkRow,
  decodeState,
  emptyClientState,
  encodeState,
  sameRowOrThrow,
  type ClientState,
  type RowStore,
  type SecretStore,
  type Store,
  type WireRow,
  type WireState,
} from "./store";
import type { Stream } from "../wire/blob";
import { parseDecimal } from "../wire/op";

/** The secret store key for the session bearer token. */
export const SECRET_SESSION = "session_token";
/** The secret store key prefix for a writer's Ed25519 private half. */
export const SECRET_WRITER = "writer_key:";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS client_state (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wire_rows (
  stream         TEXT    NOT NULL,
  seq            TEXT    NOT NULL,
  seq_key        TEXT    NOT NULL,
  writer_id      TEXT    NOT NULL,
  writer_counter TEXT    NOT NULL,
  type_flag      TEXT    NOT NULL,
  size_bucket    INTEGER NOT NULL,
  blob_hash      TEXT    NOT NULL,
  prev_hash      TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  blob           TEXT    NOT NULL,
  PRIMARY KEY (stream, seq_key)
);
`;

const COLUMNS = "stream, seq, writer_id, writer_counter, type_flag, size_bucket, blob_hash, prev_hash, created_at, blob";

/**
 * The sort key for a seq: its digit count, then its digits.
 *
 * Two properties, both load-bearing. Lexicographic order over this string is
 * numeric order over the seq (`"019" < "0210"`), and it is canonical, so a
 * seq written with a leading zero cannot occupy a second row at the same
 * position.
 */
export function seqKey(seq: bigint): string {
  const digits = seq.toString(10);
  if (digits.length > 99) throw new Error(`seq ${digits.slice(0, 20)}… has more digits than this schema can order`);
  return `${digits.length.toString(10).padStart(2, "0")}${digits}`;
}

export interface SqliteStoreOptions {
  /** Where the session token and the private keys go. Required — see Step 5. */
  secrets: SecretStore;
  /** The server URL to assume when the database holds no state yet. */
  server?: string;
}

/**
 * A {@link Store} over any {@link SqlDriver} — `bunDriver` in `client/`'s
 * tests, `expoDriver` on the device.
 *
 * The {@link SecretStore} is NOT optional. The session token and the Ed25519
 * private key are the two fields that must never reach the database, and an
 * optional parameter for that is an optional defect: every caller that forgot
 * it would still work, and would still be wrong.
 */
export function sqliteStore(db: SqlDriver, opts: SqliteStoreOptions): Store {
  const { secrets } = opts;
  db.exec(SCHEMA);

  const stmts = {
    readState: db.prepare("SELECT json FROM client_state WHERE id = 1"),
    writeState: db.prepare(
      "INSERT INTO client_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
    ),
    insert: db.prepare(`INSERT INTO wire_rows (${COLUMNS}, seq_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    one: db.prepare(`SELECT ${COLUMNS} FROM wire_rows WHERE stream = ? AND seq_key = ?`),
    range: db.prepare(`SELECT ${COLUMNS} FROM wire_rows WHERE stream = ? AND seq_key > ? ORDER BY seq_key LIMIT ?`),
    count: db.prepare("SELECT count(*) AS n FROM wire_rows WHERE stream = ?"),
    prune: db.prepare("DELETE FROM wire_rows WHERE stream = ? AND seq_key < ?"),
  };

  // Transactions FLATTEN rather than nest. `pull` wraps its whole persist step
  // in `Store.transaction` and `append` opens one of its own, and
  // `expo-sqlite`'s `withTransactionSync` has no savepoint form — so an inner
  // call joins the outer transaction instead of starting a second one.
  let depth = 0;
  const atomic = <T,>(fn: () => T): T => {
    if (depth > 0) return fn();
    return db.transaction(() => {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
      }
    });
  };

  const rows: RowStore = {
    append(stream: Stream, incoming: readonly WireRow[]): void {
      if (incoming.length === 0) return;
      // One transaction per batch: a page of rows lands whole or not at all.
      atomic(() => {
        for (const row of incoming) {
          const seq = checkRow(stream, row);
          const key = seqKey(seq);
          const have = readOne(stmts.one, stream, key);
          if (have !== null) {
            sameRowOrThrow(have, row, seq);
            continue;
          }
          stmts.insert.run(
            stream,
            row.seq,
            row.writer_id,
            row.writer_counter,
            row.type_flag,
            row.size_bucket,
            row.blob_hash,
            row.prev_hash,
            row.created_at,
            row.blob,
            key,
          );
        }
      });
    },
    range(stream: Stream, afterSeq: bigint, limit: number): WireRow[] {
      if (limit <= 0) return [];
      return stmts.range.all(stream, seqKey(afterSeq), limit).map(toWireRow);
    },
    count(stream: Stream): number {
      const got = stmts.count.all(stream) as { n: number }[];
      return got[0]?.n ?? 0;
    },
    prune(stream: Stream, beforeSeq: bigint): void {
      stmts.prune.run(stream, seqKey(beforeSeq));
    },
  };

  return {
    location: db.location,
    load(): ClientState {
      const got = stmts.readState.all() as { json: string }[];
      const json = got[0]?.json;
      if (json === undefined) return emptyClientState(opts.server ?? "");
      const stored = JSON.parse(json) as WireState;
      stored.session_token = secrets.get(SECRET_SESSION);
      for (const [id, k] of Object.entries(stored.writers ?? {})) {
        const d = secrets.get(`${SECRET_WRITER}${id}`);
        // Left ABSENT when the secure store has lost it, so `decodeState`'s
        // existing "writer X has no usable key" check refuses the state. An
        // empty-string placeholder would sign with a key nobody holds.
        if (d !== null) k.d = d;
      }
      const out = decodeState(stored, db.location);
      if (out.server === "" && opts.server !== undefined) out.server = opts.server;
      return out;
    },
    save(state: ClientState): void {
      const w = encodeState(state);
      secrets.set(SECRET_SESSION, w.session_token);
      const public_: Record<string, { x: string }> = {};
      for (const [id, k] of Object.entries(w.writers)) {
        secrets.set(`${SECRET_WRITER}${id}`, k.d ?? null);
        public_[id] = { x: k.x };
      }
      // A writer dropped from the state has its private half dropped too;
      // otherwise a revoked device's key outlives every trace of the device.
      const before = stmts.readState.all() as { json: string }[];
      const priorJSON = before[0]?.json;
      if (priorJSON !== undefined) {
        const prior = JSON.parse(priorJSON) as WireState;
        for (const id of Object.keys(prior.writers ?? {})) {
          if (!(id in public_)) secrets.set(`${SECRET_WRITER}${id}`, null);
        }
      }
      stmts.writeState.run(JSON.stringify({ ...w, session_token: null, writers: public_ }));
    },
    rows: (): RowStore => rows,
    transaction: atomic,
  };
}

function readOne(stmt: SqlStatement, stream: Stream, key: string): WireRow | null {
  const got = stmt.all(stream, key);
  const first = got[0];
  return first === undefined ? null : toWireRow(first);
}

/**
 * A database row back into a {@link WireRow}.
 *
 * Every field is re-validated rather than trusted: this decodes bytes that have
 * been on disk, and `decodeWireRow` downstream would report a type confusion as
 * a protocol error against the SERVER.
 */
function toWireRow(raw: unknown): WireRow {
  const r = raw as Record<string, unknown>;
  const text = (name: string): string => {
    const v = r[name];
    if (typeof v !== "string") throw new Error(`stored row column ${name} is ${typeof v}, want string`);
    return v;
  };
  const seq = text("seq");
  parseDecimal(seq); // a seq that is not a decimal integer never came from us
  const bucket = r["size_bucket"];
  if (typeof bucket !== "number" || !Number.isInteger(bucket)) {
    throw new Error(`stored row column size_bucket is ${String(bucket)}, want an integer`);
  }
  return {
    seq,
    stream: text("stream"),
    writer_id: text("writer_id"),
    writer_counter: text("writer_counter"),
    type_flag: text("type_flag"),
    size_bucket: bucket,
    blob_hash: text("blob_hash"),
    prev_hash: text("prev_hash"),
    created_at: text("created_at"),
    blob: text("blob"),
  };
}
