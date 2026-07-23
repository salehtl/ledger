import { describe, it, expect } from "vitest";
import { resist, shouldTrigger, pullIntent, PULL_THRESHOLD, MAX_PULL, AXIS_SLOP } from "./pullToRefresh";

describe("resist", () => {
  it("returns 0 for non-positive travel", () => {
    expect(resist(0)).toBe(0);
    expect(resist(-50)).toBe(0);
  });

  it("damps raw finger travel", () => {
    expect(resist(100)).toBe(50); // 100 * 0.5
  });

  it("caps at MAX_PULL", () => {
    expect(resist(10_000)).toBe(MAX_PULL);
  });
});

describe("shouldTrigger", () => {
  it("triggers at or past the threshold", () => {
    expect(shouldTrigger(PULL_THRESHOLD)).toBe(true);
    expect(shouldTrigger(PULL_THRESHOLD + 1)).toBe(true);
  });

  it("does not trigger below the threshold", () => {
    expect(shouldTrigger(PULL_THRESHOLD - 1)).toBe(false);
    expect(shouldTrigger(0)).toBe(false);
  });
});

describe("pullIntent (axis lock)", () => {
  it("stays undecided inside the slop", () => {
    expect(pullIntent(0, 0)).toBe("undecided");
    expect(pullIntent(AXIS_SLOP, AXIS_SLOP)).toBe("undecided");
    expect(pullIntent(-AXIS_SLOP, AXIS_SLOP)).toBe("undecided");
  });

  it("claims a clearly-downward drag", () => {
    expect(pullIntent(0, AXIS_SLOP + 1)).toBe("claim");
    expect(pullIntent(4, 30)).toBe("claim");
    expect(pullIntent(-4, 30)).toBe("claim");
  });

  it("rejects a horizontal drag even with downward drift", () => {
    expect(pullIntent(30, 0)).toBe("reject");
    expect(pullIntent(-30, 0)).toBe("reject");
    expect(pullIntent(30, 20)).toBe("reject"); // row-swipe with vertical wobble
  });

  it("rejects an upward drag (scroll intent)", () => {
    expect(pullIntent(0, -(AXIS_SLOP + 1))).toBe("reject");
  });

  it("rejects a perfect diagonal (never fights a swipe)", () => {
    expect(pullIntent(30, 30)).toBe("reject");
  });
});
