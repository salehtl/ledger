import type { SqlDriver } from "@ledger/client/store/driver.ts";

export interface ColdBodyIndex {
  get(ingestId: string): bigint | null;
  put(ingestId: string, seq: bigint): void;
  deleteBefore(seq: bigint): void;
}

export const COLD_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS cold_body_index (
  ingest_id TEXT PRIMARY KEY,
  seq       TEXT NOT NULL,
  seq_key   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cold_body_index_seq ON cold_body_index (seq_key);
`;

function seqKey(seq: bigint): string {
  const digits = seq.toString(10);
  if (digits.length > 99) throw new Error("cold body seq is too large to index");
  return `${digits.length.toString().padStart(2, "0")}${digits}`;
}

/** Durable ingest-id → global cold seq index, sharing the app's one connection. */
export function sqliteColdBodyIndex(db: SqlDriver): ColdBodyIndex {
  db.exec(COLD_INDEX_SCHEMA);
  const get = db.prepare("SELECT seq FROM cold_body_index WHERE ingest_id = ?");
  const put = db.prepare(
    "INSERT INTO cold_body_index (ingest_id, seq, seq_key) VALUES (?, ?, ?) " +
      "ON CONFLICT(ingest_id) DO UPDATE SET seq = excluded.seq, seq_key = excluded.seq_key",
  );
  const del = db.prepare("DELETE FROM cold_body_index WHERE seq_key < ?");
  return {
    get(ingestId) {
      const row = get.all(ingestId)[0] as { seq?: unknown } | undefined;
      if (row === undefined) return null;
      if (typeof row.seq !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.seq)) throw new Error("cold body index contains an invalid seq");
      return BigInt(row.seq);
    },
    put(ingestId, seq) {
      put.run(ingestId, seq.toString(), seqKey(seq));
    },
    deleteBefore(seq) {
      del.run(seqKey(seq));
    },
  };
}

export function memoryColdBodyIndex(): ColdBodyIndex {
  const values = new Map<string, bigint>();
  return {
    get: (id) => values.get(id) ?? null,
    put: (id, seq) => void values.set(id, seq),
    deleteBefore: (seq) => {
      for (const [id, at] of values) if (at < seq) values.delete(id);
    },
  };
}
