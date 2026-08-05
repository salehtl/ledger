import { beforeAll, describe, expect, test } from "bun:test";

import { bunDriver } from "@ledger/client/store/driver.ts";
import type { SqlDriver } from "@ledger/client/store/driver.ts";
import { fold, INGEST_WRITER_ID } from "@ledger/client/replay/replay.ts";
import type { LogEntry } from "@ledger/client/replay/replay.ts";
import { project } from "@ledger/client/replay/projection.ts";
import type { Txn } from "@ledger/client/replay/state.ts";
import type { Op } from "@ledger/client/wire/op.ts";

import {
  EMPTY_FILTERS,
  buildTxnQuery,
  cursorOf,
  filtersActive,
  listTransactions,
  readForkNoticesFor,
  readTxn,
  txnAmountLabel,
  txnCategoryLabel,
  txnMarkers,
  txnTotals,
  withFilterToggled,
} from "./transactions.ts";

// ---------------------------------------------------------------------------
// A log, folded and projected by production code
//
// The rows are NOT inserted into `txn` by hand. Phase 1's exit test went green
// over a production gap precisely because it performed setup production was
// supposed to perform, so this builds ops, folds them with `fold`, and projects
// them with `project` — the same two functions the sync engine calls.
//
// The fixture is hostile on purpose, in the shape v1's harness proved finds
// bugs: a merchant wider than any phone, a 250,000 amount, two currencies with
// one of them carrying no rate at all, an unparsed row, a supersede, a
// same-instant pair, a split, and a concurrent fork.
// ---------------------------------------------------------------------------

const WIDE = "SUPERMARKET AND GENERAL TRADING LLC DUBAI INTERNET CITY BRANCH 0001";
const DEVICE = "device-a";
const OTHER_DEVICE = "device-b";

function hex(n: number): string {
  return n.toString(16).padStart(64, "0");
}

let seq = 0n;
function entry(op: Op, writer = INGEST_WRITER_ID): LogEntry {
  seq += 1n;
  return { op, seq, writer_id: writer };
}

interface IngestFields {
  amount: string;
  currency: string;
  direction: "debit" | "credit";
  posted_at: string;
  merchant: string;
  last4?: string;
  category?: string | null;
  needs_review?: boolean;
}

function ingested(id: string, ingestN: number, f: IngestFields): LogEntry {
  return entry({
    v: 1,
    type: "txn_ingested",
    op_id: `op-ingest-${id}`,
    authored_at: "2026-07-01T00:00:00.000Z",
    entity: { kind: "txn", id },
    parent_version: null,
    ingest_id: hex(ingestN),
    payload: {
      amount_minor: f.amount,
      currency: f.currency,
      direction: f.direction,
      posted_at: f.posted_at,
      merchant_raw: f.merchant,
      last4: f.last4 ?? "1234",
      category: f.category ?? null,
      needs_review: f.needs_review ?? false,
      tier: "template",
    },
  });
}

function unparsed(id: string, ingestN: number, posted_at: string): LogEntry {
  return entry({
    v: 1,
    type: "txn_ingested",
    op_id: `op-ingest-${id}`,
    authored_at: "2026-07-01T00:00:00.000Z",
    entity: { kind: "txn", id },
    parent_version: null,
    ingest_id: hex(ingestN),
    payload: {
      amount_minor: "0",
      currency: "",
      direction: "",
      posted_at,
      merchant_raw: "",
      last4: "",
      category: null,
      needs_review: true,
      unparsed: true,
      tier: "none",
    },
  });
}

let db: SqlDriver;
let all: Txn[];

beforeAll(async () => {
  const log: LogEntry[] = [
    // Home currency, so AED rows freeze and USD rows do not.
    entry({
      v: 1,
      type: "home_currency_set",
      op_id: "op-home",
      authored_at: "2026-07-01T00:00:00.000Z",
      parent_version: null,
      payload: { currency: "AED" },
    }),
    ingested("t1", 1, { amount: "2450", currency: "AED", direction: "debit", posted_at: "2026-07-10T08:00:00Z", merchant: "CARREFOUR", category: "Groceries" }),
    ingested("t2", 2, { amount: "25000000", currency: "AED", direction: "debit", posted_at: "2026-07-10T09:00:00Z", merchant: WIDE, category: "Home" }),
    // A foreign row with NO rate ever set: amount_home_minor stays null.
    ingested("t3", 3, { amount: "1009", currency: "USD", direction: "debit", posted_at: "2026-07-11T10:00:00Z", merchant: "GITHUB", category: null, needs_review: true }),
    ingested("t4", 4, { amount: "500000", currency: "AED", direction: "credit", posted_at: "2026-07-12T10:00:00Z", merchant: "SALARY", category: "Income" }),
    // Two rows at the SAME instant — the keyset cursor has to break the tie or
    // paging skips one of them.
    ingested("t5", 5, { amount: "1000", currency: "AED", direction: "debit", posted_at: "2026-07-13T10:00:00Z", merchant: "SAME INSTANT A", category: "Dining" }),
    ingested("t6", 6, { amount: "2000", currency: "AED", direction: "debit", posted_at: "2026-07-13T10:00:00Z", merchant: "SAME INSTANT B", category: "Dining" }),
    // The row no tier could read.
    unparsed("t7", 7, "2026-07-14T10:00:00Z"),
    // A user-authored row: provenance "user", tier "none", real money.
    entry(
      {
        v: 1,
        type: "txn_ingested",
        op_id: "op-ingest-t8",
        authored_at: "2026-07-15T10:00:00.000Z",
        entity: { kind: "txn", id: "t8" },
        parent_version: null,
        ingest_id: hex(8),
        payload: {
          amount_minor: "7500",
          currency: "AED",
          direction: "debit",
          posted_at: "2026-07-15T10:00:00Z",
          merchant_raw: "CASH LUNCH",
          last4: "",
          category: "Dining",
          needs_review: false,
          tier: "none",
        },
      },
      DEVICE,
    ),
    // A supersede: t9 retires, t9b replaces it.
    ingested("t9", 9, { amount: "111", currency: "AED", direction: "debit", posted_at: "2026-07-16T10:00:00Z", merchant: "MISREAD", category: null }),
    entry({
      v: 1,
      type: "txn_superseded",
      op_id: "op-supersede-t9",
      authored_at: "2026-07-17T10:00:00.000Z",
      entity: { kind: "txn", id: "t9b" },
      parent_version: null,
      ingest_id: hex(9),
      payload: {
        amount_minor: "11100",
        currency: "AED",
        direction: "debit",
        posted_at: "2026-07-16T10:00:00Z",
        merchant_raw: "CORRECTLY READ",
        last4: "1234",
        category: "Shopping",
        needs_review: false,
        tier: "template",
      },
    }),
    // A split, summing exactly to its parent.
    entry({
      v: 1,
      type: "txn_split",
      op_id: "op-split-t2",
      authored_at: "2026-07-18T10:00:00.000Z",
      entity: { kind: "txn", id: "t2" },
      parent_version: 1,
      payload: {
        parts: [
          { category: "Home", amount_minor: "15000000" },
          { category: "Groceries", amount_minor: "10000000" },
        ],
      },
    }),
    // A concurrent fork on t1: two devices categorize against version 1.
    entry(
      {
        v: 1,
        type: "txn_categorized",
        op_id: "op-cat-a",
        authored_at: "2026-07-19T10:00:00.000Z",
        entity: { kind: "txn", id: "t1" },
        parent_version: 1,
        payload: { category: "Groceries", needs_review: false },
      },
      DEVICE,
    ),
    entry(
      {
        v: 1,
        type: "txn_categorized",
        op_id: "op-cat-b",
        authored_at: "2026-07-19T10:00:05.000Z",
        entity: { kind: "txn", id: "t1" },
        parent_version: 1,
        payload: { category: "Dining", needs_review: false },
      },
      OTHER_DEVICE,
    ),
  ];

  const state = fold(log);
  db = bunDriver(":memory:");
  await project(db, state);
  all = listTransactions(db, EMPTY_FILTERS, { limit: 100, after: null }).rows;
});

describe("the fixture is what the tests think it is", () => {
  test("it folded without losing anything to an anomaly we did not intend", () => {
    // Two of something for everything that partitions: two currencies, two
    // writers, two same-instant rows, two split parts, two fork sides.
    expect(all.length).toBe(9); // t9 is superseded and excluded by default
    expect(new Set(all.map((t) => t.currency))).toEqual(new Set(["AED", "USD", ""]));
    expect(new Set(all.map((t) => t.provenance))).toEqual(new Set(["ingest", "user"]));
  });

  test("the USD row really has no home-currency snapshot", () => {
    const usd = all.find((t) => t.id === "t3");
    expect(usd?.amount_home_minor).toBe(null);
    expect(all.find((t) => t.id === "t1")?.amount_home_minor).toBe(2450n);
  });

  test("money came back as bigint, at a magnitude a double would round", () => {
    const big = all.find((t) => t.id === "t2");
    expect(big?.amount_minor).toBe(25_000_000n);
    expect(typeof big?.amount_minor).toBe("bigint");
  });
});

describe("ordering and paging", () => {
  test("newest first, with a stable tiebreak", () => {
    const posted = all.map((t) => t.posted_at);
    expect([...posted].sort().reverse()).toEqual(posted);
    // The two same-instant rows are adjacent and ordered by id descending.
    const same = all.filter((t) => t.posted_at === "2026-07-13T10:00:00.000Z").map((t) => t.id);
    expect(same).toEqual(["t6", "t5"]);
  });

  test("keyset paging visits every row exactly once, including the tied pair", () => {
    const seen: string[] = [];
    let after = null as ReturnType<typeof cursorOf> | null;
    for (let page = 0; page < 20; page++) {
      const got = listTransactions(db, EMPTY_FILTERS, { limit: 2, after });
      if (got.rows.length === 0) break;
      seen.push(...got.rows.map((t) => t.id));
      after = got.next;
      if (after === null) break;
    }
    expect(seen).toEqual(all.map((t) => t.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("the page reports a next cursor only while there is more", () => {
    const first = listTransactions(db, EMPTY_FILTERS, { limit: 2, after: null });
    expect(first.next).not.toBe(null);
    const whole = listTransactions(db, EMPTY_FILTERS, { limit: 100, after: null });
    expect(whole.next).toBe(null);
  });

  test("the query is bound to the window, never to the table", () => {
    const { sql, params } = buildTxnQuery(EMPTY_FILTERS, { limit: 50, after: null });
    expect(sql).toContain("LIMIT ?");
    expect(params[params.length - 1]).toBe(51); // limit + 1, to detect "more"
    expect(sql).toContain("ORDER BY posted_at DESC, id DESC");
  });

  test("refuses a limit that is not a positive integer", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildTxnQuery(EMPTY_FILTERS, { limit, after: null })).toThrow();
    }
  });
});

describe("filters", () => {
  const ids = (f: Parameters<typeof listTransactions>[1]) =>
    listTransactions(db, f, { limit: 100, after: null }).rows.map((t) => t.id);

  test("a superseded row is out by default and in on request", () => {
    expect(ids(EMPTY_FILTERS)).not.toContain("t9");
    expect(ids(EMPTY_FILTERS)).toContain("t9b");
    expect(ids({ ...EMPTY_FILTERS, includeSuperseded: true })).toContain("t9");
  });

  test("OR within a dimension", () => {
    expect(ids({ ...EMPTY_FILTERS, currencies: ["USD"] })).toEqual(["t3"]);
    expect(ids({ ...EMPTY_FILTERS, currencies: ["USD", "AED"] }).length).toBe(8);
    expect(ids({ ...EMPTY_FILTERS, directions: ["credit"] })).toEqual(["t4"]);
  });

  test("AND across dimensions", () => {
    expect(ids({ ...EMPTY_FILTERS, directions: ["debit"], currencies: ["USD"] })).toEqual(["t3"]);
    expect(ids({ ...EMPTY_FILTERS, directions: ["credit"], currencies: ["USD"] })).toEqual([]);
  });

  test("an uncategorized row is selectable, and null is not the same as absent", () => {
    // t3 has category null. Selecting [null] must find it and must not find the
    // rows that merely have a different category.
    expect(ids({ ...EMPTY_FILTERS, categories: [null] })).toEqual(["t7", "t3"]);
    // t1 is Dining because the fork below re-categorized it — the winner's
    // payload is what the projection holds.
    expect(ids({ ...EMPTY_FILTERS, categories: ["Dining"] })).toEqual(["t8", "t6", "t5", "t1"]);
    expect(ids({ ...EMPTY_FILTERS, categories: ["Dining", null] }).length).toBe(6);
  });

  test("the flag dimension finds the rows the review queue will want", () => {
    expect(ids({ ...EMPTY_FILTERS, flags: ["unparsed"] })).toEqual(["t7"]);
    expect(ids({ ...EMPTY_FILTERS, flags: ["needs_review"] })).toEqual(["t7", "t3"]);
    expect(ids({ ...EMPTY_FILTERS, flags: ["split"] })).toEqual(["t2"]);
  });

  test("provenance separates the two writers", () => {
    expect(ids({ ...EMPTY_FILTERS, provenance: ["user"] })).toEqual(["t8"]);
    expect(ids({ ...EMPTY_FILTERS, provenance: ["ingest"] }).length).toBe(8);
  });

  test("the text query matches a merchant case-insensitively and escapes wildcards", () => {
    expect(ids({ ...EMPTY_FILTERS, query: "carrefour" })).toEqual(["t1"]);
    expect(ids({ ...EMPTY_FILTERS, query: "INTERNET CITY" })).toEqual(["t2"]);
    // A bare % must not match everything — it is a literal the user typed.
    expect(ids({ ...EMPTY_FILTERS, query: "%" })).toEqual([]);
    expect(ids({ ...EMPTY_FILTERS, query: "_" })).toEqual([]);
  });

  test("filtersActive counts every selected value across every dimension", () => {
    expect(filtersActive(EMPTY_FILTERS)).toBe(0);
    expect(filtersActive({ ...EMPTY_FILTERS, query: "  " })).toBe(0);
    expect(filtersActive({ ...EMPTY_FILTERS, directions: ["debit"], categories: [null], query: "x" })).toBe(3);
  });

  test("toggling a chip adds then removes it, and never mutates the input", () => {
    const on = withFilterToggled(EMPTY_FILTERS, "directions", "debit");
    expect(on.directions).toEqual(["debit"]);
    expect(EMPTY_FILTERS.directions).toEqual([]);
    expect(withFilterToggled(on, "directions", "debit").directions).toEqual([]);
    // null is a real category value, and toggling it must round-trip too.
    const uncategorized = withFilterToggled(EMPTY_FILTERS, "categories", null);
    expect(uncategorized.categories).toEqual([null]);
    expect(withFilterToggled(uncategorized, "categories", null).categories).toEqual([]);
  });
});

describe("splits come back with their rows, in order", () => {
  test("the parent carries its parts and they sum to it", () => {
    const parent = all.find((t) => t.id === "t2");
    expect(parent?.splits.map((s) => [s.category, s.amount_minor])).toEqual([
      ["Home", 15_000_000n],
      ["Groceries", 10_000_000n],
    ]);
    const sum = (parent?.splits ?? []).reduce((a, s) => a + s.amount_minor, 0n);
    expect(sum).toBe(parent?.amount_minor as bigint);
  });

  test("a row with no splits gets an empty list, not another row's", () => {
    expect(all.find((t) => t.id === "t1")?.splits).toEqual([]);
  });

  test("one statement fetches the whole page's parts", () => {
    // Two split parents, so "the right parts on the right row" is distinguishable
    // from "all the parts on every row".
    const page = listTransactions(db, EMPTY_FILTERS, { limit: 100, after: null }).rows;
    const withParts = page.filter((t) => t.splits.length > 0);
    expect(withParts.map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("txnTotals excludes unparsed rows through countsTowardMoney", () => {
  test("the unparsed row is counted as unreadable and added to nothing", () => {
    const totals = txnTotals(all);
    expect(totals.rows).toBe(9);
    expect(totals.unreadable).toBe(1);
    expect(totals.counted).toBe(8);
    // It has currency "", so a total that let it through would open a bucket
    // under the empty string. That bucket must not exist.
    expect(totals.byCurrency.has("")).toBe(false);
  });

  test("it groups by currency — with two currencies present, so grouping is visible", () => {
    const totals = txnTotals(all);
    expect([...totals.byCurrency.keys()].sort()).toEqual(["AED", "USD"]);
    const aed = totals.byCurrency.get("AED");
    expect(aed?.debit).toBe(2450n + 25_000_000n + 1000n + 2000n + 7500n + 11100n);
    expect(aed?.credit).toBe(500000n);
    expect(totals.byCurrency.get("USD")).toEqual({ debit: 1009n, credit: 0n, count: 1 });
  });

  test("the home total counts only rows that actually have a snapshot", () => {
    const totals = txnTotals(all);
    expect(totals.home.unconverted).toBe(1); // the USD row, no rate ever set
    expect(totals.home.converted).toBe(7);
    expect(totals.home.debit).toBe(2450n + 25_000_000n + 1000n + 2000n + 7500n + 11100n);
  });

  test("an all-unparsed set totals to nothing rather than to zero money", () => {
    const totals = txnTotals(all.filter((t) => t.unparsed));
    expect(totals.counted).toBe(0);
    expect(totals.byCurrency.size).toBe(0);
    expect(totals.home.converted).toBe(0);
  });
});

describe("row presentation", () => {
  test("an unparsed row never renders as a 0.00 transaction", () => {
    const row = all.find((t) => t.id === "t7");
    expect(row).toBeDefined();
    const label = txnAmountLabel(row as Txn);
    expect(label.unreadable).toBe(true);
    expect(label.text).not.toContain("0.00");
    expect(txnCategoryLabel(row as Txn)).toBe("Couldn't read this one");
  });

  test("a parsed row renders its signed amount", () => {
    expect(txnAmountLabel(all.find((t) => t.id === "t1") as Txn)).toEqual({
      text: "−24.50",
      flow: "out",
      unreadable: false,
    });
    expect(txnAmountLabel(all.find((t) => t.id === "t4") as Txn)).toEqual({
      text: "+5,000.00",
      flow: "in",
      unreadable: false,
    });
  });

  test("a split parent says so instead of naming one category", () => {
    expect(txnCategoryLabel(all.find((t) => t.id === "t2") as Txn)).toBe("Home + Groceries");
  });

  test("an uncategorized parsed row is not called unreadable", () => {
    const row = all.find((t) => t.id === "t3") as Txn;
    expect(txnAmountLabel(row).unreadable).toBe(false);
    expect(txnCategoryLabel(row)).toBe("Uncategorized");
  });

  test("markers name the provenance, the review state and the duplicate notice", () => {
    const kinds = (t: Txn) => txnMarkers(t).map((m) => m.kind);
    expect(kinds(all.find((t) => t.id === "t1") as Txn)).toContain("ingest");
    expect(kinds(all.find((t) => t.id === "t8") as Txn)).not.toContain("ingest");
    expect(kinds(all.find((t) => t.id === "t7") as Txn)).toEqual(expect.arrayContaining(["ingest", "unparsed"]));
    expect(kinds(all.find((t) => t.id === "t3") as Txn)).toContain("needs_review");
    // Every marker carries copy; a marker with no label is an icon nobody can read.
    for (const t of all) for (const m of txnMarkers(t)) expect(m.label.length).toBeGreaterThan(0);
  });
});

describe("readTxn and the fork notices", () => {
  test("reads one row by id, with its splits", () => {
    expect(readTxn(db, "t2")?.splits.length).toBe(2);
    expect(readTxn(db, "nope")).toBe(null);
  });

  test("a concurrent edit from two devices surfaces on the row it forked", () => {
    // Both ops named parent_version 1 on t1. The later authored_at wins; the
    // notice names both, and it is attached to the entity so a detail screen can
    // show "this changed on another device" without scanning the whole list.
    const notices = readForkNoticesFor(db, "t1");
    expect(notices.length).toBe(1);
    expect(notices[0]?.winner_op).toBe("op-cat-b");
    expect(notices[0]?.loser_op).toBe("op-cat-a");
    // And the winner's payload is the one in effect.
    expect(readTxn(db, "t1")?.category).toBe("Dining");
    // The version moved twice: a fork advances it whichever side won.
    expect(readTxn(db, "t1")?.version).toBe(3);
  });

  test("a row with no fork has none — the notice is not a property of every row", () => {
    expect(readForkNoticesFor(db, "t4")).toEqual([]);
  });
});
