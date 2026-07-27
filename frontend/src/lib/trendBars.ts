/** Bar height as a 0-100 percentage of the tallest bar; 0 when there is no data. */
export function barHeightPct(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}

import type { TrendPoint } from "./insights";

/** One row per month, in the shape the dither BarChart consumes. */
export function trendRows(points: TrendPoint[]): { period: string; label: string; spent: number }[] {
  return points.map((p) => ({ period: p.period, label: p.label, spent: p.spent }));
}

/** Position of the active month, or null when it isn't in the series. */
export function activeIndex(points: TrendPoint[], activePeriod?: string): number | null {
  if (!activePeriod) return null;
  const i = points.findIndex((p) => p.period === activePeriod);
  return i === -1 ? null : i;
}
