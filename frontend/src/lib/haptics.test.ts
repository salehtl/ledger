import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HAPTIC_PATTERNS,
  fire,
  isHapticsEnabled,
  loadHapticsEnabled,
  setHapticsEnabled,
} from "./haptics";

const nav = navigator as unknown as { vibrate?: (p: number | number[]) => boolean };

beforeEach(() => {
  localStorage.clear();
  document.querySelectorAll("[data-haptic-switch]").forEach((el) => el.remove());
  nav.vibrate = vi.fn(() => true);
  setHapticsEnabled(true);
});

describe("fire", () => {
  it("vibrates with the mapped pattern for each kind", () => {
    for (const kind of ["selection", "light", "success", "warning"] as const) {
      (nav.vibrate as ReturnType<typeof vi.fn>).mockClear();
      fire(kind);
      expect(nav.vibrate).toHaveBeenCalledWith(HAPTIC_PATTERNS[kind]);
    }
  });

  it("does nothing when disabled", () => {
    setHapticsEnabled(false);
    fire("success");
    expect(nav.vibrate).not.toHaveBeenCalled();
  });

  it("falls back to a single reused hidden switch when vibrate is unavailable", () => {
    delete nav.vibrate;
    expect(() => fire("selection")).not.toThrow();
    expect(() => fire("selection")).not.toThrow();
    // The iOS switch element is created once and reused, never duplicated.
    expect(document.querySelectorAll("[data-haptic-switch]").length).toBe(1);
  });
});

describe("enabled flag", () => {
  it("defaults to enabled when nothing is stored", () => {
    localStorage.clear();
    expect(loadHapticsEnabled()).toBe(true);
    expect(isHapticsEnabled()).toBe(true);
  });

  it("persists and reloads the flag", () => {
    setHapticsEnabled(false);
    expect(isHapticsEnabled()).toBe(false);
    expect(loadHapticsEnabled()).toBe(false);
    setHapticsEnabled(true);
    expect(loadHapticsEnabled()).toBe(true);
  });
});
