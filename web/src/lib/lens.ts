import type { Txn } from "../api/types";
import { BUCKET_LABEL, type BucketComparison, type CategoryDelta } from "./insights";
import { merchantBreakdown } from "./analysis";
import { bucketDither, bucketDensity, categoryDither } from "./ditherColor";
import { isPaletteName } from "./paletteColor";
import type { DitherColor } from "../components/dither-kit/palette";
import type { Density } from "../components/charts/DitherFill";

// The three dimensions you can slice spending by on the Insights page.
export type Lens = "buckets" | "categories" | "merchants";

/** A stored category colour as a canvas seed, or the neutral if it is missing
 *  or not a palette name. `PaletteName` and `DitherColor` are pinned to the
 *  same set by the assertions in `paletteColor.ts`, so the narrowing is exact. */
function ditherFor(color: string | undefined): DitherColor {
  return isPaletteName(color) ? color : "slate";
}

// A single ranked row in the analysis breakdown. `share` is a fraction of the
// month's total spend; delta fields are present only for lenses that compare
// to the previous month (buckets, categories), absent for merchants.
export interface BreakdownRow {
  key: string;
  name: string;
  /**
   * Palette hue for this row's bar, as a name rather than a CSS colour.
   * There is deliberately no parallel CSS-color field: every
   * consumer of a breakdown row renders a `DitherFill`, and carrying the same
   * color twice is how a legend drifts out of step with what it labels. The
   * CSS-var side of the mapping lives in `lib/ditherColor.ts`.
   */
  ditherColor: DitherColor;
  /**
   * Bar texture for this row — `"solid"` when the row is at or over budget.
   * Only set for bucket rows, since only buckets have a target to be over.
   * Category and merchant rows leave it undefined, which `DitherFill` renders
   * dotted.
   */
  density?: Density;
  spent: number;
  share: number;
  count?: number;
  delta?: number;
  deltaPct?: number | null;
  isNew?: boolean;
  isGone?: boolean;
  categoryId?: number | null;
}

function share(spent: number, total: number): number {
  return total > 0 ? spent / total : 0;
}

/**
 * Bucket rows (need/want/saving) ranked by spend, with month-over-month
 * deltas. `overBudget` is the set of bucket names at or over target for the
 * period shown (see `overBudgetBuckets` in `lib/insights.ts`) — when a bucket
 * is in it, its bar renders solid instead of dotted. Omit it (or pass an empty
 * set) where over-budget data isn't available; every bucket then renders dotted.
 */
export function bucketRows(buckets: BucketComparison[], total: number, overBudget: Set<string> = new Set()): BreakdownRow[] {
  return [...buckets]
    .sort((a, b) => b.spent - a.spent)
    .map((b) => ({
      key: b.bucket,
      name: BUCKET_LABEL[b.bucket] ?? b.bucket,
      ditherColor: bucketDither(b.bucket),
      density: bucketDensity(b.bucket, overBudget.has(b.bucket)),
      spent: b.spent,
      share: share(b.spent, total),
      delta: b.delta,
      deltaPct: b.prevSpent > 0 ? b.delta / b.prevSpent : null,
      isNew: b.prevSpent === 0 && b.spent > 0,
      isGone: b.spent === 0 && b.prevSpent > 0,
    }));
}

/**
 * Category rows ranked by spend (rows arrive pre-sorted with a `pct` share),
 * carrying each category's id for drill-down and its delta.
 *
 * The bar takes the category's **own** colour, looked up by id. It used to take
 * `categoryDither(i)` — the hue at its *spend rank* — which had two faults that
 * only showed once categories carried colours of their own: a category changed
 * hue whenever its rank changed between months, and `CATEGORY_DITHER` holds
 * five entries, so with 21 categories everything from sixth place down
 * collapsed into the same neutral grey.
 *
 * An id with no usable colour falls to the neutral rather than being
 * interpolated: an unknown name would reach `var(--color-…)` as valid CSS that
 * resolves to nothing, and the bar would vanish instead of degrading. In
 * practice the map always hits — every category is seeded at insert and
 * backfilled at startup — so this covers the window before the query lands.
 */
export function categoryRows(
  rows: (CategoryDelta & { pct: number })[],
  colorById: ReadonlyMap<number, string>,
): BreakdownRow[] {
  return rows.map((c) => ({
    key: `cat:${c.category_id}`,
    name: c.name,
    ditherColor: ditherFor(colorById.get(c.category_id)),
    spent: c.spent,
    share: c.pct,
    delta: c.delta,
    deltaPct: c.deltaPct,
    isNew: c.isNew,
    isGone: c.spent === 0 && c.prevSpent > 0,
    categoryId: c.category_id,
  }));
}

/** Merchant rows ranked by spend (no prior-month comparison available). */
export function merchantRows(txns: Txn[], total: number, limit = 20): BreakdownRow[] {
  return merchantBreakdown(txns)
    .slice(0, limit)
    .map((m, i) => ({
      key: `merchant:${m.merchant}`,
      name: m.merchant,
      ditherColor: categoryDither(i),
      spent: m.spent,
      share: share(m.spent, total),
      count: m.count,
    }));
}
