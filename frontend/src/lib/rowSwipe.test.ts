import { describe, it, expect } from "vitest";
import {
  swipeAxis, swipeTarget, swipeOffset, swipeCommits, swipeProgress,
  ROW_COMMIT, ROW_MAX_TRAVEL,
} from "./rowSwipe";

const BOTH = { lead: true, trail: true };
const LEAD_ONLY = { lead: true, trail: false };

describe("swipeAxis", () => {
  it("stays undecided within the slop", () => {
    expect(swipeAxis(4, 4)).toBeNull();
  });
  it("locks horizontal when dx dominates", () => {
    expect(swipeAxis(20, 5)).toBe("h");
  });
  it("locks vertical when dy dominates", () => {
    expect(swipeAxis(5, 20)).toBe("v");
  });
});

describe("swipeTarget", () => {
  it("maps a rightward drag to the leading action", () => {
    expect(swipeTarget(30, BOTH)).toBe("lead");
  });
  it("maps a leftward drag to the trailing action", () => {
    expect(swipeTarget(-30, BOTH)).toBe("trail");
  });
  it("returns null when the pointed-at action is absent", () => {
    expect(swipeTarget(-30, LEAD_ONLY)).toBeNull();
  });
});

describe("swipeOffset", () => {
  it("tracks the finger 1:1 within max travel", () => {
    expect(swipeOffset(60, BOTH)).toBe(60);
  });
  it("rubber-bands past max travel", () => {
    const off = swipeOffset(ROW_MAX_TRAVEL + 100, BOTH);
    expect(off).toBeGreaterThan(ROW_MAX_TRAVEL);
    expect(off).toBeLessThan(ROW_MAX_TRAVEL + 100);
  });
  it("only rubber-bands (never fully opens) toward a missing action", () => {
    const off = swipeOffset(-120, LEAD_ONLY);
    expect(off).toBeLessThan(0);
    expect(Math.abs(off)).toBeLessThan(ROW_COMMIT); // stays short of commit
  });
});

describe("swipeCommits", () => {
  it("commits past the threshold toward a real action", () => {
    expect(swipeCommits(ROW_COMMIT + 5, BOTH)).toBe("lead");
    expect(swipeCommits(-(ROW_COMMIT + 5), BOTH)).toBe("trail");
  });
  it("does not commit short of the threshold", () => {
    expect(swipeCommits(ROW_COMMIT - 5, BOTH)).toBeNull();
  });
  it("never commits toward a missing action", () => {
    expect(swipeCommits(-200, LEAD_ONLY)).toBeNull();
  });
});

describe("swipeProgress", () => {
  it("is 0 at rest and clamps to 1 at the commit threshold", () => {
    expect(swipeProgress(0)).toBe(0);
    expect(swipeProgress(ROW_COMMIT / 2)).toBeCloseTo(0.5);
    expect(swipeProgress(ROW_COMMIT * 2)).toBe(1);
  });
});
