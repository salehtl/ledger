/**
 * The Insights read, against a real projection.
 *
 * Built on the same shape as `budget.test.ts` and for the same reason: sql.js
 * hands INTEGER columns back as JS `number`s, so "does a total survive past
 * 2^53" is a genuinely different question on this driver than on Bun's, and
 * this screen is the one that *sums* — every figure on it is an aggregate.
 */
import { describe, expect, it } from "vitest";
import { ensureProjection, PROJECTION_VERSION } from "@ledger/client/replay/projection";
import type { SqlDriver } from "@ledger/client/store/driver";
import { openBrowserDriver } from "../db/driver";
import { sqlInsightsSource } from "./insights";

async function blank(): Promise<SqlDriver> {
  const db = await openBrowserDriver(`insights-${crypto.randomUUID()}`);
  ensureProjection(db);
  return db;
}

type AddOpts = {
  amount?: string;
  home?: string | null;
  direction?: string;
  category?: string | null;
  merchant?: string;
  unparsed?: number;
  review?: number;
  posted?: string;
};

async function setup(complete = 1) {
  const db = await blank();
  db.prepare(
    `INSERT INTO projection_meta (id,version,cursor_hot,cursor_cold,home_currency,complete) VALUES (1,${PROJECTION_VERSION},'0','0','AED',${complete})`,
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
        opts.merchant ?? "m",
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

const TREND = ["2026-06", "2026-07", "2026-08"];

describe("sqlInsightsSource", () => {
  // The null-category breakdown row's key is NUL-prefixed so it can never
  // collide with a real `cat:` key. That NUL is spelled `\x00` in insights.ts
  // rather than written as a literal byte (which made git and grep treat the
  // file as binary — see client/src/diag/nul.test.ts). The spelling changed;
  // this pins the VALUE, code point by code point, so it cannot drift with it.
  it("keys the uncategorized breakdown row with a literal U+0000 prefix", async () => {
    const { db, add } = await setup();
    add("u", { home: "70", category: null });
    add("g", { home: "500", category: "groceries" });

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    const uncategorized = got.categories.find((c) => c.category === null);
    expect(uncategorized).toBeDefined();
    expect(uncategorized!.key).toBe("\x00uncategorized");
    expect([...uncategorized!.key].map((c) => c.codePointAt(0))).toEqual([
      0, 117, 110, 99, 97, 116, 101, 103, 111, 114, 105, 122, 101, 100,
    ]);
    // And it is distinct from every real category key, which is the point.
    expect(got.categories.filter((c) => c.key === uncategorized!.key)).toHaveLength(1);
  });

  it("buckets the focus month's confirmed spending and keeps credits as income", async () => {
    const { db, add } = await setup();
    add("g", { home: "500", category: "groceries", posted: "2026-08-02T00:00:00.000Z" });
    add("d", { home: "300", category: "dining", posted: "2026-08-03T00:00:00.000Z" });
    add("u", { home: "70", category: null, posted: "2026-08-04T00:00:00.000Z" });
    add("i", { home: "1000", direction: "credit", category: "salary", posted: "2026-08-05T00:00:00.000Z" });

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    expect(got.usable).toBe(true);
    expect(got.homeCurrency).toBe("AED");
    expect(got.spent).toBe(870n);
    expect(got.income).toBe(1000n);
    expect(got.net).toBe(130n);
    expect(Object.fromEntries(got.buckets.map((b) => [b.bucket, b.spent]))).toEqual({
      need: 500n,
      want: 300n,
      saving: 0n,
      unassigned: 70n,
    });
  });

  it("excludes what the 50/30/20 read excludes: no home rate, in review, unread", async () => {
    const { db, add } = await setup();
    add("ok", { home: "500", category: "groceries" });
    add("norate", { home: null, category: "groceries" });
    add("review", { home: "900", category: "groceries", review: 1 });
    add("unread", { home: null, unparsed: 1, review: 1 });

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    expect(got.spent).toBe(500n);
    expect(got.categories).toHaveLength(1);
  });

  it("keeps a month out of another month's totals", async () => {
    const { db, add } = await setup();
    add("jul", { home: "400", category: "groceries", posted: "2026-07-31T23:00:00.000Z" });
    add("aug", { home: "100", category: "groceries", posted: "2026-08-01T00:00:00.000Z" });

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    expect(got.spent).toBe(100n);
    expect(got.categories[0].prevSpent).toBe(400n);
    expect(got.categories[0].delta).toBe(-300n);
    expect(got.categories[0].deltaPct).toBeCloseTo(-0.75, 6);
    expect(got.hasPrevious).toBe(true);
  });

  it("marks a category with no previous month as new, and one that stopped as gone", async () => {
    const { db, add } = await setup();
    add("old", { home: "400", category: "dining", posted: "2026-07-02T00:00:00.000Z" });
    add("new", { home: "100", category: "groceries", posted: "2026-08-02T00:00:00.000Z" });

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    const byKey = Object.fromEntries(got.categories.map((c) => [c.name, c]));
    expect(byKey["groceries"].isNew).toBe(true);
    expect(byKey["groceries"].deltaPct).toBeNull();
    expect(byKey["dining"].spent).toBe(0n);
    expect(byKey["dining"].isGone).toBe(true);
  });

  it("ranks merchants by spend within the focus month and counts them", async () => {
    const { db, add } = await setup();
    add("a1", { home: "100", merchant: "CARREFOUR", category: "groceries" });
    add("a2", { home: "150", merchant: "CARREFOUR", category: "groceries" });
    add("b1", { home: "900", merchant: "NETFLIX", category: "entertainment" });
    add("old", { home: "9999", merchant: "CARREFOUR", posted: "2026-07-01T00:00:00.000Z", category: "groceries" });

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    expect(got.merchants).toEqual([
      { merchant: "NETFLIX", spent: 900n, count: 1 },
      { merchant: "CARREFOUR", spent: 250n, count: 2 },
    ]);
  });

  it("returns one trend point per requested period, in order, filling gaps with zero", async () => {
    const { db, add } = await setup();
    add("jun", { home: "100", category: "groceries", posted: "2026-06-10T00:00:00.000Z" });
    add("aug", { home: "300", category: "groceries", posted: "2026-08-10T00:00:00.000Z" });
    add("augin", { home: "700", direction: "credit", category: "salary", posted: "2026-08-11T00:00:00.000Z" });

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    expect(got.trend).toEqual([
      { period: "2026-06", label: "Jun", spent: 100n, income: 0n },
      { period: "2026-07", label: "Jul", spent: 0n, income: 0n },
      { period: "2026-08", label: "Aug", spent: 300n, income: 700n },
    ]);
  });

  it("splits land in their own categories, and the parts sum exactly", async () => {
    const { db, add } = await setup();
    add("s", { amount: "3", home: "100", category: "ignored" });
    const put = db.prepare("INSERT INTO txn_split (txn_id,idx,category,amount_minor,amount_home_minor) VALUES (?,?,?,?,?)");
    put.run("s", 0, "groceries", "1", "33");
    put.run("s", 1, "dining", "1", "33");
    put.run("s", 2, "savings", "1", "34");

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    expect(got.spent).toBe(100n);
    expect(Object.fromEntries(got.buckets.map((b) => [b.bucket, b.spent]))).toEqual({
      need: 33n,
      want: 33n,
      saving: 34n,
      unassigned: 0n,
    });
    expect(got.categories.map((c) => c.name)).not.toContain("ignored");
  });

  it("is exact past 2^53, where a JS number is not", async () => {
    const { db, add } = await setup();
    // 9007199254740993 = 2^53 + 1: the first integer a double cannot hold.
    add("huge", { amount: "9007199254740993", home: "9007199254740993", category: "groceries" });
    add("one", { home: "1", category: "groceries" });

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    expect(got.spent).toBe(9007199254740994n);
    expect(got.categories[0].spent).toBe(9007199254740994n);
    expect(got.trend[2].spent).toBe(9007199254740994n);
    expect(got.merchants[0].spent).toBe(9007199254740994n);
  });

  it("reports a rebuilding projection as unusable rather than as a set of zeros", async () => {
    const { db, add } = await setup(0);
    add("g", { home: "500", category: "groceries" });

    const got = sqlInsightsSource(db).read("2026-08", TREND);
    expect(got.usable).toBe(false);
    expect(got.spent).toBe(0n);
    expect(got.categories).toEqual([]);
    expect(got.trend).toEqual([]);
  });

  it("has no savings rate without income to divide by", async () => {
    const { db, add } = await setup();
    add("g", { home: "500", category: "groceries" });
    expect(sqlInsightsSource(db).read("2026-08", TREND).savingsRate).toBeNull();
  });

  // --- drill -------------------------------------------------------------
  //
  // Every case here exists because summing the *listed rows* instead got it
  // wrong: the figure under a breakdown row has to be the figure on it.

  it("matches a merchant exactly, so a LIKE-alike is not counted into the total", async () => {
    const { db, add } = await setup();
    add("a", { home: "100", merchant: "CARREFOUR", category: "groceries" });
    add("b", { home: "900", merchant: "CARREFOUR MARKET", category: "groceries" });

    const got = sqlInsightsSource(db).drill("2026-08", { type: "merchant", merchant: "CARREFOUR", name: "CARREFOUR" }, 50);
    expect(got.total).toBe(100n);
    expect(got.matches).toBe(1);
    expect(got.rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("counts only the split PART that belongs to the category drilled into", async () => {
    const { db, add } = await setup();
    add("s", { amount: "3", home: "100", category: "ignored" });
    const put = db.prepare("INSERT INTO txn_split (txn_id,idx,category,amount_minor,amount_home_minor) VALUES (?,?,?,?,?)");
    put.run("s", 0, "groceries", "1", "33");
    put.run("s", 1, "dining", "1", "67");

    const got = sqlInsightsSource(db).drill("2026-08", { type: "category", category: "groceries", name: "groceries" }, 50);
    // 33, not the transaction's whole 100 — and the row is still listed, which
    // is why `hasSplit` exists for the sheet to say so.
    expect(got.total).toBe(33n);
    expect(got.rows.map((r) => r.id)).toEqual(["s"]);
    expect(got.hasSplit).toBe(true);
  });

  it("agrees with the breakdown row it came from, bucket by bucket", async () => {
    const { db, add } = await setup();
    add("g", { home: "500", category: "groceries" });
    add("d", { home: "300", category: "dining" });
    add("u", { home: "70", category: null });
    add("x", { home: "20", category: "not-a-known-category" });

    const src = sqlInsightsSource(db);
    const snap = src.read("2026-08", TREND);
    for (const b of snap.buckets) {
      const got = src.drill("2026-08", { type: "bucket", bucket: b.bucket, name: b.bucket }, 50);
      expect(got.total).toBe(b.spent);
    }
    // The remainder bucket takes both the uncategorized row and the one whose
    // category the mapping does not name.
    expect(src.drill("2026-08", { type: "bucket", bucket: "unassigned", name: "u" }, 50).matches).toBe(2);
  });

  it("finds the uncategorized rows for a null-category drill", async () => {
    const { db, add } = await setup();
    add("u", { home: "70", category: null });
    add("g", { home: "500", category: "groceries" });

    const got = sqlInsightsSource(db).drill("2026-08", { type: "category", category: null, name: "Uncategorized" }, 50);
    expect(got.total).toBe(70n);
    expect(got.rows.map((r) => r.id)).toEqual(["u"]);
  });

  it("caps the list but not the total, and says which happened", async () => {
    const { db, add } = await setup();
    for (let i = 0; i < 5; i++) add(`r${i}`, { home: "100", category: "groceries", posted: `2026-08-0${i + 1}T00:00:00.000Z` });

    const got = sqlInsightsSource(db).drill("2026-08", { type: "category", category: "groceries", name: "groceries" }, 2);
    expect(got.rows).toHaveLength(2);
    expect(got.matches).toBe(5);
    expect(got.truncated).toBe(true);
    // The whole month, not the two rows shown.
    expect(got.total).toBe(500n);
    // Newest first.
    expect(got.rows.map((r) => r.id)).toEqual(["r4", "r3"]);
  });

  it("keeps a drilled total exact past 2^53", async () => {
    const { db, add } = await setup();
    add("huge", { amount: "9007199254740993", home: "9007199254740993", category: "groceries" });
    const got = sqlInsightsSource(db).drill("2026-08", { type: "category", category: "groceries", name: "groceries" }, 50);
    expect(got.total).toBe(9007199254740993n);
  });

  it("drills nothing from an unusable projection rather than a partial list", async () => {
    const { db, add } = await setup(0);
    add("g", { home: "500", category: "groceries" });
    const got = sqlInsightsSource(db).drill("2026-08", { type: "category", category: "groceries", name: "g" }, 50);
    expect(got).toEqual({ rows: [], matches: 0, total: 0n, truncated: false, hasSplit: false });
  });

  it("computes the savings rate as a ratio, from bigint money", async () => {
    const { db, add } = await setup();
    add("g", { home: "2500", category: "groceries" });
    add("i", { home: "10000", direction: "credit", category: "salary" });
    expect(sqlInsightsSource(db).read("2026-08", TREND).savingsRate).toBeCloseTo(0.75, 6);
  });

  it("carries the user's plan, and the rule when there is none", async () => {
    const { db, add } = await setup();
    add("g", { home: "500", category: "groceries" });
    // Backwards compatibility first: no `budget_split_set` op, no change.
    expect(sqlInsightsSource(db).read("2026-08", TREND).split).toEqual({ need: 50, want: 30, saving: 20 });
    db.prepare("INSERT INTO budget_split (id,need,want,saving) VALUES (1,60,20,20)").run();
    const got = sqlInsightsSource(db).read("2026-08", TREND);
    expect(got.split).toEqual({ need: 60, want: 20, saving: 20 });
    // The plan is a label, never a filter: the money is unchanged.
    expect(got.buckets.find((b) => b.bucket === "need")?.spent).toBe(500n);
  });
});
