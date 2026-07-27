import { barHeightPct } from "./trendBars";

describe("barHeightPct", () => {
  it("scales value against max as a percentage", () => {
    expect(barHeightPct(50, 100)).toBe(50);
    expect(barHeightPct(100, 100)).toBe(100);
  });

  it("returns 0 for zero or negative values", () => {
    expect(barHeightPct(0, 100)).toBe(0);
    expect(barHeightPct(-5, 100)).toBe(0);
  });

  it("returns 0 (not NaN) when max is 0", () => {
    expect(barHeightPct(10, 0)).toBe(0);
  });

  it("clamps to 100", () => {
    expect(barHeightPct(150, 100)).toBe(100);
  });
});

import { trendRows, activeIndex } from "./trendBars";
import type { TrendPoint } from "./insights";

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", spent: 5000, income: 0 },
  { period: "2026-06", label: "Jun", spent: 10000, income: 0 },
];

describe("trendRows", () => {
  it("projects points onto chart rows, dropping income", () => {
    expect(trendRows(points)).toEqual([
      { period: "2026-05", label: "May", spent: 5000 },
      { period: "2026-06", label: "Jun", spent: 10000 },
    ]);
  });

  it("returns an empty array for an empty series", () => {
    expect(trendRows([])).toEqual([]);
  });
});

describe("activeIndex", () => {
  it("finds the active period's position", () => {
    expect(activeIndex(points, "2026-06")).toBe(1);
  });

  it("returns null when the period is absent or unset", () => {
    expect(activeIndex(points, "2026-01")).toBeNull();
    expect(activeIndex(points, undefined)).toBeNull();
  });
});
