import { describe, it, expect } from "vitest";
import { shouldDismissToast, toastExitX, TOAST_DISMISS_PX, TOAST_EXIT_PX, TOAST_FLICK_VELOCITY } from "./toastSwipe";

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

describe("toastExitX", () => {
  it("sends a right-swipe past the distance threshold out to the right", () => {
    expect(toastExitX(TOAST_DISMISS_PX + 1, 0)).toBe(TOAST_EXIT_PX);
  });

  it("sends a left-swipe past the distance threshold out to the left", () => {
    expect(toastExitX(-(TOAST_DISMISS_PX + 1), 0)).toBe(-TOAST_EXIT_PX);
  });

  it("stays put when neither threshold is cleared", () => {
    expect(toastExitX(TOAST_DISMISS_PX - 1, 0)).toBe(0);
  });

  it("sends a zero-offset right-flick out to the right, not left", () => {
    // A fast flick can be released before the pointer has moved at all —
    // offsetX is exactly 0, so direction must come from velocity, not from
    // `offsetX > 0` defaulting to false and reading as "left".
    expect(toastExitX(0, TOAST_FLICK_VELOCITY + 1)).toBe(TOAST_EXIT_PX);
  });

  it("stays put when velocity reverses a drag that never cleared the threshold", () => {
    expect(toastExitX(20, -(TOAST_FLICK_VELOCITY + 1))).toBe(0);
  });
});
