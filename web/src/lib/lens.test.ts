import { describe, it, expect } from "vitest";
import type { Txn } from "../api/types";
import type { BucketComparison, CategoryDelta } from "./insights";
import { bucketRows, categoryRows, merchantRows } from "./lens";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, AmountAedFils: 1000, Currency: "AED",
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

  it("gives every bucket row the same dotted texture — identity is carried by hue", () => {
    const buckets: BucketComparison[] = [
      { bucket: "need", spent: 50, prevSpent: 0, delta: 50 },
      { bucket: "want", spent: 30, prevSpent: 0, delta: 30 },
      { bucket: "saving", spent: 20, prevSpent: 0, delta: 20 },
    ];
    for (const row of bucketRows(buckets, 100)) {
      expect(row.density).toBe("dotted");
    }
  });

  it("marks only the over-budget buckets solid, leaving the others dotted", () => {
    const buckets: BucketComparison[] = [
      { bucket: "need", spent: 50, prevSpent: 0, delta: 50 },
      { bucket: "want", spent: 30, prevSpent: 0, delta: 30 },
      { bucket: "saving", spent: 20, prevSpent: 0, delta: 20 },
    ];
    const rows = bucketRows(buckets, 100, new Set(["want"]));
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.density]));
    expect(byKey.want).toBe("solid");
    expect(byKey.need).toBe("dotted");
    expect(byKey.saving).toBe("dotted");
  });
});

describe("categoryRows", () => {
  const input: (CategoryDelta & { pct: number })[] = [
    { category_id: 10, name: "Dining", bucket: "want", spent: 600, prevSpent: 400, delta: 200, deltaPct: 0.5, isNew: false, pct: 0.6 },
    { category_id: 11, name: "Rent", bucket: "need", spent: 400, prevSpent: 400, delta: 0, deltaPct: 0, isNew: false, pct: 0.4 },
  ];

  it("maps shares, ids and deltas", () => {
    const rows = categoryRows(input, new Map([[10, "teal"], [11, "orchid"]]));
    expect(rows[0]).toMatchObject({ name: "Dining", categoryId: 10, share: 0.6, delta: 200, key: "cat:10" });
  });

  it("takes each category's own colour, not the hue at its spend rank", () => {
    // `categoryDither` would give rank 0 "amber" and rank 1 "azure". Choosing
    // colours neither of those can produce is what makes this fail if the row
    // builder ever goes back to indexing by rank.
    const rows = categoryRows(input, new Map([[10, "teal"], [11, "orchid"]]));
    expect(rows.map((r) => r.ditherColor)).toEqual(["teal", "orchid"]);
  });

  it("keeps a category's colour when its spend rank changes", () => {
    // The regression that motivated this: a category changed hue between months
    // purely because it moved up or down the ranking.
    const reversed = [input[1], input[0]];
    const rows = categoryRows(reversed, new Map([[10, "teal"], [11, "orchid"]]));
    expect(rows.find((r) => r.categoryId === 10)!.ditherColor).toBe("teal");
    expect(rows.find((r) => r.categoryId === 11)!.ditherColor).toBe("orchid");
  });

  it("falls back to the neutral for an id with no usable colour", () => {
    // Covers the window before the categories query lands, and guards against
    // interpolating an unknown name into var(--color-…) — valid CSS that
    // resolves to nothing, so the bar would vanish rather than degrade.
    const rows = categoryRows(input, new Map([[10, "chartreuse"]]));
    expect(rows.map((r) => r.ditherColor)).toEqual(["slate", "slate"]);
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
