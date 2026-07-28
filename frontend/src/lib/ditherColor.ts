import type { DitherColor } from "../components/dither-kit/palette";
import type { Density } from "../components/charts/DitherFill";

/**
 * Which palette hue each budget bucket paints in. Canvas consumers
 * (`TrendBars`, `FlowBars`, `SwipeDeck`) need raw RGB and can't read a CSS var,
 * so the seed is chosen here; DOM consumers pass the same name through
 * `hueVar` (`lib/paletteColor.ts`) and let the cascade resolve it.
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
 * Texture for a bucket's bar: `"solid"` at or over budget, `"dotted"` otherwise —
 * the same `pct >= 1.0` threshold `ProgressBar` calls "over budget", so Home
 * and Insights agree on *when* a bucket is over even though they say it
 * differently: these hue-carrying bars say it with texture, `ProgressBar` says
 * it with its pace ink (see `derivePaceStatus`).
 *
 * The `bucket` argument no longer affects the result. Density used to encode
 * bucket identity redundantly with hue (need dense, want medium, saving
 * sparse), from when Insights' bars were monochrome. Once both screens shared
 * one dot texture that channel went away, and buckets now read the way category
 * and merchant rows always have: by hue, beside a visible text label. The
 * parameter stays so call sites and `BreakdownRow` are unchanged.
 *
 * This function stays pure and only knows what the caller already determined
 * about spend-vs-target for the period shown; it does not reach for that data
 * itself (see `overBudgetBuckets` in `lib/insights.ts`).
 */
export function bucketDensity(_bucket: string, isOverBudget = false): Density {
  return isOverBudget ? "solid" : "dotted";
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
