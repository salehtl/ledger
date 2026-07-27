import type { DitherColor } from "../components/dither-kit/palette";
import type { Density } from "../components/charts/DitherFill";

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

/**
 * The signature encoding: `--color-need`/`--color-want`/`--color-save` all
 * resolve to the same ink now, so the 50/30/20 buckets are told apart by
 * dither density instead — needs densest, wants medium, saving sparsest.
 * `bucketDither` above still selects the ink *seed* (still needed for `red`/
 * `grey`, which aren't buckets); this selects the *texture*. Callers that also
 * know a bucket is at or over its budget for the period shown should override
 * this with `"solid"` themselves (see `ProgressBar`'s `pct >= 1.0` threshold) —
 * this function only knows the bucket's identity, not its spend-vs-target.
 */
export function bucketDensity(bucket: string): Density {
  switch (bucket) {
    case "need": return "dense";
    case "want": return "medium";
    case "saving": return "sparse";
    default: return "medium";
  }
}

/**
 * One seed per CATEGORY_PALETTE entry, in the same rank order. The seven-seed
 * vocabulary (blue/purple/green/red/orange/pink/grey) is upstream dither-kit's
 * own — in our fork the *names* no longer describe their values (e.g. `pink`
 * is `--color-accent`, a navy, not pink; see `components/dither-kit/palette.ts`).
 * It also has no teal, so two ranks are a nearest-hue-family match rather than
 * an exact one — don't "fix" these back on a future reorder:
 *  - rank 3 (`CATEGORY_PALETTE[3]` = `#0e7490`, teal) takes `"pink"`, our
 *    fork's navy — the nearest cool hue still unused at this rank.
 *  - rank 5 (`CATEGORY_PALETTE[5]` = `#be185d`, rose/magenta) takes `"red"`
 *    (`#dc2626`) — the nearest warm hue still unused.
 * Ranks 0, 1, 2 and 4 are exact matches. All six stay pairwise distinct.
 */
export const CATEGORY_DITHER: DitherColor[] = ["blue", "purple", "green", "pink", "orange", "red"];

/** Seed for the category at spend-rank `i`, wrapping past the palette's end. */
export function categoryDither(i: number): DitherColor {
  return CATEGORY_DITHER[i % CATEGORY_DITHER.length];
}
