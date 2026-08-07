import { describe, expect, it } from "vitest";
import { formatMinor, formatMoney, signedMinor } from "./minorMoney";

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
