/**
 * The lane queries, against a real database.
 *
 * A port of `app/src/db/reviewQueue.test.ts`, assertion for assertion. Two
 * substitutions and nothing else: `bun:test` became `vitest`, and
 * `bunDriver(":memory:")` became `openBrowserDriver`, the sql.js driver this app
 * actually ships. The second is the point of re-running these here rather than
 * trusting the native run — sql.js hands INTEGER columns back as JS `number`s,
 * so the decoding is a genuinely different question on this driver.
 *
 * Every fixture is a real op, folded by the real `fold` and written by the real
 * `project`. Nothing is hand-inserted into the `txn` table: a fixture that set
 * `possible_duplicate_of` itself would be a test of this file's opinion about
 * the fingerprint heuristic rather than of the heuristic, and the heuristic is
 * the thing that went wrong in Phase 1.
 *
 * The fixture is deliberately hostile in the way v1's harness taught: **two of
 * everything that can collapse**. Two unparsed messages on the same day (which
 * are byte-identical in every field a user can see), two rows sharing a
 * fingerprint, two lanes' worth of review reasons, and a superseded row.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";
import { fold, INGEST_WRITER_ID, type LogEntry } from "@ledger/client/replay/replay";
import { project, readTxns } from "@ledger/client/replay/projection";
import { emptyState, type State, type Txn } from "@ledger/client/replay/state";
import type { SqlDriver } from "@ledger/client/store/driver";
import { validateOp, type Op } from "@ledger/client/wire/op";

import { openBrowserDriver } from "../db/driver";
import {
  clearDisposition,
  confirmOps,
  dispositionOf,
  duplicateKey,
  existingRuleCategory,
  forkPage,
  isSettled,
  itemKey,
  laneCounts,
  laneMoney,
  laneOf,
  lanePage,
  nextParentVersion,
  pendingCategories,
  pendingRules,
  rulesOf,
  settledBy,
  setDisposition,
  sqlReviewSource,
  topCategories,
  undoConfirmOps,
  versionOf,
  withPendingCategory,
  type Lane,
} from "./review";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const DEVICE = "dev-a";

/**
 * A distinct 64-hex ingest id per message name.
 *
 * The native suite hashed the name with `Bun.CryptoHasher`; there is no
 * synchronous sha256 in a browser, and what the fixture actually needs is only
 * that two names never collide — the fingerprint heuristic keys on the ingest id
 * for unparsed rows, so a collision here would silently recreate the very
 * collapse these tests exist to catch.
 */
const ingestIDs = new Map<string, string>();
function ingestID(name: string): string {
  const known = ingestIDs.get(name);
  if (known !== undefined) return known;
  const made = (ingestIDs.size + 1).toString(16).padStart(64, "0");
  ingestIDs.set(name, made);
  return made;
}

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

function entry(o: Op, writer = INGEST_WRITER_ID): LogEntry {
  seqCounter += 1n;
  return { op: o, seq: seqCounter, writer_id: writer };
}

function ingested(id: string, name: string, payload: Record<string, unknown>): LogEntry {
  return entry(
    op({ type: "txn_ingested", entity: { kind: "txn", id }, parentVersion: null, ingestId: ingestID(name), payload }),
  );
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

/**
 * The log every test below reads.
 *
 * `home_currency_set` is in it so the money summary has real frozen snapshots to
 * sum rather than a column of nulls — a total that is zero because nothing was
 * ever converted would pass an assertion that the total is right for entirely
 * the wrong reason.
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
      op({
        type: "rule_added",
        entity: { kind: "rule", id: "r1" },
        parentVersion: null,
        payload: { pattern: "lulu", match: "exact", category: "Groceries", priority: 0 },
      }),
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
        payload: {
          amount_minor: "4200",
          currency: "AED",
          direction: "debit",
          posted_at: "2026-06-05T09:00:00Z",
          merchant_raw: "TYPED IN",
          last4: "",
          needs_review: false,
          category: "Groceries",
        },
      }),
      DEVICE,
    ),
  );

  // 9. The row the operator actually hit: a message the template read cleanly,
  //    with every capture group filled, so nothing about it is uncertain — and
  //    no category. Before the `uncategorized` lane existed this row was in NO
  //    lane, and the screen said "All caught up" while it sat there.
  rows.push(ingested("c1", "m7", { ...DIB, needs_review: false, merchant_raw: "ADNOC", amount_minor: "12000" }));

  return rows;
}

let db: SqlDriver;
let state: State;

beforeEach(async () => {
  setPlatform(webPlatform);
  opCounter = 0;
  seqCounter = 0n;
  ingestIDs.clear();
  db = await openBrowserDriver(`review-${crypto.randomUUID()}`);
  state = fold(fixtureLog(), emptyState());
  await project(db, state);
});

// ---------------------------------------------------------------------------

describe("the fixture is the log it claims to be", () => {
  it("folded cleanly, so every assertion below is about the queries", () => {
    // The one anomaly is the duplicate notice itself, which the fixture is there
    // to produce. Anything else would mean a test below is measuring a malformed
    // op rather than a query.
    expect(state.anomalies.map((a) => a.kind)).toEqual(["possible_duplicate"]);
    expect(state.unreadable).toEqual([]);
  });

  it("produced the duplicate notice from the fingerprint heuristic, not the fixture", () => {
    expect(state.txns.get("d2")!.possible_duplicate_of).toBe("d1");
  });

  it("did NOT flag the two same-day unparsed rows against each other", () => {
    expect(state.txns.get("u1")!.possible_duplicate_of).toBeNull();
    expect(state.txns.get("u2")!.possible_duplicate_of).toBeNull();
  });

  it("resolved a fork", () => {
    expect(state.forks.length).toBe(1);
  });
});

describe("lane counts", () => {
  it("holds what each lane should", () => {
    expect(laneCounts(db)).toEqual({ needs_review: 3, unparsed: 2, duplicate: 1, uncategorized: 1, forks: 1 });
  });

  it("treats the same-day unparsed messages as TWO items, not one", () => {
    const page = lanePage(db, "unparsed");
    expect(page.length).toBe(2);
    expect(new Set(page.map((i) => i.key)).size).toBe(2);
    const [a, b] = page;
    expect(a!.txn.amount_minor).toBe(b!.txn.amount_minor);
    expect(a!.txn.currency).toBe(b!.txn.currency);
    expect(a!.txn.direction).toBe(b!.txn.direction);
    expect(a!.txn.merchant_raw).toBe(b!.txn.merchant_raw);
    expect(a!.txn.posted_at).toBe(b!.txn.posted_at);
    expect(new Set(page.map((i) => i.txn.ingest_id)).size).toBe(2);
  });

  it("agrees with laneOf, row by row", () => {
    // Two spellings of one rule — TypeScript's and SQLite's. This is what keeps
    // them from drifting; without it a badge could count a set the list does not
    // show.
    const byLane = new Map<string, Lane>();
    for (const lane of ["needs_review", "unparsed", "duplicate", "uncategorized"] as Lane[]) {
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

  it("puts a superseded row in no lane, and neither its replacement", () => {
    const ids = new Set<string>();
    for (const lane of ["needs_review", "unparsed", "duplicate", "uncategorized"] as Lane[]) {
      for (const item of lanePage(db, lane, { limit: 100 })) ids.add(item.txn.id);
    }
    expect(ids.has("u3")).toBe(false);
    expect(ids.has("u3b")).toBe(false);
  });
});

describe("the uncategorized lane", () => {
  const txnOf = (id: string): Txn => {
    const t = readTxns(db).get(id);
    if (t === undefined) throw new Error(`fixture has no ${id}`);
    return t;
  };

  it("queues a cleanly-parsed row that carries no category", () => {
    const page = lanePage(db, "uncategorized", { limit: 100 });
    expect(page.map((i) => i.txn.id)).toEqual(["c1"]);
    expect(laneOf(txnOf("c1"))).toBe("uncategorized");
    // The question it asks is "what is this", not "did we read this right".
    expect(page[0]!.reason).toBe("uncategorized");
  });

  it("does not queue a row that already has one", () => {
    // `d1` is read cleanly, not flagged, not the flagged half of the duplicate
    // notice — and categorised. It is the negative half of the same rule.
    expect(laneOf(txnOf("d1"))).toBeNull();
    expect(lanePage(db, "uncategorized", { limit: 100 }).map((i) => i.txn.id)).not.toContain("d1");
  });

  it("yields to every lane above it, so the lanes stay disjoint", () => {
    // A flagged row has no category either, and it belongs to `needs_review`:
    // "is this right" is answered before "what is it".
    expect(txnOf("t1").category).toBeNull();
    expect(laneOf(txnOf("t1"))).toBe("needs_review");
    // Same for a message nothing was read out of, and for the flagged half of a
    // duplicate notice.
    expect(laneOf(txnOf("u1"))).toBe("unparsed");
    expect(laneOf(txnOf("d2"))).toBe("duplicate");
  });

  it("does not queue a row whose parts carry the categories", async () => {
    // A split transaction's own `category` stays null while its parts hold the
    // categories. Asking for one again would ask a question already answered.
    const log = [
      ...fixtureLog(),
      entry(
        op({
          type: "txn_split",
          entity: { kind: "txn", id: "c1" },
          parentVersion: 1,
          payload: {
            parts: [
              { category: "Fuel", amount_minor: "9000" },
              { category: "Snacks", amount_minor: "3000" },
            ],
          },
        }),
        DEVICE,
      ),
    ];
    const db2 = await openBrowserDriver(`review-split-${crypto.randomUUID()}`);
    const split = fold(log, emptyState());
    await project(db2, split);
    expect(split.txns.get("c1")!.category).toBeNull();
    expect(laneOf(split.txns.get("c1")!)).toBeNull();
    expect(lanePage(db2, "uncategorized", { limit: 100 })).toEqual([]);
    db2.close();
  });

  it("clears the item once it is answered, and touches no other lane", async () => {
    // The deck's own commit path — the one author of a categorisation — and
    // then the fold the sync would perform.
    const specs = confirmOps({
      txn: readTxns(db).get("c1")!,
      category: "Fuel",
      projectedVersion: 1,
      pending: [],
      rules: [],
      newID: () => "rule-new",
    });
    // The base log is built FIRST: `entry` hands out sequence numbers in call
    // order, and an answer numbered before the ingest it answers is a log no
    // fold will accept.
    const base = fixtureLog();
    const answered = specs.map((spec) =>
      entry(
        op({
          type: spec.type,
          entity: spec.entity!,
          parentVersion: spec.parentVersion ?? null,
          payload: spec.payload,
          authoredAt: "2026-06-07T10:00:00.000Z",
        }),
        DEVICE,
      ),
    );
    const db2 = await openBrowserDriver(`review-answered-${crypto.randomUUID()}`);
    const after = fold([...base, ...answered], emptyState());
    await project(db2, after);

    expect(lanePage(db2, "uncategorized", { limit: 100 })).toEqual([]);
    expect(after.txns.get("c1")!.category).toBe("Fuel");
    // And the flagged rows are untouched: answering "what category" must not
    // clear a review flag another row legitimately carries.
    expect(after.txns.get("t1")!.needs_review).toBe(true);
    expect(laneCounts(db2)).toEqual({ needs_review: 3, unparsed: 2, duplicate: 1, uncategorized: 0, forks: 1 });
    db2.close();
  });
});

describe("what each card says", () => {
  it("distinguishes the template case from the heuristic one", () => {
    const reasons = lanePage(db, "needs_review", { limit: 100 }).map((i) => `${i.txn.id}:${i.reason}`);
    expect(reasons.sort()).toEqual(["t1:unsigned_headers", "t2:unsigned_headers", "t3:pattern_guess"]);
  });

  it("calls every unparsed card unreadable", () => {
    expect(lanePage(db, "unparsed").every((i) => i.reason === "unreadable")).toBe(true);
  });

  it("carries the row a duplicate card was flagged against", () => {
    const [item] = lanePage(db, "duplicate");
    expect(item!.txn.id).toBe("d2");
    expect(item!.counterpart?.id).toBe("d1");
    expect(item!.key).toBe(duplicateKey(item!.txn));
  });

  it("orders pages newest first and does not repeat a row across pages", () => {
    const first = lanePage(db, "needs_review", { limit: 2, offset: 0 });
    const second = lanePage(db, "needs_review", { limit: 2, offset: 2 });
    expect(first.length).toBe(2);
    expect(second.length).toBe(1);
    const ids = [...first, ...second].map((i) => i.txn.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("dismissals", () => {
  it("removes the item the QUERY returns when dismissed with the key the SCREEN builds", () => {
    // The two key spellings — the decisions' and the SQL's — checked against
    // each other from opposite sides. A comparison of two strings this module
    // built would prove only that it agrees with itself.
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "not_duplicate", "2026-06-07T00:00:00Z");
    expect(lanePage(db, "duplicate")).toEqual([]);
    expect(laneCounts(db).duplicate).toBe(0);
  });

  it("deletes neither row", () => {
    // §3.3 — a duplicate notice is a NOTICE. Both purchases stay live.
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "duplicate_confirmed", "2026-06-07T00:00:00Z");
    const after = readTxns(db);
    expect(after.get("d1")!.superseded_by).toBeNull();
    expect(after.get("d2")!.superseded_by).toBeNull();
    expect(after.get("d1")!.amount_minor).toBe(5_600n);
    expect(after.get("d2")!.amount_minor).toBe(5_600n);
  });

  it("leaves the other unparsed message when one is dismissed", () => {
    const page = lanePage(db, "unparsed");
    setDisposition(db, page[0]!.key, "unparsed", "acknowledged", "2026-06-07T00:00:00Z");
    const left = lanePage(db, "unparsed");
    expect(left.length).toBe(1);
    expect(left[0]!.key).toBe(page[1]!.key);
  });

  it("puts it back when restored", () => {
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "not_duplicate", "2026-06-07T00:00:00Z");
    clearDisposition(db, item!.key);
    expect(lanePage(db, "duplicate").length).toBe(1);
    expect(dispositionOf(db, item!.key)).toBeNull();
  });

  it("survives a projection rebuild", async () => {
    // The reason the table is NOT part of PROJECTION_SCHEMA: `project()` clears
    // its own tables every time it runs, and a dismissal that vanished on the
    // next fold would put every answered notice back on the glass.
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "not_duplicate", "2026-06-07T00:00:00Z");
    await project(db, state);
    expect(lanePage(db, "duplicate")).toEqual([]);
    expect(dispositionOf(db, item!.key)?.answer).toBe("not_duplicate");
  });

  it("acknowledges a fork notice, and its key survives a rebuild too", async () => {
    const [f] = forkPage(db);
    expect(f!.notice.winner_op).not.toBe(f!.notice.loser_op);
    setDisposition(db, f!.key, "forks", "acknowledged", "2026-06-07T00:00:00Z");
    expect(forkPage(db)).toEqual([]);
    expect(laneCounts(db).forks).toBe(0);
    await project(db, state);
    expect(forkPage(db)).toEqual([]);
  });

  it("changes an answer without making it two answers", () => {
    const [item] = lanePage(db, "duplicate");
    setDisposition(db, item!.key, "duplicate", "not_duplicate", "2026-06-07T00:00:00Z");
    setDisposition(db, item!.key, "duplicate", "duplicate_confirmed", "2026-06-08T00:00:00Z");
    expect(dispositionOf(db, item!.key)?.answer).toBe("duplicate_confirmed");
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_disposition").all()).toEqual([{ n: 1 }]);
  });
});

describe("the money summary", () => {
  it("finds no money at all in the unparsed lane", async () => {
    const m = await laneMoney(db, "unparsed");
    expect(m.counted).toBe(0);
    expect(m.excluded).toBe(2);
    expect(m.totalHomeMinor).toBe(0n);
  });

  it("sums only rows that count toward money", async () => {
    const m = await laneMoney(db, "needs_review");
    expect(m.counted).toBe(3);
    expect(m.excluded).toBe(0);
    // 25000 + 8800 + 1500, frozen at the identity rate for the home currency.
    expect(m.totalHomeMinor).toBe(35_300n);
    expect(m.awaitingRate).toBe(0);
  });

  it("drops a dismissed row from the total", async () => {
    const [item] = lanePage(db, "needs_review", { limit: 1 });
    setDisposition(db, item!.key, "needs_review", "acknowledged", "2026-06-07T00:00:00Z");
    const m = await laneMoney(db, "needs_review");
    expect(m.counted).toBe(2);
  });

  it("chunks and yields rather than reading the lane whole", async () => {
    const yields: number[] = [];
    const m = await laneMoney(db, "needs_review", { chunkSize: 1, between: (n) => void yields.push(n) });
    expect(m.counted).toBe(3);
    expect(m.totalHomeMinor).toBe(35_300n);
    expect(yields.length).toBeGreaterThanOrEqual(2);
  });

  it("counts a currency with no rate but does not sum it", async () => {
    // Proves `awaitingRate` is real rather than a field that is always zero.
    const usd = fold([ingested("f1", "m9", { ...DIB, currency: "USD", amount_minor: "1000" })], state);
    const db2 = await openBrowserDriver(`review-usd-${crypto.randomUUID()}`);
    await project(db2, usd);
    const m = await laneMoney(db2, "needs_review");
    expect(m.counted).toBe(4);
    expect(m.awaitingRate).toBe(1);
    expect(m.totalHomeMinor).toBe(35_300n);
    db2.close();
  });
});

describe("the rest of what the screen reads", () => {
  it("returns categories most-used first, with rule-only categories after", () => {
    const cats = topCategories(db);
    expect(cats[0]).toBe("Groceries");
    expect(cats).toContain("Streaming");
  });

  it("returns rules for the write-back's duplicate check", () => {
    expect(rulesOf(db)).toEqual([
      { pattern: "lulu", match: "exact", category: "Groceries", priority: 0, version: 1 },
    ]);
  });

  it("takes the version a confirm names from the projection, not from the card", () => {
    expect(versionOf(db, "s1")).toBe(3);
    expect(versionOf(db, "nope")).toBeNull();
  });

  it("attaches splits to a page's rows in one statement", () => {
    db.prepare("INSERT INTO txn_split (txn_id, idx, category, amount_minor) VALUES (?, ?, ?, ?)").run(
      "t1",
      0,
      "Groceries",
      "20000",
    );
    db.prepare("INSERT INTO txn_split (txn_id, idx, category, amount_minor) VALUES (?, ?, ?, ?)").run(
      "t1",
      1,
      "Household",
      "5000",
    );
    const item = lanePage(db, "needs_review", { limit: 100 }).find((i) => i.txn.id === "t1");
    expect(item!.txn.splits.map((s) => s.amount_minor)).toEqual([20_000n, 5_000n]);
  });
});

describe("the source the screen is handed", () => {
  it("answers every question the screen asks", async () => {
    const src = sqlReviewSource(db, () => "2026-06-07T00:00:00Z");
    expect(await src.counts()).toEqual({ needs_review: 3, unparsed: 2, duplicate: 1, uncategorized: 1, forks: 1 });
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
  it("keys a page on the entity id, so nothing groups on what the user sees", () => {
    for (const item of lanePage(db, "unparsed")) expect(item.key).toBe(itemKey(item.txn));
  });
});

// ---------------------------------------------------------------------------
// The ops an answer produces
// ---------------------------------------------------------------------------

describe("confirming a card", () => {
  const txnOf = (id: string) => {
    const t = readTxns(db).get(id);
    if (t === undefined) throw new Error(`fixture has no ${id}`);
    return t;
  };

  it("emits the categorisation and the merchant rule together", () => {
    const specs = confirmOps({
      txn: txnOf("t1"),
      category: "Groceries",
      projectedVersion: 1,
      pending: [],
      rules: [],
      newID: () => "rule-new",
    });
    expect(specs.map((s) => s.type)).toEqual(["txn_categorized", "rule_added"]);
    expect(specs[0]!.payload).toEqual({ category: "Groceries", needs_review: false });
    expect(specs[0]!.parentVersion).toBe(1);
    expect(specs[1]!.payload).toMatchObject({ match: "exact", category: "Groceries", priority: 0 });
  });

  it("does not write the same rule twice", () => {
    const rule = (confirmOps({
      txn: txnOf("t1"),
      category: "Groceries",
      projectedVersion: 1,
      pending: [],
      rules: [],
      newID: () => "rule-new",
    })[1]!.payload) as { pattern: string };
    const again = confirmOps({
      txn: txnOf("t1"),
      category: "Groceries",
      projectedVersion: 1,
      pending: [],
      rules: [{ pattern: rule.pattern, match: "exact", category: "Groceries", priority: 0, version: 1 }],
      newID: () => "rule-new",
    });
    expect(again.map((s) => s.type)).toEqual(["txn_categorized"]);
  });

  it("names a parent past every op this device has already queued", () => {
    const queued: Op[] = [
      {
        v: 1,
        type: "txn_categorized",
        op_id: "queued-1",
        authored_at: "2026-06-06T12:00:00.000Z",
        entity: { kind: "txn", id: "t1" },
        parent_version: 1,
        payload: { category: "Dining", needs_review: false },
      },
    ];
    // Without this the undo would name the same parent as the confirm, which is
    // a fork against yourself — and inside one millisecond the LATER op is the
    // one discarded, so the undo would silently vanish.
    expect(nextParentVersion("t1", 1, queued)).toBe(2);
    const specs = undoConfirmOps({ txn: txnOf("t1"), projectedVersion: 1, pending: queued });
    expect(specs[0]!.parentVersion).toBe(2);
    expect(specs[0]!.payload).toEqual({ category: txnOf("t1").category, needs_review: true });
  });

  it("keeps a card off the deck once its answer is queued, before any fold", () => {
    const queued: Op[] = [
      {
        v: 1,
        type: "txn_categorized",
        op_id: "queued-1",
        authored_at: "2026-06-06T12:00:00.000Z",
        entity: { kind: "txn", id: "t1" },
        parent_version: 1,
        payload: { category: "Dining", needs_review: false },
      },
    ];
    const settlement = settledBy(queued);
    expect(isSettled(txnOf("t1"), settlement)).toBe(true);
    expect(isSettled(txnOf("t2"), settlement)).toBe(false);
  });

  // A list cannot take the row off the screen the way the deck takes a card off
  // the pile, so it has to be able to SHOW the queued answer — otherwise a user
  // sees no change, answers again, and two answers for one merchant is how a
  // contradicting rule gets written.

  const categorized = (id: string, category: string | null, needsReview: boolean, op: string): Op => ({
    v: 1,
    type: "txn_categorized",
    op_id: op,
    authored_at: "2026-06-06T12:00:00.000Z",
    entity: { kind: "txn", id },
    parent_version: 1,
    payload: { category, needs_review: needsReview },
  });

  it("reads a row's queued answer, taking the last one when it was answered twice", () => {
    const answered = pendingCategories([
      categorized("t1", "Dining", false, "q1"),
      categorized("t1", "Groceries", false, "q2"),
    ]);
    // The version the op produces, which is what the answer expires against.
    expect(answered.get("t1")).toEqual({ category: "Groceries", needs_review: false, version: 2 });

    const shown = withPendingCategory(txnOf("t1"), answered);
    expect(shown.category).toBe("Groceries");
    expect(shown.needs_review).toBe(false);
    // Only what the op carries: money and identity are untouched, because
    // `txn_categorized` does not touch them either.
    expect(shown.amount_minor).toBe(txnOf("t1").amount_minor);
    expect(shown.id).toBe(txnOf("t1").id);
    // A row with no queued answer is returned as-is — the SAME object, so a
    // list's memo does not see a new identity for every unanswered row.
    const untouched = txnOf("t2");
    expect(withPendingCategory(untouched, answered)).toBe(untouched);
  });

  it("stops applying an answer once the projection has reached its version", () => {
    // An answer is evidence only while the projection is BEHIND the op that
    // produced it. At or past that version the fold has happened and the
    // projection is the truth — including when a peer's op won the fork, which
    // is exactly the case where a remembered answer would otherwise show a
    // category the log does not hold.
    const row = txnOf("t1");
    const behind = new Map([["t1", { category: "Dining", needs_review: false, version: row.version + 1 }]]);
    expect(withPendingCategory(row, behind).category).toBe("Dining");

    const caughtUp = new Map([["t1", { category: "Dining", needs_review: false, version: row.version }]]);
    expect(withPendingCategory(row, caughtUp)).toBe(row);
  });

  it("counts a queued rule as a rule, so one merchant is not ruled on twice", () => {
    const queued: Op[] = [
      {
        v: 1,
        type: "rule_added",
        op_id: "q-rule",
        authored_at: "2026-06-06T12:00:00.000Z",
        entity: { kind: "rule", id: "r1" },
        parent_version: null,
        payload: { pattern: "carrefour", match: "exact", category: "Groceries", priority: 0 },
      },
    ];
    expect(pendingRules(queued)).toEqual([
      { pattern: "carrefour", match: "exact", category: "Groceries", priority: 0, version: 0 },
    ]);

    // There is no rule-delete op, and two `exact` rules on one pattern at one
    // priority are resolved by comparing the categories' code points — so a
    // "correction" would silently hand the merchant to whichever sorts first,
    // forever. A screen has to be able to see that a rule already exists, and
    // within one offline session the outbox is the only place it exists.
    expect(existingRuleCategory("CARREFOUR", [], queued)).toBe("Groceries");
    expect(existingRuleCategory("CARREFOUR", [], [])).toBeNull();
    expect(existingRuleCategory("SPINNEYS", [], queued)).toBeNull();
  });
});
