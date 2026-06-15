import { describe, it, expect } from "vitest";
import {
  totalSpent, totalBudget, donutSlices, trendSeries, bucketColor, monthLabel,
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
