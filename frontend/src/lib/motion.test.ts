import { describe, it, expect } from "vitest";
import {
  EASE_OUT, EASE_DRAWER, DUR,
  SHEET_ENTER, SHEET_EXIT, PRESS_TRANSITION, FADE,
  SPRING_SNAP, SPRING_SHEET, SPRING_ROW,
} from "./motion";

describe("easing tokens", () => {
  it("exports cubic-bezier control points as 4-tuples", () => {
    expect(EASE_OUT).toEqual([0.23, 1, 0.32, 1]);
    expect(EASE_DRAWER).toEqual([0.32, 0.72, 0, 1]);
  });
});

describe("duration budget", () => {
  it("keeps every UI duration at or under 300ms", () => {
    for (const [name, seconds] of Object.entries(DUR)) {
      expect(seconds, `${name} exceeds the 300ms UI budget`).toBeLessThanOrEqual(0.3);
    }
  });
  it("makes the sheet exit snappier than its enter", () => {
    expect(SHEET_EXIT.duration!).toBeLessThan(SHEET_ENTER.duration!);
  });
});

describe("transition tokens", () => {
  it("gives duration-based transitions the ease-out curve", () => {
    expect(PRESS_TRANSITION.ease).toEqual(EASE_OUT);
    expect(FADE.ease).toEqual(EASE_OUT);
  });
  it("gives sheets the drawer curve", () => {
    expect(SHEET_ENTER.ease).toEqual(EASE_DRAWER);
    expect(SHEET_EXIT.ease).toEqual(EASE_DRAWER);
  });
  it("exports springs, not durations, for gesture-driven motion", () => {
    for (const s of [SPRING_SNAP, SPRING_SHEET, SPRING_ROW]) {
      expect(s.type).toBe("spring");
      expect(s.duration).toBeUndefined();
    }
  });
});
