import { trendRows, activeIndex, bandCenters, activeBandRect } from "./trendBars";
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

describe("activeBandRect", () => {
  it("returns null when there is no active index", () => {
    expect(activeBandRect(3, null)).toBeNull();
  });

  it("returns null when the index is outside the series", () => {
    expect(activeBandRect(3, -1)).toBeNull();
    expect(activeBandRect(3, 3)).toBeNull();
  });

  it("derives left/width from the active band's center and width", () => {
    const centers = bandCenters(3);
    const rect = activeBandRect(3, 1);
    expect(rect).not.toBeNull();
    expect(rect?.left).toBeCloseTo(centers[1].center - centers[1].width / 2, 10);
    expect(rect?.width).toBeCloseTo(centers[1].width, 10);
  });

  it("returns null for an empty series regardless of index", () => {
    expect(activeBandRect(0, 0)).toBeNull();
  });
});
