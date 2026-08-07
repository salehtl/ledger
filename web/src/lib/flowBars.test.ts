import { describe, it, expect } from "vitest";
import { flowColumns, flowRows, flowExact, compactMinor } from "./flowBars";
import type { TrendMonth } from "../v2/sources/insights";

const pt = (period: string, income: bigint, spent: bigint): TrendMonth => ({
  period,
  label: period.slice(5),
  income,
  spent,
});

describe("flowColumns", () => {
  it("computes net and its sign", () => {
    const cols = flowColumns([pt("2026-02", 200000n, 100000n), pt("2026-03", 50000n, 100000n), pt("2026-04", 100000n, 100000n)]);
    expect(cols[0].net).toBe(100000n);
    expect(cols[0].netSign).toBe("pos");
    expect(cols[1].net).toBe(-50000n);
    expect(cols[1].netSign).toBe("neg");
    expect(cols[2].net).toBe(0n);
    expect(cols[2].netSign).toBe("zero");
  });

  it("scales the net lane on its own max-absolute-net, not the gross scale", () => {
    // Gross flows are ~1M but nets are ±100k; the lane amplifies to fill ±100.
    const cols = flowColumns([pt("2026-02", 1000000n, 900000n), pt("2026-03", 1000000n, 1100000n)]);
    expect(cols[0].netLanePct).toBe(100);
    expect(cols[1].netLanePct).toBe(-100);
  });

  it("keeps net-lane signs proportional when magnitudes differ", () => {
    const cols = flowColumns([pt("2026-02", 200000n, 0n), pt("2026-03", 0n, 100000n)]);
    expect(cols[0].netLanePct).toBe(100);
    expect(cols[1].netLanePct).toBe(-50);
  });

  it("places the net lane correctly for a net past 2^53", () => {
    // The whole reason this file is `bigint`: `Number(9007199254740993n)`
    // rounds, and half of that value is what decides the dot's y position.
    const cols = flowColumns([pt("2026-02", 9007199254740993n, 0n), pt("2026-03", 0n, 4503599627370496n)]);
    expect(cols[0].netLanePct).toBe(100);
    // Truncated at the lane's four decimal places, not rounded through a
    // double: 4503599627370496/9007199254740993 is a hair under a half.
    expect(cols[1].netLanePct).toBe(-49.9999);
  });

  it("renders an empty month with net zero", () => {
    const cols = flowColumns([pt("2026-05", 0n, 0n)]);
    expect(cols[0].net).toBe(0n);
    expect(cols[0].netSign).toBe("zero");
  });

  it("carries period and label through", () => {
    const cols = flowColumns([pt("2026-07", 10n, 20n)]);
    expect(cols[0].period).toBe("2026-07");
    expect(cols[0].label).toBe("07");
  });
});

describe("compactMinor", () => {
  it("shows sub-1k amounts as whole major units with a sign", () => {
    expect(compactMinor(82000n)).toBe("+820");
    expect(compactMinor(-14000n)).toBe("−140");
  });
  it("abbreviates thousands with one decimal, trimming .0", () => {
    expect(compactMinor(120000n)).toBe("+1.2k");
    expect(compactMinor(2100000n)).toBe("+21k");
    expect(compactMinor(-350000n)).toBe("−3.5k");
  });
  it("abbreviates millions", () => {
    expect(compactMinor(150000000n)).toBe("+1.5m");
  });
  it("shows zero without a sign", () => {
    expect(compactMinor(0n)).toBe("0");
  });
  it("compacts a figure past 2^53 without rounding through a double", () => {
    // 9007199254740993 minor = 90,071,992,547,409.93 major = 90,071,992.5 m.
    expect(compactMinor(9007199254740993n)).toBe("+90071992.5m");
  });
});

describe("flowRows", () => {
  it("negates spending so stacked bars diverge around zero", () => {
    expect(flowRows(flowColumns([pt("2026-05", 200000n, 100000n), pt("2026-06", 50000n, 100000n)]))).toEqual([
      { period: "2026-05", label: "05", income: 200000, spent: -100000 },
      { period: "2026-06", label: "06", income: 50000, spent: -100000 },
    ]);
  });

  it("leaves a zero month at zero rather than negative zero", () => {
    const zero = flowRows(flowColumns([pt("2026-07", 0n, 0n)]));
    expect(Object.is(zero[0].spent, -0)).toBe(false);
    expect(zero[0].spent).toBe(0);
  });

  it("returns an empty array for an empty series", () => {
    expect(flowRows([])).toEqual([]);
  });
});

describe("flowExact", () => {
  it("maps a scaled chart value back to the exact amount it stands for", () => {
    const cols = flowColumns([pt("2026-05", 9007199254740993n, 100000n)]);
    const rows = flowRows(cols);
    const exact = flowExact(cols);
    expect(exact.get(rows[0].income)).toBe(9007199254740993n);
    expect(exact.get(rows[0].spent)).toBe(100000n);
  });
});
