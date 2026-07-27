import { describe, it, expect } from "vitest";
import {
  statusLabel, statusTone, dirhamsToFils, filsToDirhams,
  fractionToPercent, percentToFraction, shortDate,
} from "./format";

describe("shortDate", () => {
  const ref = new Date(2026, 0, 15); // Jan 2026

  it("drops the year in the reference year", () => {
    expect(shortDate("2026-07-10", ref)).toBe("Jul 10");
  });
  it("strips a leading zero from the day", () => {
    expect(shortDate("2026-07-03", ref)).toBe("Jul 3");
  });
  it("keeps the year for other years", () => {
    expect(shortDate("2025-12-31", ref)).toBe("Dec 31, 2025");
  });
  it("accepts a full RFC3339 timestamp", () => {
    expect(shortDate("2026-02-01T09:30:00Z", ref)).toBe("Feb 1");
  });
  it("returns the input unchanged when unparseable", () => {
    expect(shortDate("nope", ref)).toBe("nope");
  });
});

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
  it("labels archived", () => {
    expect(statusLabel("archived")).toBe("Archived");
  });
});

describe("statusTone", () => {
  it("maps statuses to a pill tone", () => {
    expect(statusTone("confirmed")).toBe("default");
    expect(statusTone("needs_review")).toBe("attention");
    expect(statusTone("ignored")).toBe("muted");
    expect(statusTone("transfer")).toBe("default");
  });
  it("tones archived as muted", () => {
    expect(statusTone("archived")).toBe("muted");
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
