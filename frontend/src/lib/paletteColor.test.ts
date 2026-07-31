import { projectColor, PALETTE_NAMES, PALETTE_DISPLAY_ORDER, isPaletteName, hueVar } from "./paletteColor";

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

describe("hueVar", () => {
  it("resolves a palette hue to its CSS custom property", () => {
    expect(hueVar("amber")).toBe("var(--color-amber)");
    expect(hueVar("lilac")).toBe("var(--color-lilac)");
    expect(hueVar("sage")).toBe("var(--color-sage)");
  });

  it("handles the -deep shades, which are palette names like any other", () => {
    expect(hueVar("azure-deep")).toBe("var(--color-azure-deep)");
  });

  it("covers every palette name — a hue with no var would render as nothing", () => {
    // var(--color-chartreuse) is valid CSS that resolves to nothing, so a
    // missing var fails silently at runtime. This is the guard against that.
    for (const name of PALETTE_NAMES) {
      expect(hueVar(name)).toBe(`var(--color-${name})`);
    }
  });
});

describe("PALETTE_DISPLAY_ORDER", () => {
  // The picker renders this list, the backfill walks PALETTE_NAMES. If they
  // ever stop being the same set, a colour the store can assign becomes one
  // the user cannot pick — invisible, because the row still renders it fine.
  it("is a permutation of PALETTE_NAMES — same names, no dupes, none dropped", () => {
    expect(PALETTE_DISPLAY_ORDER).toHaveLength(PALETTE_NAMES.length);
    expect(new Set(PALETTE_DISPLAY_ORDER).size).toBe(PALETTE_DISPLAY_ORDER.length);
    expect([...PALETTE_DISPLAY_ORDER].sort()).toEqual([...PALETTE_NAMES].sort());
  });

  // Six per row is what 320px fits (see the picker in CategoryManager), so
  // "base above its own deep" only holds if the halves stay aligned.
  it("puts every base step directly above its own deep step in a six-wide grid", () => {
    const half = PALETTE_DISPLAY_ORDER.length / 2;
    for (let i = 0; i < half; i++) {
      expect(PALETTE_DISPLAY_ORDER[i + half]).toBe(`${PALETTE_DISPLAY_ORDER[i]}-deep`);
    }
  });

  it("does not reorder PALETTE_NAMES itself — the backfill indexes into it", () => {
    // store.SeedCategoryColor mirrors this array by index; a reorder here would
    // silently re-seed every category on the next backfill.
    expect(PALETTE_NAMES[0]).toBe("azure");
    expect(PALETTE_NAMES[6]).toBe("ochre");
    expect(PALETTE_NAMES[12]).toBe("azure-deep");
  });
});
