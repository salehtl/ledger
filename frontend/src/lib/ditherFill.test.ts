import { describe, it, expect } from "vitest";
import { segmentBounds } from "./ditherFill";

describe("segmentBounds", () => {
  it("reaches full width when the segments sum to max", () => {
    // Three segments at 1/3 each over 100 columns. Rounding each span on its
    // own gives 33 + 33 + 33 = 99 — one column of track left showing on a bar
    // that is by definition full. Cumulative boundaries land on 33/67/100.
    const bounds = segmentBounds([1, 1, 1], 3, 100);
    expect(bounds).toEqual([
      [0, 33],
      [33, 67],
      [67, 100],
    ]);
    expect(bounds[bounds.length - 1][1]).toBe(100);
  });

  it("never accumulates error, however many segments there are", () => {
    const n = 17;
    const bounds = segmentBounds(Array(n).fill(1), n, 261);
    expect(bounds[bounds.length - 1][1]).toBe(261);
    // Segments stay contiguous — no gaps, no overlaps.
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i][0]).toBe(bounds[i - 1][1]);
    }
  });

  it("leaves track when the segments fall short of max", () => {
    expect(segmentBounds([25], 100, 80)).toEqual([[0, 20]]);
  });

  it("clamps at cols when the segments overshoot max", () => {
    expect(segmentBounds([80, 80], 100, 50)).toEqual([
      [0, 40],
      [40, 50],
    ]);
  });

  it("treats a negative segment as zero rather than eating its neighbour", () => {
    expect(segmentBounds([-10, 50], 100, 100)).toEqual([
      [0, 0],
      [0, 50],
    ]);
  });

  it("renders empty instead of NaN when max is zero", () => {
    expect(segmentBounds([0], 0, 100)).toEqual([[0, 0]]);
  });

  it("returns nothing for no segments", () => {
    expect(segmentBounds([], 100, 100)).toEqual([]);
  });
});
