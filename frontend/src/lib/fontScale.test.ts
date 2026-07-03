import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  applyFontScale,
  loadFontScale,
  saveFontScale,
} from "./fontScale";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("font-size");
});

describe("loadFontScale", () => {
  it("defaults to 100 when nothing is stored", () => {
    expect(loadFontScale()).toBe(DEFAULT_FONT_SCALE);
  });

  it("round-trips a saved scale", () => {
    saveFontScale(90);
    expect(loadFontScale()).toBe(90);
  });

  it("falls back to the default on garbage or out-of-range values", () => {
    localStorage.setItem("ledger-font-scale", "abc");
    expect(loadFontScale()).toBe(DEFAULT_FONT_SCALE);
    localStorage.setItem("ledger-font-scale", "120");
    expect(loadFontScale()).toBe(DEFAULT_FONT_SCALE);
  });
});

describe("applyFontScale", () => {
  it("sets the root font-size for a reduced scale", () => {
    applyFontScale(85);
    expect(document.documentElement.style.fontSize).toBe("85%");
  });

  it("removes the override at the default scale", () => {
    applyFontScale(85);
    applyFontScale(DEFAULT_FONT_SCALE);
    expect(document.documentElement.style.fontSize).toBe("");
  });
});

describe("FONT_SCALE_OPTIONS", () => {
  it("covers 80–100 in 5% steps with the default last", () => {
    expect(FONT_SCALE_OPTIONS).toEqual([80, 85, 90, 95, 100]);
  });
});
