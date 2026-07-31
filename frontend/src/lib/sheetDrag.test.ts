import { describe, it, expect } from "vitest";
import { shouldDismissSheet, SHEET_DISMISS_PX, SHEET_FLICK_VELOCITY } from "./sheetDrag";
import { FLICK_MIN_PX } from "./gesture";

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
  it("ignores a fast reading that never cleared the distance floor", () => {
    // A shivered tap on the drag handle is reported at ~600px/s on a few
    // pixels of travel. Without the floor it closed the sheet mid-edit.
    expect(shouldDismissSheet(5, SHEET_FLICK_VELOCITY * 2)).toBe(false);
    expect(shouldDismissSheet(FLICK_MIN_PX - 1, SHEET_FLICK_VELOCITY + 1)).toBe(false);
    expect(shouldDismissSheet(FLICK_MIN_PX, SHEET_FLICK_VELOCITY + 1)).toBe(true);
  });
});
