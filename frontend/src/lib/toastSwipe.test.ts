import { describe, it, expect } from "vitest";
import { shouldDismissToast, TOAST_DISMISS_PX, TOAST_FLICK_VELOCITY } from "./toastSwipe";

describe("shouldDismissToast", () => {
  it("dismisses a slow drag once it clears the distance threshold", () => {
    expect(shouldDismissToast(TOAST_DISMISS_PX + 1, 0)).toBe(true);
    expect(shouldDismissToast(-(TOAST_DISMISS_PX + 1), 0)).toBe(true);
  });

  it("keeps a slow drag that never clears the threshold", () => {
    expect(shouldDismissToast(TOAST_DISMISS_PX - 1, 0)).toBe(false);
  });

  it("dismisses a short flick on velocity alone", () => {
    expect(shouldDismissToast(20, TOAST_FLICK_VELOCITY + 1)).toBe(true);
    expect(shouldDismissToast(-20, -(TOAST_FLICK_VELOCITY + 1))).toBe(true);
  });

  it("ignores velocity pointing back toward centre", () => {
    // Dragged right, then flicked left — the user changed their mind.
    expect(shouldDismissToast(20, -(TOAST_FLICK_VELOCITY + 1))).toBe(false);
  });
});
