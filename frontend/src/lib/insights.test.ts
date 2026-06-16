import { describe, it, expect } from "vitest";
import {
  totalSpent, totalBudget, donutSlices, trendSeries, bucketColor, monthLabel,
  totalProjection, paceStatus, paceTone, categoryDeltas,
} from "./insights";
import type { BucketSummary, CategorySpend, MonthlyTotal } from "../api/types";

const buckets: BucketSummary[] = [
  { bucket: "need", target: 300000, spent: 210000, remaining: 90000, pct_used: 0.7, projection: 300000 },
  { bucket: "want", target: 200000, spent: 180000, remaining: 20000, pct_used: 0.9, projection: 240000 },
  { bucket: "saving", target: 100000, spent: 92000, remaining: 8000, pct_used: 0.92, projection: 100000 },
];

describe("totals", () => {
  it("sums spent and target across buckets", () => {
    expect(totalSpent(buckets)).toBe(482000);
    expect(totalBudget(buckets)).toBe(600000);
  });
});

describe("donutSlices", () => {
  it("keeps top N and rolls the rest into 'Other'", () => {
    const cats: CategorySpend[] = [
      { category_id: 1, name: "Groceries", bucket: "need", spent: 5000 },
      { category_id: 2, name: "Dining", bucket: "want", spent: 4000 },
      { category_id: 3, name: "Transport", bucket: "need", spent: 3000 },
      { category_id: 4, name: "Misc", bucket: "want", spent: 1000 },
    ];
    const slices = donutSlices(cats, 2);
    expect(slices.map((s) => s.name)).toEqual(["Groceries", "Dining", "Other"]);
    expect(slices[2].value).toBe(4000); // 3000 + 1000
  });
});

describe("trendSeries", () => {
  it("fills missing months with zeros, oldest→newest, with labels", () => {
    const totals: MonthlyTotal[] = [{ period: "2026-06", spent: 8000, income: 100000 }];
    const series = trendSeries(totals, ["2026-04", "2026-05", "2026-06"]);
    expect(series.map((p) => p.spent)).toEqual([0, 0, 8000]);
    expect(series.map((p) => p.label)).toEqual(["Apr", "May", "Jun"]);
  });
});

describe("helpers", () => {
  it("maps buckets to colors and months to short labels", () => {
    expect(bucketColor("need")).toBe("var(--color-need)");
    expect(monthLabel("2026-01")).toBe("Jan");
  });
});

describe("pace", () => {
  const b = (over: Partial<BucketSummary>): BucketSummary => ({
    bucket: "need", target: 0, spent: 0, remaining: 0, pct_used: 0, projection: 0, ...over,
  });

  it("sums bucket projections", () => {
    expect(totalProjection([b({ projection: 300000 }), b({ projection: 240000 })])).toBe(540000);
  });

  it("classifies pace as under / over / overbudget", () => {
    expect(paceStatus(100, 1000, 800)).toBe("under"); // projected within budget
    expect(paceStatus(100, 1000, 1200)).toBe("over"); // projected to overspend
    expect(paceStatus(1000, 1000, 1000)).toBe("overbudget"); // already at/over target
    expect(paceStatus(0, 0, 0)).toBe("under"); // no target set
  });

  it("maps a pace status to a tone", () => {
    expect(paceTone("under")).toBe("good");
    expect(paceTone("over")).toBe("warn");
    expect(paceTone("overbudget")).toBe("bad");
  });
});

describe("categoryDeltas", () => {
  const cur: CategorySpend[] = [
    { category_id: 1, name: "Groceries", bucket: "need", spent: 2000 },
    { category_id: 2, name: "Dining", bucket: "want", spent: 500 },
    { category_id: 3, name: "Gifts", bucket: "want", spent: 300 }, // new
  ];
  const prev: CategorySpend[] = [
    { category_id: 1, name: "Groceries", bucket: "need", spent: 1000 },
    { category_id: 2, name: "Dining", bucket: "want", spent: 800 },
    { category_id: 4, name: "Travel", bucket: "want", spent: 600 }, // gone
  ];

  it("computes delta and deltaPct for matched categories", () => {
    const d = categoryDeltas(cur, prev);
    const groceries = d.find((x) => x.category_id === 1)!;
    expect(groceries.delta).toBe(1000);
    expect(groceries.deltaPct).toBeCloseTo(1.0);
    expect(groceries.isNew).toBe(false);
  });
  it("marks a category absent last month as new with null deltaPct", () => {
    const gifts = categoryDeltas(cur, prev).find((x) => x.category_id === 3)!;
    expect(gifts.isNew).toBe(true);
    expect(gifts.deltaPct).toBeNull();
    expect(gifts.delta).toBe(300);
  });
  it("includes a category present last month but gone this month with spent 0", () => {
    const travel = categoryDeltas(cur, prev).find((x) => x.category_id === 4)!;
    expect(travel.spent).toBe(0);
    expect(travel.prevSpent).toBe(600);
    expect(travel.delta).toBe(-600);
    expect(travel.deltaPct).toBe(-1);
  });
});
