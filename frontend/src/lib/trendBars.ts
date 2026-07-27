import type { TrendPoint } from "./insights";
import { buildBandScale } from "../components/dither-kit/scales";

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

/**
 * Fractional (0-1) horizontal center and slot width for each of `n` bar
 * bands. Delegates to dither-kit's own `buildBandScale` (the same d3
 * `scaleBand`, same `paddingInner`/`paddingOuter`) called with a plot width
 * of 1, so the result is a pure fraction and — because it's literally the
 * same function BarChart uses to lay out bars, not a second copy of its
 * padding constants — can never drift from what the canvas actually paints.
 *
 * Only meaningful when the chart's `margins.left`/`right` are zero: d3's
 * band scale ranges over the *plot* width, and this treats plot width as
 * equal to the container width so a label row with no margins of its own
 * can share these exact fractions.
 */
export function bandCenters(n: number): { center: number; width: number }[] {
  if (n <= 0) return [];
  const scale = buildBandScale(n, 1);
  const bandwidth = scale.bandwidth();
  const step = scale.step();
  return Array.from({ length: n }, (_, i) => ({
    center: (scale(i) ?? 0) + bandwidth / 2,
    width: step,
  }));
}

/**
 * Left offset and width (0–1 fractions of the plot width) for a highlight
 * spanning the active month's whole band — built from the same
 * `bandCenters()` the bars and label rows use, so a highlight positioned from
 * this lines up with the active bar by construction. Returns null when
 * there's no active index or it's outside the series, so callers render
 * nothing rather than a highlight with NaN geometry.
 */
export function activeBandRect(n: number, index: number | null): { left: number; width: number } | null {
  if (index == null) return null;
  const band = bandCenters(n)[index];
  if (!band) return null;
  return { left: band.center - band.width / 2, width: band.width };
}
