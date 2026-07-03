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
