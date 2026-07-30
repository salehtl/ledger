import { describe, it, expect } from "vitest";
import type { MonthlyTotal } from "../api/types";
import {
  linePoints, polylinePoints, areaPolygon, nearestIndex, deltaSummary,
  isFlatZero, axisIndices, matrixBlocks, monthColumn, netTotals,
  txnMatchesCategory, cellTxns, monthTxns, fifoSpendAges,
  yoyRows, yoySummary, pctLabel,
  type IncomeExpenseRow, type NetWorthPoint, type ReportTxn,
} from "./reports";

function txn(over: Partial<ReportTxn>): ReportTxn {
  return {
    ID: 1, PostedAt: "2026-07-01T10:00:00Z", AmountFils: 1000, AmountAedFils: 1000,
    Currency: "AED", Direction: "debit", MerchantRaw: "Shop", Status: "confirmed",
    Confidence: 1, Source: "email", CategoryID: 5, CategoryName: "Groceries",
    Bucket: "need", Kind: "spending", BucketSnapshot: "need",
    ...over,
  };
}

describe("linePoints", () => {
  it("spreads x over 0..100 and inverts y with padding", () => {
    const pts = linePoints([0, 50, 100], 8);
    expect(pts.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(pts[0].y).toBe(92); // min → bottom pad
    expect(pts[2].y).toBe(8);  // max → top pad
    expect(pts[1].y).toBe(50);
  });
  it("flat series sits at mid-height, single point centers", () => {
    expect(linePoints([7, 7, 7]).every((p) => p.y === 50)).toBe(true);
    expect(linePoints([42])).toEqual([{ x: 50, y: 50 }]);
    expect(linePoints([])).toEqual([]);
  });
  it("handles negative values (net worth can be under water)", () => {
    const pts = linePoints([-100, 100]);
    expect(pts[0].y).toBeGreaterThan(pts[1].y);
  });
});

describe("polylinePoints / areaPolygon", () => {
  it("serializes for svg and clip-path, closing the area to the bottom", () => {
    const pts = linePoints([0, 100], 0);
    expect(polylinePoints(pts)).toBe("0,100 100,0");
    expect(areaPolygon(pts)).toBe("polygon(0% 100%, 0% 100%, 100% 0%, 100% 100%)");
  });
  it("degrades to a flat strip on no points", () => {
    expect(areaPolygon([])).toBe("polygon(0% 100%, 100% 100%)");
  });
});

describe("nearestIndex", () => {
  it("maps fractions to the closest point and clamps", () => {
    expect(nearestIndex(0, 12)).toBe(0);
    expect(nearestIndex(1, 12)).toBe(11);
    expect(nearestIndex(0.5, 3)).toBe(1);
    expect(nearestIndex(-0.2, 12)).toBe(0);
    expect(nearestIndex(1.4, 12)).toBe(11);
    expect(nearestIndex(0.9, 1)).toBe(0);
  });
});

describe("deltaSummary", () => {
  it("latest vs previous with pct", () => {
    expect(deltaSummary([100, 150])).toEqual({ latest: 150, delta: 50, pct: 0.5 });
  });
  it("pct null off a zero base; single point has no delta", () => {
    expect(deltaSummary([0, 80]).pct).toBeNull();
    expect(deltaSummary([80])).toEqual({ latest: 80, delta: 0, pct: null });
    expect(deltaSummary([])).toEqual({ latest: 0, delta: 0, pct: null });
  });
  it("negative-base pct uses magnitude so direction stays honest", () => {
    expect(deltaSummary([-100, -50])).toEqual({ latest: -50, delta: 50, pct: 0.5 });
  });
});

describe("isFlatZero / axisIndices", () => {
  const zero = (month: string): NetWorthPoint => ({ month, budget_fils: 0, tracking_fils: 0, networth_fils: 0 });
  it("flags an all-zero series (no check-ins yet)", () => {
    expect(isFlatZero([zero("2026-06"), zero("2026-07")])).toBe(true);
    expect(isFlatZero([zero("2026-06"), { ...zero("2026-07"), networth_fils: 5 }])).toBe(false);
  });
  it("axis labels: all when few, first/last plus spread when many", () => {
    expect(axisIndices(3)).toEqual([0, 1, 2]);
    expect(axisIndices(12)).toEqual([0, 4, 7, 11]);
    expect(axisIndices(0)).toEqual([]);
  });
});

describe("matrix helpers", () => {
  const row = (over: Partial<IncomeExpenseRow>): IncomeExpenseRow => ({
    category_id: 1, name: "X", kind: "spending", by_month_fils: [0], total_fils: 0, avg_fils: 0, ...over,
  });
  it("splits blocks preserving order", () => {
    const rows = [row({ name: "Salary", kind: "income" }), row({ name: "A" }), row({ name: "B" })];
    const b = matrixBlocks(rows);
    expect(b.income.map((r) => r.name)).toEqual(["Salary"]);
    expect(b.spending.map((r) => r.name)).toEqual(["A", "B"]);
  });
  it("monthColumn gives a two-line header", () => {
    expect(monthColumn("2026-05")).toEqual({ mon: "May", yr: "’26" });
  });
  it("netTotals sums and integer-averages", () => {
    expect(netTotals([100, 200, 50])).toEqual({ total: 350, avg: 116 });
    expect(netTotals([])).toEqual({ total: 0, avg: 0 });
  });
});

describe("drill filters", () => {
  const rows: ReportTxn[] = [
    txn({ ID: 1, PostedAt: "2026-07-02T10:00:00Z", CategoryID: 5 }),
    txn({ ID: 2, PostedAt: "2026-06-02T10:00:00Z", CategoryID: 5 }),
    txn({
      ID: 3, PostedAt: "2026-07-05T10:00:00Z", CategoryID: null, CategoryName: "",
      Splits: [
        { ID: 1, TransactionID: 3, CategoryID: 5, AmountFils: 600 },
        { ID: 2, TransactionID: 3, CategoryID: 7, AmountFils: 400 },
      ],
    }),
    txn({ ID: 4, PostedAt: "2026-07-09T10:00:00Z", CategoryID: 7 }),
  ];
  it("matches direct category and split lines", () => {
    expect(txnMatchesCategory(rows[0], 5)).toBe(true);
    expect(txnMatchesCategory(rows[2], 5)).toBe(true);
    expect(txnMatchesCategory(rows[2], 9)).toBe(false);
  });
  it("cellTxns = category × month; monthTxns = whole month", () => {
    expect(cellTxns(rows, 5, "2026-07").map((t) => t.ID)).toEqual([1, 3]);
    expect(cellTxns(rows, 5, "2026-06").map((t) => t.ID)).toEqual([2]);
    expect(monthTxns(rows, "2026-07").map((t) => t.ID)).toEqual([1, 3, 4]);
  });
});

describe("fifoSpendAges", () => {
  const income = (id: number, date: string, amt: number) =>
    txn({ ID: id, PostedAt: date, AmountFils: amt, AmountAedFils: amt, Direction: "credit", Kind: "income", CategoryName: "Salary" });
  const spend = (id: number, date: string, amt: number) =>
    txn({ ID: id, PostedAt: date, AmountFils: amt, AmountAedFils: amt });

  it("ages spends from the lot funding their final fil, FIFO", () => {
    const ages = fifoSpendAges([
      income(1, "2026-07-01T08:00:00Z", 1000),
      income(2, "2026-07-10T08:00:00Z", 1000),
      spend(3, "2026-07-11T08:00:00Z", 800),   // lot 1 → 10 days
      spend(4, "2026-07-15T08:00:00Z", 400),   // 200 from lot 1, 200 from lot 2 → 5 days
    ]);
    expect(ages).toEqual([
      { id: 3, date: "2026-07-11T08:00:00Z", ageDays: 10 },
      { id: 4, date: "2026-07-15T08:00:00Z", ageDays: 5 },
    ]);
  });
  it("skips pool-empty spends, partial funding still ages", () => {
    const ages = fifoSpendAges([
      spend(1, "2026-07-01T08:00:00Z", 500),  // nothing to drain — skipped
      income(2, "2026-07-02T08:00:00Z", 300),
      spend(3, "2026-07-06T08:00:00Z", 900),  // drains all 300 → funded, 4 days
    ]);
    expect(ages).toEqual([{ id: 3, date: "2026-07-06T08:00:00Z", ageDays: 4 }]);
  });
  it("ignores unconverted foreign rows, non-cashflow kinds, and unconfirmed rows", () => {
    const ages = fifoSpendAges([
      income(1, "2026-07-01T08:00:00Z", 1000),
      txn({ ID: 90, PostedAt: "2026-07-02T08:00:00Z", AmountFils: 100000, AmountAedFils: null, Currency: "USD" }),
      txn({ ID: 91, PostedAt: "2026-07-03T08:00:00Z", Kind: "excluded", Direction: "debit" }),
      txn({ ID: 92, PostedAt: "2026-07-03T09:00:00Z", Status: "needs_review" }),
      spend(2, "2026-07-04T08:00:00Z", 500),
    ]);
    expect(ages).toEqual([{ id: 2, date: "2026-07-04T08:00:00Z", ageDays: 3 }]);
  });
  it("keeps only the last 10 funded spends", () => {
    const flows: ReportTxn[] = [income(1, "2026-07-01T08:00:00Z", 100000)];
    for (let i = 0; i < 14; i++) {
      flows.push(spend(10 + i, `2026-07-${String(2 + i).padStart(2, "0")}T08:00:00Z`, 100));
    }
    const ages = fifoSpendAges(flows);
    expect(ages).toHaveLength(10);
    expect(ages[0].id).toBe(14);
  });
});

describe("yoyRows / yoySummary / pctLabel", () => {
  const trend: MonthlyTotal[] = [];
  // 18 months of data: 2025-02 .. 2026-07 (so Aug–Jan prior-year is known,
  // 2025-01 and earlier is not).
  for (let i = 17; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 6 - i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    trend.push({ period, spent: 1000 + i, income: 0 });
  }

  it("pairs each trailing month with its prior-year month", () => {
    const rows = yoyRows(trend, "2026-07");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ period: "2025-08", prevPeriod: "2024-08", prev: null, pct: null });
    expect(rows[11]).toMatchObject({ period: "2026-07", prevPeriod: "2025-07", cur: 1000, prev: 1012, delta: -12 });
  });
  it("months inside the data span but absent count 0; before it, null", () => {
    const sparse: MonthlyTotal[] = [
      { period: "2025-03", spent: 500, income: 0 },
      { period: "2026-06", spent: 700, income: 0 },
    ];
    const rows = yoyRows(sparse, "2026-07");
    const jun = rows.find((r) => r.period === "2026-06")!;
    expect(jun).toMatchObject({ cur: 700, prev: 0, pct: null }); // 2025-06 inside span → 0
    const aug = rows.find((r) => r.period === "2025-08")!;
    expect(aug.prev).toBeNull(); // 2024-08 predates data
  });
  it("empty trend: every prior year is unknown", () => {
    const rows = yoyRows([], "2026-07");
    expect(rows.every((r) => r.cur === 0 && r.prev === null)).toBe(true);
  });
  it("summary totals only comparable months", () => {
    const s = yoySummary(yoyRows(trend, "2026-07"));
    expect(s.comparableMonths).toBe(6); // 2026-02..07 have known prior years
    expect(s.curTotal).toBe(1000 + 1001 + 1002 + 1003 + 1004 + 1005);
    expect(s.prevTotal).toBe(1012 + 1013 + 1014 + 1015 + 1016 + 1017);
    expect(s.delta).toBe(s.curTotal - s.prevTotal);
  });
  it("pctLabel prints signed percents and an em-dash for unknown", () => {
    expect(pctLabel(0.062)).toBe("+6%");
    expect(pctLabel(-0.126)).toBe("−13%");
    expect(pctLabel(0.001)).toBe("0%");
    expect(pctLabel(null)).toBe("—");
  });
});
