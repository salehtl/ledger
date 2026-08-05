import { describe, expect, test } from "bun:test";

import { convert } from "@ledger/client/replay/fx.ts";

import {
  MAX_MINOR,
  MINOR_DIGITS,
  MINOR_SCALE,
  divideEvenly,
  draftFromMinor,
  formatMinor,
  parseAmountDraft,
  remainderAfter,
  sanitizeAmountDraft,
  signedAmount,
  sumMinor,
} from "./money.ts";

describe("formatMinor", () => {
  test("always prints exactly the currency's minor digits", () => {
    expect(formatMinor(0n)).toBe("0.00");
    expect(formatMinor(5n)).toBe("0.05");
    expect(formatMinor(50n)).toBe("0.50");
    expect(formatMinor(100n)).toBe("1.00");
    expect(formatMinor(123456n)).toBe("1,234.56");
  });

  test("groups every three digits, at every boundary", () => {
    expect(formatMinor(99999n)).toBe("999.99");
    expect(formatMinor(100000n)).toBe("1,000.00");
    expect(formatMinor(99999999n)).toBe("999,999.99");
    expect(formatMinor(100000000n)).toBe("1,000,000.00");
    expect(formatMinor(123456789012n)).toBe("1,234,567,890.12");
  });

  test("the hostile fixture amount from v1's harness", () => {
    // seed.mjs carries a 250,000 amount precisely because it is wide enough to
    // break a row's layout. It must at least be printed correctly.
    expect(formatMinor(25_000_000n)).toBe("250,000.00");
  });

  test("a value above 2^53 survives, where a number would not", () => {
    const minor = 9_007_199_254_740_993n; // 2^53 + 1
    expect(formatMinor(minor)).toBe("90,071,992,547,409.93");
    // The measurement, not the claim: the double path really does lose it.
    expect(BigInt(Number(minor))).not.toBe(minor);
  });

  test("the largest int64 of minor units", () => {
    expect(formatMinor(MAX_MINOR)).toBe("92,233,720,368,547,758.07");
  });

  test("negatives carry a real minus sign and never a negative zero", () => {
    expect(formatMinor(-1n)).toBe("−0.01");
    expect(formatMinor(-123456n)).toBe("−1,234.56");
    // bigint has no -0, and the formatter must not manufacture one either: a
    // float path prints "-0.00" for a remainder that came out at exactly zero.
    expect(formatMinor(-0n)).toBe("0.00");
    expect(formatMinor(0n - 0n)).toBe("0.00");
  });

  test("the scale and the digit count agree", () => {
    expect(MINOR_SCALE).toBe(10n ** BigInt(MINOR_DIGITS));
  });
});

describe("signedAmount", () => {
  test("direction rides on the glyph, not on colour alone", () => {
    expect(signedAmount("debit", 2450n)).toEqual({ text: "−24.50", flow: "out" });
    expect(signedAmount("credit", 500000n)).toEqual({ text: "+5,000.00", flow: "in" });
  });

  test("an empty direction is not a zero — it prints as unknown", () => {
    // The Task 7 shape: an unparsed row has amount 0n and direction "". Printing
    // "0.00" here is the exact defect Task 18 Step 5 forbids.
    expect(signedAmount("", 0n)).toEqual({ text: "—", flow: "none" });
  });
});

describe("parseAmountDraft", () => {
  test("an empty draft is empty, never zero", () => {
    // Number("") === 0 is the springback v1's harness found by clearing every
    // field on every screen. The parser must be able to say "no number yet".
    expect(parseAmountDraft("")).toEqual({ kind: "empty" });
    expect(parseAmountDraft("   ")).toEqual({ kind: "empty" });
    expect(parseAmountDraft(".")).toEqual({ kind: "empty" });
  });

  test("whole and fractional entry", () => {
    expect(parseAmountDraft("150")).toEqual({ kind: "ok", minor: 15000n, rounded: false });
    expect(parseAmountDraft("39.50")).toEqual({ kind: "ok", minor: 3950n, rounded: false });
    expect(parseAmountDraft("39.5")).toEqual({ kind: "ok", minor: 3950n, rounded: false });
    expect(parseAmountDraft("0.05")).toEqual({ kind: "ok", minor: 5n, rounded: false });
    expect(parseAmountDraft(".5")).toEqual({ kind: "ok", minor: 50n, rounded: false });
    expect(parseAmountDraft("12.")).toEqual({ kind: "ok", minor: 1200n, rounded: false });
  });

  test("grouping separators and spaces are stripped, a dot is the decimal point", () => {
    expect(parseAmountDraft("1,250.75")).toEqual({ kind: "ok", minor: 125075n, rounded: false });
    expect(parseAmountDraft("1,234,567")).toEqual({ kind: "ok", minor: 123456700n, rounded: false });
    expect(parseAmountDraft("1 234.5")).toEqual({ kind: "ok", minor: 123450n, rounded: false });
    expect(parseAmountDraft("1 234.5")).toEqual({ kind: "ok", minor: 123450n, rounded: false });
  });

  test("excess fraction digits round HALF-UP, and say that they did", () => {
    expect(parseAmountDraft("1.005")).toEqual({ kind: "ok", minor: 101n, rounded: true });
    expect(parseAmountDraft("1.004")).toEqual({ kind: "ok", minor: 100n, rounded: true });
    expect(parseAmountDraft("1.0049999")).toEqual({ kind: "ok", minor: 100n, rounded: true });
    expect(parseAmountDraft("1.995")).toEqual({ kind: "ok", minor: 200n, rounded: true });
    // Trailing zeros beyond the minor digits change nothing, so they are not a
    // rounding event and must not be reported as one.
    expect(parseAmountDraft("1.5000")).toEqual({ kind: "ok", minor: 150n, rounded: false });
  });

  test("its rounding is the SAME rule client/src/replay/fx.ts converts with", () => {
    // Half-up above zero, both of them. If these two ever disagree, one part of
    // the app rounds a user's typed amount differently from the part that
    // converts it, and the disagreement is one minor unit and silent.
    //
    // convert(x, rate) = (x*rate + 500_000) / 1_000_000. One minor unit at a
    // rate of 100.<tail> is therefore the same real number as a draft of
    // "1.00<tail>" — 100.<tail> minor units — reached by the other route.
    for (const [tail, typed] of [
      ["0", "1.000"],
      ["4", "1.004"],
      ["5", "1.005"],
      ["6", "1.006"],
      ["9", "1.009"],
    ] as const) {
      const viaFx = convert(1n, BigInt(`100${tail}00000`));
      const viaDraft = parseAmountDraft(typed);
      expect(viaDraft.kind).toBe("ok");
      if (viaDraft.kind !== "ok") throw new Error("unreachable");
      expect(viaDraft.minor).toBe(viaFx);
    }
  });

  test("refuses what is not a plain non-negative amount", () => {
    for (const bad of ["-5", "1e3", "1.2.3", "abc", "12abc", "0x10", "Infinity", "١٢٣", "1..2"]) {
      expect(parseAmountDraft(bad).kind).toBe("invalid");
    }
  });

  test("refuses an amount no int64 of minor units can hold", () => {
    expect(parseAmountDraft("92233720368547758.07")).toEqual({ kind: "ok", minor: MAX_MINOR, rounded: false });
    expect(parseAmountDraft("92233720368547758.08").kind).toBe("invalid");
    expect(parseAmountDraft("99999999999999999999").kind).toBe("invalid");
  });

  test("round-trips through draftFromMinor", () => {
    for (const minor of [0n, 1n, 5n, 99n, 100n, 3950n, 25_000_000n, 9_007_199_254_740_993n, MAX_MINOR]) {
      const back = parseAmountDraft(draftFromMinor(minor));
      expect(back).toEqual({ kind: "ok", minor, rounded: false });
    }
  });

  test("draftFromMinor drops a bare .00 but never a real fraction", () => {
    expect(draftFromMinor(15000n)).toBe("150");
    expect(draftFromMinor(3950n)).toBe("39.50");
    expect(draftFromMinor(5n)).toBe("0.05");
    expect(draftFromMinor(0n)).toBe("0");
  });
});

describe("sanitizeAmountDraft", () => {
  test("keeps what a user can still be typing", () => {
    expect(sanitizeAmountDraft("")).toBe("");
    expect(sanitizeAmountDraft("12.")).toBe("12.");
    expect(sanitizeAmountDraft("1,250.7")).toBe("1,250.7");
  });

  test("a comma keypad emits a decimal comma; a second separator is dropped", () => {
    // "12,5" has no dot, so the comma is the decimal separator this keypad had.
    expect(sanitizeAmountDraft("12,5")).toBe("12.5");
    // "1,250.75" has a dot, so the comma is grouping and stays grouping.
    expect(sanitizeAmountDraft("1,250.75")).toBe("1,250.75");
    // A lone comma followed by exactly three digits is grouping, so a pasted
    // "1,234" is 1234 and not 1.23 — the one case where guessing wrong turns a
    // four-figure amount into a one-figure one.
    expect(sanitizeAmountDraft("1,234")).toBe("1,234");
    expect(parseAmountDraft(sanitizeAmountDraft("1,234"))).toEqual({ kind: "ok", minor: 123400n, rounded: false });
    expect(sanitizeAmountDraft("1,234,567")).toBe("1,234,567");
  });

  test("strips what cannot be part of an amount", () => {
    expect(sanitizeAmountDraft("AED 12.50")).toBe("12.50");
    expect(sanitizeAmountDraft("-12")).toBe("12");
    expect(sanitizeAmountDraft("1.2.3")).toBe("1.23");
  });

  test("sanitizing is idempotent", () => {
    for (const raw of ["AED 1,250.75", "12,5", "--3..4", "1 000"]) {
      expect(sanitizeAmountDraft(sanitizeAmountDraft(raw))).toBe(sanitizeAmountDraft(raw));
    }
  });
});

describe("divideEvenly", () => {
  test("the last part absorbs the remainder, so the set sums exactly", () => {
    expect(divideEvenly(10000n, 3)).toEqual([3333n, 3333n, 3334n]);
    expect(divideEvenly(10000n, 1)).toEqual([10000n]);
    expect(divideEvenly(1n, 1)).toEqual([1n]);
  });

  test("every division sums back to the parent — I8_split_sum's precondition", () => {
    for (const total of [1n, 2n, 7n, 100n, 3950n, 25_000_000n, MAX_MINOR]) {
      for (const n of [1, 2, 3, 4, 7, 13]) {
        const parts = divideEvenly(total, n);
        expect(parts.length).toBe(n);
        expect(sumMinor(parts)).toBe(total);
      }
    }
  });

  test("a parent too small to divide produces zero parts, which callers must refuse", () => {
    // Split parts go through positiveMoney on decode, so a 0n part would be an
    // invalid_payload anomaly. The division reports the truth; validation is the
    // caller's job (see txnEdit).
    expect(divideEvenly(2n, 3)).toEqual([0n, 0n, 2n]);
  });

  test("refuses a negative parent and a non-positive count", () => {
    expect(() => divideEvenly(-1n, 2)).toThrow();
    expect(() => divideEvenly(100n, 0)).toThrow();
    expect(() => divideEvenly(100n, 1.5)).toThrow();
  });
});

describe("remainderAfter", () => {
  test("an exactly-allocated split leaves exactly zero, with no negative zero", () => {
    const r = remainderAfter(10000n, [3333n, 3333n, 3334n]);
    expect(r).toBe(0n);
    expect(formatMinor(r)).toBe("0.00");
  });

  test("overshoot is negative, undershoot positive", () => {
    expect(remainderAfter(10000n, [5000n, 5001n])).toBe(-1n);
    expect(remainderAfter(10000n, [5000n])).toBe(5000n);
    expect(remainderAfter(10000n, [])).toBe(10000n);
  });
});
