/**
 * The lane queries, against a real database.
 *
 * Every fixture here is a real op, folded by the real `fold` and written by the
 * real `project`. Nothing is hand-inserted into the `txn` table: a fixture that
 * set `possible_duplicate_of` itself would be a test of this file's opinion
 * about the fingerprint heuristic rather than of the heuristic, and the
 * heuristic is the thing that went wrong in Phase 1.
 *
 * The fixture is deliberately hostile in the way v1's harness taught: **two of
 * everything that can collapse**. Two unparsed messages on the same day (which
 * are byte-identical in every field a user can see), two rows sharing a
 * fingerprint, two lanes' worth of review reasons, and a superseded row of each
 * kind. A fixture with one of something cannot tell correct grouping apart from
 * no grouping at all.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { bunDriver } from "@ledger/client/store/driver.ts";
import { project, readTxns } from "@ledger/client/replay/projection.ts";
import { emptyState, type State } from "@ledger/client/replay/state.ts";
import { fold, type LogEntry } from "@ledger/client/replay/replay.ts";
import { validateOp, type Op } from "@ledger/client/wire/op.ts";
import type { SqlDriver } from "@ledger/client/store/driver.ts";

import { itemKey, laneOf, duplicateKey, type Lane } from "../lib/review.ts";
import {
  clearDisposition,
  dispositionOf,
  forkPage,
  laneCounts,
  laneMoney,
  lanePage,
  rulesOf,
  setDisposition,
  sqliteReviewSource,
  topCategories,
  versionOf,
} from "./reviewQueue.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const INGEST = "ingest";
const DEVICE = "dev-a";

const ingestID = (name: string): string => new Bun.CryptoHasher("sha256").update(name).digest("hex");

let opCounter = 0;
let seqCounter = 0n;

function op(spec: {
  type: string;
  entity: { kind: string; id: string };
  parentVersion: number | null;
  ingestId?: string;
  payload: unknown;
  authoredAt?: string;
}): Op {
  const o: Op = {
    v: 1,
    type: spec.type as Op["type"],
    op_id: `op-${++opCounter}`,
    authored_at: spec.authoredAt ?? "2026-06-06T10:00:00.000Z",
    entity: spec.entity,
    parent_version: spec.parentVersion,
    payload: spec.payload,
  };
  if (spec.ingestId !== undefined) o.ingest_id = spec.ingestId;
  validateOp(o);
  return o;
}

function entry(o: Op, writer = INGEST): LogEntry {
  seqCounter += 1n;
  return { op: o, seq: seqCounter, writer_id: writer };
}

function ingested(id: string, name: string, payload: Record<string, unknown>): LogEntry {
  return entry(op({ type: "txn_ingested", entity: { kind: "txn", id }, parentVersion: null, ingestId: ingestID(name), payload }));
}

const DIB = {
  amount_minor: "25000",
  currency: "AED",
  direction: "debit",
  posted_at: "2026-06-05T09:00:00Z",
  merchant_raw: "CARREFOUR HYPERMARKET",
  last4: "3701",
  tier: "template",
  needs_review: true,
};

const UNPARSED = {
  amount_minor: "0",
  currency: "",
  direction: "",
  posted_at: "2026-06-05T09:00:00Z",
  merchant_raw: "",
  last4: "",
  is_transfer: false,
  tier: "none",
  needs_review: true,
  unparsed: true,
  normalizer_version: 1,
};

/**
 * The log every test below reads.
 *
 * `home_currency_set` and a `rate_set` are in it so the money summary has real
 * frozen snapshots to sum rather than a column of nulls — a total that is zero
 * because nothing was ever converted would pass an assertion that the total is
 * right for entirely the wrong reason.
 */
function fixtureLog(): LogEntry[] {
  const rows: LogEntry[] = [];
  rows.push(entry(homeCurrency("AED"), DEVICE));

  // 1. The DIB case: template tier, flagged because the decoding headers were
  //    not signed. Two of them, so the lane is never one row.
  rows.push(ingested("t1", "m1", DIB));
  rows.push(ingested("t2", "m2", { ...DIB, merchant_raw: "SPINNEYS", amount_minor: "8800" }));

  // 2. The heuristic tier: same lane, different reason.
  rows.push(ingested("t3", "m3", { ...DIB, tier: "heuristic", merchant_raw: "UNKNOWN SHOP", amount_minor: "1500" }));

  // 3. Two messages no tier resolved, on the SAME DAY. Identical in every field
  //    a user can see. This is the pair Phase 1's exit run collapsed.
  rows.push(ingested("u1", "unread-a", UNPARSED));
  rows.push(ingested("u2", "unread-b", UNPARSED));

  // 4. A settled row: categorised, not flagged. It must be in no lane.
  rows.push(ingested("s1", "m4", { ...DIB, needs_review: false, category: "Groceries", merchant_raw: "LULU" }));

  // 5. Two rows sharing a fingerprint — the duplicate notice, produced by the
  //    real heuristic rather than written into the column by hand.
  const twin = { ...DIB, merchant_raw: "NETFLIX", amount_minor: "5600", needs_review: false, category: "Streaming" };
  rows.push(ingested("d1", "m5", twin));
  rows.push(ingested("d2", "m6", twin));

  // 6. A fork: two categorisations of `s1` naming the same parent.
  rows.push(
    entry(
      op({
        type: "txn_categorized",
        entity: { kind: "txn", id: "s1" },
        parentVersion: 1,
        payload: { category: "Dining", needs_review: false },
        authoredAt: "2026-06-06T10:00:00.000Z",
      }),
      DEVICE,
    ),
  );
  rows.push(
    entry(
      op({
        type: "txn_categorized",
        entity: { kind: "txn", id: "s1" },
        parentVersion: 1,
        payload: { category: "Groceries", needs_review: false },
        authoredAt: "2026-06-06T11:00:00.000Z",
      }),
      "dev-b",
    ),
  );

  // 7. A rule, so the write-back's duplicate check and the category grid have
  //    something to read.
  rows.push(
    entry(
      op({ type: "rule_added", entity: { kind: "rule", id: "r1" }, parentVersion: null, payload: { pattern: "lulu", match: "exact", category: "Groceries", priority: 0 } }),
      DEVICE,
    ),
  );

  // 8. A superseded unparsed row: the user typed it in. Neither the retired row
  //    nor its replacement is a review item.
  rows.push(ingested("u3", "unread-c", UNPARSED));
  rows.push(
    entry(
      op({
        type: "txn_superseded",
        entity: { kind: "txn", id: "u3b" },
        parentVersion: null,
        ingestId: ingestID("unread-c"),
        payload: { amount_minor: "4200", currency: "AED", direction: "debit", posted_at: "2026-06-05T09:00:00Z", merchant_raw: "TYPED IN", last4: "", needs_review: false, category: "Groceries" },
      }),
      DEVICE,
    ),
  );

  return rows;
}

function homeCurrency(ccy: string): Op {
  const o: Op = {
    v: 1,
    type: "home_currency_set",
    op_id: `op-${++opCounter}`,
    authored_at: "2026-06-01T00:00:00.000Z",
    parent_version: null,
    payload: { currency: ccy },
  };
  validateOp(o);
  return o;
}

let db: SqlDriver;
let state: State;

async function build(): Promise<void> {
  opCounter = 0;
  seqCounter = 0n;
  db = bunDriver(":memory:");
  state = fold(fixtureLog(), emptyState());
  await project(db, state);
}

beforeEach(async () => {
  await build();
});

// ---------------------------------------------------------------------------

describe("the fixture is the log it claims to be", () => {
  test("it folded cleanly, so every assertion below is about the queries", () => {
    // The one anomaly is the duplicate notice itself, which the fixture is
    // there to produce. Anything else would mean a test below is measuring a
    // malformed op rather than a query.
    expect(state.anomalies.map((a) => a.kind)).toEqual(["possible_duplicate"]);
    expect(state.unreadable).toEqual([]);
  });

  test("the duplicate notice was produced by the fingerprint heuristic, not by the fixture", () => {
    expect(state.txns.get("d2")!.possible_duplicate_of).toBe("d1");
  });

  test("the two same-day unparsed rows were NOT flagged against each other", () => {
    // Task 7's fix, observed from the queue's side: before it, every unparsed
    // row of a day fingerprinted to `||0|||day` and each was a possible
    // duplicate of every other.
    expect(state.txns.get("u1")!.possible_duplicate_of).toBeNull();
    expect(state.txns.get("u2")!.possible_duplicate_of).toBeNull();
  });

  test("a fork really was resolved", () => {
    expect(state.forks.length).toBe(1);
  });
});

describe("lane counts", () => {
  test("each lane holds what it should", () => {
    expect(laneCounts(db)).toEqual({ needs_review: 3, unparsed: 2, duplicate: 1, forks: 1 });
  });

  test("the same-day unparsed messages are TWO items, not one", () => {
    const page = lanePage(db, "unparsed");
    expect(page.length).toBe(2);
    expect(new Set(page.map((i) => i.key)).size).toBe(2);
    // …and they are identical in every field the collapse used to key on.
    const [a, b] = page;
    expect(a!.txn.amount_minor).toBe(b!.txn.amount_minor);
    expect(a!.txn.currency).toBe(b!.txn.currency);
    expect(a!.txn.direction).toBe(b!.txn.direction);
    expect(a!.txn.merchant_raw).toBe(b!.txn.merchant_raw);
    expect(a!.txn.posted_at).toBe(b!.txn.posted_at);
    expect(new Set(page.map((i) => i.txn.ingest_id)).size).toBe(2);
  });

  test("the SQL lanes agree with laneOf, row by row", () => {
    // Two spellings of one rule — TypeScript's and SQLite's. This is what keeps
    // them from drifting; without it a badge could count a set the list does
    // not show.
    const byLane = new Map<string, Lane>();
    for (const lane of ["needs_review", "unparsed", "duplicate"] as Lane[]) {
      for (const item of lanePage(db, lane, { limit: 100 })) byLane.set(item.txn.id, lane);
    }
    let checked = 0;
    for (const t of readTxns(db).values()) {
      expect(byLane.get(t.id) ?? null).toBe(laneOf(t));
      checked++;
    }
    expect(checked).toBe(state.txns.size);
    expect(checked).toBeGreaterThan(8);
  });

  test("a superseded row is in no lane, and neither is its replacement", () => {
    const ids = new Set<string>();
    for (const lane of ["needs_review", "unparsed", "duplicate"] as Lane[]) {
      for (const item of lanePage(db, lane, { limit: 100 })) ids.add(item.txn.id);
    }
    expect(ids.has("u3")).toBe(false);
    expect(ids.has("u3b")).toBe(false);
  });
});

describe("what each card says", () => {
  test("the needs_review lane distinguishes the template case from the heuristic one", () => {
    const reasons = lanePage(db, "needs_review", { limit: 100 }).map((i) => `${i.txn.id}:${i.reason}`);
    expect(reasons.sort()).toEqual(["t1:unsigned_headers", "t2:unsigned_headers", "t3:pattern_guess"]);
  });

  test("every unparsed card is the unreadable reason", () => {
    expect(lanePage(db, "unparsed").every((i) => i.reason === "unreadable")).toBe(true);
  });

  test("a duplicate card carries the row it was flagged against", () => {
    const [item] = lanePage(db, "duplicate");
    expect(item!.txn.id).toBe("d2");
    expect(item!.counterpart?.id).toBe("d1");
    expect(item!.key).toBe(duplicateKey(item!.txn));
  });

  test("pages are ordered newest first and do not repeat a row across pages", () => {
    const first = lanePage(db, "needs_review", { limit: 2, offset: 0 });
    const second = lanePage(db, "needs_review", { limit: 2, offset: 2 });
    expect(first.length).toBe(2);
    expect(second.length).toBe(1);
    const ids = [...first, ...second].map((i) => i.txn.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("dismissals", () => {
  test("dismissing with the key the SCREEN builds removes the item the QUERY returns", () => {
    // The two key spellings — `lib/review.ts`'s and the SQL's — are checked
    // against each other from opposite sides. A comparison of two strings this
    // module built would prove only that it agrees with itself.
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "not_duplicate", "2026-06-07T00:00:00Z");
    expect(lanePage(db, "duplicate")).toEqual([]);
    expect(laneCounts(db).duplicate).toBe(0);
  });

  test("a dismissal deletes neither row", () => {
    // §3.3:73 — a duplicate notice is a NOTICE. Both purchases stay live.
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "duplicate_confirmed", "2026-06-07T00:00:00Z");
    const after = readTxns(db);
    expect(after.get("d1")!.superseded_by).toBeNull();
    expect(after.get("d2")!.superseded_by).toBeNull();
    expect(after.get("d1")!.amount_minor).toBe(5_600n);
    expect(after.get("d2")!.amount_minor).toBe(5_600n);
  });

  test("dismissing one unparsed message leaves the other", () => {
    const page = lanePage(db, "unparsed");
    setDisposition(db, page[0]!.key, "unparsed", "acknowledged", "2026-06-07T00:00:00Z");
    const left = lanePage(db, "unparsed");
    expect(left.length).toBe(1);
    expect(left[0]!.key).toBe(page[1]!.key);
  });

  test("restoring puts it back", () => {
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "not_duplicate", "2026-06-07T00:00:00Z");
    clearDisposition(db, item!.key);
    expect(lanePage(db, "duplicate").length).toBe(1);
    expect(dispositionOf(db, item!.key)).toBeNull();
  });

  test("dismissals survive a projection rebuild", async () => {
    // The reason the table is NOT part of PROJECTION_SCHEMA: `project()` clears
    // its own six tables every time it runs, and a dismissal that vanished on
    // the next fold would put every answered notice back on the glass.
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "not_duplicate", "2026-06-07T00:00:00Z");
    await project(db, state);
    expect(lanePage(db, "duplicate")).toEqual([]);
    expect(dispositionOf(db, item!.key)?.answer).toBe("not_duplicate");
  });

  test("a fork notice can be acknowledged, and its key survives a rebuild too", async () => {
    const [f] = forkPage(db);
    expect(f!.notice.winner_op).not.toBe(f!.notice.loser_op);
    setDisposition(db, f!.key, "forks", "acknowledged", "2026-06-07T00:00:00Z");
    expect(forkPage(db)).toEqual([]);
    expect(laneCounts(db).forks).toBe(0);
    await project(db, state);
    expect(forkPage(db)).toEqual([]);
  });

  test("an answer can be changed, and does not become two answers", () => {
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "not_duplicate", "2026-06-07T00:00:00Z");
    setDisposition(db, item!.key, "duplicate", "duplicate_confirmed", "2026-06-08T00:00:00Z");
    expect(dispositionOf(db, item!.key)?.answer).toBe("duplicate_confirmed");
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_disposition").all()).toEqual([{ n: 1 }]);
  });
});

describe("the money summary", () => {
  test("the unparsed lane carries no money at all", () => {
    return laneMoney(db, "unparsed").then((m) => {
      expect(m.counted).toBe(0);
      expect(m.excluded).toBe(2);
      expect(m.totalHomeMinor).toBe(0n);
    });
  });

  test("the confirm lane sums only rows that count toward money", async () => {
    const m = await laneMoney(db, "needs_review");
    expect(m.counted).toBe(3);
    expect(m.excluded).toBe(0);
    // 25000 + 8800 + 1500, frozen at the identity rate for the home currency.
    expect(m.totalHomeMinor).toBe(35_300n);
    expect(m.awaitingRate).toBe(0);
  });

  test("a dismissed row leaves the total", async () => {
    const [item] = lanePage(db, "needs_review", { limit: 1 });
    setDisposition(db, item!.key, "needs_review", "acknowledged", "2026-06-07T00:00:00Z");
    const m = await laneMoney(db, "needs_review");
    expect(m.counted).toBe(2);
  });

  test("it chunks and yields rather than reading the lane whole", async () => {
    const yields: number[] = [];
    const m = await laneMoney(db, "needs_review", { chunkSize: 1, between: (n) => void yields.push(n) });
    expect(m.counted).toBe(3);
    expect(m.totalHomeMinor).toBe(35_300n);
    // Three rows at one per chunk: a yield after each full chunk, and the
    // fourth read returns nothing.
    expect(yields.length).toBeGreaterThanOrEqual(2);
  });

  test("a currency with no rate is counted but not summed", async () => {
    // Prove `awaitingRate` is real rather than a field that is always zero.
    const usd = fold([ingested("f1", "m9", { ...DIB, currency: "USD", amount_minor: "1000" })], state);
    const db2 = bunDriver(":memory:");
    await project(db2, usd);
    const m = await laneMoney(db2, "needs_review");
    expect(m.counted).toBe(4);
    expect(m.awaitingRate).toBe(1);
    expect(m.totalHomeMinor).toBe(35_300n);
    db2.close();
  });
});

describe("the rest of what the screen reads", () => {
  test("categories come back most-used first, with rule-only categories after", () => {
    const cats = topCategories(db);
    expect(cats[0]).toBe("Groceries");
    expect(cats).toContain("Streaming");
  });

  test("rules come back for the write-back's duplicate check", () => {
    expect(rulesOf(db)).toEqual([{ pattern: "lulu", match: "exact", category: "Groceries", priority: 0, version: 1 }]);
  });

  test("the version a confirm names comes from the projection, not from the card", () => {
    expect(versionOf(db, "s1")).toBe(3);
    expect(versionOf(db, "nope")).toBeNull();
  });

  test("splits are attached to a page's rows in one statement", () => {
    db.prepare("INSERT INTO txn_split (txn_id, idx, category, amount_minor) VALUES (?, ?, ?, ?)").run("t1", 0, "Groceries", "20000");
    db.prepare("INSERT INTO txn_split (txn_id, idx, category, amount_minor) VALUES (?, ?, ?, ?)").run("t1", 1, "Household", "5000");
    const item = lanePage(db, "needs_review", { limit: 100 }).find((i) => i.txn.id === "t1");
    expect(item!.txn.splits.map((s) => s.amount_minor)).toEqual([20_000n, 5_000n]);
  });
});

describe("the source the screen is handed", () => {
  test("it answers every question the screen asks", async () => {
    const src = sqliteReviewSource(db, () => "2026-06-07T00:00:00Z");
    expect(await src.counts()).toEqual({ needs_review: 3, unparsed: 2, duplicate: 1, forks: 1 });
    expect((await src.page("unparsed")).length).toBe(2);
    expect((await src.forks()).length).toBe(1);
    expect((await src.money("unparsed")).excluded).toBe(2);
    expect((await src.categories()).length).toBeGreaterThan(0);
    expect((await src.rules()).length).toBe(1);
    expect(await src.version("t1")).toBe(1);

    const [item] = await src.page("duplicate");
    await src.dismiss(item!.key, "duplicate", "not_duplicate");
    expect((await src.page("duplicate")).length).toBe(0);
    expect(dispositionOf(db, item!.key)?.at).toBe("2026-06-07T00:00:00Z");
    await src.restore(item!.key);
    expect((await src.page("duplicate")).length).toBe(1);
  });
});

describe("item keys", () => {
  test("a page's key is the entity id, so nothing groups on what the user sees", () => {
    for (const item of lanePage(db, "unparsed")) expect(item.key).toBe(itemKey(item.txn));
  });
});
