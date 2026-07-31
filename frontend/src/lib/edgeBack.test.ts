import { describe, expect, it } from "vitest";
import { EDGE_FLICK_VELOCITY, EDGE_ZONE_PX, inEdgeZone, shouldGoBack } from "./edgeBack";
import { FLICK_MIN_PX } from "./gesture";

describe("inEdgeZone", () => {
  it("accepts starts within the zone and rejects beyond it", () => {
    expect(inEdgeZone(0)).toBe(true);
    expect(inEdgeZone(EDGE_ZONE_PX)).toBe(true);
    expect(inEdgeZone(EDGE_ZONE_PX + 1)).toBe(false);
  });
});

describe("shouldGoBack", () => {
  const W = 390;
  it("goes back past a third of the screen width", () => {
    expect(shouldGoBack(W / 3 + 1, 0, W)).toBe(true);
  });
  it("stays below a third with no speed", () => {
    expect(shouldGoBack(W / 3 - 1, 0, W)).toBe(false);
  });
  it("goes back on a short rightward flick", () => {
    expect(shouldGoBack(40, EDGE_FLICK_VELOCITY + 1, W)).toBe(true);
  });
  it("never goes back on a leftward drag", () => {
    expect(shouldGoBack(-100, 0, W)).toBe(false);
  });
  it("ignores a rightward flick reading that never cleared the distance floor", () => {
    // A tap in the leftmost 24px of a drill-in page is ordinary — that is
    // where the back chevron lives — and a shivered one reads at flick speed.
    expect(shouldGoBack(5, EDGE_FLICK_VELOCITY * 2, W)).toBe(false);
    expect(shouldGoBack(FLICK_MIN_PX - 1, EDGE_FLICK_VELOCITY + 1, W)).toBe(false);
    expect(shouldGoBack(FLICK_MIN_PX, EDGE_FLICK_VELOCITY + 1, W)).toBe(true);
  });
  it("ignores a leftward flick that reverses a rightward drag", () => {
    expect(shouldGoBack(40, -(EDGE_FLICK_VELOCITY + 1), W)).toBe(false);
  });
});
