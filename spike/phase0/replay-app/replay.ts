import * as SQLite from "expo-sqlite";

export type Op = {
  iid: string; posted_at: string; amount: number; currency: string;
  direction: "debit" | "credit"; merchant: string; bucket: string; status: string;
};

const DB_NAME = "phase0.db";

// Single native SQLite connection for the app's lifetime, held here so
// coldRestore(), the warm-start effect, and the Reset DB button in App.tsx
// all share it instead of each `SQLite.openDatabaseSync` call opening its
// own native connection and never closing it. `openDatabaseSync` has no
// connection cache/registry of its own (confirmed by reading
// expo-sqlite's source) and nothing auto-closes a connection when its JS
// wrapper is garbage collected — every un-closed call site was leaking a
// live native connection per press, which is off-JS-heap memory that no
// amount of chunking/GC on the JS side can reclaim. `db` is reassigned,
// never duplicated, so at most one native connection is ever live.
let db: SQLite.SQLiteDatabase | null = null;

function ensureSchema(handle: SQLite.SQLiteDatabase) {
  handle.execSync(`CREATE TABLE IF NOT EXISTS transactions (
    iid TEXT PRIMARY KEY, posted_at TEXT NOT NULL, amount INTEGER NOT NULL,
    currency TEXT NOT NULL, direction TEXT NOT NULL, merchant TEXT,
    bucket TEXT, status TEXT NOT NULL)`);
}

// Returns the shared connection, opening it (once) the first time it's
// needed and reusing it on every later call. Use this when you just need
// "the database" without forcing a fresh open — the warm-start effect and
// the Reset DB button both want this: neither is measuring a cold-restore
// database-open cost, and reusing the connection is exactly what avoids
// the leak.
export function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync(DB_NAME);
    ensureSchema(db);
  }
  return db;
}

// Closes any existing shared connection and opens a genuinely fresh one in
// its place. Cold restore calls this so every press pays a real
// connection-open cost — dbOpenMs stays meaningful on every run, not just
// the first — while still never leaking: the old handle is always closed
// before the new one replaces it in the module-level `db` reference.
//
// Null `db` BEFORE calling closeSync(), not after. If closeSync() throws
// (SQLITE_BUSY, or any other native error) while `db` still points at the
// old handle, every later reopenDb() call would re-enter this branch and
// throw at the same line forever — the instrument would be wedged until
// force-quit, which is exactly the "can't complete the 4-press protocol"
// failure this function exists to fix. By nulling first, a throw here still
// propagates to the caller (it is not swallowed — a close failure is a real
// problem worth surfacing), but `db` is already null when it does, so the
// *next* reopenDb()/getDb() call opens a clean new connection instead of
// retrying the same broken close.
export function reopenDb(): SQLite.SQLiteDatabase {
  if (db) {
    const old = db;
    db = null;
    old.closeSync();
  }
  return getDb();
}

export function resetDb(db: SQLite.SQLiteDatabase) {
  db.execSync("DELETE FROM transactions");
}

export function insertOps(db: SQLite.SQLiteDatabase, ops: Op[]) {
  const stmt = db.prepareSync(
    "INSERT OR REPLACE INTO transactions (iid, posted_at, amount, currency, direction, merchant, bucket, status) VALUES (?,?,?,?,?,?,?,?)");
  try {
    db.withTransactionSync(() => {
      for (const o of ops) {
        stmt.executeSync([o.iid, o.posted_at, o.amount, o.currency, o.direction, o.merchant, o.bucket, o.status]);
      }
    });
  } finally {
    stmt.finalizeSync();
  }
}

export function bucketDebits(db: SQLite.SQLiteDatabase): Record<string, Record<string, number>> {
  const rows = db.getAllSync<{ month: string; bucket: string; total: number }>(`
    SELECT substr(posted_at,1,7) AS month,
           CASE WHEN bucket='' THEN 'uncategorized' ELSE bucket END AS bucket,
           SUM(amount) AS total
    FROM transactions
    WHERE direction='debit' AND status='confirmed'
    GROUP BY 1,2`);
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.month] ??= {})[r.bucket] = r.total;
  return out;
}
