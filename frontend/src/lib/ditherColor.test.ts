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
  it("is dotted for every bucket — hue tells buckets apart, not texture", () => {
    // Density used to encode bucket identity redundantly with hue. Once Home
    // and Insights shared one dot texture that second channel went away;
    // category and merchant rows had never carried it either.
    expect(bucketDensity("need")).toBe("dotted");
    expect(bucketDensity("want")).toBe("dotted");
    expect(bucketDensity("saving")).toBe("dotted");
  });

  it("is dotted for an unknown bucket", () => {
    expect(bucketDensity("mystery")).toBe("dotted");
  });

  it("goes solid for any bucket at or over budget — texture is now purely a state channel", () => {
    expect(bucketDensity("need", true)).toBe("solid");
    expect(bucketDensity("want", true)).toBe("solid");
    expect(bucketDensity("saving", true)).toBe("solid");
  });

  it("treats an omitted isOverBudget as under budget", () => {
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
