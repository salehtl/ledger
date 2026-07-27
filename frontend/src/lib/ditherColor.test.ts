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
});
