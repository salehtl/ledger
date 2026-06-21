import { describe, it, expect } from "vitest";
import type { Txn } from "../api/types";
import { isSpending, spendingTxns, effectiveBucket, bucketBreakdown, merchantBreakdown, searchTxns } from "./analysis";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "M", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 1, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "",
    ...p,
  };
}

describe("isSpending / spendingTxns", () => {
  it("keeps only confirmed spending debits", () => {
    const rows = [
      txn({ ID: 1 }),                                   // counts
      txn({ ID: 2, Status: "needs_review" }),           // not confirmed
      txn({ ID: 3, Direction: "credit" }),              // not a debit
      txn({ ID: 4, Kind: "income" }),                   // not spending
      txn({ ID: 5, Kind: "" }),                         // uncategorized
    ];
    expect(rows.filter(isSpending).map((t) => t.ID)).toEqual([1]);
    expect(spendingTxns(rows).map((t) => t.ID)).toEqual([1]);
  });
});

describe("effectiveBucket", () => {
  it("uses live bucket when not frozen", () => {
    expect(effectiveBucket(txn({ Bucket: "want", BucketSnapshot: "need" }), false)).toBe("want");
  });
  it("prefers snapshot when frozen and present", () => {
    expect(effectiveBucket(txn({ Bucket: "want", BucketSnapshot: "need" }), true)).toBe("need");
  });
  it("falls back to live bucket when frozen but snapshot empty", () => {
    expect(effectiveBucket(txn({ Bucket: "want", BucketSnapshot: "" }), true)).toBe("want");
  });
});

describe("bucketBreakdown", () => {
  it("groups spending by bucket then category with shares, reconciling per category", () => {
    const rows = [
      txn({ ID: 1, AmountFils: 600, CategoryID: 10, CategoryName: "Dining", Bucket: "want" }),
      txn({ ID: 2, AmountFils: 400, CategoryID: 10, CategoryName: "Dining", Bucket: "want" }),
      txn({ ID: 3, AmountFils: 1000, CategoryID: 11, CategoryName: "Rent", Bucket: "need" }),
      txn({ ID: 4, AmountFils: 999, Status: "needs_review", CategoryID: 10, Bucket: "want" }), // excluded
    ];
    const out = bucketBreakdown(rows, false);
    // need (1000) sorts before want (1000)? tie -> sorted by spent desc; both 1000.
    const want = out.find((b) => b.bucket === "want")!;
    const need = out.find((b) => b.bucket === "need")!;
    expect(want.spent).toBe(1000);
    expect(need.spent).toBe(1000);
    const dining = want.categories.find((c) => c.categoryId === 10)!;
    expect(dining.spent).toBe(1000);   // reconciles: 600 + 400, excludes the needs_review 999
    expect(dining.count).toBe(2);
    expect(want.share).toBeCloseTo(0.5, 5); // 1000 / 2000 total
  });
  it("uses the bucket snapshot when frozen", () => {
    const rows = [txn({ ID: 1, AmountFils: 500, Bucket: "want", BucketSnapshot: "need" })];
    const live = bucketBreakdown(rows, false);
    expect(live[0].bucket).toBe("want");
    const frozen = bucketBreakdown(rows, true);
    expect(frozen[0].bucket).toBe("need");
  });
});

describe("merchantBreakdown", () => {
  it("groups by merchant, sorts desc, folds Other when topN given", () => {
    const rows = [
      txn({ ID: 1, MerchantRaw: "Deliveroo", AmountFils: 300 }),
      txn({ ID: 2, MerchantRaw: "Deliveroo", AmountFils: 200 }),
      txn({ ID: 3, MerchantRaw: "Noon", AmountFils: 400 }),
      txn({ ID: 4, MerchantRaw: "Talabat", AmountFils: 100 }),
    ];
    const all = merchantBreakdown(rows);
    expect(all.map((m) => [m.merchant, m.spent, m.count])).toEqual([
      ["Deliveroo", 500, 2], ["Noon", 400, 1], ["Talabat", 100, 1],
    ]);
    expect(all[0].share).toBeCloseTo(0.5, 5); // 500 / 1000
    const top2 = merchantBreakdown(rows, 2);
    expect(top2.map((m) => m.merchant)).toEqual(["Deliveroo", "Noon", "Other"]);
    expect(top2[2].spent).toBe(100); // Talabat folded into Other
  });
  it("excludes non-spending transactions", () => {
    const rows = [
      txn({ ID: 1, MerchantRaw: "Deliveroo", AmountFils: 300 }),
      txn({ ID: 2, MerchantRaw: "Bank", AmountFils: 999, Kind: "income", Direction: "credit" }),
      txn({ ID: 3, MerchantRaw: "Noon", AmountFils: 200, Status: "needs_review" }),
    ];
    const out = merchantBreakdown(rows);
    expect(out.map((m) => m.merchant)).toEqual(["Deliveroo"]);
    expect(out[0].spent).toBe(300);
    expect(out[0].share).toBeCloseTo(1, 5); // 300 / 300 (only spending counted)
  });
});

describe("searchTxns", () => {
  it("matches merchant substring case-insensitively, empty term returns all", () => {
    const rows = [txn({ ID: 1, MerchantRaw: "Deliveroo DMCC" }), txn({ ID: 2, MerchantRaw: "Noon" })];
    expect(searchTxns(rows, "deliv").map((t) => t.ID)).toEqual([1]);
    expect(searchTxns(rows, "  ").map((t) => t.ID)).toEqual([1, 2]);
  });
});
