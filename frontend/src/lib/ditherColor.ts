import type { DitherColor } from "../components/dither-kit/palette";

/**
 * Bridges the app's CSS-var colors to dither-kit's seven seed names. The canvas
 * paints raw RGB and can't read a CSS var, so anything dithered picks its seed
 * here. Keep this in step with `bucketColor` and `CATEGORY_PALETTE` in insights.ts.
 */
export function bucketDither(bucket: string): DitherColor {
  switch (bucket) {
    case "need": return "blue";
    case "want": return "purple";
    case "saving": return "green";
    default: return "grey";
  }
}

/** One seed per CATEGORY_PALETTE entry, in the same rank order. */
export const CATEGORY_DITHER: DitherColor[] = ["blue", "purple", "green", "red", "orange", "pink"];

/** Seed for the category at spend-rank `i`, wrapping past the palette's end. */
export function categoryDither(i: number): DitherColor {
  return CATEGORY_DITHER[i % CATEGORY_DITHER.length];
}
