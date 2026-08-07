import { describe, it, expect } from "vitest";
import { numberCells, wheelOffsetPct, fitScale } from "./rollingNumber";

describe("numberCells", () => {
  it("splits digits and separators", () => {
    const cells = numberCells("1,234.56");
    expect(cells.map((c) => c.char).join("")).toBe("1,234.56");
    expect(cells.map((c) => c.digit)).toEqual([1, null, 2, 3, 4, null, 5, 6]);
  });

  it("keys cells from the right so trailing digits keep identity as the number grows", () => {
    const before = numberCells("999.99");
    const after = numberCells("1,000.00");
    // The cents columns (last 3 chars: ".", d, d) must keep the same keys.
    expect(before.slice(-3).map((c) => c.key)).toEqual(after.slice(-3).map((c) => c.key));
    // Keys are unique within one value.
    expect(new Set(after.map((c) => c.key)).size).toBe(after.length);
  });

  it("treats the zero placeholder as a single static cell", () => {
    expect(numberCells("—")).toEqual([{ key: 1, char: "—", digit: null }]);
  });
});

describe("wheelOffsetPct", () => {
  it("translates the track up by 10% per digit", () => {
    expect(wheelOffsetPct(0)).toBe(-0);
    expect(wheelOffsetPct(3)).toBe(-30);
    expect(wheelOffsetPct(9)).toBe(-90);
  });
});

describe("fitScale", () => {
  it("returns 1 when content fits", () => {
    expect(fitScale(300, 200)).toBe(1);
    expect(fitScale(300, 300)).toBe(1);
  });

  it("shrinks proportionally when content overflows", () => {
    expect(fitScale(300, 400)).toBeCloseTo(0.75);
  });

  it("floors at minScale for pathological values", () => {
    expect(fitScale(100, 1000)).toBe(0.5);
    expect(fitScale(100, 1000, 0.3)).toBeCloseTo(0.3);
  });

  it("is a no-op before layout has real measurements", () => {
    expect(fitScale(0, 400)).toBe(1);
    expect(fitScale(300, 0)).toBe(1);
  });
});
