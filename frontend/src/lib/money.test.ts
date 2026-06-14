import { describe, it, expect } from "vitest";
import { formatFils, moneyClass } from "./money";

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
