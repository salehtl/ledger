import { describe, it, expect } from "vitest";
import { flowColumns, flowRows, compactFils } from "./flowBars";
import type { TrendPoint } from "./insights";

const pt = (period: string, income: number, spent: number): TrendPoint => ({
  period,
  label: period.slice(5),
  income,
  spent,
});

describe("flowColumns", () => {
  it("computes net and its sign", () => {
    const cols = flowColumns([pt("2026-02", 200000, 100000), pt("2026-03", 50000, 100000), pt("2026-04", 100000, 100000)]);
    expect(cols[0].net).toBe(100000);
    expect(cols[0].netSign).toBe("pos");
    expect(cols[1].net).toBe(-50000);
    expect(cols[1].netSign).toBe("neg");
    expect(cols[2].net).toBe(0);
    expect(cols[2].netSign).toBe("zero");
  });

  it("scales the net lane on its own max-absolute-net, not the gross scale", () => {
    // Gross flows are ~1M but nets are ±100k; the lane amplifies to fill ±100.
    const cols = flowColumns([pt("2026-02", 1000000, 900000), pt("2026-03", 1000000, 1100000)]);
    expect(cols[0].netLanePct).toBe(100); // net +100000 of maxAbsNet 100000
    expect(cols[1].netLanePct).toBe(-100); // net -100000 of maxAbsNet 100000
  });

  it("keeps net-lane signs proportional when magnitudes differ", () => {
    const cols = flowColumns([pt("2026-02", 200000, 0), pt("2026-03", 0, 100000)]);
    expect(cols[0].netLanePct).toBe(100); // +200000 of maxAbsNet 200000
    expect(cols[1].netLanePct).toBe(-50); // -100000 of maxAbsNet 200000
  });

  it("renders an empty month with net zero", () => {
    const cols = flowColumns([pt("2026-05", 0, 0)]);
    expect(cols[0].net).toBe(0);
    expect(cols[0].netSign).toBe("zero");
  });

  it("carries period and label through", () => {
    const cols = flowColumns([pt("2026-07", 10, 20)]);
    expect(cols[0].period).toBe("2026-07");
    expect(cols[0].label).toBe("07");
  });
});

describe("compactFils", () => {
  it("shows sub-1k amounts as whole AED with a sign", () => {
    expect(compactFils(82000)).toBe("+820");
    expect(compactFils(-14000)).toBe("−140");
  });
  it("abbreviates thousands with one decimal, trimming .0", () => {
    expect(compactFils(120000)).toBe("+1.2k");
    expect(compactFils(2100000)).toBe("+21k");
    expect(compactFils(-350000)).toBe("−3.5k");
  });
  it("abbreviates millions", () => {
    expect(compactFils(150000000)).toBe("+1.5m");
  });
  it("shows zero without a sign", () => {
    expect(compactFils(0)).toBe("0");
  });
});

describe("flowRows", () => {
  it("negates spending so stacked bars diverge around zero", () => {
    const pts: TrendPoint[] = [
      { period: "2026-05", label: "May", income: 200000, spent: 100000 },
      { period: "2026-06", label: "Jun", income: 50000, spent: 100000 },
    ];
    expect(flowRows(flowColumns(pts))).toEqual([
      { period: "2026-05", label: "May", income: 200000, spent: -100000 },
      { period: "2026-06", label: "Jun", income: 50000, spent: -100000 },
    ]);
  });

  it("leaves a zero month at zero rather than negative zero", () => {
    const zero = flowRows(flowColumns([{ period: "2026-07", label: "Jul", income: 0, spent: 0 }]));
    expect(Object.is(zero[0].spent, -0)).toBe(false);
    expect(zero[0].spent).toBe(0);
  });

  it("returns an empty array for an empty series", () => {
    expect(flowRows([])).toEqual([]);
  });
});
