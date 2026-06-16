import { describe, it, expect } from "vitest";
import { addMonth, normalizeRange, scopeBounds, scopeAnchor, scopeLabel } from "./scope";
import { currentPeriod } from "./insights";

describe("addMonth", () => {
  it("steps within and across year boundaries", () => {
    expect(addMonth("2026-06", 1)).toBe("2026-07");
    expect(addMonth("2026-06", -1)).toBe("2026-05");
    expect(addMonth("2026-12", 1)).toBe("2027-01");
    expect(addMonth("2026-01", -1)).toBe("2025-12");
  });
});

describe("normalizeRange", () => {
  it("orders the two endpoints ascending", () => {
    expect(normalizeRange("2026-06", "2026-03")).toEqual({ from: "2026-03", to: "2026-06" });
    expect(normalizeRange("2026-03", "2026-06")).toEqual({ from: "2026-03", to: "2026-06" });
  });
});

describe("scopeBounds", () => {
  it("brackets a single month", () => {
    expect(scopeBounds({ kind: "month", period: "2026-06" })).toEqual({ from: "2026-06-01", to: "2026-06-32" });
  });
  it("brackets a range from first day to last-plus-one day", () => {
    expect(scopeBounds({ kind: "range", from: "2026-03", to: "2026-06" })).toEqual({ from: "2026-03-01", to: "2026-06-32" });
  });
  it("returns no bounds for all time", () => {
    expect(scopeBounds({ kind: "all" })).toEqual({});
  });
});

describe("scopeAnchor", () => {
  it("is the month itself, the range end, or the current month for all", () => {
    expect(scopeAnchor({ kind: "month", period: "2026-04" })).toBe("2026-04");
    expect(scopeAnchor({ kind: "range", from: "2026-03", to: "2026-06" })).toBe("2026-06");
    expect(scopeAnchor({ kind: "all" })).toBe(currentPeriod());
  });
});

describe("scopeLabel", () => {
  it("labels a single month", () => {
    expect(scopeLabel({ kind: "month", period: "2026-06" })).toBe("Jun 2026");
  });
  it("labels a same-year range compactly", () => {
    expect(scopeLabel({ kind: "range", from: "2026-03", to: "2026-06" })).toBe("Mar–Jun 2026");
  });
  it("labels a cross-year range with both years", () => {
    expect(scopeLabel({ kind: "range", from: "2025-12", to: "2026-02" })).toBe("Dec 2025 – Feb 2026");
  });
  it("labels all time", () => {
    expect(scopeLabel({ kind: "all" })).toBe("All time");
  });
});
