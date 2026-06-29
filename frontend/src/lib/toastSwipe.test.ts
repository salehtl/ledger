import { describe, it, expect } from "vitest";
import { shouldDismissToast, TOAST_DISMISS_DISTANCE } from "./toastSwipe";

describe("shouldDismissToast", () => {
  it("dismisses on a long horizontal drag either direction", () => {
    expect(shouldDismissToast(TOAST_DISMISS_DISTANCE + 1, 1000)).toBe(true);
    expect(shouldDismissToast(-(TOAST_DISMISS_DISTANCE + 1), 1000)).toBe(true);
  });
  it("dismisses on a quick flick", () => {
    expect(shouldDismissToast(30, 100)).toBe(true); // 0.3 px/ms > 0.11
  });
  it("snaps back on a small slow drag", () => {
    expect(shouldDismissToast(20, 1000)).toBe(false);
  });
});
