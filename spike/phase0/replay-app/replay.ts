import * as SQLite from "expo-sqlite";

export type Op = {
  iid: string; posted_at: string; amount: number; currency: string;
  direction: "debit" | "credit"; merchant: string; bucket: string; status: string;
};

export function openDb() {
  const db = SQLite.openDatabaseSync("phase0.db");
  db.execSync(`CREATE TABLE IF NOT EXISTS transactions (
    iid TEXT PRIMARY KEY, posted_at TEXT NOT NULL, amount INTEGER NOT NULL,
    currency TEXT NOT NULL, direction TEXT NOT NULL, merchant TEXT,
    bucket TEXT, status TEXT NOT NULL)`);
  return db;
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
