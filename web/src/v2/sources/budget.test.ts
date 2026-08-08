/**
 * A port of `app/src/screens/budget/source.test.ts`, assertion for assertion.
 *
 * Two things changed and nothing else: `bun:test` became `vitest`, and
 * `bunDriver(":memory:")` became the browser driver this app actually ships —
 * sql.js over the jsdom in-memory fallback. The second substitution is the
 * point of re-running these here rather than trusting the native run: sql.js
 * hands INTEGER columns back as JS `number`s, so the exact-past-2^53 cases
 * below are a genuinely different question on this driver than on Bun's.
 */
import { describe, expect, it } from "vitest";
import { ensureProjection, PROJECTION_VERSION } from "@ledger/client/replay/projection";
import type { SqlDriver } from "@ledger/client/store/driver";
import { openBrowserDriver } from "../db/driver";
import {
  DEFAULT_BUDGET_MAPPING,
  DEFAULT_BUDGET_SPLIT,
  budgetSplitOps,
  splitSum,
  sqlBudgetSource,
  type BudgetMapping,
} from "./budget";

async function blank(): Promise<SqlDriver> {
  const db = await openBrowserDriver(`budget-${crypto.randomUUID()}`);
  ensureProjection(db);
  return db;
}

type AddOpts = {
  amount?: string;
  home?: string | null;
  direction?: string;
  category?: string | null;
  unparsed?: number;
  review?: number;
  posted?: string;
};

async function setup() {
  const db = await blank();
  // `version` MUST be the live PROJECTION_VERSION, not a hardcoded literal: a
  // stale literal here would silently pass every test above `projectionIsUsable`'s
  // gate whether or not that gate actually fires — see the "refuses to read a
  // stale-version projection" test below for the case that gate exists for.
  db.prepare(
    `INSERT INTO projection_meta (id,version,cursor_hot,cursor_cold,home_currency,complete) VALUES (1,${PROJECTION_VERSION},'0','0','AED',1)`,
  ).run();
  const add = (id: string, opts: AddOpts = {}) =>
    db
      .prepare(
        `INSERT INTO txn
    (id,ingest_id,amount_minor,currency,direction,posted_at,merchant_raw,last4,category,needs_review,provenance,amount_home_minor,unparsed,tier,parse_error,superseded_by,possible_duplicate_of,version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      )
      .run(
        id,
        id.padEnd(64, "a"),
        opts.amount ?? "100",
        opts.unparsed ? "" : "AED",
        opts.direction ?? (opts.unparsed ? "" : "debit"),
        opts.posted ?? "2026-08-01T00:00:00.000Z",
        "m",
        "",
        opts.category ?? null,
        opts.review ?? 0,
        "ingest",
        opts.home === undefined ? "100" : opts.home,
        opts.unparsed ?? 0,
        opts.unparsed ? "none" : "template",
        opts.unparsed ? "no_match" : null,
        null,
        null,
      );
  return { db, add };
}

describe("sqlBudgetSource", () => {
  it("aggregates confirmed live unsplit spending and keeps credits as income context", async () => {
    const { db, add } = await setup();
    add("g", { home: "500", category: "groceries" });
    add("w", { home: "300", category: "unknown" });
    add("i", { home: "1000", direction: "credit", category: "salary" });
    const got = sqlBudgetSource(db).read(Date.parse("2026-08-03T00:00:00Z"));
    expect(got.buckets).toEqual({ need: 500n, want: 0n, saving: 0n });
    expect(got.unassigned).toBe(300n);
    expect(got.income).toBe(1000n);
  });

  it("allocates frozen home money across split categories exactly with deterministic remainder", async () => {
    const { db, add } = await setup();
    add("s", { amount: "3", home: "100", category: "ignored" });
    const put = db.prepare("INSERT INTO txn_split (txn_id,idx,category,amount_minor,amount_home_minor) VALUES (?,?,?,?,?)");
    put.run("s", 0, "groceries", "1", "33");
    put.run("s", 1, "dining", "1", "33");
    put.run("s", 2, "savings", "1", "34");
    const got = sqlBudgetSource(db).read(Date.parse("2026-08-20T00:00:00Z"));
    expect(got.buckets).toEqual({ need: 33n, want: 33n, saving: 34n });
    expect(got.buckets.need + got.buckets.want + got.buckets.saving).toBe(100n);
  });

  it("uses an explicit replaceable category mapping and fallback", async () => {
    const { db, add } = await setup();
    add("a", { category: "custom" });
    add("b", { category: "unknown" });
    const mapping: BudgetMapping = { categories: { custom: "saving" }, fallback: "need" };
    expect(sqlBudgetSource(db, mapping).read(Date.parse("2026-08-20T00:00:00Z")).buckets).toEqual({
      need: 100n,
      want: 0n,
      saving: 100n,
    });
    expect(DEFAULT_BUDGET_MAPPING.fallback).toBeNull();
  });

  it("counts missing-home and unread exclusions and warms until 14 days or 10 confirmed rows", async () => {
    const { db, add } = await setup();
    add("missing", { home: null });
    add("raw", { home: null, unparsed: 1, review: 1 });
    let got = sqlBudgetSource(db).read(Date.parse("2026-08-10T00:00:00Z"));
    expect(got.excluded).toEqual({ missingHomeRate: 1, unparsed: 1, unresolvedDuplicates: 0, sameDuplicates: 0 });
    expect(got.warming).toBe(true);
    for (let i = 0; i < 9; i++) add(`t${i}`);
    got = sqlBudgetSource(db).read(Date.parse("2026-08-10T00:00:00Z"));
    expect(got.confirmedTransactions).toBe(10);
    expect(got.warming).toBe(false);

    const older = await setup();
    older.add("old", { posted: "2026-07-20T00:00:00.000Z" });
    expect(sqlBudgetSource(older.db).read(Date.parse("2026-08-03T00:00:00Z")).warming).toBe(false);
  });

  it("excludes review rows and superseded rows from every money aggregate", async () => {
    const { db, add } = await setup();
    add("review", { home: "900", category: "groceries", review: 1 });
    add("dead", { home: "700", category: "groceries" });
    db.prepare("UPDATE txn SET superseded_by='op-new' WHERE id='dead'").run();
    expect(sqlBudgetSource(db).read(Date.parse("2026-08-20T00:00:00Z")).buckets).toEqual({ need: 0n, want: 0n, saving: 0n });
  });

  it("keeps grouped int64 money exact above 2^53", async () => {
    const { db, add } = await setup();
    add("a", { home: "4503599627370496", category: "groceries" });
    add("b", { home: "4503599627370497", category: "groceries" });
    expect(sqlBudgetSource(db).read(Date.now()).buckets.need).toBe(9007199254740993n);
  });

  it("keeps a grouped aggregate exact at signed int64 max", async () => {
    const { db, add } = await setup();
    add("a", { home: "9223372036854775800", category: "groceries" });
    add("b", { home: "7", category: "groceries" });
    expect(sqlBudgetSource(db).read(Date.now()).buckets.need).toBe(9223372036854775807n);
  });

  it("duplicate disposition controls confirmed spending durably", async () => {
    const { db, add } = await setup();
    add("base", { home: "100", category: "groceries" });
    add("flagged", { home: "100", category: "groceries" });
    db.prepare("UPDATE txn SET possible_duplicate_of='base' WHERE id='flagged'").run();
    let got = sqlBudgetSource(db).read(Date.now());
    expect(got.buckets.need).toBe(100n);
    expect(got.excluded.unresolvedDuplicates).toBe(1);
    db.prepare("UPDATE txn SET duplicate_disposition='same' WHERE id='flagged'").run();
    got = sqlBudgetSource(db).read(Date.now());
    expect(got.buckets.need).toBe(100n);
    expect(got.excluded.sameDuplicates).toBe(1);
    db.prepare("UPDATE txn SET duplicate_disposition='different' WHERE id='flagged'").run();
    expect(sqlBudgetSource(db).read(Date.now()).buckets.need).toBe(200n);
    db.prepare("UPDATE txn SET duplicate_disposition=NULL WHERE id='flagged'").run();
    expect(sqlBudgetSource(db).read(Date.now()).buckets.need).toBe(100n);
  });

  it("reads grouped totals, not every split part", async () => {
    const { db, add } = await setup();
    add("many", { amount: "500", home: "500" });
    const put = db.prepare("INSERT INTO txn_split (txn_id,idx,category,amount_minor,amount_home_minor) VALUES (?,?,?,?,?)");
    for (let i = 0; i < 500; i++) put.run("many", i, "groceries", "1", "1");
    let aggregateRows = -1;
    const measured: SqlDriver = {
      location: db.location,
      exec: (sql) => db.exec(sql),
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          run: (...args) => statement.run(...args),
          all: (...args) => {
            const rows = statement.all(...args);
            if (sql.includes("WITH parts AS")) aggregateRows = rows.length;
            return rows;
          },
        };
      },
      transaction: (fn) => db.transaction(fn),
      close: () => db.close(),
    };
    expect(sqlBudgetSource(measured).read(Date.now()).buckets.need).toBe(500n);
    expect(aggregateRows).toBe(1);
  });

  it("a usable projection reports usable: true and a real snapshot", async () => {
    const { db, add } = await setup();
    add("g", { home: "500", category: "groceries" });
    const got = sqlBudgetSource(db).read(Date.now());
    expect(got.usable).toBe(true);
    expect(got.buckets.need).toBe(500n);
  });

  it("refuses to read a stale-version projection rather than showing zeros as fact", async () => {
    const { db, add } = await setup();
    add("g", { home: "100000", category: "groceries" });
    const put = db.prepare("INSERT INTO txn_split (txn_id,idx,category,amount_minor,amount_home_minor) VALUES (?,?,?,?,?)");
    put.run("g", 0, "groceries", "100000", "100000");
    db.prepare("UPDATE projection_meta SET version = ? WHERE id = 1").run(PROJECTION_VERSION - 1);

    const got = sqlBudgetSource(db).read(Date.now());
    expect(got.usable).toBe(false);
    expect(got.buckets).toEqual({ need: 0n, want: 0n, saving: 0n });
    expect(got.income).toBe(0n);
    expect(got.unassigned).toBe(0n);
    expect(got.confirmedTransactions).toBe(0);
    expect(got.excluded).toEqual({ missingHomeRate: 0, unparsed: 0, unresolvedDuplicates: 0, sameDuplicates: 0 });
    // The home currency is still known — an unusable projection is a "come back
    // in a moment" state, not amnesia about what currency the user set.
    expect(got.homeCurrency).toBe("AED");
  });

  it("refuses to read an incomplete projection (complete=0) rather than presenting a partial log as the 50/30/20", async () => {
    const { db, add } = await setup();
    add("g", { home: "500", category: "groceries" });
    db.prepare("UPDATE projection_meta SET complete = 0 WHERE id = 1").run();
    const got = sqlBudgetSource(db).read(Date.now());
    expect(got.usable).toBe(false);
    expect(got.buckets.need).toBe(0n);
  });

  it("an unusable projection with no meta row at all still reports usable: false, not a throw", async () => {
    const db = await blank();
    const got = sqlBudgetSource(db).read(Date.now());
    expect(got.usable).toBe(false);
    expect(got.homeCurrency).toBeNull();
    expect(got.buckets).toEqual({ need: 0n, want: 0n, saving: 0n });
  });
});

/**
 * The plan the user chose.
 *
 * The FIRST test is the backwards-compatibility guarantee, and it is first
 * deliberately: an account with no `budget_split_set` op must produce byte-
 * identical maths to the build that predates the op, or the schema-v3 upgrade is
 * not a no-op for data.
 */
describe("the budget split", () => {
  it("with NO budget_split_set op, the maths is identical to the build that predates it", async () => {
    const { db, add } = await setup();
    add("g", { home: "500", category: "groceries" });
    add("d", { home: "300", category: "dining" });
    add("s", { home: "200", category: "savings" });
    add("u", { home: "70", category: "unknown" });
    add("i", { home: "1000", direction: "credit", category: "salary" });

    // The explicit mapping is what every caller got before this change; the
    // implicit one is what they get now. Compared as whole snapshots so a field
    // that started reading configuration cannot slip past a spot check.
    const before = sqlBudgetSource(db, DEFAULT_BUDGET_MAPPING).read(Date.parse("2026-08-20T00:00:00Z"));
    const after = sqlBudgetSource(db).read(Date.parse("2026-08-20T00:00:00Z"));
    const { split: _s, ...afterRest } = after;
    const { split: _b, ...beforeRest } = before;
    expect(afterRest).toEqual(beforeRest);
    expect(afterRest.buckets).toEqual({ need: 500n, want: 300n, saving: 200n });
    expect(afterRest.unassigned).toBe(70n);

    // And the split reads as the rule it has always been.
    expect(after.split).toEqual(DEFAULT_BUDGET_SPLIT);
    expect(DEFAULT_BUDGET_SPLIT).toEqual({ need: 50, want: 30, saving: 20 });
  });

  it("carries the split the log holds, not the default", async () => {
    const { db, add } = await setup();
    add("g", { home: "500", category: "groceries" });
    db.prepare("INSERT INTO budget_split (id,need,want,saving) VALUES (1,60,20,20)").run();
    const got = sqlBudgetSource(db).read(Date.parse("2026-08-20T00:00:00Z"));
    expect(got.split).toEqual({ need: 60, want: 20, saving: 20 });
    // The plan changes what the buckets MEAN, never what is in them: the money
    // is still the sum of what happened.
    expect(got.buckets).toEqual({ need: 500n, want: 0n, saving: 0n });
  });

  it("an unusable projection reports the default rather than a half-read plan", async () => {
    const db = await blank();
    expect(sqlBudgetSource(db).read(Date.now()).split).toEqual(DEFAULT_BUDGET_SPLIT);
  });
});

describe("splitSum", () => {
  it("names the sum so a screen can say it BEFORE the user saves", () => {
    expect(splitSum({ need: 60, want: 30, saving: 20 })).toBe(110);
    expect(splitSum({ need: 60, want: 20, saving: 20 })).toBe(100);
  });
});

describe("budgetSplitOps", () => {
  it("authors one parent-free op with the percentages exactly as typed", () => {
    // No `v` here on purpose: `Client.buildAuthoredOp` stamps each type's own
    // minimum (3, for this one), and a spec that carried its own would be a
    // second place for the floor to be wrong.
    expect(budgetSplitOps({ need: 60, want: 20, saving: 20 })).toEqual([
      { type: "budget_split_set", payload: { need: 60, want: 20, saving: 20 } },
    ]);
  });

  it("refuses a split that does not sum to 100 rather than normalising it", () => {
    // Silently rewriting 60/30/20 to 55/27/18 is a change to the user's plan
    // that nothing told them about. The fold refuses it as an `invalid_payload`
    // anomaly; the author refuses to write it in the first place.
    expect(() => budgetSplitOps({ need: 60, want: 30, saving: 20 })).toThrow(/100/);
    expect(() => budgetSplitOps({ need: 33.5, want: 46.5, saving: 20 })).toThrow(/whole/);
  });
});
