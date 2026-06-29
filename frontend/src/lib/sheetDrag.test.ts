import { describe, it, expect } from "vitest";
import { sheetOffset, shouldDismiss, SHEET_DISMISS_DISTANCE } from "./sheetDrag";

describe("sheetOffset", () => {
  it("moves 1:1 when dragged down", () => {
    expect(sheetOffset(50)).toBe(50);
    expect(sheetOffset(0)).toBe(0);
  });
  it("applies damped resistance when dragged up past rest", () => {
    const up = sheetOffset(-100);
    expect(up).toBeLessThan(0);          // still moves up a little
    expect(up).toBeGreaterThan(-100);    // but far less than the raw drag
  });
});

describe("shouldDismiss", () => {
  it("dismisses on a long slow drag down", () => {
    expect(shouldDismiss(SHEET_DISMISS_DISTANCE + 1, 1000)).toBe(true);
  });
  it("dismisses on a quick flick even if short", () => {
    expect(shouldDismiss(40, 100)).toBe(true);   // 0.4 px/ms > 0.11
  });
  it("snaps back on a short slow drag", () => {
    expect(shouldDismiss(40, 1000)).toBe(false); // 0.04 px/ms, under both bars
  });
  it("never dismisses on an upward drag", () => {
    expect(shouldDismiss(-200, 100)).toBe(false);
  });
});
