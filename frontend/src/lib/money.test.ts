import { describe, it, expect } from "vitest";
import { formatFils, moneyClass, flowAmount } from "./money";

describe("formatFils", () => {
  it("groups thousands and shows 2 decimals", () => {
    expect(formatFils(123456)).toBe("1,234.56");
  });
  it("wraps negatives in parentheses", () => {
    expect(formatFils(-50000)).toBe("(500.00)");
  });
  it("renders zero as a dash", () => {
    expect(formatFils(0)).toBe("—");
  });
});

describe("moneyClass", () => {
  it("flags negatives and zero", () => {
    expect(moneyClass(-1)).toContain("money-neg");
    expect(moneyClass(0)).toContain("money-zero");
    expect(moneyClass(100)).toBe("money");
  });
});

describe("flowAmount", () => {
  it("marks credits inbound with a plus", () => {
    expect(flowAmount("credit", 500000)).toEqual({ text: "+5,000.00", flow: "in" });
  });
  it("marks debits outbound with a minus", () => {
    // U+2212 minus sign, matching the swipe card.
    expect(flowAmount("debit", 2450)).toEqual({ text: "−24.50", flow: "out" });
  });
  it("signs the magnitude, never a stored negative", () => {
    // transactions.amount is always positive; guard against a stray sign.
    expect(flowAmount("debit", -2450).text).toBe("−24.50");
  });
});
