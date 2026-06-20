import { describe, it, expect } from "vitest";
import {
  monthRange,
  txnTotals,
  applyTxnFilters,
  filtersActive,
  sourceLabel,
  buildManualTxnPayload,
  EMPTY_FILTERS,
  type TxnFilters,
} from "./transactions";
import type { Txn } from "../api/types";

const mkTxn = (over: Partial<Txn>): Txn => ({
  ID: 1, PostedAt: "2026-06-10", AmountFils: 1000, Currency: "AED",
  Direction: "debit", MerchantRaw: "X", Status: "confirmed", Confidence: 0,
  Source: "email", CategoryID: null, CategoryName: "", Bucket: "", ...over,
});

describe("applyTxnFilters", () => {
  const rows: Txn[] = [
    mkTxn({ ID: 1, Bucket: "need", Direction: "debit", CategoryID: 1, Source: "email" }),
    mkTxn({ ID: 2, Bucket: "want", Direction: "debit", CategoryID: 2, Source: "import" }),
    mkTxn({ ID: 3, Bucket: "want", Direction: "credit", CategoryID: null, Source: "ai" }),
  ];

  it("returns all rows when filters are empty", () => {
    expect(applyTxnFilters(rows, EMPTY_FILTERS)).toHaveLength(3);
  });

  it("ORs values within a dimension", () => {
    const f: TxnFilters = { ...EMPTY_FILTERS, buckets: ["need", "want"] };
    expect(applyTxnFilters(rows, f).map((t) => t.ID)).toEqual([1, 2, 3]);
  });

  it("ANDs across dimensions", () => {
    const f: TxnFilters = { ...EMPTY_FILTERS, buckets: ["want"], directions: ["debit"] };
    expect(applyTxnFilters(rows, f).map((t) => t.ID)).toEqual([2]);
  });

  it("matches categories by id and excludes null categories", () => {
    const f: TxnFilters = { ...EMPTY_FILTERS, categoryIds: [2] };
    expect(applyTxnFilters(rows, f).map((t) => t.ID)).toEqual([2]);
    const none: TxnFilters = { ...EMPTY_FILTERS, categoryIds: [99] };
    expect(applyTxnFilters(rows, none)).toHaveLength(0);
  });

  it("filters by source", () => {
    const f: TxnFilters = { ...EMPTY_FILTERS, sources: ["ai"] };
    expect(applyTxnFilters(rows, f).map((t) => t.ID)).toEqual([3]);
  });
});

describe("filtersActive", () => {
  it("counts selected values across dimensions", () => {
    expect(filtersActive(EMPTY_FILTERS)).toBe(0);
    expect(filtersActive({ buckets: ["need"], categoryIds: [1, 2], directions: [], sources: ["ai"] })).toBe(4);
  });
});

describe("sourceLabel", () => {
  it("maps known sources", () => {
    expect(sourceLabel("email")).toBe("Email");
    expect(sourceLabel("ai")).toBe("AI");
  });
  it("prettifies unknown sources", () => {
    expect(sourceLabel("import_derived")).toBe("Import Derived");
  });
});

describe("monthRange", () => {
  it("brackets a month inclusive of timestamped posted_at values", () => {
    const { from, to } = monthRange("2026-06");
    expect(from).toBe("2026-06-01");
    // posted_at is an RFC3339 timestamp; the upper bound must sort after any
    // day+time within June yet before July (backend filter is inclusive <=).
    expect("2026-06-01T00:00:00Z" >= from).toBe(true);
    expect("2026-06-30T23:59:59Z" <= to).toBe(true);
    expect("2026-07-01T00:00:00Z" <= to).toBe(false);
  });

  it("covers the 31st of 31-day months", () => {
    const { to } = monthRange("2026-07");
    expect("2026-07-31T12:00:00Z" <= to).toBe(true);
    expect("2026-08-01T00:00:00Z" <= to).toBe(false);
  });
});

describe("txnTotals", () => {
  const mk = (over: Partial<Txn>): Txn => ({
    ID: 1, PostedAt: "2026-06-10", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "X", Status: "confirmed", Confidence: 0,
    Source: "email", CategoryID: null, CategoryName: "", Bucket: "", ...over,
  });

  it("sums debits as spend and ignores credits", () => {
    const rows = [
      mk({ AmountFils: 5000, Direction: "debit" }),
      mk({ AmountFils: 2000, Direction: "credit" }),
      mk({ AmountFils: 1500, Direction: "debit" }),
    ];
    expect(txnTotals(rows)).toEqual({ count: 3, spentFils: 6500 });
  });

  it("returns zeroes for an empty list", () => {
    expect(txnTotals([])).toEqual({ count: 0, spentFils: 0 });
  });
});

describe("buildManualTxnPayload", () => {
  const base = { merchant: "Carrefour", amountAed: "42.50", direction: "debit", date: "2026-06-15", categoryId: 3 };

  it("builds a payload from valid input", () => {
    const r = buildManualTxnPayload(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({
        posted_at: "2026-06-15", amount_fils: 4250, currency: "AED",
        direction: "debit", merchant_raw: "Carrefour", category_id: 3,
      });
    }
  });

  it("defaults category_id to 0 when none chosen", () => {
    const r = buildManualTxnPayload({ ...base, categoryId: null });
    expect(r.ok && r.payload.category_id).toBe(0);
  });

  it("trims the merchant", () => {
    const r = buildManualTxnPayload({ ...base, merchant: "  Spinneys  " });
    expect(r.ok && r.payload.merchant_raw).toBe("Spinneys");
  });

  it("rejects a blank merchant", () => {
    const r = buildManualTxnPayload({ ...base, merchant: "   " });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    expect(buildManualTxnPayload({ ...base, amountAed: "0" }).ok).toBe(false);
    expect(buildManualTxnPayload({ ...base, amountAed: "-5" }).ok).toBe(false);
    expect(buildManualTxnPayload({ ...base, amountAed: "abc" }).ok).toBe(false);
  });

  it("rejects a bad direction", () => {
    expect(buildManualTxnPayload({ ...base, direction: "sideways" }).ok).toBe(false);
  });

  it("rejects a malformed date", () => {
    expect(buildManualTxnPayload({ ...base, date: "06/15/2026" }).ok).toBe(false);
  });
});
