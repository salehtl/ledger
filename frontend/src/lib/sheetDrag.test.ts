import { describe, it, expect } from "vitest";
import { shouldDismissSheet, SHEET_DISMISS_PX, SHEET_FLICK_VELOCITY } from "./sheetDrag";

describe("shouldDismissSheet", () => {
  it("dismisses once dragged past the distance threshold", () => {
    expect(shouldDismissSheet(SHEET_DISMISS_PX + 1, 0)).toBe(true);
  });
  it("snaps back below the threshold with no speed", () => {
    expect(shouldDismissSheet(SHEET_DISMISS_PX - 1, 0)).toBe(false);
  });
  it("dismisses a short downward flick on velocity alone", () => {
    expect(shouldDismissSheet(24, SHEET_FLICK_VELOCITY + 1)).toBe(true);
  });
  it("never dismisses on an upward drag", () => {
    expect(shouldDismissSheet(-200, 0)).toBe(false);
    expect(shouldDismissSheet(-10, SHEET_FLICK_VELOCITY + 1)).toBe(false);
  });
  it("ignores an upward flick that reverses a downward drag", () => {
    expect(shouldDismissSheet(30, -(SHEET_FLICK_VELOCITY + 1))).toBe(false);
  });
});
