import type { DitherColor } from "../components/dither-kit/palette";
import type { Density } from "../components/charts/DitherFill";

/**
 * Which palette hue each budget bucket paints in. The canvas paints raw RGB and
 * can't read a CSS var, so anything dithered picks its seed here.
 *
 * These three are the one set that physically *touches* — ComparativeSummary
 * stacks them into a single bar — so they were chosen for separation, not
 * tidiness. Validated as a triple: worst adjacent ΔE 18.2 under deuteranopia,
 * 24.5 normal vision. The obvious azure/lilac/sage assignment fails badly
 * (ΔE 0.9 — azure and lilac collapse to the same blue-grey), so needs takes
 * amber to break the two cool hues apart. Don't reorder without re-validating.
 */
export function bucketDither(bucket: string): DitherColor {
  switch (bucket) {
    case "need": return "amber";
    case "want": return "lilac";
    case "saving": return "sage";
    default: return "slate";
  }
}

/**
 * Selects the texture (density) encoding for a bucket. Buckets are deliberately
 * double-encoded: `bucketDither` above selects the hue (amber/lilac/sage), and
 * this selects the dither texture — needs densest, wants medium, saving sparsest.
 * The redundancy is deliberate: anyone who can't resolve the dot pattern still
 * gets the hue, and anyone who can't distinguish the hue still reads the density.
 *
 * `isOverBudget` overrides the bucket's usual density to `"solid"` — a bucket
 * at or over its target renders full ink, exactly the texture-not-colour
 * reading `ProgressBar` already gives its own fill at `pct >= 1.0`. This
 * function stays pure and only knows the bucket's identity plus whatever the
 * caller already determined about its spend-vs-target for the period shown;
 * it does not reach for that data itself (see `overBudgetBuckets` in
 * `lib/insights.ts`, which turns a period's `BucketSummary[]` into the set of
 * over-budget bucket names callers pass in here).
 */
export function bucketDensity(bucket: string, isOverBudget = false): Density {
  if (isOverBudget) return "solid";
  switch (bucket) {
    case "need": return "dense";
    case "want": return "medium";
    case "saving": return "sparse";
    default: return "medium";
  }
}

/**
 * Categorical hues by spend rank, in a fixed order that never changes — the
 * order *is* the colour-blindness safety mechanism, so it alternates the two
 * groups that collapse under red-green CVD (cool: azure, lilac / warm: amber,
 * sage, rose) and staggers lightness alongside. Validated as an ordered set:
 * worst adjacent ΔE 13.7 light and 12.8 dark under protanopia, 18.0 / 16.6
 * normal vision.
 *
 * Five, not six. A sixth hue could not clear the chroma floor and the
 * separation floor at once on paper — teal was the casualty, landing at C .087
 * against a .10 floor and colliding with both its neighbours. Rather than ship
 * a pair nobody can tell apart, rank 5 and beyond fold into the neutral.
 */
export const CATEGORY_DITHER: DitherColor[] = ["amber", "azure", "sage", "lilac", "rose"];

/**
 * Seed for the category at spend-rank `i`. Everything past the palette folds
 * into the neutral rather than cycling — a repeated hue would say two unrelated
 * categories are the same thing. Callers that care about the tail should rank
 * and group into an explicit "Other" row.
 */
export function categoryDither(i: number): DitherColor {
  return CATEGORY_DITHER[i] ?? "slate";
}
