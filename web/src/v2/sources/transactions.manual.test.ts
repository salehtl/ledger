/**
 * Manual transaction entry, at the op layer.
 *
 * Every test here folds the ops the screen would actually author, through the
 * real `fold` + `project`, so what is asserted is what replay would do with
 * them — not what this file believes the payload means.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";
import { project } from "@ledger/client/replay/projection";
import { fold, INGEST_WRITER_ID, type LogEntry } from "@ledger/client/replay/replay";
import type { State, Txn } from "@ledger/client/replay/state";
import type { OpSpec } from "@ledger/client/outbox/outbox";
import type { Op } from "@ledger/client/wire/op";
import { validateOp } from "@ledger/client/wire/op";

import { openBrowserDriver } from "../db/driver";
import {
  buildTxnQuery,
  draftOf,
  EMPTY_FILTERS,
  listTransactions,
  manualAmountAdvice,
  manualEditOps,
  manualTxnOps,
  manualTxnPayload,
  matchesFilters,
  moneyEditable,
  newIngestID,
  sqlTxnSource,
  txnMarkers,
  type ManualDraft,
  type TxnFilters,
} from "./transactions";

const DEVICE = "11111111-1111-4111-8111-111111111111";

const DRAFT: ManualDraft = {
  amount: "12.50",
  currency: "AED",
  direction: "debit",
  merchant: "CORNER COFFEE",
  date: "2026-08-09",
  category: "eating out",
};

beforeAll(() => {
  setPlatform(webPlatform);
});

let counter = 0;
function newID(): string {
  counter += 1;
  return `manual-${counter}`;
}

/** The op the outbox would build from a spec, validated exactly as it would be. */
function opOf(spec: OpSpec, n: number): Op {
  const op: Op = {
    v: 1,
    type: spec.type as Op["type"],
    op_id: `op-${n}`,
    authored_at: "2026-08-09T12:00:00.000Z",
    parent_version: spec.parentVersion ?? null,
    payload: spec.payload,
    ...(spec.entity === undefined ? {} : { entity: spec.entity }),
    ...(spec.ingestId === undefined ? {} : { ingest_id: spec.ingestId }),
  };
  // The real path validates before it commits, so a payload this file builds
  // and replay would refuse fails here rather than silently folding to nothing.
  validateOp(op);
  return op;
}

/** Folds specs as if a DEVICE wrote them, unless `writer` says otherwise. */
function foldSpecs(specs: readonly OpSpec[], writer: string = DEVICE): State {
  const log: LogEntry[] = [
    { op: opOf({ type: "home_currency_set", payload: { currency: "AED" }, parentVersion: null }, 0), seq: 1n, writer_id: INGEST_WRITER_ID },
    ...specs.map((s, i) => ({ op: opOf(s, i + 1), seq: BigInt(i + 2), writer_id: writer })),
  ];
  return fold(log);
}

/** The correction ops for one row, or a throw naming the refusal. */
function editSpecs(txn: Txn, draft: ManualDraft): OpSpec[] {
  const built = manualEditOps({ txn, draft, projectedVersion: txn.version, pending: [] });
  if (!built.ok) throw new Error(`the correction was refused: ${built.reason}`);
  return built.specs;
}

function manualSpecs(draft: ManualDraft = DRAFT): OpSpec[] {
  const built = manualTxnOps({ draft, ingestID: newIngestID(), newID });
  if (!built.ok) throw new Error(`the draft was refused: ${built.reason}`);
  return built.specs;
}

describe("a manual entry's provenance", () => {
  it("is user, and the same payload under the ingest writer is ingest — so it comes from the writer, never the payload", () => {
    const specs = manualSpecs();
    const mine = [...foldSpecs(specs).txns.values()][0]!;
    const theirs = [...foldSpecs(specs, INGEST_WRITER_ID).txns.values()][0]!;

    expect(mine.provenance).toBe("user");
    expect(theirs.provenance).toBe("ingest");
  });

  it("can never present as bank-verified", () => {
    const built = manualTxnPayload(DRAFT);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Not merely absent from the fold: absent from the PAYLOAD. `client.ts`
    // throws on a client-supplied `verified_origin_domain` because it is
    // server-attested, so an op carrying one would never even be queued.
    expect(built.payload).not.toHaveProperty("verified_origin_domain");
    expect(built.payload).toMatchObject({ tier: "none", unparsed: false, entry_method: "manual" });

    const t = [...foldSpecs(manualSpecs()).txns.values()][0]!;
    expect(t.verified_origin_domain).toBeNull();
    const kinds = txnMarkers(t).map((m) => m.kind);
    expect(kinds).toContain("manual");
    expect(kinds).not.toContain("ingest");
    expect(txnMarkers(t).find((m) => m.kind === "manual")?.label).toBe("Added by you");
  });
});

describe("a manual entry's amount", () => {
  it("round-trips exactly above 2^53 minor units", () => {
    // 9,007,199,254,740,993 fils — one past Number.MAX_SAFE_INTEGER, which a
    // `number` cannot hold and rounds DOWN to ...992 without complaining. The
    // round-trip THROUGH a number is the assertion; a literal of the same value
    // in this file would have been rounded by the parser too, so comparing two
    // literals would compare two copies of the same corruption.
    const big = 9007199254740993n;
    expect(BigInt(Number(big))).not.toBe(big);

    const t = [...foldSpecs(manualSpecs({ ...DRAFT, amount: "90071992547409.93" })).txns.values()][0]!;
    expect(t.amount_minor).toBe(big);
  });

  it("refuses an empty field instead of reading it as zero", () => {
    expect(manualTxnPayload({ ...DRAFT, amount: "" })).toEqual({ ok: false, reason: "How much was it?" });
    expect(manualAmountAdvice("", "AED")).toBe("How much was it?");
    // The springback this guards against: `Number("")` is 0, and a payload
    // built that way is a real op for a zero-dirham purchase.
    expect(Number("")).toBe(0);
  });

  it("refuses zero, a negative and an over-precise amount, each in its own words", () => {
    expect(manualAmountAdvice("0", "AED")).toBe("A transaction moves money, so it has to be more than AED 0.00.");
    expect(manualAmountAdvice("-5", "AED")).toContain("Pick Income if money came in");
    expect(manualAmountAdvice("1.234", "AED")).toContain("two decimal places");
    expect(manualAmountAdvice("12.50", "AED")).toBe("AED 12.50.");
  });
});

describe("two identical manual entries", () => {
  it("are two transactions, both live, with no op dropped", () => {
    // The same coffee, twice on the same day — which is a thing that happens.
    const state = foldSpecs([...manualSpecs(), ...manualSpecs()]);

    expect(state.txns.size).toBe(2);
    expect([...state.txns.values()].every((t) => t.superseded_by === null)).toBe(true);
    // The second row IS flagged, and that is the right outcome: a
    // `possible_duplicate` is a NOTICE on a row the user can dispose of, and
    // both rows exist and both count. `duplicate_ingest` — what a
    // content-hashed ingest id would produce — is the opposite: the op is
    // refused and there is no second row at all.
    expect(state.anomalies.map((a) => a.kind)).toEqual(["possible_duplicate"]);
    expect([...state.txns.values()].filter((t) => t.possible_duplicate_of !== null)).toHaveLength(1);
  });

  it("would collide if the ingest id were derived from the fields", () => {
    // The bug this is a regression test for, made explicit: reuse one ingest id
    // — which is what a content hash of an identical draft produces — and the
    // second op is dropped with an anomaly instead of becoming a row.
    const shared = newIngestID();
    const twice = [DRAFT, DRAFT].flatMap((d) => {
      const built = manualTxnOps({ draft: d, ingestID: shared, newID });
      if (!built.ok) throw new Error(built.reason);
      return built.specs;
    });
    const state = foldSpecs(twice);

    expect(state.txns.size).toBe(1);
    expect(state.anomalies.map((a) => a.kind)).toEqual(["duplicate_ingest"]);
  });

  it("mints a 64-lower-case-hex ingest id, which validateOp requires", () => {
    const id = newIngestID();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe(newIngestID());
  });
});

describe("correcting a manual entry", () => {
  it("changes the merchant, the day and the category, and clears the review flag", () => {
    const created = manualSpecs({ ...DRAFT, category: null });
    const before = [...foldSpecs(created).txns.values()][0]!;
    expect(before.needs_review).toBe(true);

    const edits = editSpecs(before, { ...draftOf(before), merchant: "CORNER CAFE", date: "2026-08-10", category: "eating out" });
    const after = [...foldSpecs([...created, ...edits]).txns.values()][0]!;

    expect(after.merchant_raw).toBe("CORNER CAFE");
    expect(after.posted_at.slice(0, 10)).toBe("2026-08-10");
    expect(after.category).toBe("eating out");
    expect(after.needs_review).toBe(false);
  });

  it("appends nothing when nothing the op owns changed", () => {
    const before = [...foldSpecs(manualSpecs()).txns.values()][0]!;
    expect(manualEditOps({ txn: before, draft: draftOf(before), projectedVersion: before.version, pending: [] }))
      .toEqual({ ok: true, specs: [] });
  });

  it("corrects the amount, the currency and the type, and the fold takes them", () => {
    const created = manualSpecs();
    const before = [...foldSpecs(created).txns.values()][0]!;
    expect(before.amount_minor).toBe(1250n);

    const edits = editSpecs(before, { ...draftOf(before), amount: "999.99", currency: "USD", direction: "credit" });
    const state = foldSpecs([...created, ...edits]);
    const after = [...state.txns.values()][0]!;

    // No anomaly: the fold ACCEPTED the money, it did not merely tolerate the op.
    expect(state.anomalies).toEqual([]);
    expect(after.amount_minor).toBe(99999n);
    expect(after.currency).toBe("USD");
    expect(after.direction).toBe("credit");
  });

  it("corrects an amount above 2^53 minor units exactly", () => {
    const created = manualSpecs();
    const before = [...foldSpecs(created).txns.values()][0]!;
    const big = 9007199254740993n;
    expect(BigInt(Number(big))).not.toBe(big); // it really is past the float boundary

    const edits = editSpecs(before, { ...draftOf(before), amount: "90071992547409.93" });
    const after = [...foldSpecs([...created, ...edits]).txns.values()][0]!;
    expect(after.amount_minor).toBe(big);
  });

  it("refuses an unreadable amount in words rather than authoring an op", () => {
    const before = [...foldSpecs(manualSpecs()).txns.values()][0]!;
    for (const [amount, reason] of [["", "How much was it?"], ["0", "A transaction moves money, so it has to be more than AED 0.00."]] as const) {
      const built = manualEditOps({ txn: before, draft: { ...draftOf(before), amount }, projectedVersion: before.version, pending: [] });
      expect(built).toEqual({ ok: false, reason });
    }
  });

  it("names only what moved, so an unchanged amount does not reconvert the snapshot", () => {
    const created = manualSpecs();
    const before = [...foldSpecs(created).txns.values()][0]!;
    const built = manualEditOps({ txn: before, draft: { ...draftOf(before), merchant: "CORNER CAFE" }, projectedVersion: before.version, pending: [] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.specs[0]!.payload).toEqual({ merchant_raw: "CORNER CAFE" });
  });

  it("never names the money of a row the mailbox produced, and the fold would refuse it if it did", () => {
    const created = manualSpecs();
    // The same payload under the INGEST writer: a bank row, unforgeably.
    const bankRow = [...foldSpecs(created, INGEST_WRITER_ID).txns.values()][0]!;
    expect(bankRow.provenance).toBe("ingest");
    expect(moneyEditable(bankRow)).toBe(false);

    const built = manualEditOps({
      txn: bankRow,
      draft: { ...draftOf(bankRow), amount: "999.99", currency: "USD", direction: "credit", merchant: "STILL EDITABLE" },
      projectedVersion: bankRow.version,
      pending: [],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    for (const spec of built.specs) {
      for (const key of ["amount_minor", "currency", "direction", "unparsed", "tier", "parse_error"]) {
        expect(spec.payload).not.toHaveProperty(key);
      }
    }

    // And the other half of the rule: had it named them, replay would refuse.
    const forced = foldSpecs([
      ...created,
      { type: "txn_edited", entity: { kind: "txn", id: bankRow.id }, parentVersion: 1, payload: { amount_minor: "99999", merchant_raw: "FIXED" } },
    ], INGEST_WRITER_ID);
    const after = [...forced.txns.values()][0]!;
    expect(after.amount_minor).toBe(1250n);
    expect(after.merchant_raw).toBe("FIXED");
    expect(forced.anomalies.map((a) => a.kind)).toContain("unsupported_edit_field");
  });

  it("cannot be bought with entry_method — the writer decides, and a device cannot be the ingest writer", () => {
    const created = manualSpecs();
    const bankRow = [...foldSpecs(created, INGEST_WRITER_ID).txns.values()][0]!;
    const forced = foldSpecs([
      ...created,
      {
        type: "txn_edited",
        entity: { kind: "txn", id: bankRow.id },
        parentVersion: 1,
        payload: { amount_minor: "1", entry_method: "manual" },
      },
    ], INGEST_WRITER_ID);
    expect([...forced.txns.values()][0]!.amount_minor).toBe(1250n);
    expect(forced.anomalies.map((a) => a.kind)).toContain("unsupported_edit_field");
  });
});

describe("matchesFilters", () => {
  /**
   * It is a second spelling of {@link buildTxnQuery}, for the rows the screen
   * holds before a fold. Two spellings of one filter drift, so both are run over
   * the same rows and required to agree.
   */
  it("agrees with the SQL the list actually uses", async () => {
    const specs = [
      ...manualSpecs({ ...DRAFT, merchant: "CORNER COFFEE", category: "eating out", amount: "12.50" }),
      ...manualSpecs({ ...DRAFT, merchant: "SALARY", direction: "credit", category: null, date: "2026-08-01" }),
      ...manualSpecs({ ...DRAFT, merchant: "GITHUB", currency: "USD", category: "shopping", date: "2026-08-20" }),
    ];
    const state = foldSpecs(specs);
    const db = await openBrowserDriver(`manual-${crypto.randomUUID()}`);
    await project(db, state);
    const source = sqlTxnSource(db);
    const rows = [...state.txns.values()];

    const cases: TxnFilters[] = [
      EMPTY_FILTERS,
      { ...EMPTY_FILTERS, directions: ["credit"] },
      { ...EMPTY_FILTERS, currencies: ["USD"] },
      { ...EMPTY_FILTERS, provenance: ["user"] },
      { ...EMPTY_FILTERS, provenance: ["ingest"] },
      { ...EMPTY_FILTERS, categories: [null] },
      { ...EMPTY_FILTERS, categories: ["shopping"] },
      { ...EMPTY_FILTERS, flags: ["needs_review"] },
      { ...EMPTY_FILTERS, flags: ["confirmed"] },
      { ...EMPTY_FILTERS, query: "corner" },
      { ...EMPTY_FILTERS, from: "2026-08-05", to: "2026-08-15" },
    ];
    for (const f of cases) {
      const fromSQL = source.list(f, { limit: 50, after: null }).rows.map((t) => t.id).sort();
      const fromJS = rows.filter((t) => matchesFilters(t, f)).map((t) => t.id).sort();
      expect(fromJS, `filter ${JSON.stringify(f)}`).toEqual(fromSQL);
    }
    // The `listTransactions` import is what the source calls; naming it keeps
    // this test honest about which query it compared against.
    expect(listTransactions(db, EMPTY_FILTERS, { limit: 50, after: null }).rows).toHaveLength(3);
  });
});
