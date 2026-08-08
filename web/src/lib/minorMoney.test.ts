import { describe, expect, it } from "vitest";
import { formatMinor, formatMoney, minorToDraft, monthlyTotalAdvice, parseMinorDraft, signedMinor } from "./minorMoney";

describe("formatMinor", () => {
  it("groups and pads without touching a Number", () => {
    expect(formatMinor(0n)).toBe("0.00");
    expect(formatMinor(5n)).toBe("0.05");
    expect(formatMinor(123456n)).toBe("1,234.56");
    expect(formatMinor(-123456n)).toBe("−1,234.56");
  });

  it("stays exact past 2^53, which is the whole point of the bigint", () => {
    // 9007199254740993n is Number.MAX_SAFE_INTEGER + 2: a `number` cannot hold
    // it, so a float round trip anywhere in here shows up as a wrong digit.
    expect(formatMinor(9007199254740993n)).toBe("90,071,992,547,409.93");
    expect(formatMinor(9223372036854775807n)).toBe("92,233,720,368,547,758.07");
  });
});

describe("formatMoney", () => {
  it("prefixes the code, and prints bare when the home currency is unknown", () => {
    expect(formatMoney(123456n, "AED")).toBe("AED 1,234.56");
    expect(formatMoney(123456n, "")).toBe("1,234.56");
  });
});

describe("signedMinor", () => {
  it("puts the direction on the glyph", () => {
    expect(signedMinor("debit", 2450n)).toEqual({ text: "−24.50", flow: "out" });
    expect(signedMinor("credit", 500000n)).toEqual({ text: "+5,000.00", flow: "in" });
  });

  it("prints an em dash for an unparsed row rather than a zero purchase", () => {
    expect(signedMinor("", 0n)).toEqual({ text: "—", flow: "none" });
  });
});

/**
 * The parse half, and the one with a bug history behind it.
 *
 * `NumberField` clamps silently per field: with `allowDecimal={false}` a typed
 * `33.3` becomes `333` and then clamps to the field's max. That is acceptable
 * for a percentage bounded by 100 and WRONG for money — nobody should discover
 * that the budget they typed is not the budget that was saved. So this refuses
 * visibly and never rewrites.
 */
describe("parseMinorDraft", () => {
  it("an empty draft is an absent total, which is not zero", () => {
    expect(parseMinorDraft("")).toEqual({ state: "empty" });
    expect(parseMinorDraft("   ")).toEqual({ state: "empty" });
    // Zero is a total a person can state, and it is not the same statement.
    expect(parseMinorDraft("0")).toEqual({ state: "amount", minor: 0n });
  });

  it("reads major units into minor units as a bigint", () => {
    expect(parseMinorDraft("12000")).toEqual({ state: "amount", minor: 1_200_000n });
    expect(parseMinorDraft("8500.5")).toEqual({ state: "amount", minor: 850_050n });
    expect(parseMinorDraft("8500.50")).toEqual({ state: "amount", minor: 850_050n });
    expect(parseMinorDraft("0.05")).toEqual({ state: "amount", minor: 5n });
    // Mid-keystroke: the digits typed so far, read as typed.
    expect(parseMinorDraft("12.")).toEqual({ state: "amount", minor: 1_200n });
  });

  it("honours a leading zero rather than rewriting the text", () => {
    expect(parseMinorDraft("007")).toEqual({ state: "amount", minor: 700n });
  });

  it("stays exact past 2^53, with no Number anywhere on the path", () => {
    // 2^53 + 1 minor units, typed as major units with a fraction.
    expect(parseMinorDraft("90071992547409.93")).toEqual({ state: "amount", minor: 9_007_199_254_740_993n });
    const back = parseMinorDraft("90071992547409.93");
    if (back.state !== "amount") throw new Error("expected an amount");
    expect(formatMinor(back.minor)).toBe("90,071,992,547,409.93");
    // The float64 route loses it, which is why this one is a bigint.
    expect(Math.round(Number("90071992547409.93") * 100)).not.toBe(9_007_199_254_740_993);
  });

  it("refuses more than two decimals visibly instead of rounding them away", () => {
    const got = parseMinorDraft("12.345");
    expect(got.state).toBe("refused");
    if (got.state !== "refused") throw new Error("expected a refusal");
    expect(got.reason).toMatch(/two decimal/i);
  });

  it("refuses a negative, because a budget is what you plan to spend", () => {
    const got = parseMinorDraft("-100");
    expect(got.state).toBe("refused");
    if (got.state !== "refused") throw new Error("expected a refusal");
    expect(got.reason).toMatch(/negative/i);
  });

  it("refuses anything that is not a plain decimal amount", () => {
    for (const text of ["12,000", "1e6", "abc", "12.3.4", "AED 12", "0x10", "."]) {
      expect(parseMinorDraft(text).state).toBe("refused");
    }
  });
});

describe("minorToDraft", () => {
  it("is the inverse of parseMinorDraft, so a seeded field is never unreadable to it", () => {
    // Ungrouped: `parseMinorDraft` refuses a comma, so `formatMinor`'s grouping
    // would seed a field the same screen then calls unreadable.
    expect(minorToDraft(1_200_000n)).toBe("12000.00");
    expect(minorToDraft(5n)).toBe("0.05");
    expect(minorToDraft(0n)).toBe("0.00");
    expect(minorToDraft(null)).toBe("");
    expect(minorToDraft(9_007_199_254_740_993n)).toBe("90071992547409.93");
    for (const minor of [0n, 5n, 1_200_000n, 9_007_199_254_740_993n]) {
      expect(parseMinorDraft(minorToDraft(minor))).toEqual({ state: "amount", minor });
    }
  });
});

describe("monthlyTotalAdvice", () => {
  it("says what an empty field means, so leaving it alone is an informed choice", () => {
    expect(monthlyTotalAdvice("", "AED")).toBe("No monthly total — ledger will just show what you spend.");
  });

  it("says the amount back in full before anything is saved", () => {
    expect(monthlyTotalAdvice("12000", "AED")).toBe("AED 12,000.00 a month.");
    expect(monthlyTotalAdvice("12000", null)).toBe("12,000.00 a month.");
  });

  it("says the refusal itself, never a rewritten amount", () => {
    expect(monthlyTotalAdvice("12.345", "AED")).toMatch(/two decimal/i);
    expect(monthlyTotalAdvice("12.345", "AED")).not.toMatch(/12\.35|12\.34/);
  });
});
