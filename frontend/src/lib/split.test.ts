import { splitSegments } from "./split";

describe("splitSegments", () => {
  it("maps a valid 50/30/20 split to full-bar widths", () => {
    const s = splitSegments(0.5, 0.3, 0.2);
    expect(s.needPct).toBeCloseTo(50);
    expect(s.wantPct).toBeCloseTo(30);
    expect(s.savingPct).toBeCloseTo(20);
    expect(s.totalPct).toBe(100);
    expect(s.ok).toBe(true);
  });

  it("leaves a gap when the split is under-allocated", () => {
    const s = splitSegments(0.4, 0.3, 0.2);
    expect(s.needPct).toBeCloseTo(40);
    expect(s.wantPct).toBeCloseTo(30);
    expect(s.savingPct).toBeCloseTo(20);
    expect(s.totalPct).toBe(90);
    expect(s.ok).toBe(false);
  });

  it("normalizes to a full bar when over-allocated", () => {
    const s = splitSegments(0.6, 0.3, 0.3);
    expect(s.needPct).toBeCloseTo(50);
    expect(s.wantPct).toBeCloseTo(25);
    expect(s.savingPct).toBeCloseTo(25);
    expect(s.totalPct).toBe(120);
    expect(s.ok).toBe(false);
  });

  it("handles an all-zero split without NaN", () => {
    const s = splitSegments(0, 0, 0);
    expect(s.needPct).toBe(0);
    expect(s.wantPct).toBe(0);
    expect(s.savingPct).toBe(0);
    expect(s.totalPct).toBe(0);
    expect(s.ok).toBe(false);
  });

  it("clamps negative fractions to zero-width segments", () => {
    const s = splitSegments(-0.1, 0.5, 0.5);
    expect(s.needPct).toBe(0);
    expect(s.wantPct).toBeCloseTo(50);
    expect(s.savingPct).toBeCloseTo(50);
  });
});
