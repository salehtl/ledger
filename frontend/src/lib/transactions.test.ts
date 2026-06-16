import { describe, it, expect } from "vitest";
import { monthRange, txnTotals } from "./transactions";
import type { Txn } from "../api/types";

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
