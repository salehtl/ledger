import type { BucketSummary, CategorySpend, MonthlyTotal } from "../api/types";

export function totalSpent(buckets: BucketSummary[]): number {
  return buckets.reduce((s, b) => s + b.spent, 0);
}
export function totalBudget(buckets: BucketSummary[]): number {
  return buckets.reduce((s, b) => s + b.target, 0);
}

export function bucketColor(bucket: string): string {
  switch (bucket) {
    case "need": return "var(--color-need)";
    case "want": return "var(--color-want)";
    case "saving": return "var(--color-save)";
    default: return "var(--color-muted)";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(period: string): string {
  const m = Number(period.slice(5, 7));
  return MONTHS[m - 1] ?? period;
}

export interface DonutSlice { name: string; value: number; color: string; }

/** Top `topN` categories by spend; everything else folded into "Other". */
export function donutSlices(cats: CategorySpend[], topN = 6): DonutSlice[] {
  const sorted = [...cats].sort((a, b) => b.spent - a.spent);
  const head = sorted.slice(0, topN).map((c) => ({ name: c.name, value: c.spent, color: bucketColor(c.bucket) }));
  const rest = sorted.slice(topN).reduce((s, c) => s + c.spent, 0);
  if (rest > 0) head.push({ name: "Other", value: rest, color: "var(--color-muted)" });
  return head;
}

export interface TrendPoint { period: string; label: string; spent: number; income: number; }

/** Project totals onto an explicit ordered list of periods, filling gaps with 0. */
export function trendSeries(totals: MonthlyTotal[], periods: string[]): TrendPoint[] {
  const byPeriod = new Map(totals.map((t) => [t.period, t]));
  return periods.map((p) => {
    const t = byPeriod.get(p);
    return { period: p, label: monthLabel(p), spent: t?.spent ?? 0, income: t?.income ?? 0 };
  });
}

/** The current month as "YYYY-MM" (local time). */
export function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Sum of each bucket's run-rate projection (where this month is heading). */
export function totalProjection(buckets: BucketSummary[]): number {
  return buckets.reduce((s, b) => s + b.projection, 0);
}

export type PaceStatus = "under" | "over" | "overbudget";

/**
 * Pace verdict for one budget line:
 *  - "overbudget": already spent the whole target,
 *  - "over": projected to overspend by month-end,
 *  - "under": projected to finish within budget.
 */
export function paceStatus(spent: number, target: number, projection: number): PaceStatus {
  if (target > 0 && spent >= target) return "overbudget";
  if (target > 0 && projection > target) return "over";
  return "under";
}

/** Tone for a pace status, matching the app's semantic colors. */
export function paceTone(status: PaceStatus): "good" | "warn" | "bad" {
  return status === "overbudget" ? "bad" : status === "over" ? "warn" : "good";
}

export interface CategoryDelta {
  category_id: number;
  name: string;
  bucket: string;
  spent: number;
  prevSpent: number;
  delta: number;            // spent - prevSpent
  deltaPct: number | null;  // prevSpent > 0 ? delta / prevSpent : null
  isNew: boolean;           // prevSpent === 0 && spent > 0
}

/** Pair each category's spend with its previous-month spend. Includes "gone" categories (present last month only) with spent 0. */
export function categoryDeltas(cur: CategorySpend[], prev: CategorySpend[]): CategoryDelta[] {
  const prevMap = new Map(prev.map((c) => [c.category_id, c]));
  const out: CategoryDelta[] = cur.map((c) => {
    const prevSpent = prevMap.get(c.category_id)?.spent ?? 0;
    const delta = c.spent - prevSpent;
    return {
      category_id: c.category_id, name: c.name, bucket: c.bucket,
      spent: c.spent, prevSpent, delta,
      deltaPct: prevSpent > 0 ? delta / prevSpent : null,
      isNew: prevSpent === 0 && c.spent > 0,
    };
  });
  const curIds = new Set(cur.map((c) => c.category_id));
  for (const p of prev) {
    if (!curIds.has(p.category_id)) {
      out.push({
        category_id: p.category_id, name: p.name, bucket: p.bucket,
        spent: 0, prevSpent: p.spent, delta: -p.spent, deltaPct: -1, isNew: false,
      });
    }
  }
  return out;
}

/** Add a `pct` field (fraction of `total`) to each row. */
export function withShare<T extends { spent: number }>(rows: T[], total: number): (T & { pct: number })[] {
  return rows.map((r) => ({ ...r, pct: total > 0 ? r.spent / total : 0 }));
}

export interface BucketComparison { bucket: string; spent: number; prevSpent: number; delta: number; }

const BUCKET_ORDER = ["need", "want", "saving"] as const;

/** Per-bucket spend this month vs last, in fixed need/want/saving order. */
export function bucketComparison(cur: CategorySpend[], prev: CategorySpend[]): BucketComparison[] {
  const sumBy = (rows: CategorySpend[], bucket: string) =>
    rows.filter((c) => c.bucket === bucket).reduce((s, c) => s + c.spent, 0);
  return BUCKET_ORDER.map((bucket) => {
    const spent = sumBy(cur, bucket);
    const prevSpent = sumBy(prev, bucket);
    return { bucket, spent, prevSpent, delta: spent - prevSpent };
  });
}

/** The `n` categories that moved most this month, by absolute fils change; zero-deltas excluded. */
export function topMovers(deltas: CategoryDelta[], n = 3): CategoryDelta[] {
  return deltas
    .filter((d) => d.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, n);
}

export interface SavingsResult { net: number; rate: number | null; }

/** Net (income − spent) and savings rate; rate is null when there's no income to divide by. */
export function savingsRate(income: number, spent: number): SavingsResult {
  return { net: income - spent, rate: income > 0 ? (income - spent) / income : null };
}

/** The trailing `n` period strings ("YYYY-MM"), oldest first, ending at `end` (a YYYY-MM). */
export function trailingPeriods(end: string, n: number): string[] {
  const [y, m] = end.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
