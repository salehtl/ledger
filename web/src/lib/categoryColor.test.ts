import { describe, it, expect } from "vitest";
import { categoryColor } from "./categoryColor";

describe("categoryColor", () => {
  it("resolves a palette name to its themed variable", () => {
    expect(categoryColor("teal")).toBe("var(--color-teal)");
    expect(categoryColor("azure-deep")).toBe("var(--color-azure-deep)");
  });

  it("falls back to the neutral for anything it does not know", () => {
    // Never interpolate an unvalidated name: var(--color-chartreuse) is valid
    // CSS that resolves to nothing, so the mark would silently vanish rather
    // than degrade.
    for (const v of [null, undefined, "", "chartreuse", "#ff0000"]) {
      expect(categoryColor(v)).toBe("var(--color-slate)");
    }
  });
});
