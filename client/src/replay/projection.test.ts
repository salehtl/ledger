import { afterEach, expect, test } from "bun:test";

import {
  PROJECTION_VERSION,
  ProjectionCancelled,
  ensureProjection,
  project,
  projectionIsUsable,
  readAnomalies,
  readForks,
  readMeta,
  readRates,
  readRateUpdatedAt,
  readRules,
  readTxns,
} from "./projection";
import { fold, type LogEntry } from "./replay";
import { emptyState, type State, type Txn } from "./state";
import { bunDriver } from "../store/driver";
import type { SqlDriver } from "../store/driver";
import type { Op, OpType } from "../wire/op";

// ---------------------------------------------------------------------------
// Fixtures
//
// The log below is HOSTILE ON PURPOSE, in the way `frontend/harness/seed.mjs`
// taught: no two transactions agree on any field, one amount is past 2^53, one
// row is unparsed, one currency has no rate, one rate is explicitly unset, and
// the splits differ in LENGTH as well as in content. A fixture whose rows agree
// cannot tell a correct projection from one that writes a constant, and a
// fixture with one of anything cannot tell correct grouping from no grouping.
// ---------------------------------------------------------------------------

const drivers: SqlDriver[] = [];

function db(): SqlDriver {
  const d = bunDriver(":memory:");
  drivers.push(d);
  return d;
}

afterEach(() => {
  for (const d of drivers.splice(0)) d.close();
});

const ingestID = (name: string): string => new Bun.CryptoHasher("sha256").update(name).digest("hex");

let opCounter = 0;

function op(type: OpType, writer: string, rest: Partial<Op> & { payload: unknown }, authoredAt: string): LogEntry {
  return {
    writer_id: writer,
    seq: 0n, // replaced by `log()`
    op: { v: 1, type, op_id: `op-${++opCounter}`, authored_at: authoredAt, parent_version: null, ...rest },
  };
}

/** Numbers the entries 1..n so the fold's ordering guard is satisfied. */
function log(entries: LogEntry[]): LogEntry[] {
  return entries.map((e, i) => ({ ...e, seq: BigInt(i + 1) }));
}

function ingested(
  name: string,
  id: string,
  payload: Record<string, unknown>,
  writer = "ingest",
  authoredAt = "2026-06-05T09:00:05Z",
): LogEntry {
  return op("txn_ingested", writer, { entity: { kind: "txn", id }, ingest_id: ingestID(name), payload }, authoredAt);
}

/** The full fixture state: four transactions, two rules, three rates, a fork, anomalies. */
function fixture(): State {
  opCounter = 0;
  return fold(
    log([
      op("home_currency_set", "dev-a", { payload: { currency: "AED" } }, "2026-06-01T00:00:00Z"),
      op("rate_set", "dev-a", { payload: { currency: "USD", rate_micro: "3672500" } }, "2026-06-01T00:01:00Z"),
      op("rate_set", "dev-a", { payload: { currency: "JPY", rate_micro: "24500" } }, "2026-06-01T00:02:00Z"),
      op("rate_unset", "dev-a", { payload: { currency: "JPY" } }, "2026-06-01T00:03:00Z"),

      // t1 — AED, debit, categorized, two splits, low-value, template tier.
      ingested("m1", "t1", {
        amount_minor: "25000",
        currency: "AED",
        direction: "debit",
        posted_at: "2026-06-05T09:00:00Z",
        merchant_raw: "CARREFOUR HYPERMARKET",
        last4: "3701",
        needs_review: false,
        tier: "template",
      }),
      op(
        "txn_categorized",
        "dev-a",
        { entity: { kind: "txn", id: "t1" }, parent_version: 1, payload: { category: "groceries" } },
        "2026-06-05T10:00:00Z",
      ),
      op(
        "txn_split",
        "dev-a",
        {
          entity: { kind: "txn", id: "t1" },
          parent_version: 2,
          payload: {
            parts: [
              { category: "food", amount_minor: "10000" },
              { category: "household", amount_minor: "15000" },
            ],
          },
        },
        "2026-06-05T10:30:00Z",
      ),

      // t2 — USD, CREDIT, uncategorized, no splits, an amount past 2^53, and a
      // heuristic tier. Every field differs from t1's, so a projection that
      // transposed two columns or wrote a constant fails here rather than
      // passing on a fixture that agrees with itself.
      ingested(
        "m2",
        "t2",
        {
          amount_minor: "9007199254740993",
          currency: "USD",
          direction: "credit",
          posted_at: "2026-06-07T14:22:11Z",
          merchant_raw: "SALARY | ACME  LLC",
          last4: "0042",
          needs_review: true,
          tier: "heuristic",
        },
        "dev-b",
      ),

      // t3 — unparsed: zero amount, empty currency AND empty direction, tier
      // "none". The row Task 7 exists for.
      ingested("m3", "t3", {
        amount_minor: "0",
        currency: "",
        direction: "",
        posted_at: "2026-06-08T03:00:00Z",
        merchant_raw: "",
        last4: "",
        is_transfer: false,
        tier: "none",
        needs_review: true,
        unparsed: true,
        normalizer_version: 3,
      }),

      // t4 — a currency with NO rate, so its home snapshot stays null while
      // t1's and t2's are frozen. Three splits, so the split table is grouped by
      // txn AND ordered within a txn by two different lengths.
      ingested("m4", "t4", {
        amount_minor: "77777",
        currency: "GBP",
        direction: "debit",
        posted_at: "2026-06-09T18:45:00Z",
        merchant_raw: "TFL TRAVEL CH",
        last4: "9911",
        needs_review: false,
        tier: "template",
      }),
      op(
        "txn_split",
        "dev-a",
        {
          entity: { kind: "txn", id: "t4" },
          parent_version: 1,
          payload: {
            parts: [
              { category: "travel", amount_minor: "50000" },
              { category: "food", amount_minor: "20000" },
              { category: "misc", amount_minor: "7777" },
            ],
          },
        },
        "2026-06-09T19:00:00Z",
      ),

      // Two rules, differing in every field.
      op(
        "rule_added",
        "dev-a",
        { entity: { kind: "rule", id: "r1" }, payload: { pattern: "CARREFOUR", match: "contains", category: "groceries", priority: 10 } },
        "2026-06-10T08:00:00Z",
      ),
      op(
        "rule_added",
        "dev-b",
        { entity: { kind: "rule", id: "r2" }, payload: { pattern: "^TFL", match: "regex", category: "transport", priority: 90 } },
        "2026-06-10T08:05:00Z",
      ),

      // A real concurrent fork: two devices categorize t2 from the same parent.
      op(
        "txn_categorized",
        "dev-a",
        { entity: { kind: "txn", id: "t2" }, parent_version: 1, payload: { category: "income" } },
        "2026-06-11T09:00:00Z",
      ),
      op(
        "txn_categorized",
        "dev-b",
        { entity: { kind: "txn", id: "t2" }, parent_version: 1, payload: { category: "salary" } },
        "2026-06-11T09:00:01Z",
      ),

      // An anomaly with no fork: a second create for an id that already exists.
      ingested("m5", "t1", {
        amount_minor: "111",
        currency: "AED",
        direction: "debit",
        posted_at: "2026-06-12T09:00:00Z",
        merchant_raw: "DUPLICATE",
        last4: "0000",
      }),
    ]),
  );
}

/**
 * Every field of {@link Txn}, enumerated so the comparison below is exhaustive
 * by construction rather than by whoever wrote it remembering.
 *
 * Phase 1's Task 13 review found the equivalent check comparing only
 * `amount_home_minor` and existence, which certified a reordered fork winner as
 * clean. The guard against repeating that is not diligence — it is the test
 * immediately below, which re-derives the field set from a real folded row and
 * fails if this list drifts from it.
 */
const TXN_FIELDS: readonly (keyof Txn)[] = [
  "id",
  "ingest_id",
  "amount_minor",
  "currency",
  "direction",
  "posted_at",
  "merchant_raw",
  "last4",
  "category",
  "needs_review",
  "unparsed",
  "tier",
  "parse_error",
  "provenance",
  "amount_home_minor",
  "splits",
  "superseded_by",
  "possible_duplicate_of",
  "duplicate_disposition",
  "verified_origin_domain",
  "version",
];

test("the field list this suite compares is every field a folded Txn actually has", () => {
  const s = fixture();
  const one = [...s.txns.values()][0];
  expect(one).toBeDefined();
  expect([...Object.keys(one as Txn)].sort()).toEqual([...TXN_FIELDS].sort());
});

test("the fixture is hostile: no two transactions agree, and every projected shape is present", () => {
  // The anti-vacuity guard for everything below. A fixture that quietly stopped
  // producing forks, splits, a null home snapshot or an unparsed row would make
  // half of these tests assert over empty collections and stay green.
  const s = fixture();
  expect(s.txns.size).toBe(4);
  expect([...s.txns.values()].filter((t) => t.splits.length > 0).length).toBe(2);
  expect([...s.txns.values()].filter((t) => t.unparsed).length).toBe(1);
  expect([...s.txns.values()].filter((t) => t.amount_home_minor === null).length).toBeGreaterThan(0);
  expect([...s.txns.values()].filter((t) => t.amount_home_minor !== null).length).toBeGreaterThan(0);
  expect([...s.txns.values()].filter((t) => t.category === null).length).toBeGreaterThan(0);
  expect(new Set([...s.txns.values()].map((t) => t.currency)).size).toBe(4);
  expect(new Set([...s.txns.values()].map((t) => t.direction)).size).toBe(3);
  expect(s.rules.size).toBe(2);
  // AED (the home identity, installed by `home_currency_set`), USD, and JPY —
  // which is present with a NULL value because it was set and then unset.
  expect(s.rates.size).toBe(3);
  expect(s.rates.get("AED")).toBe(1_000_000n);
  expect(s.rates.get("JPY")).toBeNull(); // present-with-null: a live rate_unset
  expect(s.forks.length).toBeGreaterThan(0);
  expect(s.anomalies.length).toBeGreaterThan(0);
  expect([...s.txns.values()].some((t) => t.amount_minor > 9_007_199_254_740_992n)).toBe(true);
});

test("projectionMatchesState: every field of every transaction round-trips", async () => {
  const s = fixture();
  const d = db();
  await project(d, s);

  const back = readTxns(d);
  expect([...back.keys()].sort()).toEqual([...s.txns.keys()].sort());
  for (const [id, want] of s.txns) {
    const got = back.get(id);
    expect(got).toBeDefined();
    for (const f of TXN_FIELDS) {
      // Named in the message so a failure says WHICH field, on WHICH row.
      expect({ id, [f]: got?.[f] }).toEqual({ id, [f]: want[f] });
    }
  }
});

test("projectionMatchesState: rules, rates, forks and anomalies round-trip too", async () => {
  const s = fixture();
  const d = db();
  await project(d, s);

  expect(readRules(d)).toEqual(s.rules);
  expect(readRates(d)).toEqual(s.rates);
  expect(readRateUpdatedAt(d)).toEqual(s.rateUpdatedAt);
  expect(readForks(d)).toEqual(s.forks);
  expect(readAnomalies(d)).toEqual(s.anomalies);
  expect(readMeta(d)).toEqual({
    version: PROJECTION_VERSION,
    cursorHot: s.cursors.hot,
    cursorCold: s.cursors.cold,
    homeCurrency: "AED",
    complete: true,
  });
});

test("a rate that was UNSET is a row with a null micro, not a missing row", async () => {
  // The distinction the fold makes and a naive projection loses: a key present
  // with null is "someone unset this rate", an absent key is "no rate was ever
  // set". They drive different UI and different FX behaviour.
  const s = fixture();
  const d = db();
  await project(d, s);
  const rates = readRates(d);
  expect(rates.has("JPY")).toBe(true);
  expect(rates.get("JPY")).toBeNull();
  expect(rates.has("GBP")).toBe(false);
});

test("money survives the round trip past 2^53, as bigint and never as number", async () => {
  const s = fixture();
  const d = db();
  await project(d, s);
  const t2 = readTxns(d).get("t2");
  expect(t2?.amount_minor).toBe(9_007_199_254_740_993n);
  // The column itself is TEXT, so nothing downstream can get a float out of it
  // even by asking wrongly. `typeof` on the raw value is the measurement — a
  // check against the decoded bigint would be a check on the decoder.
  const raw = d.prepare("SELECT amount_minor, typeof(amount_minor) AS t FROM txn WHERE id = 't2'").all()[0] as Record<
    string,
    unknown
  >;
  expect(raw["t"]).toBe("text");
  expect(raw["amount_minor"]).toBe("9007199254740993");
  for (const col of ["amount_home_minor"]) {
    const types = d
      .prepare(`SELECT DISTINCT typeof(${col}) AS t FROM txn`)
      .all()
      .map((r) => (r as Record<string, unknown>)["t"]);
    expect(types.sort()).toEqual(["null", "text"]);
  }
  const splitTypes = d
    .prepare("SELECT DISTINCT typeof(amount_minor) AS t FROM txn_split")
    .all()
    .map((r) => (r as Record<string, unknown>)["t"]);
  expect(splitTypes).toEqual(["text"]);
  const t1 = s.txns.get("t1");
  const t1Home = t1?.amount_home_minor;
  if (t1Home === null || t1Home === undefined) throw new Error("hostile fixture lost t1 home snapshot");
  const projectedHomeParts = d
    .prepare("SELECT amount_home_minor FROM txn_split WHERE txn_id = 't1' ORDER BY idx")
    .all()
    .map((r) => BigInt(String((r as Record<string, unknown>)["amount_home_minor"])));
  expect(projectedHomeParts.reduce((sum, amount) => sum + amount, 0n)).toBe(t1Home);
  const rateTypes = d
    .prepare("SELECT DISTINCT typeof(rate_micro) AS t FROM rate")
    .all()
    .map((r) => (r as Record<string, unknown>)["t"]);
  expect(rateTypes.sort()).toEqual(["null", "text"]);
});

test("splits are grouped by transaction and ordered within one", async () => {
  // Two transactions with splits, of DIFFERENT lengths, so "grouped correctly"
  // is distinguishable from "not grouped at all" and from "grouped but ordered
  // by whatever SQLite felt like".
  const s = fixture();
  const d = db();
  await project(d, s);
  const back = readTxns(d);
  expect(back.get("t1")?.splits).toEqual([
    { category: "food", amount_minor: 10000n },
    { category: "household", amount_minor: 15000n },
  ]);
  expect(back.get("t4")?.splits).toEqual([
    { category: "travel", amount_minor: 50000n },
    { category: "food", amount_minor: 20000n },
    { category: "misc", amount_minor: 7777n },
  ]);
  expect(back.get("t2")?.splits).toEqual([]);
});

test("a reversed split list is NOT reported as equal — the order assertion has teeth", async () => {
  const s = fixture();
  const t1 = s.txns.get("t1");
  expect(t1).toBeDefined();
  const flipped: State = { ...s, txns: new Map(s.txns) };
  flipped.txns.set("t1", { ...(t1 as Txn), splits: [...(t1 as Txn).splits].reverse() });
  const d = db();
  await project(d, flipped);
  expect(readTxns(d).get("t1")?.splits).not.toEqual((t1 as Txn).splits);
});

test("the projection is a full REPLACE: rows the new state does not have are gone", async () => {
  const s = fixture();
  const d = db();
  await project(d, s);
  expect(readTxns(d).size).toBe(4);

  const trimmed: State = { ...s, txns: new Map([["t1", s.txns.get("t1") as Txn]]), rules: new Map(), forks: [], anomalies: [] };
  await project(d, trimmed);
  expect([...readTxns(d).keys()]).toEqual(["t1"]);
  expect(readRules(d).size).toBe(0);
  expect(readForks(d)).toEqual([]);
  expect(readAnomalies(d)).toEqual([]);
  // The stale splits went with their transactions: a delete that missed the
  // child table would leave t4's three parts attached to nothing.
  expect(d.prepare("SELECT count(*) AS n FROM txn_split WHERE txn_id != 't1'").all()[0]).toEqual({ n: 0 });
});

test("project chunks at the given size and yields between chunks, never after the last", async () => {
  const s = fixture();
  const d = db();
  const seen: number[] = [];
  const report = await project(d, s, { chunkSize: 2, between: (c) => void seen.push(c) });
  // 4 transactions at 2 per chunk is 2 chunks and ONE gap between them.
  expect(report.chunks).toBe(2);
  expect(seen).toEqual([1]);
  expect(readTxns(d).size).toBe(4);
});

test("project writes each chunk before it asks for the next", async () => {
  // Task 5's poisoning technique, moved from the row store to the transaction
  // source. An implementation that did `[...s.txns.values()]` and then wrote the
  // array in slices reads the same transactions, produces the same counts, emits
  // the same number of yields, and holds every one of them at once — which is
  // the shape the chunking exists to forbid, and which every other test in this
  // file is blind to.
  //
  // This one is here because it was MISSING: the memory measurement in
  // `net/engine.test.ts` covers the fold, and when it was narrowed to
  // `materializeChunked` the projection lost its only proof. A mutation that
  // materialized the whole list survived until this existed.
  const real = fixture();
  let poisoned = 0;
  const values = function* (): Generator<Txn> {
    let previous: Txn | null = null;
    for (const t of real.txns.values()) {
      if (previous !== null) {
        // The caller has moved on; whatever it kept is now worthless.
        previous.amount_minor = -999_999n;
        previous.category = "!!!! poisoned: this row was retained past its turn";
        poisoned++;
      }
      previous = t;
      yield t;
    }
  };
  const hostile: State = {
    ...real,
    txns: { size: real.txns.size, values } as unknown as Map<string, Txn>,
  };

  const d = db();
  await project(d, hostile, { chunkSize: 1 });
  expect(poisoned).toBe(real.txns.size - 1);
  const back = readTxns(d);
  expect(back.size).toBe(real.txns.size);
  for (const t of back.values()) {
    expect(t.amount_minor).not.toBe(-999_999n);
    expect(t.category).not.toBe("!!!! poisoned: this row was retained past its turn");
  }
});

test("a chunk size that divides the row count exactly does not yield an extra time", async () => {
  // The off-by-one a "did the last chunk come back short?" implementation has:
  // with 4 rows at 4 per chunk it needs an extra empty probe to discover it
  // finished, and yields once where there is no gap.
  const s = fixture();
  const seen: number[] = [];
  const report = await project(db(), s, { chunkSize: 4, between: (c) => void seen.push(c) });
  expect(report.chunks).toBe(1);
  expect(seen).toEqual([]);
});

test("an interrupted projection reads back as UNUSABLE rather than as a short log", async () => {
  const s = fixture();
  const d = db();
  let stop = false;
  await expect(
    project(d, s, {
      chunkSize: 1,
      cancelled: () => stop,
      between: (c) => {
        if (c >= 2) stop = true;
      },
    }),
  ).rejects.toThrow(ProjectionCancelled);

  // Rows ARE on disk — this is the dangerous state, and the point is that it is
  // visible. A consumer that trusted `SELECT * FROM txn` here would show a user
  // two transactions and no warning.
  expect(readTxns(d).size).toBeGreaterThan(0);
  expect(readTxns(d).size).toBeLessThan(4);
  expect(projectionIsUsable(d)).toBe(false);
  expect(readMeta(d)?.complete).toBe(false);

  // …and the repair is a re-projection, which is complete.
  await project(d, s);
  expect(projectionIsUsable(d)).toBe(true);
  expect(readTxns(d).size).toBe(4);
});

test("a projection written by another version is unusable, and is rebuilt rather than migrated", async () => {
  const s = fixture();
  const d = db();
  await project(d, s);
  expect(projectionIsUsable(d)).toBe(true);

  d.prepare("UPDATE projection_meta SET version = ? WHERE id = 1").run(PROJECTION_VERSION + 1);
  expect(projectionIsUsable(d)).toBe(false);

  await project(d, s);
  expect(readMeta(d)?.version).toBe(PROJECTION_VERSION);
  expect(projectionIsUsable(d)).toBe(true);
});

test("an empty state projects to empty tables and a complete meta row", async () => {
  const d = db();
  const report = await project(d, emptyState());
  expect(report).toEqual({ txns: 0, splits: 0, rules: 0, rates: 0, forks: 0, anomalies: 0, chunks: 0 });
  expect(projectionIsUsable(d)).toBe(true);
  expect(readTxns(d).size).toBe(0);
});

test("ensureProjection is idempotent and readMeta on a fresh database is null, not a throw", () => {
  const d = db();
  ensureProjection(d);
  ensureProjection(d);
  expect(readMeta(d)).toBeNull();
  expect(projectionIsUsable(d)).toBe(false);
});

test("literal v1 projection is unusable and is fully rebuilt at the current version", async () => {
  const d = db();
  d.exec(`
    CREATE TABLE rate (currency TEXT PRIMARY KEY, rate_micro TEXT);
    CREATE TABLE projection_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, cursor_hot TEXT NOT NULL,
      cursor_cold TEXT NOT NULL, home_currency TEXT, complete INTEGER NOT NULL);
    INSERT INTO rate VALUES ('USD', '3672500');
    INSERT INTO projection_meta VALUES (1, 1, '9', '0', 'AED', 1);
  `);
  expect(PROJECTION_VERSION).toBe(4);
  expect(projectionIsUsable(d)).toBe(false);
  const state = emptyState();
  state.homeCurrency = "AED";
  state.rates.set("USD", 3_672_500n);
  state.rateUpdatedAt.set("USD", "2026-08-01T00:00:00.000Z");
  await project(d, state);
  expect(readMeta(d)?.version).toBe(PROJECTION_VERSION);
  expect(projectionIsUsable(d)).toBe(true);
  expect(readRateUpdatedAt(d).get("USD")).toBe("2026-08-01T00:00:00.000Z");
});

test("the indices the list, review and budget screens need are actually created", () => {
  // Written, tested green, never wired is this project's second-most-expensive
  // defect shape. An index in a schema string nobody executed is exactly that.
  const d = db();
  ensureProjection(d);
  const names = d
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'txn'")
    .all()
    .map((r) => (r as Record<string, unknown>)["name"]);
  expect(names).toContain("txn_posted_at");
  expect(names).toContain("txn_needs_review");
  expect(names).toContain("txn_category");
  expect(names).toContain("txn_superseded");
  // And they are USED, not merely present: an index SQLite's planner ignores is
  // an index that does not exist.
  const plan = d
    .prepare("EXPLAIN QUERY PLAN SELECT id FROM txn WHERE needs_review = 1 ORDER BY posted_at")
    .all()
    .map((r) => JSON.stringify(r))
    .join(" ");
  expect(plan).toContain("txn_needs_review");
});
