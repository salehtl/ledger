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
