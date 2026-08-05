import { describe, expect, test } from "bun:test";

import { Client } from "@ledger/client/net/client.ts";
import { Outbox } from "@ledger/client/outbox/outbox.ts";
import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { project } from "@ledger/client/replay/projection.ts";
import { fold, INGEST_WRITER_ID } from "@ledger/client/replay/replay.ts";
import type { LogEntry } from "@ledger/client/replay/replay.ts";
import type { State, Txn } from "@ledger/client/replay/state.ts";
import { bunDriver } from "@ledger/client/store/driver.ts";
import type { SqlDriver } from "@ledger/client/store/driver.ts";
import { memStore } from "@ledger/client/store/store.ts";
import type { Op } from "@ledger/client/wire/op.ts";

import { readForkNoticesFor, readTxn } from "./transactions.ts";
import { commitCategorize, commitSplit, commitTxnEdit, planTxnEdit, type EditDeps } from "./txnEdit.ts";

const DEVICE = "device-a";
const OTHER = "device-b";

function hex(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/**
 * The fixture log. Two parsed rows, one unparsed row, one AED rate head via the
 * home currency and one USD rate so a supersede has something to freeze against.
 */
function baseLog(): LogEntry[] {
  let seq = 0n;
  const at = (op: Op, writer = INGEST_WRITER_ID): LogEntry => {
    seq += 1n;
    return { op, seq, writer_id: writer };
  };
  return [
    at({
      v: 1,
      type: "home_currency_set",
      op_id: "op-home",
      authored_at: "2026-07-01T00:00:00.000Z",
      parent_version: null,
      payload: { currency: "AED" },
    }),
    at({
      v: 1,
      type: "rate_set",
      op_id: "op-rate-usd",
      authored_at: "2026-07-01T00:00:00.000Z",
      parent_version: null,
      payload: { currency: "USD", rate_micro: "3672500" },
    }),
    at({
      v: 1,
      type: "txn_ingested",
      op_id: "op-i1",
      authored_at: "2026-07-10T08:00:00.000Z",
      entity: { kind: "txn", id: "t1" },
      parent_version: null,
      ingest_id: hex(1),
      payload: {
        amount_minor: "2450",
        currency: "AED",
        direction: "debit",
        posted_at: "2026-07-10T08:30:45Z",
        merchant_raw: "CARREF0UR",
        last4: "1234",
        category: null,
        needs_review: true,
        tier: "heuristic",
      },
    }),
    at({
      v: 1,
      type: "txn_ingested",
      op_id: "op-i2",
      authored_at: "2026-07-11T08:00:00.000Z",
      entity: { kind: "txn", id: "t2" },
      parent_version: null,
      ingest_id: hex(2),
      payload: {
        amount_minor: "30000",
        currency: "AED",
        direction: "debit",
        posted_at: "2026-07-11T08:00:00Z",
        merchant_raw: "SPLIT ME",
        last4: "1234",
        category: "Home",
        needs_review: false,
        tier: "template",
      },
    }),
    // The row Task 7 made representable: a message that arrived and could not be
    // read. Amount 0, no currency, no direction.
    at({
      v: 1,
      type: "txn_ingested",
      op_id: "op-i3",
      authored_at: "2026-07-12T08:00:00.000Z",
      entity: { kind: "txn", id: "u1" },
      parent_version: null,
      ingest_id: hex(3),
      payload: {
        amount_minor: "0",
        currency: "",
        direction: "",
        posted_at: "2026-07-12T09:15:00Z",
        merchant_raw: "",
        last4: "",
        category: null,
        needs_review: true,
        unparsed: true,
        tier: "none",
      },
    }),
  ];
}

interface Harness {
  db: SqlDriver;
  deps: EditDeps;
  state: State;
  seq: bigint;
  /** The ops this device has queued, as `Client.emit` built them. */
  queued(): readonly Op[];
  /** Folds queued ops at the next positions and re-projects, as a sync would. */
  sync(writer?: string): Promise<void>;
  refresh(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const log = baseLog();
  const state = fold(log);
  const db = bunDriver(":memory:");
  await project(db, state);

  // A REAL client and a REAL outbox: the op that gets folded below is the op
  // `Client.emit` builds, ulid and authored_at and all, not one this test wrote
  // to look like it. A hand-built op would certify the test's idea of the wire
  // shape rather than the app's.
  const client = new Client({ store: memStore("http://scratch.invalid") });
  const outbox = new Outbox(client);
  let folded = 0;

  const h: Harness = {
    db,
    state,
    seq: BigInt(log.length),
    deps: {
      db,
      enqueue: (spec: OpSpec) => {
        outbox.enqueue(spec);
      },
      newId: (() => {
        let n = 0;
        return () => `new-${++n}`;
      })(),
    },
    queued: () => outbox.pending,
    async sync(writer = DEVICE) {
      const fresh = outbox.pending.slice(folded);
      folded = outbox.pending.length;
      for (const op of fresh) {
        h.seq += 1n;
        fold([{ op, seq: h.seq, writer_id: writer }], h.state);
      }
      await project(db, h.state);
    },
    async refresh() {
      await project(db, h.state);
    },
  };
  return h;
}

function anomalyKinds(s: State): string[] {
  return s.anomalies.map((a) => a.kind);
}

function payloadOf(op: Op): Record<string, unknown> {
  return op.payload as Record<string, unknown>;
}

describe("a category change is a txn_categorized against the row's current head", () => {
  test("it lands, and it changes what it says it changes", async () => {
    const h = await harness();
    const before = anomalyKinds(h.state).length;
    const res = commitCategorize(h.deps, "t1", "Groceries");
    expect(res).toEqual({ ok: true, changed: true, ops: expect.anything(), newId: null });

    const op = h.queued()[0] as Op;
    expect(op.type).toBe("txn_categorized");
    expect(op.parent_version).toBe(1);
    expect(op.entity).toEqual({ kind: "txn", id: "t1" });

    await h.sync();
    const after = readTxn(h.db, "t1") as Txn;
    expect(after.category).toBe("Groceries");
    expect(after.needs_review).toBe(false);
    expect(after.version).toBe(2);
    // The op did something. An edit that lands, consumes a version and changes
    // nothing is the failure this assertion exists to exclude.
    expect(anomalyKinds(h.state).length).toBe(before);
  });

  test("no change at all queues nothing", async () => {
    const h = await harness();
    expect(commitCategorize(h.deps, "t2", "Home", false)).toEqual({ ok: true, changed: false });
    expect(h.queued().length).toBe(0);
  });

  test("the head is re-read at emit, so a sync in between does not fork", async () => {
    const h = await harness();
    // Something else moves the head first — another device's categorization,
    // arriving while this screen was open.
    h.seq += 1n;
    fold(
      [
        {
          op: {
            v: 1,
            type: "txn_categorized",
            op_id: "op-remote",
            authored_at: "2026-07-20T00:00:00.000Z",
            entity: { kind: "txn", id: "t1" },
            parent_version: 1,
            payload: { category: "Dining", needs_review: false },
          },
          seq: h.seq,
          writer_id: OTHER,
        },
      ],
      h.state,
    );
    await h.refresh();

    commitCategorize(h.deps, "t1", "Groceries");
    // Version 2, not the 1 a screen loaded before the sync would have held.
    expect((h.queued()[0] as Op).parent_version).toBe(2);

    await h.sync();
    expect(readTxn(h.db, "t1")?.category).toBe("Groceries");
    expect(readForkNoticesFor(h.db, "t1")).toEqual([]);
  });
});

describe("a merchant or date correction is a txn_edited", () => {
  test("it carries only the fields it changed, and keeps the time of day", async () => {
    const h = await harness();
    const before = anomalyKinds(h.state).length;
    const res = commitTxnEdit(h.deps, "t1", { merchant: "Carrefour", day: "2026-07-09" });
    expect(res.ok).toBe(true);

    const op = h.queued()[0] as Op;
    expect(op.type).toBe("txn_edited");
    expect(Object.keys(payloadOf(op)).sort()).toEqual(["merchant_raw", "posted_at"]);
    expect(payloadOf(op)["posted_at"]).toBe("2026-07-09T08:30:45.000Z");

    await h.sync();
    const after = readTxn(h.db, "t1") as Txn;
    expect(after.merchant_raw).toBe("Carrefour");
    expect(after.posted_at).toBe("2026-07-09T08:30:45.000Z");
    expect(anomalyKinds(h.state).length).toBe(before);
  });

  test("a txn_edited NEVER carries a parse-owned field", async () => {
    // `replay.ts` rejects amount_minor / currency / direction / unparsed / tier /
    // parse_error on an edit and records `unsupported_edit_field`. An edit that
    // carried one would land, consume a version, change nothing, and tell the
    // user nothing.
    const h = await harness();
    commitTxnEdit(h.deps, "t1", {
      merchant: "Carrefour",
      amount: "24.50", // identical to the current amount: not a change
      currency: "AED",
      direction: "debit",
    });
    const op = h.queued()[0] as Op;
    expect(op.type).toBe("txn_edited");
    for (const owned of ["amount_minor", "currency", "direction", "unparsed", "tier", "parse_error"]) {
      expect(Object.keys(payloadOf(op))).not.toContain(owned);
    }
  });

  test("changing only the category still takes the narrow op", async () => {
    const h = await harness();
    commitTxnEdit(h.deps, "t1", { category: "Groceries", needsReview: false });
    expect((h.queued()[0] as Op).type).toBe("txn_categorized");
  });

  test("a superseded row is refused rather than edited into a dead end", async () => {
    const h = await harness();
    commitTxnEdit(h.deps, "t1", { amount: "99.99" });
    await h.sync();
    const res = commitTxnEdit(h.deps, "t1", { merchant: "too late" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors[0]).toContain("replaced");
  });
});

describe("an amount correction is a txn_superseded, because an edit cannot carry one", () => {
  test("the old row retires, the new one is live, and FX is recomputed at its own position", async () => {
    const h = await harness();
    const before = anomalyKinds(h.state).length;
    const res = commitTxnEdit(h.deps, "t1", { amount: "1,024.99", currency: "USD" });
    expect(res).toMatchObject({ ok: true, changed: true, newId: "new-1" });

    const op = h.queued()[0] as Op;
    expect(op.type).toBe("txn_superseded");
    expect(op.parent_version).toBe(null);
    expect(op.ingest_id).toBe(hex(1));
    expect(payloadOf(op)["amount_minor"]).toBe("102499");

    await h.sync();
    const old = readTxn(h.db, "t1") as Txn;
    const fresh = readTxn(h.db, "new-1") as Txn;
    expect(old.superseded_by).toBe(op.op_id);
    expect(fresh.amount_minor).toBe(102499n);
    expect(fresh.currency).toBe("USD");
    // (102499 × 3_672_500 + 500_000) / 1_000_000 = 376_428 — computed fresh at
    // this op's own position, neither inherited from t1 nor left null.
    expect(fresh.amount_home_minor).toBe(376_428n);
    expect(fresh.ingest_id).toBe(old.ingest_id);
    expect(anomalyKinds(h.state).length).toBe(before);
  });

  test("the corrected row is authored by the device, so its provenance says so", async () => {
    const h = await harness();
    commitTxnEdit(h.deps, "t1", { amount: "99.99" });
    await h.sync();
    expect(readTxn(h.db, "t1")?.provenance).toBe("ingest");
    expect(readTxn(h.db, "new-1")?.provenance).toBe("user");
  });
});

describe("rescuing an unparsed row — the row most in need of an edit path", () => {
  test("a row with no amount, no currency and no direction can be entered by hand", async () => {
    const h = await harness();
    const before = anomalyKinds(h.state).length;
    const unparsedRow = readTxn(h.db, "u1") as Txn;
    expect(unparsedRow.unparsed).toBe(true);
    expect(unparsedRow.amount_minor).toBe(0n);
    expect(unparsedRow.currency).toBe("");
    expect(unparsedRow.direction).toBe("");

    const res = commitTxnEdit(h.deps, "u1", {
      amount: "63.75",
      currency: "AED",
      direction: "debit",
      merchant: "TALABAT",
      category: "Dining",
    });
    expect(res).toMatchObject({ ok: true, changed: true, newId: "new-1" });

    const op = h.queued()[0] as Op;
    expect(op.type).toBe("txn_superseded");
    expect(op.ingest_id).toBe(hex(3));

    await h.sync();
    const fixed = readTxn(h.db, "new-1") as Txn;
    expect(fixed.unparsed).toBe(false);
    expect(fixed.tier).toBe("none"); // client-authored, and NOT unparsed
    expect(fixed.amount_minor).toBe(6375n);
    expect(fixed.currency).toBe("AED");
    expect(fixed.direction).toBe("debit");
    expect(fixed.merchant_raw).toBe("TALABAT");
    expect(fixed.category).toBe("Dining");
    expect(fixed.needs_review).toBe(false);
    expect(fixed.amount_home_minor).toBe(6375n); // AED is home: identity rate
    // The message it came from is still joined to it.
    expect(fixed.ingest_id).toBe(unparsedRow.ingest_id);
    // And the empty row is retired rather than deleted (§2: nothing is dropped).
    expect(readTxn(h.db, "u1")?.superseded_by).toBe(op.op_id);
    expect(anomalyKinds(h.state).length).toBe(before);
  });

  test("the naive alternative really does fail silently — which is why the routing exists", async () => {
    // A `txn_edited` carrying the amount. It is a legal op; it lands, consumes a
    // version, and changes nothing except to record that it was refused.
    const h = await harness();
    h.seq += 1n;
    fold(
      [
        {
          op: {
            v: 1,
            type: "txn_edited",
            op_id: "op-naive",
            authored_at: "2026-07-20T00:00:00.000Z",
            entity: { kind: "txn", id: "u1" },
            parent_version: 1,
            payload: { amount_minor: "6375", currency: "AED", direction: "debit" },
          },
          seq: h.seq,
          writer_id: DEVICE,
        },
      ],
      h.state,
    );
    await h.refresh();
    const after = readTxn(h.db, "u1") as Txn;
    expect(after.amount_minor).toBe(0n); // unchanged
    expect(after.version).toBe(2); // but the version moved
    expect(anomalyKinds(h.state)).toContain("unsupported_edit_field");
  });

  test("a half-filled rescue is refused with the reason, not queued", async () => {
    const h = await harness();
    const res = commitTxnEdit(h.deps, "u1", { amount: "63.75" }); // no currency, no direction
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.join(" ")).toContain("currency");
    expect(res.errors.join(" ")).toContain("money in or money out");
    expect(h.queued().length).toBe(0);
  });

  test("an unparsed row can still have its merchant corrected without a rescue", async () => {
    const h = await harness();
    const res = commitTxnEdit(h.deps, "u1", { merchant: "possibly TALABAT" });
    expect(res.ok).toBe(true);
    const op = h.queued()[0] as Op;
    expect(op.type).toBe("txn_edited");
    await h.sync();
    const after = readTxn(h.db, "u1") as Txn;
    expect(after.merchant_raw).toBe("possibly TALABAT");
    expect(after.unparsed).toBe(true); // still unreadable; the money is still missing
  });

  test("an empty amount field is empty, not zero", async () => {
    const h = await harness();
    const res = commitTxnEdit(h.deps, "u1", { amount: "", currency: "AED", direction: "debit" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.join(" ")).toContain("Enter an amount");
    // Number("") === 0 would have produced a 0.00 transaction here.
    expect(h.queued().length).toBe(0);
  });
});

describe("two devices editing at once fork, and the fork is surfaced", () => {
  test("both edits materialise: one wins the value, both are named in a notice", async () => {
    const a = await harness();
    // Device A and device B both plan against version 1 — neither has seen the
    // other. Their ops are built by the same production planner.
    const current = readTxn(a.db, "t1") as Txn;
    const planA = planTxnEdit(current, { category: "Groceries" }, () => "unused");
    const planB = planTxnEdit(current, { category: "Dining" }, () => "unused");
    expect(planA.kind).toBe("edit");
    expect(planB.kind).toBe("edit");
    if (planA.kind !== "edit" || planB.kind !== "edit") throw new Error("unreachable");
    expect(planA.op.parentVersion).toBe(1);
    expect(planB.op.parentVersion).toBe(1);

    a.seq += 1n;
    fold(
      [
        {
          op: {
            v: 1,
            type: "txn_categorized",
            op_id: "op-a",
            authored_at: "2026-07-20T00:00:00.000Z",
            entity: { kind: "txn", id: "t1" },
            parent_version: 1,
            payload: planA.op.payload,
          },
          seq: a.seq,
          writer_id: DEVICE,
        },
      ],
      a.state,
    );
    a.seq += 1n;
    fold(
      [
        {
          op: {
            v: 1,
            type: "txn_categorized",
            op_id: "op-b",
            // Authored LATER, so it wins the tiebreak even though it is second.
            authored_at: "2026-07-20T00:01:00.000Z",
            entity: { kind: "txn", id: "t1" },
            parent_version: 1,
            payload: planB.op.payload,
          },
          seq: a.seq,
          writer_id: OTHER,
        },
      ],
      a.state,
    );
    await a.refresh();

    const notices = readForkNoticesFor(a.db, "t1");
    expect(notices.length).toBe(1);
    expect(notices[0]?.winner_op).toBe("op-b");
    expect(notices[0]?.loser_op).toBe("op-a");
    expect(readTxn(a.db, "t1")?.category).toBe("Dining");
    // The version moved for both, because a version is a function of the total
    // order and not of who won.
    expect(readTxn(a.db, "t1")?.version).toBe(3);
  });
});

describe("splits", () => {
  test("a split that sums exactly is emitted and applies", async () => {
    const h = await harness();
    const before = anomalyKinds(h.state).length;
    const res = commitSplit(h.deps, "t2", [
      { category: "Home", amount: "100" },
      { category: "Groceries", amount: "200" },
    ]);
    expect(res.ok).toBe(true);
    const op = h.queued()[0] as Op;
    expect(op.type).toBe("txn_split");
    expect(op.parent_version).toBe(1);

    await h.sync();
    const after = readTxn(h.db, "t2") as Txn;
    expect(after.splits.map((s) => [s.category, s.amount_minor])).toEqual([
      ["Home", 10000n],
      ["Groceries", 20000n],
    ]);
    expect(anomalyKinds(h.state).length).toBe(before);
  });

  test("a split that does not sum is refused at the keyboard, not in the fold", async () => {
    const h = await harness();
    const res = commitSplit(h.deps, "t2", [
      { category: "Home", amount: "100" },
      { category: "Groceries", amount: "199.99" },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors[0]).toContain("add up");
    expect(h.queued().length).toBe(0);
  });

  test("an unparsed row cannot be split — there is no amount to divide", async () => {
    const h = await harness();
    const res = commitSplit(h.deps, "u1", [{ category: "Dining", amount: "10" }]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors[0]).toContain("no amount");
  });

  test("un-splitting is refused with a reason, because the vocabulary cannot express it", async () => {
    const h = await harness();
    const res = commitSplit(h.deps, "t2", []);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors[0]).toContain("at least one part");
  });

  test("a zero-valued part is refused, since positiveMoney would reject the payload", async () => {
    const h = await harness();
    const res = commitSplit(h.deps, "t2", [
      { category: "Home", amount: "0" },
      { category: "Groceries", amount: "300" },
    ]);
    expect(res.ok).toBe(false);
  });
});

describe("a row that is no longer here", () => {
  test("commits report it rather than throwing into a screen", async () => {
    const h = await harness();
    expect(commitTxnEdit(h.deps, "nope", { merchant: "x" })).toEqual({
      ok: false,
      errors: ["That transaction is no longer on this device."],
    });
    expect(commitSplit(h.deps, "nope", [{ category: "a", amount: "1" }]).ok).toBe(false);
  });
});
