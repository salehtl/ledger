import { afterEach, describe, expect, it, vi } from "vitest";
import * as haptics from "./haptics";
import * as sound from "./sound";
import { fire, HAPTIC_FOR } from "./feedback";
import { FEEDBACK_KINDS } from "./soundSpec";

describe("HAPTIC_FOR mapping", () => {
  it("maps every feedback kind to a valid haptic", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(HAPTIC_FOR[kind]).toBeTruthy();
    }
  });

  it("routes semantic kinds to the right tactile pattern", () => {
    expect(HAPTIC_FOR.selection).toBe("selection");
    expect(HAPTIC_FOR.navigation).toBe("light");
    expect(HAPTIC_FOR.toggle).toBe("selection");
    expect(HAPTIC_FOR.milestone).toBe("success");
    expect(HAPTIC_FOR.error).toBe("warning");
  });
});

describe("feedback.fire", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drives both channels for a kind", () => {
    const h = vi.spyOn(haptics, "fire").mockImplementation(() => {});
    const s = vi.spyOn(sound, "play").mockImplementation(() => {});
    fire("success");
    expect(h).toHaveBeenCalledWith("success");
    expect(s).toHaveBeenCalledWith("success");
  });

  it("plays the sound for every kind", () => {
    vi.spyOn(haptics, "fire").mockImplementation(() => {});
    const s = vi.spyOn(sound, "play").mockImplementation(() => {});
    for (const kind of FEEDBACK_KINDS) {
      s.mockClear();
      fire(kind);
      expect(s).toHaveBeenCalledWith(kind);
    }
  });
});
