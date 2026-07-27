import { barHeightPct, trendRows, activeIndex, bandCenters } from "./trendBars";
import type { TrendPoint } from "./insights";

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

describe("bandCenters", () => {
  it("returns an empty array for zero or negative bands", () => {
    expect(bandCenters(0)).toEqual([]);
    expect(bandCenters(-1)).toEqual([]);
  });

  it("centers a single band at the midpoint", () => {
    const [b] = bandCenters(1);
    expect(b.center).toBeCloseTo(0.5, 10);
  });

  it("matches d3 scaleBand's own paddingInner(0.28)/paddingOuter(0.18) geometry for two bands", () => {
    // Independently derived from d3's band-scale formula (not by re-calling
    // buildBandScale): step = 1 / (n - paddingInner + 2*paddingOuter),
    // center_i = step * (paddingOuter + i + (1 - paddingInner) / 2).
    // n=2 => step = 1/2.08, center_0 = step*0.54, center_1 = step*1.54.
    const step = 1 / 2.08;
    const [may, jun] = bandCenters(2);
    expect(may.center).toBeCloseTo(step * 0.54, 10);
    expect(jun.center).toBeCloseTo(step * 1.54, 10);
    expect(may.width).toBeCloseTo(step, 10);
    expect(jun.width).toBeCloseTo(step, 10);
  });

  it("keeps bands symmetric around the midpoint", () => {
    const centers = bandCenters(5).map((b) => b.center);
    for (let i = 0; i < centers.length; i++) {
      expect(centers[i] + centers[centers.length - 1 - i]).toBeCloseTo(1, 10);
    }
  });
});
