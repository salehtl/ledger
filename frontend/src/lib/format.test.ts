import { describe, it, expect } from "vitest";
import {
  statusLabel, statusTone, dirhamsToFils, filsToDirhams,
  fractionToPercent, percentToFraction,
} from "./format";

describe("statusLabel", () => {
  it("humanizes known statuses", () => {
    expect(statusLabel("needs_review")).toBe("Needs review");
    expect(statusLabel("confirmed")).toBe("Confirmed");
    expect(statusLabel("transfer")).toBe("Transfer");
    expect(statusLabel("ignored")).toBe("Ignored");
  });
  it("falls back to capitalized raw value", () => {
    expect(statusLabel("pending")).toBe("Pending");
  });
});

describe("statusTone", () => {
  it("maps statuses to a pill tone", () => {
    expect(statusTone("confirmed")).toBe("good");
    expect(statusTone("needs_review")).toBe("warn");
    expect(statusTone("ignored")).toBe("muted");
    expect(statusTone("transfer")).toBe("neutral");
  });
});

describe("money <-> dirhams", () => {
  it("converts dirhams to fils with rounding", () => {
    expect(dirhamsToFils(12.34)).toBe(1234);
    expect(dirhamsToFils(0)).toBe(0);
    expect(dirhamsToFils(10)).toBe(1000);
  });
  it("converts fils to dirhams", () => {
    expect(filsToDirhams(1234)).toBe(12.34);
    expect(filsToDirhams(0)).toBe(0);
  });
});

describe("fraction <-> percent", () => {
  it("rounds fraction to whole percent", () => {
    expect(fractionToPercent(0.5)).toBe(50);
    expect(fractionToPercent(0.2)).toBe(20);
  });
  it("converts whole percent to fraction", () => {
    expect(percentToFraction(30)).toBeCloseTo(0.3, 5);
  });
});
