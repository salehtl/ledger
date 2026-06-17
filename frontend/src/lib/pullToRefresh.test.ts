import { describe, it, expect } from "vitest";
import { resist, shouldTrigger, PULL_THRESHOLD, MAX_PULL } from "./pullToRefresh";

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
