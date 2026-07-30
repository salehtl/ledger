import { describe, expect, it } from "vitest";
import { EDGE_FLICK_VELOCITY, EDGE_ZONE_PX, inEdgeZone, shouldGoBack } from "./edgeBack";

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
});
