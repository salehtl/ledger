import { describe, it, expect } from "vitest";
import { formatFils, moneyClass, flowAmount, aedFils, nativeAmountTag } from "./money";

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

const txn = (over: Partial<{ AmountFils: number; Currency: string; AmountAedFils: number | null }>) => ({
  AmountFils: 1009, Currency: "USD", AmountAedFils: 3706, ...over,
});

describe("aedFils", () => {
  it("returns AmountFils for AED rows regardless of snapshot", () => {
    expect(aedFils(txn({ Currency: "AED", AmountFils: 5000, AmountAedFils: 5000 }))).toBe(5000);
  });
  it("treats empty currency as AED", () => {
    expect(aedFils(txn({ Currency: "", AmountFils: 700, AmountAedFils: null }))).toBe(700);
  });
  it("returns the snapshot for foreign rows", () => {
    expect(aedFils(txn({}))).toBe(3706);
  });
  it("returns null for unconverted foreign rows", () => {
    expect(aedFils(txn({ AmountAedFils: null }))).toBeNull();
  });
});

describe("nativeAmountTag", () => {
  it("is null for AED rows", () => {
    expect(nativeAmountTag(txn({ Currency: "AED" }))).toBeNull();
    expect(nativeAmountTag(txn({ Currency: "" }))).toBeNull();
  });
  it("formats the native amount with its code", () => {
    expect(nativeAmountTag(txn({}))).toBe("USD 10.09");
    expect(nativeAmountTag(txn({ Currency: "EUR", AmountFils: 241234 }))).toBe("EUR 2,412.34");
  });
});
