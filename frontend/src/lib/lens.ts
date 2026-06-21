import type { Txn } from "../api/types";
import { bucketColor, BUCKET_LABEL, CATEGORY_PALETTE, type BucketComparison, type CategoryDelta } from "./insights";
import { merchantBreakdown } from "./analysis";

// The three dimensions you can slice spending by on the Insights page.
export type Lens = "buckets" | "categories" | "merchants";

// A single ranked row in the analysis breakdown. `share` is a fraction of the
// month's total spend; delta fields are present only for lenses that compare
// to the previous month (buckets, categories), absent for merchants.
export interface BreakdownRow {
  key: string;
  name: string;
  color: string;
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

/** Bucket rows (need/want/saving) ranked by spend, with month-over-month deltas. */
export function bucketRows(buckets: BucketComparison[], total: number): BreakdownRow[] {
  return [...buckets]
    .sort((a, b) => b.spent - a.spent)
    .map((b) => ({
      key: b.bucket,
      name: BUCKET_LABEL[b.bucket] ?? b.bucket,
      color: bucketColor(b.bucket),
      spent: b.spent,
      share: share(b.spent, total),
      delta: b.delta,
      deltaPct: b.prevSpent > 0 ? b.delta / b.prevSpent : null,
      isNew: b.prevSpent === 0 && b.spent > 0,
      isGone: b.spent === 0 && b.prevSpent > 0,
    }));
}

/** Category rows ranked by spend (rows arrive pre-sorted with a `pct` share),
 *  each a distinct palette hue, carrying its id for drill-down and its delta. */
export function categoryRows(rows: (CategoryDelta & { pct: number })[]): BreakdownRow[] {
  return rows.map((c, i) => ({
    key: `cat:${c.category_id}`,
    name: c.name,
    color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
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
      color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
      spent: m.spent,
      share: share(m.spent, total),
      count: m.count,
    }));
}
