import { describe, expect, it } from "vitest";
import {
  clampNumber,
  formatNumericValue,
  isIncompleteNumericText,
  parseNumericDraft,
  sanitizeNumericText,
} from "./numericDraft";

describe("parseNumericDraft", () => {
  // The whole point of the module: an empty field is not zero.
  it("reports null for an empty field rather than 0", () => {
    expect(parseNumericDraft("")).toBeNull();
    expect(Number("")).toBe(0); // the trap this exists to avoid
  });

  it("reports null for partial input the user is still typing", () => {
    expect(parseNumericDraft("-")).toBeNull();
    expect(parseNumericDraft(".")).toBeNull();
    expect(parseNumericDraft("12.")).toBeNull();
    expect(parseNumericDraft("-.")).toBeNull();
  });

  it("parses complete numbers", () => {
    expect(parseNumericDraft("0")).toBe(0);
    expect(parseNumericDraft("7")).toBe(7);
    expect(parseNumericDraft("12.5")).toBe(12.5);
    expect(parseNumericDraft(".5")).toBe(0.5);
    expect(parseNumericDraft("-3.25")).toBe(-3.25);
    expect(parseNumericDraft("007")).toBe(7);
    expect(parseNumericDraft("25000.00")).toBe(25000);
  });

  it("rejects text that Number() would happily coerce", () => {
    expect(parseNumericDraft("abc")).toBeNull();
    expect(parseNumericDraft("1e5")).toBeNull();
    expect(parseNumericDraft("0x10")).toBeNull();
    expect(parseNumericDraft("Infinity")).toBeNull();
    expect(parseNumericDraft("12px")).toBeNull();
  });
});

describe("sanitizeNumericText", () => {
  it("drops characters that can't be part of the number", () => {
    expect(sanitizeNumericText("12abc3")).toBe("123");
    expect(sanitizeNumericText("1 2 3")).toBe("123");
  });

  it("keeps only the first decimal separator", () => {
    expect(sanitizeNumericText("1.2.3")).toBe("1.23");
  });

  it("accepts a comma as a decimal separator", () => {
    expect(sanitizeNumericText("12,5")).toBe("12.5");
  });

  it("honours allowDecimal", () => {
    expect(sanitizeNumericText("12.5", { allowDecimal: false })).toBe("125");
  });

  it("allows a leading minus only when asked, and only in front", () => {
    expect(sanitizeNumericText("-5")).toBe("5");
    expect(sanitizeNumericText("-5", { allowNegative: true })).toBe("-5");
    expect(sanitizeNumericText("5-3", { allowNegative: true })).toBe("53");
  });

  it("preserves an empty string so the field can be cleared", () => {
    expect(sanitizeNumericText("")).toBe("");
  });
});

describe("isIncompleteNumericText", () => {
  it("recognises the states a user passes through while typing 12.5", () => {
    expect(isIncompleteNumericText("")).toBe(true);
    expect(isIncompleteNumericText("1")).toBe(false);
    expect(isIncompleteNumericText("12")).toBe(false);
    expect(isIncompleteNumericText("12.")).toBe(true);
    expect(isIncompleteNumericText("12.5")).toBe(false);
  });
});

describe("clampNumber", () => {
  it("applies only the bounds it is given", () => {
    expect(clampNumber(150, 0, 100)).toBe(100);
    expect(clampNumber(-5, 0, 100)).toBe(0);
    expect(clampNumber(50, 0, 100)).toBe(50);
    expect(clampNumber(150, undefined, undefined)).toBe(150);
    expect(clampNumber(-5, 0)).toBe(0);
  });
});

describe("formatNumericValue", () => {
  it("shows an absent value as an empty field", () => {
    expect(formatNumericValue(null)).toBe("");
    expect(formatNumericValue(undefined)).toBe("");
    expect(formatNumericValue(NaN)).toBe("");
  });

  it("does not add trailing zeros to whole numbers", () => {
    expect(formatNumericValue(25000)).toBe("25000");
    expect(formatNumericValue(25000, 2)).toBe("25000");
    expect(formatNumericValue(12.5, 2)).toBe("12.5");
    expect(formatNumericValue(12.505, 2)).toBe("12.51");
  });
});
