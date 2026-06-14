import { describe, it, expect } from "vitest";
import { pctsValid } from "./SettingsDrawer";

describe("pctsValid", () => {
  it("accepts 50/30/20", () => {
    expect(pctsValid(0.5, 0.3, 0.2)).toBe(true);
  });
  it("rejects sums that miss 1.0", () => {
    expect(pctsValid(0.5, 0.5, 0.5)).toBe(false);
    expect(pctsValid(0.4, 0.3, 0.2)).toBe(false);
  });
});
