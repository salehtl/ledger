/**
 * Ranked breakdown rows for the Insights lenses, over the local projection.
 *
 * # Why the money here is `bigint`
 *
 * Every row is an aggregate of an aggregate: a category total is a SUM over
 * transactions, and the share beside it is that SUM against the month's. The
 * projection stores amounts as TEXT because a JS `number` cannot hold an
 * `int64` (`client/src/replay/projection.ts`), so a `number` on this path would
 * be a rounding bug that only appears at the top of the screen where the
 * figures are largest. `share` is a ratio, not money, and is derived by
 * dividing in `bigint` first.
 *
 * # No `overBudget`, and no per-category colour
 *
 * Both were v1 HTTP data. `overBudget` came from `/api/summary`'s `pct_used`,
 * which needs a target, and no op in the v2 vocabulary authors one — so every
 * bar renders dotted and nothing here claims a bucket is "over". Category
 * colours came from `/api/categories`; `category` is a free-form string in
 * `client/src/replay/state.ts` with no entity and no colour behind it, so rows
 * take {@link categoryDither}'s spend-rank hue, which is exactly what it is
 * documented to be.
 */
import type { BucketDelta, CategoryDelta, DrillTarget, InsightsBucket, MerchantTotal } from "../v2/sources/insights";
import { bucketDither, bucketDensity, categoryDither } from "./ditherColor";
import type { DitherColor } from "../components/dither-kit/palette";
import type { Density } from "../components/charts/DitherFill";

// The three dimensions you can slice spending by on the Insights page.
export type Lens = "buckets" | "categories" | "merchants";

/** Display names for the four buckets this screen ranks, the remainder included. */
export const LENS_BUCKET_LABEL: Record<InsightsBucket, string> = {
  need: "Needs",
  want: "Wants",
  saving: "Savings & debt",
  unassigned: "Uncategorized",
};

/**
 * A single ranked row in the analysis breakdown. `share` is a fraction of the
 * month's total spend; delta fields are present only for lenses that compare to
 * the previous month (buckets, categories), absent for merchants.
 */
export interface BreakdownRow {
  key: string;
  name: string;
  /**
   * Palette hue for this row's bar, as a name rather than a CSS colour. There
   * is deliberately no parallel CSS-color field: every consumer renders a
   * `DitherFill`, and carrying the same colour twice is how a legend drifts out
   * of step with what it labels.
   */
  ditherColor: DitherColor;
  /** Bar texture. Always dotted here — see the header on `overBudget`. */
  density?: Density;
  spent: bigint;
  share: number;
  count?: number;
  delta?: bigint;
  deltaPct?: number | null;
  isNew?: boolean;
  isGone?: boolean;
  /** What tapping this row drills into. */
  drill: DrillTarget;
}

/**
 * The three things a breakdown row can open. Defined in `sources/insights.ts`
 * because the *source* is what has to interpret it exactly — see `DrillPage`.
 */
export type { DrillTarget };

/**
 * `spent / total` as a 0..1 fraction. Divided in `bigint` at six decimal places
 * so the money never enters a double; only the bounded quotient does.
 */
export function share(spent: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((spent * 1_000_000n) / total) / 1_000_000;
}

/** Bucket rows ranked by spend, with month-over-month deltas. */
export function bucketRows(buckets: readonly BucketDelta[], total: bigint): BreakdownRow[] {
  return [...buckets]
    .filter((b) => b.spent > 0n || b.prevSpent > 0n)
    .sort((a, b) => (b.spent === a.spent ? 0 : b.spent > a.spent ? 1 : -1))
    .map((b) => ({
      key: b.key,
      name: LENS_BUCKET_LABEL[b.bucket],
      ditherColor: bucketDither(b.bucket),
      density: bucketDensity(b.bucket),
      spent: b.spent,
      share: share(b.spent, total),
      delta: b.delta,
      deltaPct: b.deltaPct,
      isNew: b.isNew,
      isGone: b.isGone,
      drill: { type: "bucket", bucket: b.bucket, name: LENS_BUCKET_LABEL[b.bucket] },
    }));
}

/** Category rows, already ranked by the source, carrying their delta. */
export function categoryRows(categories: readonly CategoryDelta[], total: bigint): BreakdownRow[] {
  return categories.map((c, i) => ({
    key: c.key,
    name: c.name,
    ditherColor: categoryDither(i),
    spent: c.spent,
    share: share(c.spent, total),
    delta: c.delta,
    deltaPct: c.deltaPct,
    isNew: c.isNew,
    isGone: c.isGone,
    drill: { type: "category", category: c.category, name: c.name },
  }));
}

/** Merchant rows ranked by spend (no prior-month comparison available). */
export function merchantRows(merchants: readonly MerchantTotal[], total: bigint, limit = 20): BreakdownRow[] {
  return merchants.slice(0, limit).map((m, i) => ({
    key: `merchant:${m.merchant}`,
    name: m.merchant || "—",
    ditherColor: categoryDither(i),
    spent: m.spent,
    share: share(m.spent, total),
    count: m.count,
    drill: { type: "merchant", merchant: m.merchant, name: m.merchant || "—" },
  }));
}
