import { describe, it, expect } from "vitest";
import type { BucketDelta, CategoryDelta, MerchantTotal } from "../v2/sources/insights";
import { bucketRows, categoryRows, merchantRows, share } from "./lens";

function bucket(p: Partial<BucketDelta> & Pick<BucketDelta, "bucket" | "spent" | "prevSpent">): BucketDelta {
  const d = p.spent - p.prevSpent;
  return {
    key: p.bucket,
    name: p.bucket,
    delta: d,
    deltaPct: p.prevSpent === 0n ? null : Number(d) / Number(p.prevSpent),
    isNew: p.prevSpent === 0n && p.spent > 0n,
    isGone: p.spent === 0n && p.prevSpent > 0n,
    ...p,
  };
}

describe("share", () => {
  it("divides in bigint, so a total past 2^53 still gives an exact fraction", () => {
    expect(share(9007199254740993n, 18014398509481986n)).toBeCloseTo(0.5, 6);
  });
  it("is zero when there is nothing to be a fraction of", () => {
    expect(share(10n, 0n)).toBe(0);
  });
});

describe("bucketRows", () => {
  it("ranks by spend with share and month-over-month delta", () => {
    const rows = bucketRows(
      [bucket({ bucket: "need", spent: 400n, prevSpent: 500n }), bucket({ bucket: "want", spent: 600n, prevSpent: 0n })],
      1000n,
    );
    expect(rows.map((r) => r.name)).toEqual(["Wants", "Needs"]); // 600 before 400
    expect(rows[0].share).toBeCloseTo(0.6, 5);
    expect(rows[0].isNew).toBe(true);
    expect(rows[1].deltaPct).toBeCloseTo(-0.2, 5);
    expect(rows[0].key).toBe("want");
    expect(rows[0].drill).toEqual({ type: "bucket", bucket: "want", name: "Wants" });
  });

  it("names the uncategorized remainder rather than dropping it out of the shares", () => {
    const rows = bucketRows([bucket({ bucket: "unassigned", spent: 100n, prevSpent: 0n })], 100n);
    expect(rows[0].name).toBe("Uncategorized");
    expect(rows[0].share).toBe(1);
  });

  it("drops a bucket with no spending in either month", () => {
    const rows = bucketRows(
      [bucket({ bucket: "need", spent: 50n, prevSpent: 0n }), bucket({ bucket: "saving", spent: 0n, prevSpent: 0n })],
      50n,
    );
    expect(rows.map((r) => r.key)).toEqual(["need"]);
  });

  it("gives every bucket row the same dotted texture — there is no target to be over", () => {
    const rows = bucketRows(
      [
        bucket({ bucket: "need", spent: 50n, prevSpent: 0n }),
        bucket({ bucket: "want", spent: 30n, prevSpent: 0n }),
        bucket({ bucket: "saving", spent: 20n, prevSpent: 0n }),
      ],
      100n,
    );
    for (const row of rows) expect(row.density).toBe("dotted");
  });
});

describe("categoryRows", () => {
  const input: CategoryDelta[] = [
    { key: "cat:dining", name: "dining", category: "dining", bucket: "want", spent: 600n, prevSpent: 400n, delta: 200n, deltaPct: 0.5, isNew: false, isGone: false },
    { key: "cat:housing", name: "housing", category: "housing", bucket: "need", spent: 400n, prevSpent: 400n, delta: 0n, deltaPct: 0, isNew: false, isGone: false },
  ];

  it("maps shares, deltas and the drill target", () => {
    const rows = categoryRows(input, 1000n);
    expect(rows[0]).toMatchObject({ name: "dining", share: 0.6, delta: 200n, key: "cat:dining" });
    expect(rows[0].drill).toEqual({ type: "category", category: "dining", name: "dining" });
  });

  it("colours by spend rank, which is the only signal the projection carries", () => {
    // `category` is a free-form string in `replay/state.ts`: there is no
    // category entity and therefore no stored colour to key on.
    expect(categoryRows(input, 1000n).map((r) => r.ditherColor)).toEqual(["amber", "azure"]);
  });

  it("keeps a total past 2^53 exact", () => {
    const rows = categoryRows(
      [{ ...input[0], spent: 9007199254740993n }],
      9007199254740993n,
    );
    expect(rows[0].spent).toBe(9007199254740993n);
    expect(rows[0].share).toBe(1);
  });
});

describe("merchantRows", () => {
  it("ranks merchants by spend with share of total and no delta", () => {
    const merchants: MerchantTotal[] = [
      { merchant: "Noon", spent: 1000n, count: 1 },
      { merchant: "Deliveroo", spent: 500n, count: 2 },
    ];
    const rows = merchantRows(merchants, 1500n);
    expect(rows.map((r) => [r.name, r.spent, r.count])).toEqual([
      ["Noon", 1000n, 1],
      ["Deliveroo", 500n, 2],
    ]);
    expect(rows[0].share).toBeCloseTo(0.667, 3);
    expect(rows[0].delta).toBeUndefined();
    expect(rows[1].key).toBe("merchant:Deliveroo");
    expect(rows[1].drill).toEqual({ type: "merchant", merchant: "Deliveroo", name: "Deliveroo" });
  });
});
