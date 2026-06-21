import { describe, it, expect } from "vitest";
import type { Txn } from "../api/types";
import type { BucketComparison, CategoryDelta } from "./insights";
import { bucketRows, categoryRows, merchantRows } from "./lens";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "M", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 1, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "",
    ...p,
  };
}

describe("bucketRows", () => {
  it("ranks by spend with share and month-over-month delta", () => {
    const buckets: BucketComparison[] = [
      { bucket: "need", spent: 400, prevSpent: 500, delta: -100 },
      { bucket: "want", spent: 600, prevSpent: 0, delta: 600 },
    ];
    const rows = bucketRows(buckets, 1000);
    expect(rows.map((r) => r.name)).toEqual(["Wants", "Needs"]); // 600 before 400
    expect(rows[0].share).toBeCloseTo(0.6, 5);
    expect(rows[0].isNew).toBe(true); // want had no prior spend
    expect(rows[1].deltaPct).toBeCloseTo(-0.2, 5); // need: -100/500
    expect(rows[0].key).toBe("want");
  });
});

describe("categoryRows", () => {
  it("maps shares, ids, deltas and assigns distinct palette colors by rank", () => {
    const input: (CategoryDelta & { pct: number })[] = [
      { category_id: 10, name: "Dining", bucket: "want", spent: 600, prevSpent: 400, delta: 200, deltaPct: 0.5, isNew: false, pct: 0.6 },
      { category_id: 11, name: "Rent", bucket: "need", spent: 400, prevSpent: 400, delta: 0, deltaPct: 0, isNew: false, pct: 0.4 },
    ];
    const rows = categoryRows(input);
    expect(rows[0]).toMatchObject({ name: "Dining", categoryId: 10, share: 0.6, delta: 200, key: "cat:10" });
    expect(rows[0].color).not.toBe(rows[1].color); // distinct hues by rank
  });
});

describe("merchantRows", () => {
  it("ranks merchants by spend with share of total and no delta", () => {
    const txns = [
      txn({ ID: 1, MerchantRaw: "Deliveroo", AmountFils: 300 }),
      txn({ ID: 2, MerchantRaw: "Deliveroo", AmountFils: 200 }),
      txn({ ID: 3, MerchantRaw: "Noon", AmountFils: 1000 }),
    ];
    const rows = merchantRows(txns, 1500);
    expect(rows.map((r) => [r.name, r.spent, r.count])).toEqual([
      ["Noon", 1000, 1], ["Deliveroo", 500, 2],
    ]);
    expect(rows[0].share).toBeCloseTo(0.667, 3);
    expect(rows[0].delta).toBeUndefined();
    expect(rows[1].key).toBe("merchant:Deliveroo");
  });
});
