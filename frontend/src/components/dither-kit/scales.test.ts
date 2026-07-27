import { describe, it, expect } from "vitest";
import { buildYScale, computeBands } from "./scales";
import { flowColumns, flowRows } from "../../lib/flowBars";
import type { TrendPoint } from "../../lib/insights";

// Lives here, beside `palette.test.ts`, rather than in `lib/`: the behaviour
// under test belongs to the *vendored* module and to our local fork of it
// (`stackOffsetDiverging`). If a future `shadcn add --overwrite` reverts
// `scales.ts`, the failure lands next to the file that regressed instead of in
// app code that merely consumes it. The fixtures come from the real
// `lib/flowBars.ts` output, because FlowBars is the consumer that depends on
// the fork.

const pt = (period: string, income: number, spent: number): TrendPoint => ({
  period,
  label: period.slice(5),
  income,
  spent,
});

describe("computeBands · stacked", () => {
  // Two surplus months and one *deficit* month (spending > income) — the case
  // the in-vs-out chart exists to show, and the one plain cumulative stacking
  // (stackOffsetNone) paints outside the canvas.
  const cols = flowColumns([
    pt("2026-02", 200000, 100000), // surplus
    pt("2026-03", 50000, 100000), // deficit
    pt("2026-04", 100000, 100000), // break-even
  ]);
  const rows = flowRows(cols);

  it("splits negatives below zero instead of piling them on the positives", () => {
    const { bands } = computeBands(rows, ["income", "spent"], "stacked");

    // Income stacks up from zero.
    expect(bands.income).toEqual([
      [0, 200000],
      [0, 50000],
      [0, 100000],
    ]);
    // Spending (negated by flowRows) stacks *down* from zero — it must not
    // start where income ended.
    expect(bands.spent).toEqual([
      [-100000, 0],
      [-100000, 0],
      [-100000, 0],
    ]);
  });

  it("straddles zero, so min is negative and the deficit month stays in frame", () => {
    const { max, min } = computeBands(rows, ["income", "spent"], "stacked");

    expect(max).toBe(200000);
    expect(min).toBe(-100000);
    expect(min).toBeLessThan(0);

    // The y-scale therefore spans [-maxOut, +maxIn] and the whole deficit bar
    // maps inside the plot. With stackOffsetNone, min stayed 0 and the deficit
    // month's bar bottom (-50000) mapped to a pixel below the canvas.
    const y = buildYScale(min, max, 100);
    const bottom = y(min);
    expect(bottom).toBeGreaterThan(0);
    expect(bottom).toBeLessThanOrEqual(100);
    // Zero is not the vertical midpoint: the scale is asymmetric.
    expect(y(0)).toBeGreaterThan(0);
    expect(y(0)).toBeLessThan(bottom);
  });

  it("keeps plain cumulative behaviour when every series is positive", () => {
    const { bands, max, min } = computeBands(
      [{ a: 10, b: 5 }],
      ["a", "b"],
      "stacked"
    );
    expect(bands.a).toEqual([[0, 10]]);
    expect(bands.b).toEqual([[10, 15]]);
    expect(max).toBe(15);
    expect(min).toBe(0);
  });

  it("still normalizes to 0..1 for percent", () => {
    const { bands, max } = computeBands(
      [{ a: 30, b: 10 }],
      ["a", "b"],
      "percent"
    );
    expect(bands.a[0][1]).toBeCloseTo(0.75, 6);
    expect(bands.b[0][1]).toBeCloseTo(1, 6);
    expect(max).toBeCloseTo(1, 6);
  });
});
