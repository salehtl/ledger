import { describe, it, expect } from "vitest";
import { shouldDismissToast, toastExitX, TOAST_DISMISS_PX, TOAST_EXIT_PX, TOAST_FLICK_VELOCITY } from "./toastSwipe";
import { FLICK_MIN_PX } from "./gesture";

describe("shouldDismissToast", () => {
  it("dismisses a slow drag once it clears the distance threshold", () => {
    expect(shouldDismissToast(TOAST_DISMISS_PX + 1, 0)).toBe(true);
    expect(shouldDismissToast(-(TOAST_DISMISS_PX + 1), 0)).toBe(true);
  });

  it("keeps a slow drag that never clears the threshold", () => {
    expect(shouldDismissToast(TOAST_DISMISS_PX - 1, 0)).toBe(false);
  });

  it("dismisses a short flick on velocity alone", () => {
    expect(shouldDismissToast(FLICK_MIN_PX + 6, TOAST_FLICK_VELOCITY + 1)).toBe(true);
    expect(shouldDismissToast(-(FLICK_MIN_PX + 6), -(TOAST_FLICK_VELOCITY + 1))).toBe(true);
  });

  it("ignores velocity pointing back toward centre", () => {
    // Dragged right, then flicked left — the user changed their mind.
    expect(shouldDismissToast(FLICK_MIN_PX + 6, -(TOAST_FLICK_VELOCITY + 1))).toBe(false);
  });

  it("ignores a fast reading that never cleared the distance floor", () => {
    // The press-on-Undo case: a finger that lands on the action button and
    // shivers is reported at flick speed on a handful of pixels. Dismissing
    // there loses the undo outright — SwipeDeck's undo is one-shot.
    expect(shouldDismissToast(5, TOAST_FLICK_VELOCITY * 2)).toBe(false);
    expect(shouldDismissToast(FLICK_MIN_PX - 1, TOAST_FLICK_VELOCITY + 1)).toBe(false);
    expect(shouldDismissToast(FLICK_MIN_PX, TOAST_FLICK_VELOCITY + 1)).toBe(true);
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

  it("stays put on a zero-offset flick — that is a twitch, not a swipe", () => {
    // This used to fly out to the right: a fast reading with no travel at all
    // was treated as a flick and the direction taken from velocity. The
    // distance floor (lib/gesture.ts) rules the whole case out, which is the
    // point — a toast that vanishes on a stationary finger takes its Undo
    // with it.
    expect(toastExitX(0, TOAST_FLICK_VELOCITY + 1)).toBe(0);
  });

  it("takes the exit direction from a real flick's offset", () => {
    expect(toastExitX(FLICK_MIN_PX + 6, TOAST_FLICK_VELOCITY + 1)).toBe(TOAST_EXIT_PX);
    expect(toastExitX(-(FLICK_MIN_PX + 6), -(TOAST_FLICK_VELOCITY + 1))).toBe(-TOAST_EXIT_PX);
  });

  it("stays put when velocity reverses a drag that never cleared the threshold", () => {
    expect(toastExitX(FLICK_MIN_PX + 6, -(TOAST_FLICK_VELOCITY + 1))).toBe(0);
  });
});
