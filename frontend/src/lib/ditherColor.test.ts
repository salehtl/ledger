import { bucketDither, categoryDither, CATEGORY_DITHER } from "./ditherColor";
import { CATEGORY_PALETTE } from "./insights";

describe("bucketDither", () => {
  it("maps each budget bucket to its token's dither seed", () => {
    expect(bucketDither("need")).toBe("blue");
    expect(bucketDither("want")).toBe("purple");
    expect(bucketDither("saving")).toBe("green");
  });

  it("falls back to grey for anything else", () => {
    expect(bucketDither("mystery")).toBe("grey");
  });
});

describe("categoryDither", () => {
  it("has one dither seed per CATEGORY_PALETTE entry", () => {
    expect(CATEGORY_DITHER).toHaveLength(CATEGORY_PALETTE.length);
  });

  it("assigns distinct seeds so adjacent ranks stay distinguishable", () => {
    expect(new Set(CATEGORY_DITHER).size).toBe(CATEGORY_DITHER.length);
  });

  it("wraps around past the end of the palette", () => {
    expect(categoryDither(0)).toBe(CATEGORY_DITHER[0]);
    expect(categoryDither(CATEGORY_DITHER.length)).toBe(CATEGORY_DITHER[0]);
  });

  it("pins the two intentional near-matches so a well-meaning reorder has to confront the reasoning", () => {
    // CATEGORY_PALETTE[3] (#0e7490, teal) has no exact seed in the seven-name
    // vocabulary; "pink" is our fork's navy (--color-accent), the nearest
    // cool hue still unused at this rank — not an actual pink.
    expect(categoryDither(3)).toBe("pink");
    // CATEGORY_PALETTE[5] (#be185d, rose/magenta) takes "red", the nearest
    // warm hue still unused.
    expect(categoryDither(5)).toBe("red");
  });
});
