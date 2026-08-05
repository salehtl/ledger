import { describe, expect, test } from "bun:test";
import { bunDriver } from "@ledger/client/store/driver.ts";
import type { SqlDriver } from "@ledger/client/store/driver.ts";
import { ensureProjection } from "@ledger/client/replay/projection.ts";
import { DEFAULT_BUDGET_MAPPING, sqlBudgetSource, type BudgetMapping } from "./source.ts";

function setup() {
  const db = bunDriver(":memory:"); ensureProjection(db);
  db.prepare("INSERT INTO projection_meta (id,version,cursor_hot,cursor_cold,home_currency,complete) VALUES (1,1,'0','0','AED',1)").run();
  const add = (id: string, opts: { amount?: string; home?: string | null; direction?: string; category?: string | null; unparsed?: number; review?: number; posted?: string } = {}) => db.prepare(`INSERT INTO txn
    (id,ingest_id,amount_minor,currency,direction,posted_at,merchant_raw,last4,category,needs_review,provenance,amount_home_minor,unparsed,tier,parse_error,superseded_by,possible_duplicate_of,version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(id, id.padEnd(64, "a"), opts.amount ?? "100", opts.unparsed ? "" : "AED", opts.direction ?? (opts.unparsed ? "" : "debit"), opts.posted ?? "2026-08-01T00:00:00.000Z", "m", "", opts.category ?? null, opts.review ?? 0, "ingest", opts.home === undefined ? "100" : opts.home, opts.unparsed ?? 0, opts.unparsed ? "none" : "template", opts.unparsed ? "no_match" : null, null, null);
  return { db, add };
}

describe("sqlBudgetSource", () => {
  test("aggregates confirmed live unsplit spending and keeps credits as income context", () => {
    const { db, add } = setup(); add("g", { home: "500", category: "groceries" }); add("w", { home: "300", category: "unknown" }); add("i", { home: "1000", direction: "credit", category: "salary" });
    const got = sqlBudgetSource(db).read(Date.parse("2026-08-03T00:00:00Z"));
    expect(got.buckets).toEqual({ need: 500n, want: 0n, saving: 0n }); expect(got.unassigned).toBe(300n); expect(got.income).toBe(1000n);
  });

  test("allocates frozen home money across split categories exactly with deterministic remainder", () => {
    const { db, add } = setup(); add("s", { amount: "3", home: "100", category: "ignored" });
    const put = db.prepare("INSERT INTO txn_split (txn_id,idx,category,amount_minor,amount_home_minor) VALUES (?,?,?,?,?)");
    put.run("s", 0, "groceries", "1", "33"); put.run("s", 1, "dining", "1", "33"); put.run("s", 2, "savings", "1", "34");
    const got = sqlBudgetSource(db).read(Date.parse("2026-08-20T00:00:00Z"));
    expect(got.buckets).toEqual({ need: 33n, want: 33n, saving: 34n });
    expect(got.buckets.need + got.buckets.want + got.buckets.saving).toBe(100n);
  });

  test("uses an explicit replaceable category mapping and fallback", () => {
    const { db, add } = setup(); add("a", { category: "custom" }); add("b", { category: "unknown" });
    const mapping: BudgetMapping = { categories: { custom: "saving" }, fallback: "need" };
    expect(sqlBudgetSource(db, mapping).read(Date.parse("2026-08-20T00:00:00Z")).buckets).toEqual({ need: 100n, want: 0n, saving: 100n });
    expect(DEFAULT_BUDGET_MAPPING.fallback).toBeNull();
  });

  test("counts missing-home and unread exclusions and warms until 14 days or 10 confirmed rows", () => {
    const { db, add } = setup(); add("missing", { home: null }); add("raw", { home: null, unparsed: 1, review: 1 });
    let got = sqlBudgetSource(db).read(Date.parse("2026-08-10T00:00:00Z"));
    expect(got.excluded).toEqual({ missingHomeRate: 1, unparsed: 1, unresolvedDuplicates: 0, sameDuplicates: 0 }); expect(got.warming).toBe(true);
    for (let i = 0; i < 9; i++) add(`t${i}`);
    got = sqlBudgetSource(db).read(Date.parse("2026-08-10T00:00:00Z")); expect(got.confirmedTransactions).toBe(10); expect(got.warming).toBe(false);
    const older = setup(); older.add("old", { posted: "2026-07-20T00:00:00.000Z" });
    expect(sqlBudgetSource(older.db).read(Date.parse("2026-08-03T00:00:00Z")).warming).toBe(false);
  });

  test("excludes review rows and superseded rows from every money aggregate", () => {
    const { db, add } = setup(); add("review", { home: "900", category: "groceries", review: 1 }); add("dead", { home: "700", category: "groceries" });
    db.prepare("UPDATE txn SET superseded_by='op-new' WHERE id='dead'").run();
    expect(sqlBudgetSource(db).read(Date.parse("2026-08-20T00:00:00Z")).buckets).toEqual({ need: 0n, want: 0n, saving: 0n });
  });

  test("keeps grouped int64 money exact above 2^53", () => { const { db, add } = setup(); add("a", { home: "4503599627370496", category: "groceries" }); add("b", { home: "4503599627370497", category: "groceries" }); const got = sqlBudgetSource(db).read(Date.now()); expect(got.buckets.need).toBe(9007199254740993n); });

  test("keeps a grouped aggregate exact at signed int64 max", () => { const { db, add } = setup(); add("a", { home: "9223372036854775800", category: "groceries" }); add("b", { home: "7", category: "groceries" }); expect(sqlBudgetSource(db).read(Date.now()).buckets.need).toBe(9223372036854775807n); });

  test("duplicate disposition controls confirmed spending durably", () => { const { db, add } = setup(); add("base", { home: "100", category: "groceries" }); add("flagged", { home: "100", category: "groceries" }); db.prepare("UPDATE txn SET possible_duplicate_of='base' WHERE id='flagged'").run(); let got = sqlBudgetSource(db).read(Date.now()); expect(got.buckets.need).toBe(100n); expect(got.excluded.unresolvedDuplicates).toBe(1); db.prepare("UPDATE txn SET duplicate_disposition='same' WHERE id='flagged'").run(); got = sqlBudgetSource(db).read(Date.now()); expect(got.buckets.need).toBe(100n); expect(got.excluded.sameDuplicates).toBe(1); db.prepare("UPDATE txn SET duplicate_disposition='different' WHERE id='flagged'").run(); expect(sqlBudgetSource(db).read(Date.now()).buckets.need).toBe(200n); db.prepare("UPDATE txn SET duplicate_disposition=NULL WHERE id='flagged'").run(); expect(sqlBudgetSource(db).read(Date.now()).buckets.need).toBe(100n); });

  test("the native bridge receives grouped totals, not every split part", () => {
    const { db, add } = setup(); add("many", { amount: "500", home: "500" });
    const put = db.prepare("INSERT INTO txn_split (txn_id,idx,category,amount_minor,amount_home_minor) VALUES (?,?,?,?,?)");
    for (let i = 0; i < 500; i++) put.run("many", i, "groceries", "1", "1");
    let aggregateRows = -1;
    const measured: SqlDriver = {
      location: db.location,
      exec: (sql) => db.exec(sql),
      prepare(sql) { const statement = db.prepare(sql); return { run: (...args) => statement.run(...args), all: (...args) => { const rows = statement.all(...args); if (sql.includes("WITH parts AS")) aggregateRows = rows.length; return rows; } }; },
      transaction: (fn) => db.transaction(fn),
      close: () => db.close(),
    };
    expect(sqlBudgetSource(measured).read(Date.now()).buckets.need).toBe(500n);
    expect(aggregateRows).toBe(1);
  });
});
