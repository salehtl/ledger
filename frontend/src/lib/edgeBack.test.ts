import { describe, expect, it } from "vitest";
import { BACK_COMMIT_VELOCITY, EDGE_ZONE_PX, edgeBackOffset, inEdgeZone, shouldGoBack } from "./edgeBack";

describe("inEdgeZone", () => {
  it("accepts starts within the zone and rejects beyond it", () => {
    expect(inEdgeZone(0)).toBe(true);
    expect(inEdgeZone(EDGE_ZONE_PX)).toBe(true);
    expect(inEdgeZone(EDGE_ZONE_PX + 1)).toBe(false);
  });
});

describe("edgeBackOffset", () => {
  it("follows rightward drag 1:1 and clamps leftward drag to rest", () => {
    expect(edgeBackOffset(120)).toBe(120);
    expect(edgeBackOffset(0)).toBe(0);
    expect(edgeBackOffset(-40)).toBe(0);
  });
});

describe("shouldGoBack", () => {
  const width = 390; // iPhone-ish viewport

  it("commits past a third of the viewport width", () => {
    expect(shouldGoBack(130, 5000, width)).toBe(true);
    expect(shouldGoBack(129, 5000, width)).toBe(false);
  });

  it("commits a fast flick regardless of distance", () => {
    expect(shouldGoBack(40, 40 / BACK_COMMIT_VELOCITY - 1, width)).toBe(true);
  });

  it("rejects slow short drags and leftward drags", () => {
    expect(shouldGoBack(40, 2000, width)).toBe(false);
    expect(shouldGoBack(-200, 10, width)).toBe(false);
    expect(shouldGoBack(0, 10, width)).toBe(false);
  });
});
