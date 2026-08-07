import { describe, it, expect } from "vitest";
import { flicked, FLICK_MIN_PX } from "./gesture";

const V = 500;

describe("flicked", () => {
  it("accepts a fast drag that cleared the distance floor", () => {
    expect(flicked(FLICK_MIN_PX, V, FLICK_MIN_PX, V)).toBe(true);
    expect(flicked(-FLICK_MIN_PX, -V, FLICK_MIN_PX, V)).toBe(true);
  });

  it("rejects a fast twitch that did not clear the floor", () => {
    // The whole reason this helper exists: PanSession reports ~600px/s for a
    // five-pixel shiver, which is past every surface's flick threshold.
    expect(flicked(FLICK_MIN_PX - 1, V * 2, FLICK_MIN_PX, V)).toBe(false);
    expect(flicked(5, 600, FLICK_MIN_PX, V)).toBe(false);
  });

  it("rejects velocity pointing back the way the drag came", () => {
    expect(flicked(60, -V, FLICK_MIN_PX, V)).toBe(false);
    expect(flicked(-60, V, FLICK_MIN_PX, V)).toBe(false);
  });

  it("rejects a long slow drag (that is the distance rule's job, not this one)", () => {
    expect(flicked(300, V - 1, FLICK_MIN_PX, V)).toBe(false);
    expect(flicked(300, 0, FLICK_MIN_PX, V)).toBe(false);
  });

  it("rejects a zero offset however fast the reading", () => {
    expect(flicked(0, V * 10, FLICK_MIN_PX, V)).toBe(false);
  });

  it("is inclusive at both thresholds", () => {
    expect(flicked(FLICK_MIN_PX, V, FLICK_MIN_PX, V)).toBe(true);
    expect(flicked(FLICK_MIN_PX - 0.01, V, FLICK_MIN_PX, V)).toBe(false);
    expect(flicked(FLICK_MIN_PX, V - 0.01, FLICK_MIN_PX, V)).toBe(false);
  });
});
