import { bucketDither, bucketDensity, categoryDither, CATEGORY_DITHER } from "./ditherColor";

describe("bucketDither", () => {
  it("maps each budget bucket to its palette hue", () => {
    expect(bucketDither("need")).toBe("amber");
    expect(bucketDither("want")).toBe("lilac");
    expect(bucketDither("saving")).toBe("sage");
  });

  it("falls back to the neutral for anything else", () => {
    expect(bucketDither("mystery")).toBe("slate");
  });

  it("keeps needs off a cool hue — the three stack into one bar and must stay apart", () => {
    // ComparativeSummary stacks these three touching each other. The intuitive
    // azure/lilac/sage assignment collapses: azure and lilac read as the same
    // blue-grey under deuteranopia (validated ΔE 0.9, far under the floor of
    // 8). Needs takes a warm hue so no two cool hues sit adjacent. If this ever
    // changes, re-run the palette validator on the triple before shipping.
    const cool = ["azure", "lilac"];
    const buckets = ["need", "want", "saving"].map(bucketDither);
    expect(buckets.filter((c) => cool.includes(c))).toHaveLength(1);
  });
});

describe("bucketDensity", () => {
  it("maps each budget bucket to its signature density: needs densest, wants medium, saving sparsest", () => {
    expect(bucketDensity("need")).toBe("dense");
    expect(bucketDensity("want")).toBe("medium");
    expect(bucketDensity("saving")).toBe("sparse");
  });

  it("falls back to medium (zero bias) for anything else", () => {
    expect(bucketDensity("mystery")).toBe("medium");
  });

  it("overrides every bucket's density to solid when isOverBudget is true", () => {
    expect(bucketDensity("need", true)).toBe("solid");
    expect(bucketDensity("want", true)).toBe("solid");
    expect(bucketDensity("saving", true)).toBe("solid");
  });

  it("defaults isOverBudget to false, so an un-migrated call site is unaffected", () => {
    expect(bucketDensity("need")).toBe(bucketDensity("need", false));
  });
});

describe("categoryDither", () => {
  it("assigns distinct hues so ranks stay distinguishable", () => {
    expect(new Set(CATEGORY_DITHER).size).toBe(CATEGORY_DITHER.length);
  });

  it("alternates warm and cool so no two adjacent ranks collapse under red-green CVD", () => {
    // Hue alone collapses into two groups for a red-green colourblind reader:
    // cool (azure, lilac) and warm (amber, sage, rose). Neighbouring ranks must
    // straddle that split, which is what the fixed order buys. Validated at
    // worst adjacent ΔE 13.7 light / 12.8 dark; this test pins the structure
    // that produces it.
    const cool = new Set(["azure", "lilac"]);
    for (let i = 1; i < CATEGORY_DITHER.length; i++) {
      expect(cool.has(CATEGORY_DITHER[i])).not.toBe(cool.has(CATEGORY_DITHER[i - 1]));
    }
  });

  it("folds every rank past the palette into the neutral rather than cycling", () => {
    // Reusing a hue would claim two unrelated categories are the same thing.
    expect(categoryDither(0)).toBe(CATEGORY_DITHER[0]);
    expect(categoryDither(CATEGORY_DITHER.length)).toBe("slate");
    expect(categoryDither(CATEGORY_DITHER.length + 7)).toBe("slate");
  });
});
