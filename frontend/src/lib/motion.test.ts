import { describe, it, expect } from "vitest";
import { sheetTransition, scrimTransition, SHEET_ENTER_MS, SHEET_EXIT_MS } from "./motion";

describe("sheetTransition", () => {
  it("uses the drawer curve and enter duration when motion is allowed", () => {
    expect(sheetTransition(false)).toBe(`transform ${SHEET_ENTER_MS}ms var(--ease-drawer)`);
  });
  it("drops the transform transition under reduced motion", () => {
    expect(sheetTransition(true)).toBe("none");
  });
});

describe("scrimTransition", () => {
  it("animates opacity with the ease-out curve (kept even under reduced motion)", () => {
    expect(scrimTransition()).toContain("opacity");
    expect(scrimTransition()).toContain("var(--ease-out)");
  });
});

describe("timing constants", () => {
  it("stay within the UI budget (<300ms exit, <=300ms enter)", () => {
    expect(SHEET_EXIT_MS).toBeLessThan(300);
    expect(SHEET_ENTER_MS).toBeLessThanOrEqual(300);
  });
});
