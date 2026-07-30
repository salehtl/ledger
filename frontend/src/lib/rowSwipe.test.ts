import { describe, it, expect } from "vitest";
import { swipeCommits, swipeProgress, ROW_COMMIT, ROW_FLICK_VELOCITY } from "./rowSwipe";

const both = { lead: true, trail: true };
const leadOnly = { lead: true, trail: false };

describe("swipeCommits", () => {
  it("commits the lead action on a long rightward drag", () => {
    expect(swipeCommits(ROW_COMMIT + 1, 0, both)).toBe("lead");
  });
  it("commits the trail action on a long leftward drag", () => {
    expect(swipeCommits(-(ROW_COMMIT + 1), 0, both)).toBe("trail");
  });
  it("commits on a short flick", () => {
    expect(swipeCommits(20, ROW_FLICK_VELOCITY + 1, both)).toBe("lead");
  });
  it("returns null below both thresholds", () => {
    expect(swipeCommits(ROW_COMMIT - 1, 0, both)).toBeNull();
  });
  it("never commits an action the row does not have", () => {
    expect(swipeCommits(-(ROW_COMMIT + 1), 0, leadOnly)).toBeNull();
  });
  it("ignores velocity that reverses the drag", () => {
    expect(swipeCommits(20, -(ROW_FLICK_VELOCITY + 1), both)).toBeNull();
  });
});

describe("swipeProgress", () => {
  it("ramps 0..1 across the commit distance and clamps beyond it", () => {
    expect(swipeProgress(0)).toBe(0);
    expect(swipeProgress(ROW_COMMIT)).toBe(1);
    expect(swipeProgress(ROW_COMMIT * 2)).toBe(1);
    expect(swipeProgress(-ROW_COMMIT)).toBe(1);
  });
});
