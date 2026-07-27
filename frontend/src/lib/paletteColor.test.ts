import { projectColor, PALETTE_NAMES, isPaletteName } from "./paletteColor";

describe("projectColor", () => {
  it("resolves a palette name to its CSS var", () => {
    // A var, not a hex: the cascade re-resolves it on a theme flip, so no
    // consumer needs a theme subscription. A stored light-mode hex could not
    // do this — azure sits at 2.82:1 on the dark ground.
    expect(projectColor("azure")).toBe("var(--color-azure)");
    expect(projectColor("sage")).toBe("var(--color-sage)");
  });

  it("covers every palette name", () => {
    for (const n of PALETTE_NAMES) {
      expect(projectColor(n)).toBe(`var(--color-${n})`);
    }
  });

  it("passes a legacy hex through unchanged", () => {
    // Projects predate this and stored literals; they must keep rendering.
    expect(projectColor("#1373d9")).toBe("#1373d9");
    expect(projectColor("#abc")).toBe("#abc");
  });

  it("falls back to the neutral for null, empty and unknown values", () => {
    // No read path may throw on unexpected data — this reads whatever is in
    // the column, which nothing constrains.
    expect(projectColor(null)).toBe("var(--color-slate)");
    expect(projectColor(undefined)).toBe("var(--color-slate)");
    expect(projectColor("")).toBe("var(--color-slate)");
    expect(projectColor("chartreuse")).toBe("var(--color-slate)");
  });

  it("does not treat an unknown name as a var, which would render nothing", () => {
    // The dangerous failure: var(--color-chartreuse) is valid CSS that
    // resolves to nothing, so the dot would silently vanish rather than
    // fall back.
    expect(projectColor("chartreuse")).not.toContain("chartreuse");
  });
});

describe("isPaletteName", () => {
  it("accepts names and rejects everything else", () => {
    expect(isPaletteName("amber")).toBe(true);
    expect(isPaletteName("#b5771e")).toBe(false);
    expect(isPaletteName("")).toBe(false);
    expect(isPaletteName(null)).toBe(false);
  });
});
